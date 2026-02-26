import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { URL } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { resolveUploadRoot } from './utils.js'
import { config } from '../config/index.js'
import { handleAdminRequest } from './router.js'
import { buildAdminToken, verifyAdminToken, getAdminSession } from './auth.js'
import { getSessions, removeAccount, getSession } from '../core/account.js'
import { ProxyPool } from '../core/proxy-pool.js'
import { accountStore, getSessionStore } from '../store/index.js'
import { loadCardDb, saveCardDb, updateCard } from '../api/card-store.js'
import { loadSystemSettings, saveSystemSettings } from '../api/system-store.js'
import { Socks5Client } from '../utils/socks5.js'
import { log } from '../utils/logger.js'
import {
    type AccountCacheRow,
    loadAccountCache,
    saveAccountCache,
    updateAccountStat,
    incrementRuntime,
    removeFromAccountCacheByGid,
} from '../store/account-cache.js'
import { setLogBroadcastCallback, type LogEntry } from '../utils/logger.js'

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
}

type AdminAccountView = {
    id: string
    gid: number
    qqNumber?: string
    name: string
    platform: 'qq' | 'wx'
    level: number
    gold?: number
    exp?: number
    status: 'online' | 'offline'
    statusReason?: string
    runtimeSec: number
    proxy?: string
    latestLog?: string
    income?: {
        gold: number
        exp: number
    }
}

type AdminCardView = {
    id: string
    code: string
    type: string
    expiresAt?: number
    maxBind: number
    boundCount: number
    onlineCount: number
    status: 'active' | 'disabled'
    note?: string
    accounts: AdminAccountView[]
}

type ProxyHealthRow = {
    raw: string
    masked: string
    ok: boolean
    elapsedMs: number
    ip?: string
    error?: string
}

let server: http.Server | null = null
let wsServer: WebSocketServer | null = null
const adminClients = new Set<WebSocket>()
const ALERT_HISTORY_LIMIT = 500

type AdminAlertKind = 'disconnect' | 'remote_login' | 'reconnect_failed'
type AdminAlert = {
    id: string
    ts: number
    level: 'warn' | 'critical'
    kind: AdminAlertKind
    gid: number
    qqNumber?: string
    accountId: string
    accountName: string
    statusReason?: string
    message: string
}

let realtimeTimer: ReturnType<typeof setInterval> | null = null
let realtimeInited = false
let prevAccountState = new Map<string, { status: string; statusReason: string }>()
const alertHistory: AdminAlert[] = []



function maskProxyUrl(proxyUrl: string): string {
    try {
        const u = new URL(proxyUrl)
        if (u.password) u.password = '***'
        return u.toString()
    } catch {
        return String(proxyUrl || '').replace(/:([^:@/]+)@/g, ':***@')
    }
}

function runtimeSecFromStatusAt(statusAt?: number): number {
    if (!statusAt || statusAt <= 0) return 0
    return Math.max(0, Math.floor((Date.now() - statusAt) / 1000))
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

function normalizeLineBreaks(text: unknown): string {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\\n/g, '\n')
}

function cardTypeToDays(type: string, inputDays?: number): number {
    if (typeof inputDays === 'number' && Number.isFinite(inputDays) && inputDays > 0) return inputDays
    if (type === '测试卡') return 0.25
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

function inferCardType(card: any): string {
    if (card.cardType) return String(card.cardType)
    if (!card.expiresAt) return '永久卡'
    const leftDays = (Number(card.expiresAt) - Date.now()) / 86400000
    if (leftDays <= 0) return '已过期'
    if (leftDays <= 0.26) return '测试卡'
    if (leftDays <= 1.1) return '1天卡'
    if (leftDays <= 3.1) return '3天卡'
    if (leftDays <= 5.1) return '5天卡'
    if (leftDays <= 7.1) return '周卡'
    if (leftDays <= 31) return '月卡'
    return '月卡'
}

function generateCardPlain(prefix = 'FARM'): string {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`
}


function upsertAccountCacheFromStore(): Map<number, AccountCacheRow> {
    const db = loadAccountCache()
    const map = new Map<number, AccountCacheRow>()
    for (const row of db.rows) map.set(row.gid, row)

    const sessions = getSessions()

    for (const a of accountStore.getAccounts()) {
        const gid = Number(a.gid || 0)
        if (gid <= 0) continue

        // Get live stats from session if available
        const session = getSession(a.id)
        const userState = session?.conn?.userState
        const currentGold = userState?.gold || 0
        const currentExp = userState?.exp || 0

        const cur = map.get(gid)
        const row: AccountCacheRow = {
            gid,
            name: a.name || cur?.name || `GID:${gid}`,
            qqNumber: a.qqNumber || cur?.qqNumber || '',
            platform: a.platform || cur?.platform || 'qq',
            level: Number(a.level || cur?.level || 0),
            lastSeenAt: Date.now(),
            totalRuntimeSec: cur?.totalRuntimeSec || 0,
            baseGold: cur?.baseGold,
            baseExp: cur?.baseExp,
            gold: currentGold > 0 ? currentGold : cur?.gold, // Prefer live values
            exp: currentExp > 0 ? currentExp : cur?.exp,
        }

        // Initialize base values if this is the first time seeing actual values
        if (currentGold > 0 && typeof row.baseGold !== 'number') row.baseGold = currentGold
        if (currentExp > 0 && typeof row.baseExp !== 'number') row.baseExp = currentExp

        map.set(gid, row)
    }

    const rows = [...map.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 5000)
    saveAccountCache({ version: 1, rows })
    return new Map(rows.map((x) => [x.gid, x]))
}




function buildDashboardData() {
    const db = loadCardDb()
    const accounts = accountStore.getAccounts()
    const sessions = getSessions()
    const cacheByGid = upsertAccountCacheFromStore()

    const byGid = new Map<number, (typeof accounts)[number]>()
    for (const a of accounts) {
        const gid = Number(a.gid || 0)
        if (gid > 0) byGid.set(gid, a)
    }

    const onlineByGid = new Map<number, { proxy?: string }>()
    for (const s of sessions.values()) {
        const gid = Number(s.conn?.userState?.gid || 0)
        if (gid > 0) onlineByGid.set(gid, { proxy: maskProxyUrl(s.getProxyUrl() || '') })
    }

    const boundGidSet = new Set<number>()
    const cards: AdminCardView[] = db.cards.map((card) => {
        const gids = Array.isArray(card.boundAccountGids) ? card.boundAccountGids : []

        const accountRows: AdminAccountView[] = gids.map((gid: number) => {
            const nGid = Number(gid) || 0
            if (nGid > 0) boundGidSet.add(nGid)
            const found = byGid.get(nGid)
            const online = onlineByGid.has(nGid)

            const liveUser = found?.id ? getSessionStore(found.id)?.state?.user : null
            return {
                id: found?.id || `gid-${nGid}`,
                gid: nGid,
                qqNumber: found?.qqNumber || cacheByGid.get(nGid)?.qqNumber || '',
                name: found?.name || cacheByGid.get(nGid)?.name || `GID:${nGid}`,
                platform: found?.platform || cacheByGid.get(nGid)?.platform || 'qq',
                level: Number(found?.level || cacheByGid.get(nGid)?.level || 0),
                gold: typeof liveUser?.gold === 'number' ? Number(liveUser.gold) : undefined,
                exp: typeof liveUser?.exp === 'number' ? Number(liveUser.exp) : undefined,
                status: online ? 'online' : 'offline',
                statusReason: found?.statusReason || '',
                runtimeSec: runtimeSecFromStatusAt(found?.statusAt),
                proxy: onlineByGid.get(nGid)?.proxy || '',
                latestLog: latestLogByAccountId(found?.id),
                income: {
                    gold: Math.max(0, (typeof liveUser?.gold === 'number' ? Number(liveUser.gold) : 0) - (cacheByGid.get(nGid)?.baseGold || 0)),
                    exp: Math.max(0, (typeof liveUser?.exp === 'number' ? Number(liveUser.exp) : 0) - (cacheByGid.get(nGid)?.baseExp || 0)),
                }
            }
        })

        return {
            id: String(card.id || ''),
            code: String(card.code || card.note || ''),
            type: inferCardType(card),
            expiresAt: typeof card.expiresAt === 'number' ? card.expiresAt : undefined,
            maxBind: Number(card.maxBindAccounts || 1),
            boundCount: gids.length,
            onlineCount: accountRows.filter((x) => x.status === 'online').length,
            status: card.status === 'disabled' ? 'disabled' : 'active',
            note: typeof card.note === 'string' ? card.note : '',
            accounts: accountRows,
        }
    })

    const unboundAccounts: AdminAccountView[] = []
    const seenLoose = new Set<number>()
    for (const a of accounts) {
        const gid = Number(a.gid || 0)
        if (gid <= 0 || boundGidSet.has(gid)) continue
        seenLoose.add(gid)
        const online = onlineByGid.has(gid)
        const liveUser = getSessionStore(a.id)?.state?.user
        unboundAccounts.push({
            id: a.id,
            gid,
            qqNumber: a.qqNumber || cacheByGid.get(gid)?.qqNumber || '',
            name: a.name || cacheByGid.get(gid)?.name || `GID:${gid}`,
            platform: a.platform || cacheByGid.get(gid)?.platform || 'qq',
            level: Number(a.level || cacheByGid.get(gid)?.level || 0),
            gold: typeof liveUser?.gold === 'number' ? Number(liveUser.gold) : undefined,
            exp: typeof liveUser?.exp === 'number' ? Number(liveUser.exp) : undefined,
            status: online ? 'online' : 'offline',
            statusReason: a.statusReason || '',
            runtimeSec: runtimeSecFromStatusAt(a.statusAt),
            income: {
                gold: Math.max(0, (typeof liveUser?.gold === 'number' ? Number(liveUser.gold) : 0) - (cacheByGid.get(gid)?.baseGold || 0)),
                exp: Math.max(0, (typeof liveUser?.exp === 'number' ? Number(liveUser.exp) : 0) - (cacheByGid.get(gid)?.baseExp || 0)),
            },
            proxy: onlineByGid.get(gid)?.proxy || '',
            latestLog: latestLogByAccountId(a.id),
        })
    }
    for (const [gid, row] of cacheByGid) {
        if (seenLoose.has(gid) || boundGidSet.has(gid)) continue
        unboundAccounts.push({
            id: `cache-${gid}`,
            gid,
            qqNumber: row.qqNumber || '',
            name: row.name || `GID:${gid}`,
            platform: row.platform,
            level: Number(row.level || 0),
            status: onlineByGid.has(gid) ? 'online' : 'offline',
            statusReason: 'cached',
            runtimeSec: 0,
            proxy: onlineByGid.get(gid)?.proxy || '',
            latestLog: '',
        })
    }

    return {
        cards,
        totalSessions: sessions.size,
        unboundAccounts,
    }
}

function buildProxyData() {
    const pool = ProxyPool.getStatus()
    const configRows = ProxyPool.listForAdmin()
    const sessions = [...getSessions().values()].map((s) => {
        const gid = Number(s.conn?.userState?.gid || 0)
        const acc = accountStore.getAccounts().find((a) => a.id === s.id)
        return {
            id: s.id,
            gid,
            qqNumber: acc?.qqNumber || '',
            platform: acc?.platform || 'qq',
            name: s.conn?.userState?.name || acc?.name || s.id,
            proxy: maskProxyUrl(s.getProxyUrl() || ''),
            runtimeSec: runtimeSecFromStatusAt(acc?.statusAt),
            proxyDebug: s.conn.getProxyDebug?.() || null,
        }
    })
    return { pool, sessions, configRows }
}

async function probeProxyExit(proxyUrl: string, timeoutMs = 5000): Promise<{ ok: boolean; elapsedMs: number; ip?: string; error?: string }> {
    const startedAt = Date.now()
    try {
        const socket = await Socks5Client.connect(proxyUrl, { host: 'api.ipify.org', port: 80 }, { timeout: timeoutMs })
        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                socket.destroy()
                resolve({ ok: false, elapsedMs: Date.now() - startedAt, error: 'timeout' })
            }, timeoutMs)

            socket.once('error', (err) => {
                clearTimeout(timer)
                resolve({ ok: false, elapsedMs: Date.now() - startedAt, error: err?.message || 'socket_error' })
            })

            socket.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\nUser-Agent: FarmProxyDiag\r\n\r\n')

            let data = ''
            socket.on('data', (chunk) => {
                data += chunk.toString()
            })
            socket.on('end', () => {
                clearTimeout(timer)
                const body = data.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim()
                const ip = body.match(/\d{1,3}(?:\.\d{1,3}){3}/)?.[0]
                if (ip) resolve({ ok: true, elapsedMs: Date.now() - startedAt, ip })
                else resolve({ ok: false, elapsedMs: Date.now() - startedAt, error: 'invalid_response' })
            })
        })
    } catch (e: any) {
        return { ok: false, elapsedMs: Date.now() - startedAt, error: e?.message || 'connect_failed' }
    }
}

async function runProxyHealthCheck(timeoutMs = 5000): Promise<ProxyHealthRow[]> {
    const rows = ProxyPool.listForAdmin()
    const tasks = rows.map(async (row) => {
        const ret = await probeProxyExit(row.raw, timeoutMs)
        return {
            raw: row.raw,
            masked: row.masked,
            ok: ret.ok,
            elapsedMs: ret.elapsedMs,
            ip: ret.ip,
            error: ret.error,
        } satisfies ProxyHealthRow
    })
    return Promise.all(tasks)
}

function pushAlert(alert: AdminAlert): void {
    alertHistory.push(alert)
    if (alertHistory.length > ALERT_HISTORY_LIMIT) {
        alertHistory.splice(0, alertHistory.length - ALERT_HISTORY_LIMIT)
    }
}

function getAlertHistory(limit = 100): AdminAlert[] {
    const max = Math.min(Math.max(Number(limit) || 100, 1), ALERT_HISTORY_LIMIT)
    return alertHistory.slice(-max)
}

function getAllAccountsFromDashboard(data: { cards: AdminCardView[]; unboundAccounts: AdminAccountView[] }): AdminAccountView[] {
    const rows: AdminAccountView[] = []
    for (const card of data.cards || []) {
        for (const acc of card.accounts || []) rows.push(acc)
    }
    for (const acc of data.unboundAccounts || []) rows.push(acc)
    return rows
}

function accountIdText(acc: AdminAccountView): string {
    if (acc.platform === 'qq' && acc.qqNumber) return `QQ:${acc.qqNumber}`
    return `GID:${acc.gid}`
}

function makeAlert(kind: AdminAlertKind, acc: AdminAccountView): AdminAlert {
    const ts = Date.now()
    const level = kind === 'disconnect' ? 'warn' : 'critical'
    const idText = accountIdText(acc)
    const msg =
        kind === 'remote_login'
            ? `账号异地登录: ${acc.name} (${idText})`
            : kind === 'reconnect_failed'
                ? `账号重连失败: ${acc.name} (${idText})`
                : `账号断线: ${acc.name} (${idText})`
    return {
        id: `alt-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        ts,
        level,
        kind,
        gid: Number(acc.gid || 0),
        qqNumber: acc.qqNumber || '',
        accountId: String(acc.id || ''),
        accountName: String(acc.name || ''),
        statusReason: String(acc.statusReason || ''),
        message: msg,
    }
}

function detectAlerts(data: { cards: AdminCardView[]; unboundAccounts: AdminAccountView[] }): AdminAlert[] {
    const currMap = new Map<string, { status: string; statusReason: string; acc: AdminAccountView }>()
    const rows = getAllAccountsFromDashboard(data)
    for (const acc of rows) {
        const key = String(acc.id || `gid-${acc.gid}`)
        currMap.set(key, {
            status: String(acc.status || ''),
            statusReason: String(acc.statusReason || ''),
            acc,
        })
    }

    if (!realtimeInited) {
        prevAccountState = new Map([...currMap.entries()].map(([k, v]) => [k, { status: v.status, statusReason: v.statusReason }]))
        realtimeInited = true
        return []
    }

    const emitted: AdminAlert[] = []
    for (const [key, curr] of currMap) {
        const prev = prevAccountState.get(key)
        const reason = curr.statusReason.toLowerCase()

        const becameOffline = prev?.status === 'online' && curr.status === 'offline'
        const reasonChanged = prev?.statusReason !== curr.statusReason

        if ((reason.includes('remote_login') || reason.includes('other_login')) && reasonChanged) {
            emitted.push(makeAlert('remote_login', curr.acc))
        } else if ((reason.includes('reconnect_failed') || reason.includes('relogin_failed')) && reasonChanged) {
            emitted.push(makeAlert('reconnect_failed', curr.acc))
        } else if (becameOffline && !(reason.includes('remote_login') || reason.includes('reconnect_failed'))) {
            emitted.push(makeAlert('disconnect', curr.acc))
        }
    }

    prevAccountState = new Map([...currMap.entries()].map(([k, v]) => [k, { status: v.status, statusReason: v.statusReason }]))
    return emitted
}

function wsSend(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== ws.OPEN) return
    try {
        ws.send(JSON.stringify(payload))
    } catch { }
}

function wsBroadcast(payload: unknown): void {
    for (const ws of adminClients) wsSend(ws, payload)
}


function startRealtimeTicker(): void {
    if (realtimeTimer) return
    realtimeTimer = setInterval(() => {
        // 1. Increment runtime for online accounts
        const now = Date.now()
        const sessions = getSessions()
        for (const s of sessions.values()) {
            const gid = Number(s.conn?.userState?.gid || 0)
            if (gid > 0) {
                incrementRuntime(gid, 1)
            }
        }

        const dashboard = buildDashboardData()
        const proxy = buildProxyData()
        const newAlerts = detectAlerts(dashboard)
        for (const a of newAlerts) pushAlert(a)

        const history = getAlertHistory(200)
        wsBroadcast({ type: 'snapshot', ts: now, data: { dashboard, proxy, alerts: history } })
        for (const a of newAlerts) wsBroadcast({ type: 'alert', ts: now, data: a })
    }, 1000)
}

// ... (startAdminServer implementation is mostly same, just need to ensure correct imports)

export function startAdminServer(): void {
    if (server) return
    const port = config.adminPort || 2222

    server = http.createServer(async (req, res) => {
        // ... (rest of server setup)
        try {
            const url = new URL(req.url || '', `http://${req.headers.host}`)

            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

            if (req.method === 'OPTIONS') {
                res.statusCode = 204
                res.end()
                return
            }

            if (url.pathname.startsWith('/api/admin')) {
                await handleAdminRequest(req, res, url)
                return
            }

            // Static Files (管理端入口固定到 /admin，避免误落到用户端首页)
            if (url.pathname === '/') {
                res.statusCode = 302
                res.setHeader('Location', '/admin')
                res.end()
                return
            }

            const distRoot = resolveUploadRoot()
            const isAdminSpa = url.pathname === '/admin' || url.pathname.startsWith('/admin/')
            const isAssetPath = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/uploads/')
            const staticRelPath = isAdminSpa
                ? (url.pathname === '/admin' ? 'index.html' : url.pathname.replace(/^\/admin\//, ''))
                : url.pathname.slice(1)

            let filePath = join(distRoot, staticRelPath || 'index.html')
            if (!existsSync(filePath) && isAdminSpa) {
                // admin/dashboard 等前端路由统一回退到 index.html
                filePath = join(distRoot, 'index.html')
            }

            if (existsSync(filePath)) {
                const ext = extname(filePath)
                const mime = MIME_TYPES[ext] || 'application/octet-stream'
                res.writeHead(200, { 'Content-Type': mime })
                res.end(readFileSync(filePath))
                return
            }

            if (!isAdminSpa && !isAssetPath) {
                res.statusCode = 404
                res.end('Not Found')
                return
            }

            res.statusCode = 404
            res.end('Not Found')
        } catch (e: any) {
            log('Admin', `Request Error: ${e?.message}`)
            if (!res.headersSent) {
                res.statusCode = 500
                res.end(JSON.stringify({ ok: false, error: 'Internal Server Error' }))
            }
        }
    })
    wsServer = new WebSocketServer({ server, path: '/ws' })
    wsServer.on('connection', (ws) => {
        ws.on('error', () => { })
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString())
                if (msg.type === 'auth') {
                    const token = String(msg.token || '')
                    if (verifyAdminToken(token)) {
                        ; (ws as any).data = { authed: true }
                        adminClients.add(ws)
                        ws.send(JSON.stringify({ type: 'auth_ok' }))

                        // Send initial snapshot
                        const dashboard = buildDashboardData()
                        const proxy = buildProxyData()
                        const alerts = getAlertHistory(200)
                        ws.send(JSON.stringify({ type: 'snapshot', ts: Date.now(), data: { dashboard, proxy, alerts } }))
                    } else {
                        ws.send(JSON.stringify({ type: 'auth_fail' }))
                        ws.close()
                    }
                    return
                }

                if (msg.type === 'sub_log') {
                    if (!(ws as any).data?.authed) return
                        ; (ws as any).data.subLog = true
                    return
                }
            } catch { }
        })

        ws.on('close', () => {
            adminClients.delete(ws)
        })
    })

    server.listen(port, '0.0.0.0', () => {
        log('Admin', `管理后台已启动 http://0.0.0.0:${port}/admin`)
        startRealtimeTicker()
    })
}

// ...





function wsBroadcastLog(entry: LogEntry) {
    const str = JSON.stringify({ type: 'log', data: entry })
    for (const ws of adminClients) {
        if (ws.readyState === WebSocket.OPEN && (ws as any).data?.subLog) {
            ws.send(str)
        }
    }
}

setLogBroadcastCallback(wsBroadcastLog)
