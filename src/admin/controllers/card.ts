import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { readBody } from '../utils.js'
import { AuthSession } from '../auth.js'
import { getAgentById, updateAgentBalance } from '../../api/agent-store.js'
import { loadCardDb, saveCardDbAsync, updateCard } from '../../api/card-store.js'
import { getSessions } from '../../core/account.js'
import { removeFromAccountCacheByGid } from './dashboard.js'
import { accountStore, removeSessionStore, getSessionStore } from '../../store/index.js'
import { removeAccount, pauseAccount } from '../../core/account.js'

function generateCardPlain(prefix = 'FARM'): string {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`
}

function cardTypeToDays(type: string, inputDays?: number): number {
    if (typeof inputDays === 'number' && Number.isFinite(inputDays) && inputDays > 0) return inputDays
    if (type === '测试卡') return 0.25 // 6 hours
    if (type === '1天卡') return 1
    if (type === '3天卡') return 3
    if (type === '5天卡') return 5
    if (type === '周卡') return 7
    if (type === '月卡') return 30
    return 0
}

function normalizeCardType(type: string): string {
    const val = String(type || '').trim()
    if (['测试卡', '1天卡', '3天卡', '5天卡', '周卡', '月卡', '永久卡'].includes(val)) return val
    return '月卡'
}

export async function handleCardGenerate(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (!session) {
        res.statusCode = 401
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
    }

    const body = await readBody(req)
    const cardTypeRaw = String(body.type || '').trim()
    const isExpansion = cardTypeRaw === 'expansion'

    // For expansion cards, we allow 'expansion' type. For others, we normalize.
    const cardType = isExpansion ? 'expansion' : normalizeCardType(body.type)

    const count = Math.min(Math.max(Number(body.count) || 1, 1), 50)
    const maxBind = Math.min(Math.max(Number(body.maxBindAccounts) || 1, 1), 100) // Increase limit for expansion

    // Expansion cards have no duration (days=0).
    const days = isExpansion ? 0 : cardTypeToDays(cardType, Number(body.days) || 0)
    const expiresAt = days > 0 ? Date.now() + days * 86400000 : undefined
    const note = String(body.note || '')

    // Agent Logic
    let creatorId = 'author'
    if (session.role === 'agent') {
        const agentId = session.id
        const agent = await getAgentById(agentId)
        if (!agent || agent.status !== 'active') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: 'Agent invalid or disabled' }))
            return
        }

        // 1. Permission Check
        if (agent.allowedCardTypes && Array.isArray(agent.allowedCardTypes) && agent.allowedCardTypes.length > 0) {
            if (!agent.allowedCardTypes.includes(cardType)) {
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: false, error: `您没有权限生成 ${cardType}，请联系管理员` }))
                return
            }
        }

        // 2. Price Calculation
        const defaultPrices: Record<string, number> = {
            '测试卡': 0.1,
            '1天卡': 0.975,
            '3天卡': 999, // Disabled/Expensive
            '5天卡': 999, // Disabled/Expensive
            '周卡': 3.9,
            '月卡': 9.75,
            '永久卡': 19.5,
            'expansion': 0.975
        }

        const agentPrices = agent.customPrices || {}
        // Priority: Agent Custom Price > Default Price > Fallback (Days)
        let unitPrice = 0

        if (typeof agentPrices[cardType] === 'number') {
            unitPrice = agentPrices[cardType]
        } else if (typeof defaultPrices[cardType] === 'number') {
            unitPrice = defaultPrices[cardType]
        } else {
            unitPrice = days // Fallback to 1 point per day if not defined
            if (isExpansion) unitPrice = 10
        }

        const totalCost = unitPrice * count

        // Ensure non-negative
        if (totalCost < 0) {
            res.end(JSON.stringify({ ok: false, error: 'Price calculation error' }))
            return
        }

        if (agent.balance < totalCost) {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: `余额不足，需要 ${totalCost} 点，当前 ${agent.balance} 点` }))
            return
        }

        // Deduct balance
        await updateAgentBalance(agentId, -totalCost)
        creatorId = agentId
    }

    const db = loadCardDb()
    const cards: string[] = []

    for (let i = 0; i < count; i++) {
        const plain = generateCardPlain(isExpansion ? 'EXT' : 'FARM')
        db.cards.push({
            id: randomBytes(8).toString('hex'),
            hash: createHash('sha256').update(plain).digest('hex'),
            code: plain,
            status: 'active',
            cardType: cardType as any,
            expiresAt,
            maxActivations: 1, // Expansion cards are one-time use
            usedCount: 0,
            maxBindAccounts: maxBind, // For expansion, this is the amount to ADD
            boundUserId: undefined,
            boundAccountGids: [],
            lastUsedAt: undefined,
            note: note,
            creatorId,
        })
        cards.push(plain)
    }

    await saveCardDbAsync(db)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: { cards, card: cards[0], count } }))
}

export async function handleCardToggle(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (!session) {
        res.statusCode = 401
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
    }

    const body = await readBody(req)
    const id = String(body.id || '')
    const status = String(body.status || '')
    if (!id || !['active', 'disabled'].includes(status)) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'invalid params' }))
        return
    }

    const db = loadCardDb()
    const card = db.cards.find(c => c.id === id)
    if (!card) {
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'Card not found' }))
        return
    }

    // Permission Check
    if (session.role === 'agent' && card.creatorId !== session.id) {
        res.statusCode = 403
        res.end(JSON.stringify({ ok: false, error: 'Permission denied' }))
        return
    }

    card.status = status as any
    await saveCardDbAsync(db)

    if (status === 'disabled') {
        const bound = Array.isArray(card.boundAccountGids) ? card.boundAccountGids : []
        const targetIds: string[] = []
        for (const s of getSessions().values()) {
            const gid = Number(s.conn?.userState?.gid || 0)
            if (gid > 0 && bound.includes(gid)) {
                targetIds.push(s.id)
            }
        }
        for (const tid of targetIds) {
            pauseAccount(tid, 'Card Disabled by Admin')
        }
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
}

export async function handleCardUpdate(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (!session) {
        res.statusCode = 401
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
    }

    const body = await readBody(req)
    const id = String(body.id || '')
    const maxBindAccounts = Number(body.maxBindAccounts)
    const note = body.note // Allow note update

    if (!id) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'Missing ID' }))
        return
    }

    const db = loadCardDb()
    const card = db.cards.find(c => c.id === id)
    if (!card) {
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'Card not found' }))
        return
    }

    // Permission Check
    if (session.role === 'agent' && card.creatorId !== session.id) {
        res.statusCode = 403
        res.end(JSON.stringify({ ok: false, error: 'Permission denied' }))
        return
    }

    if (Number.isFinite(maxBindAccounts)) card.maxBindAccounts = maxBindAccounts
    if (typeof note === 'string') card.note = note
    await saveCardDbAsync(db)

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
}

export async function handleCardUnbind(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (!session) {
        res.statusCode = 401
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
    }

    const body = await readBody(req)
    const { cardId, accountGid } = body

    if (!cardId || !accountGid) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'missing params' }))
        return
    }

    const db = loadCardDb()
    const card = db.cards.find(c => c.id === cardId)
    if (!card) {
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'card not found' }))
        return
    }

    // Permission Check
    if (session.role === 'agent' && card.creatorId !== session.id) {
        res.statusCode = 403
        res.end(JSON.stringify({ ok: false, error: 'Permission denied' }))
        return
    }

    if (Array.isArray(card.boundAccountGids)) {
        card.boundAccountGids = card.boundAccountGids.filter(g => Number(g) !== Number(accountGid))
        await saveCardDbAsync(db)
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
}

export async function handleCardDelete(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (!session) {
        res.statusCode = 401
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
    }

    const body = await readBody(req)
    const id = String(body.id || '')
    if (!id) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'Missing card ID' }))
        return
    }

    const db = loadCardDb()
    const cardIndex = db.cards.findIndex(c => c.id === id)
    if (cardIndex === -1) {
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'Card not found' }))
        return
    }

    const card = db.cards[cardIndex]

    // Permission Check
    if (session.role === 'agent' && card.creatorId !== session.id) {
        res.statusCode = 403
        res.end(JSON.stringify({ ok: false, error: 'Permission denied' }))
        return
    }

    // Pause any bound sessions before deleting
    const bound = Array.isArray(card.boundAccountGids) ? card.boundAccountGids : []
    const targetIds: string[] = []
    for (const session of getSessions().values()) {
        const gid = Number(session.conn?.userState?.gid || 0)
        if (gid > 0 && bound.includes(gid)) {
            targetIds.push(session.id)
        }
    }
    for (const tid of targetIds) {
        pauseAccount(tid, 'Card Deleted by Admin')
    }

    // Remove card from DB
    db.cards.splice(cardIndex, 1)
    await saveCardDbAsync(db)

    // Also remove bound accounts from cache
    for (const gid of bound) {
        removeFromAccountCacheByGid(gid)
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
}
