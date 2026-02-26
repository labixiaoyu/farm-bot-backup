
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { readBody } from '../utils.js'
import { AuthSession } from '../auth.js'
import { getAgentById, createAgent, updateAgentBalance, updateAgentPassword, getAllAgents, Agent } from '../../api/agent-store.js'

export async function handleAgentList(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (!session || session.role !== 'author') {
        res.statusCode = 403
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }))
        return
    }

    const agents = await getAllAgents()
    // Hide passwordHash
    const safeAgents = agents.map(a => {
        const { passwordHash, ...rest } = a
        return rest
    })

    res.end(JSON.stringify({ ok: true, data: safeAgents }))
}

export async function handleAgentCreate(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (!session || session.role !== 'author') {
        res.statusCode = 403
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }))
        return
    }

    const body = await readBody(req)
    const { username, password, remark } = body as any

    if (!username || !password) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'Missing username or password' }))
        return
    }

    const existing = await getAllAgents()
    if (existing.find(a => a.username === username)) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'Username already exists' }))
        return
    }

    const { customPrices, allowedCardTypes, balance } = body as any
    const agent = await createAgent(username, password, remark)

    // Update additional fields if provided
    if (customPrices || allowedCardTypes) {
        await import('../../api/agent-store.js').then(m => m.updateAgentProfile(agent.id, { customPrices, allowedCardTypes }))
    }

    if (balance && typeof balance === 'number') {
        await updateAgentBalance(agent.id, balance)
    }

    res.end(JSON.stringify({ ok: true, data: { id: agent.id } }))
}

export async function handleAgentUpdate(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (!session || session.role !== 'author') {
        res.statusCode = 403
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }))
        return
    }

    const body = await readBody(req)
    const { id, type, value, ...rest } = body as any

    const agent = await getAgentById(id)
    if (!agent) {
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'Agent not found' }))
        return
    }

    try {
        const { updateAgentProfile } = await import('../../api/agent-store.js')

        if (type === 'recharge') {
            const amount = Number(value)
            if (isNaN(amount)) throw new Error('Invalid amount')
            await updateAgentBalance(id, amount)
        } else if (type === 'password') {
            if (!value) throw new Error('Invalid password')
            await updateAgentPassword(id, String(value))
        } else if (type === 'remark') {
            await updateAgentProfile(id, { remark: String(value) })
        } else if (type === 'profile') {
            // Generic profile update (prices, allowed types)
            // Expect value to be an object with { customPrices, allowedCardTypes }
            // Or just use rest params if structured that way.
            // Let's assume 'value' contains the partial object or use spread.
            await updateAgentProfile(id, value)
        } else {
            throw new Error('Unknown update type')
        }

        res.end(JSON.stringify({ ok: true }))
    } catch (e: any) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: e.message }))
    }
}
