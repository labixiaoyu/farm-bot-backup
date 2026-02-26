import { WebSocketServer, type WebSocket } from 'ws'
import { buildDashboardData, buildProxyData, getAllAccountsFromDashboard, type AdminAccountView, type AdminCardView } from './controllers/dashboard.js'
import type { IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import { buildAdminToken } from './auth.js'

const adminClients = new Set<WebSocket>()
const ALERT_HISTORY_LIMIT = 500

type AdminAlertKind = 'disconnect' | 'remote_login' | 'reconnect_failed'
type AdminAlert = {
    id: string
    ts: number
    level: 'warn' | 'critical'
    kind: AdminAlertKind
    gid: number
    accountId: string
    accountName: string
    statusReason?: string
    message: string
}

let realtimeTimer: ReturnType<typeof setInterval> | null = null
let realtimeInited = false
let prevAccountState = new Map<string, { status: string; statusReason: string }>()
const alertHistory: AdminAlert[] = []

function pushAlert(alert: AdminAlert): void {
    alertHistory.push(alert)
    if (alertHistory.length > ALERT_HISTORY_LIMIT) {
        alertHistory.splice(0, alertHistory.length - ALERT_HISTORY_LIMIT)
    }
}

export function getAlertHistory(limit = 100): AdminAlert[] {
    const max = Math.min(Math.max(Number(limit) || 100, 1), ALERT_HISTORY_LIMIT)
    return alertHistory.slice(-max)
}

function makeAlert(kind: AdminAlertKind, acc: AdminAccountView): AdminAlert {
    const ts = Date.now()
    const level = kind === 'disconnect' ? 'warn' : 'critical'
    const msg =
        kind === 'remote_login'
            ? `账号异地登录: ${acc.name} (GID:${acc.gid})`
            : kind === 'reconnect_failed'
                ? `账号重连失败: ${acc.name} (GID:${acc.gid})`
                : `账号断线: ${acc.name} (GID:${acc.gid})`
    return {
        id: `alt-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        ts,
        level,
        kind,
        gid: Number(acc.gid || 0),
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
        const dashboard = buildDashboardData()
        const proxy = buildProxyData()
        const newAlerts = detectAlerts(dashboard)
        for (const a of newAlerts) pushAlert(a)

        const history = getAlertHistory(200)
        wsBroadcast({ type: 'snapshot', ts: Date.now(), data: { dashboard, proxy, alerts: history } })
        for (const a of newAlerts) wsBroadcast({ type: 'alert', ts: Date.now(), data: a })
    }, 1000)
}

// Phase 2: WebTerminal
// We will modify handleUpgrade to accept /ws/terminal connection
// and bind it to a specific account's logger.

export let wsServer: WebSocketServer | null = null

export function initWebSocket() {
    wsServer = new WebSocketServer({ noServer: true })
    startRealtimeTicker()
    return wsServer
}

export function handleUpgrade(req: IncomingMessage, socket: any, head: any) {
    try {
        const base = `http://${req.headers.host || '127.0.0.1'}`
        const u = new URL(req.url || '', base)

        const token = String(u.searchParams.get('token') || '')
        if (!token || token !== buildAdminToken()) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
            socket.destroy()
            return
        }

        if (u.pathname === '/ws/admin') {
            wsServer?.handleUpgrade(req, socket, head, (ws) => {
                adminClients.add(ws)
                ws.on('close', () => {
                    adminClients.delete(ws)
                })
                // Initial snapshot
                wsSend(ws, {
                    type: 'snapshot',
                    ts: Date.now(),
                    data: {
                        dashboard: buildDashboardData(),
                        proxy: buildProxyData(),
                        alerts: getAlertHistory(200),
                    },
                })
            })
            return
        }

        // Phase 2: Terminal
        if (u.pathname === '/ws/terminal') {
            // TODO: Implement terminal logic
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
            socket.destroy()
            return
        }

        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
    } catch {
        socket.destroy()
    }
}
