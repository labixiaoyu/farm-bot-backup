import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessions } from '../../core/account.js'
import { accountStore, getSessionStore } from '../../store/index.js'
import { loadCardDb } from '../../api/card-store.js'
import { ProxyPool } from '../../core/proxy-pool.js'
import { getLevelExpProgress } from '../../config/game-data.js'
import { AuthSession } from '../auth.js'
import { getAgentById } from '../../api/agent-store.js'

export const ADMIN_ACCOUNT_CACHE_FILE = join(process.cwd(), '.admin-account-cache.json')

export type AdminAccountView = {
    id: string
    gid: number
    name: string
    platform: 'qq' | 'wx'
    level: number
    status: 'online' | 'offline'
    statusReason?: string
    runtimeSec: number
    proxy?: string
    latestLog?: string
    recentLogs?: string[]
    baseGold?: number
    baseExp?: number
    gold?: number
    exp?: number
    qqNumber?: string
    income?: {
        gold: number
        exp: number
    }
    levelUpEtaSec?: number
}

export type AdminCardView = {
    id: string
    code: string
    type: string
    expiresAt?: number
    maxBind: number
    boundUserId?: string
    boundCount: number
    onlineCount: number
    status: 'active' | 'disabled'
    statusText: string
    note?: string
    accounts: AdminAccountView[]
    creatorId?: string
}

type AccountCacheRow = {
    gid: number
    name: string
    platform: 'qq' | 'wx'
    level: number
    lastSeenAt: number
    proxy?: string
    totalRuntime?: number
    baseGold?: number
    baseExp?: number
    qqNumber?: string
}

type AccountCacheDb = {
    version: 1
    rows: AccountCacheRow[]
}

function loadAccountCache(): AccountCacheDb {
    if (!existsSync(ADMIN_ACCOUNT_CACHE_FILE)) return { version: 1, rows: [] }
    try {
        const raw = JSON.parse(readFileSync(ADMIN_ACCOUNT_CACHE_FILE, 'utf8'))
        const rows = Array.isArray(raw?.rows) ? raw.rows : []
        return {
            version: 1,
            rows: rows
                .map((x: any) => ({
                    gid: Number(x?.gid || 0),
                    name: String(x?.name || ''),
                    platform: x?.platform === 'wx' ? 'wx' : 'qq',
                    level: Number(x?.level || 0),
                    lastSeenAt: Number(x?.lastSeenAt || 0),
                    proxy: x?.proxy || undefined,
                    totalRuntime: Number(x?.totalRuntime || 0),
                    baseGold: x?.baseGold ? Number(x.baseGold) : undefined,
                    baseExp: x?.baseExp ? Number(x.baseExp) : undefined,
                    qqNumber: x?.qqNumber ? String(x.qqNumber) : undefined,
                }))
                .filter((x: AccountCacheRow) => x.gid > 0),
        }
    } catch {
        return { version: 1, rows: [] }
    }
}

function saveAccountCache(db: AccountCacheDb): void {
    writeFileSync(ADMIN_ACCOUNT_CACHE_FILE, JSON.stringify(db, null, 2), 'utf8')
}

export function removeFromAccountCacheByGid(gid: number): void {
    const nGid = Number(gid || 0)
    if (nGid <= 0) return
    const db = loadAccountCache()
    const next = db.rows.filter((x) => Number(x.gid || 0) !== nGid)
    if (next.length !== db.rows.length) {
        saveAccountCache({ version: 1, rows: next })
    }
}

function upsertAccountCacheFromStore(): Map<number, AccountCacheRow> {
    const db = loadAccountCache()
    const map = new Map<number, AccountCacheRow>()
    for (const row of db.rows) map.set(row.gid, row)
    for (const a of accountStore.getAccounts()) {
        const gid = Number(a.gid || 0)
        if (gid <= 0) continue
        const cur = map.get(gid)
        map.set(gid, {
            gid,
            name: a.name || cur?.name || `GID:${gid}`,
            platform: a.platform || cur?.platform || 'qq',
            qqNumber: a.qqNumber || cur?.qqNumber || '',
            level: Number(a.level || cur?.level || 0),
            lastSeenAt: Date.now(),
            proxy: a.proxy || cur?.proxy || undefined,
            totalRuntime: a.totalRuntime || cur?.totalRuntime || 0,
            baseGold: cur?.baseGold, // We should essentially update this if we want to track 'session' gain, or keep it if we want 'daily' gain? 
            // For now, let's just persist what was there, or maybe we should initialize it?
            // Actually, the main.py logic initializes base on first see.
            // Here we might just want to store the snapshot.
            // Let's copy from current if exists using cur?.baseGold
            // But wait, if we want to calculate gain, we need a 'start' value.
            // If the backend restarts, we lose the in-memory 'gain base'.
            // If we want persistence of gain base, we need to specific logic.
            // For now, to satisfy the type error and minimal functionality:
            baseExp: cur?.baseExp,
        })
    }
    const rows = [...map.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 5000)
    saveAccountCache({ version: 1, rows })
    return new Map(rows.map((x) => [x.gid, x]))
}

function maskProxyUrl(proxyUrl: string): string {
    try {
        const u = new URL(proxyUrl)
        if (u.password) u.password = '***'
        return u.toString()
    } catch {
        return String(proxyUrl || '').replace(/:([^:@/]+)@/g, ':***@')
    }
}

function runtimeSecFromStatusAt(statusAt?: number, totalRuntime?: number): number {
    const base = totalRuntime || 0
    if (!statusAt || statusAt <= 0) return base
    // 如果 statusAt 存在（说明当前状态可能是 online/connecting/offline），
    // 但通常只有 online 状态下 statusAt 才表示“开始运行时间”。
    // 这里调用通过 Context 判断。
    // 在 buildDashboardData 中，account.statusAt 只有在 online 时才有意义用于计算增量，
    // 或者说，如果 account 是 online，则 runtime = total + (now - statusAt)。
    // 如果 account 是 offline，runtime = total。
    // 但是 accountStore.updateAccount 会在 status 变更时更新 statusAt。
    // 逻辑：
    // - online: total + (now - statusAt)
    // - offline/connecting/error: total (因为 accumulatedRuntime 已经更新了 total)
    // 
    // 这里的 helper 只是负责计算 (now - statusAt)，不应该负责判断 status。
    // 调用者负责传入 (now - statusAt) 只有在 online 时。
    // 
    // 让我们可以简化：
    // 如果传入了 statusAt 且 > 0，且我们假设调用者只在 online 时传入 statusAt？
    // 不，调用者传入 found?.statusAt。
    // 我们需要 status 来判断。
    // 让我们修改签名： runtimeSecFromAccount(account: AccountInfo | undefined)
    return base + Math.max(0, Math.floor((Date.now() - statusAt) / 1000))
}

function calculateRuntime(a: { status?: string, statusAt?: number, totalRuntime?: number } | undefined, fromCache?: AccountCacheRow): number {
    const base = (a?.totalRuntime || 0) > (fromCache?.totalRuntime || 0) ? (a?.totalRuntime || 0) : (fromCache?.totalRuntime || 0)
    if (a?.status === 'online' && a.statusAt && a.statusAt > 0) {
        return base + Math.max(0, Math.floor((Date.now() - a.statusAt) / 1000))
    }
    return base
}

function latestLogByAccountId(accountId?: string): string {
    if (!accountId) return ''
    try {
        const store = getSessionStore(accountId)
        const rows = store?.state?.logs || []
        const last = rows.length > 0 ? rows[rows.length - 1] : null
        if (!last) return ''
        const tag = String(last.tag || '')
        const msg = String(last.message || '')
        return tag ? `[${tag}] ${msg}` : msg
    } catch {
        return ''
    }
}

function recentLogsByAccountId(accountId?: string, count: number = 5): string[] {
    if (!accountId) return []
    try {
        const store = getSessionStore(accountId)
        const rows = store?.state?.logs || []
        return rows.slice(-count).map(last => {
            const tag = String(last.tag || '')
            const msg = String(last.message || '')
            return tag ? `[${tag}] ${msg}` : msg
        })
    } catch {
        return []
    }
}

function inferCardType(card: any): string {
    if (card.cardType) return String(card.cardType)
    if (!card.expiresAt) return '永久卡'
    const leftDays = Math.max(0, Math.ceil((Number(card.expiresAt) - Date.now()) / 86400000))
    if (leftDays <= 1) return '1天卡'
    if (leftDays <= 3) return '3天卡'
    if (leftDays <= 5) return '5天卡'
    if (leftDays <= 7) return '周卡'
    if (leftDays <= 31) return '月卡'
    return '月卡'
}

export async function buildDashboardData(session?: AuthSession) {
    const db = loadCardDb()
    const accounts = accountStore.getAccounts()
    const sessions = getSessions()
    const cacheByGid = upsertAccountCacheFromStore()

    let agentBalance = 0
    let filteredCards = db.cards

    // Filter for Agent
    if (session?.role === 'agent') {
        const agent = await getAgentById(session.id)
        agentBalance = agent?.balance || 0
        filteredCards = db.cards.filter(c => c.creatorId === session.id)
    }

    const byGid = new Map<number, (typeof accounts)[number]>()
    for (const a of accounts) {
        const gid = Number(a.gid || 0)
        if (gid > 0) byGid.set(gid, a)
    }

    const onlineByGid = new Map<number, { proxy?: string, qqNumber?: string }>()
    for (const s of sessions.values()) {
        const gid = Number(s.conn?.userState?.gid || 0)
        const uin = String(s.conn?.userState?.uin || '')
        if (gid > 0) onlineByGid.set(gid, { proxy: maskProxyUrl(s.getProxyUrl() || ''), qqNumber: uin })
    }

    const boundGidSet = new Set<number>()
    const cards: AdminCardView[] = filteredCards.map((card) => {
        const gids = Array.isArray(card.boundAccountGids) ? card.boundAccountGids : []

        const accountRows: AdminAccountView[] = gids.map((gid: number) => {
            const nGid = Number(gid) || 0
            if (nGid > 0) boundGidSet.add(nGid)
            const found = byGid.get(nGid)
            const online = onlineByGid.has(nGid)
            const cache = cacheByGid.get(nGid)
            const liveUser = found?.id ? getSessionStore(found.id)?.state?.user : null
            const runtime = calculateRuntime(found, cache)
            const incomeExp = Math.max(0, (typeof liveUser?.exp === 'number' ? Number(liveUser.exp) : 0) - (cache?.baseExp || 0))

            let eta = 0
            if (runtime > 60 && incomeExp > 0) { // Require at least 1 min runtime to calc rate
                const rate = incomeExp / runtime
                const { needed } = getLevelExpProgress(Number(found?.level || cache?.level || 0), Number(liveUser?.exp || cache?.baseExp || 0))
                if (rate > 0 && needed > 0) {
                    eta = Math.floor(needed / rate)
                }
            }

            return {
                id: found?.id || `gid-${nGid}`,
                gid: nGid,
                name: found?.name || cache?.name || `GID:${nGid}`,
                platform: found?.platform || cache?.platform || 'qq',
                level: Number(found?.level || cache?.level || 0),
                status: online ? 'online' : 'offline',
                statusReason: found?.statusReason || '',
                runtimeSec: runtime,
                proxy: onlineByGid.get(nGid)?.proxy || found?.proxy || cache?.proxy || '',
                latestLog: latestLogByAccountId(found?.id),
                recentLogs: recentLogsByAccountId(found?.id, 5),
                baseExp: cache?.baseExp,
                qqNumber: found?.qqNumber || cache?.qqNumber || onlineByGid.get(nGid)?.qqNumber || '',
                income: {
                    gold: Math.max(0, (typeof liveUser?.gold === 'number' ? Number(liveUser.gold) : 0) - (cache?.baseGold || 0)),
                    exp: incomeExp,
                },
                levelUpEtaSec: eta,
            }
        })

        let displayStatus = '未激活'
        const hasBoundAccounts = gids.length > 0
        if (card.status === 'disabled') displayStatus = '已禁用'
        else if (typeof card.expiresAt === 'number' && Date.now() > card.expiresAt) displayStatus = '已过期'
        else if (card.boundUserId || hasBoundAccounts) displayStatus = '已激活'

        return {
            id: String(card.id || ''),
            code: String(card.code || ''),
            type: inferCardType(card),
            expiresAt: typeof card.expiresAt === 'number' ? card.expiresAt : undefined,
            maxBind: Number(card.maxBindAccounts || 1),
            boundUserId: card.boundUserId || '',
            boundCount: gids.length,
            onlineCount: accountRows.filter((x) => x.status === 'online').length,
            status: card.status === 'disabled' ? 'disabled' : 'active',
            statusText: displayStatus,
            note: typeof card.note === 'string' ? card.note : '',
            accounts: accountRows,
            creatorId: card.creatorId,
        }
    })

    const unboundAccounts: AdminAccountView[] = []

    // Only show unbound accounts to Author, or if the agent somehow has access?
    // Agents generally only see accounts bound to their cards.
    // So unboundAccounts should probably be filtered out for Agents unless they bound it?
    // But unbound means "not bound to any card". Agents shouldn't see these.

    if (session?.role !== 'agent') {
        const seenLoose = new Set<number>()
        for (const a of accounts) {
            const gid = Number(a.gid || 0)
            if (gid <= 0 || boundGidSet.has(gid)) continue
            seenLoose.add(gid)
            const online = onlineByGid.has(gid)
            const cache = cacheByGid.get(gid)
            const liveUser = getSessionStore(a.id)?.state?.user

            unboundAccounts.push({
                id: a.id,
                gid,
                name: a.name || cache?.name || `GID:${gid}`,
                platform: a.platform || cache?.platform || 'qq',
                qqNumber: a.qqNumber || cache?.qqNumber || onlineByGid.get(gid)?.qqNumber || '',
                level: Number(a.level || cache?.level || 0),
                status: online ? 'online' : 'offline',
                statusReason: a.statusReason || '',
                runtimeSec: calculateRuntime(a, cache),
                proxy: onlineByGid.get(gid)?.proxy || '',
                latestLog: latestLogByAccountId(a.id),
                recentLogs: recentLogsByAccountId(a.id, 5),
                baseGold: cache?.baseGold,
                baseExp: cache?.baseExp,
                income: {
                    gold: Math.max(0, (typeof liveUser?.gold === 'number' ? Number(liveUser.gold) : 0) - (cache?.baseGold || 0)),
                    exp: Math.max(0, (typeof liveUser?.exp === 'number' ? Number(liveUser.exp) : 0) - (cache?.baseExp || 0)),
                }
            })
        }
        for (const [gid, row] of cacheByGid) {
            if (seenLoose.has(gid) || boundGidSet.has(gid)) continue
            unboundAccounts.push({
                id: `cache-${gid}`,
                gid,
                name: row.name || `GID:${gid}`,
                platform: row.platform,
                qqNumber: row.qqNumber || onlineByGid.get(gid)?.qqNumber || '',
                level: Number(row.level || 0),
                status: onlineByGid.has(gid) ? 'online' : 'offline',
                statusReason: 'cached',
                runtimeSec: calculateRuntime(undefined, row),
                proxy: onlineByGid.get(gid)?.proxy || '',
                latestLog: '',
                income: { gold: 0, exp: 0 }
            })
        }
    }

    let totalSessions = sessions.size
    if (session?.role === 'agent') {
        totalSessions = cards.reduce((sum, c) => sum + c.onlineCount, 0)
    }

    return {
        cards,
        totalSessions,
        unboundAccounts,
        agentBalance,
        role: session?.role || 'author',
        id: session?.id || '',
    }
}

export function buildProxyData() {
    const pool = ProxyPool.getStatus()
    const sessions = [...getSessions().values()].map((s) => {
        const gid = Number(s.conn?.userState?.gid || 0)
        const acc = accountStore.getAccounts().find((a) => a.id === s.id)
        return {
            id: s.id,
            gid,
            name: s.conn?.userState?.name || acc?.name || s.id,
            proxy: maskProxyUrl(s.getProxyUrl() || ''),
            runtimeSec: calculateRuntime(acc),
            proxyDebug: s.conn.getProxyDebug?.() || null,
        }
    })
    return { pool, sessions }
}

export function getAllAccountsFromDashboard(data: { cards: AdminCardView[]; unboundAccounts: AdminAccountView[] }): AdminAccountView[] {
    const rows: AdminAccountView[] = []
    for (const card of data.cards || []) {
        for (const acc of card.accounts || []) rows.push(acc)
    }
    for (const acc of data.unboundAccounts || []) rows.push(acc)
    return rows
}
