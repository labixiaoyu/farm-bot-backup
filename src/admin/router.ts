import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import { config } from '../config/index.js'
import { readBody } from './utils.js'
import { checkRateLimit, randomDelay } from '../utils/rate-limit.js'
import { createAdminSession, verifyAdminToken } from './auth.js'
import { getAgentByUsername, verifyAgentPassword } from '../api/agent-store.js'
import { buildDashboardData } from './controllers/dashboard.js'
import { handleProxyGet, handleProxyHealth } from './controllers/proxy.js'
import { getAlertHistory } from './websocket.js'
import { handleCardGenerate, handleCardToggle, handleCardUpdate, handleCardUnbind, handleCardDelete } from './controllers/card.js'
import { handleAccountStop, handleAccountRemove } from './controllers/account.js'
import { handleSettingsGet, handleSettingsPost, handleUpload, handleBackup, handleAnnouncementPost } from './controllers/system.js'
import { handleLeaderboard } from './controllers/leaderboard.js'
import { handleAgentList, handleAgentCreate, handleAgentUpdate } from './controllers/agent.js'

function requireAuthor(res: ServerResponse, session?: { role: string }) {
    if (session?.role !== 'author') {
        res.statusCode = 403
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'Permission denied: Author only' }))
        return false
    }
    return true
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname.replace('/api/admin', '')
    console.log(`[Admin Request] method=${req.method} url=${req.url} path=${path} bodyLen=${req.headers['content-length']}`)

    if (path === '/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || 'unknown'
        const limit = checkRateLimit(`admin_login:${ip}`, 5, 60000)

        if (limit.limitReached) {
            res.statusCode = 429
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: `Too many attempts. Retry in ${Math.ceil((limit.resetTime - Date.now()) / 1000)}s` }))
            return
        }

        const body = await readBody(req)

        // 1. Try Author Login (admin / env password)
        // Support old style { password } or new style { username: 'admin', password }
        const isAuthor = (body.username === 'admin' || !body.username) && body.password === config.adminPassword

        if (isAuthor) {
            const token = createAdminSession('author', 'admin', 'Super Admin')
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, token, role: 'author' }))
            return
        }

        // 2. Try Agent Login
        if (body.username && body.username !== 'admin') {
            const agent = await getAgentByUsername(body.username)
            if (agent && agent.status === 'active' && verifyAgentPassword(agent, body.password)) {
                const token = createAdminSession('agent', agent.id, agent.username)
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: true, token, role: 'agent' }))
                return
            }
        }

        // Failed
        await randomDelay(1000, 3000)
        console.log(`[Login Failed] User: "${body.username || 'admin'}" IP: ${ip}`)
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'Auth failed' }))
        return
    }

    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.replace('Bearer ', '')
    const session = verifyAdminToken(token)

    if (!session) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
    }

    // Inject session into request for controllers (optional, or pass as arg)
    // For now, we just validated the token.
    // TODO: Pass session to controllers.

    // Dashboard
    if (path === '/dashboard' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        const data = await buildDashboardData(session)
        res.end(JSON.stringify({ ok: true, data }))
        return
    }

    if (path === '/leaderboard' && req.method === 'GET') {
        await handleLeaderboard(req, res, session)
        return
    }

    if (path === '/proxy' && req.method === 'GET') {
        if (!requireAuthor(res, session)) return
        await handleProxyGet(req, res)
        return
    }

    if (path === '/proxy/health' && req.method === 'POST') {
        if (!requireAuthor(res, session)) return
        await handleProxyHealth(req, res)
        return
    }

    if (path === '/alerts' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, data: { alerts: getAlertHistory(200) } }))
        return
    }

    // Card
    if (path === '/card/generate' && req.method === 'POST') return handleCardGenerate(req, res, session)
    if (path === '/card/toggle' && req.method === 'POST') return handleCardToggle(req, res, session)
    if (path === '/card/update' && req.method === 'POST') return handleCardUpdate(req, res, session)
    if (path === '/card/unbind' && req.method === 'POST') return handleCardUnbind(req, res, session)
    if (path === '/card/delete' && req.method === 'POST') return handleCardDelete(req, res, session)

    // Account
    if (path === '/account/stop' && req.method === 'POST') return handleAccountStop(req, res)
    if (path === '/account/remove' && req.method === 'POST') return handleAccountRemove(req, res)

    // Agent Management (Author only)
    if (path === '/agent/list' && req.method === 'GET') {
        if (!requireAuthor(res, session)) return
        await handleAgentList(req, res, session)
        return
    }

    if (path === '/agent/create' && req.method === 'POST') {
        if (!requireAuthor(res, session)) return
        await handleAgentCreate(req, res, session)
        return
    }

    if (path === '/agent/update' && req.method === 'POST') {
        if (!requireAuthor(res, session)) return
        await handleAgentUpdate(req, res, session)
        return
    }

    // System
    if (path === '/settings' && req.method === 'GET') {
        if (!requireAuthor(res, session)) return
        await handleSettingsGet(req, res)
        return
    }

    if (path === '/settings' && req.method === 'POST') {
        if (!requireAuthor(res, session)) return
        await handleSettingsPost(req, res)
        return
    }

    if (path === '/upload' && req.method === 'POST') {
        if (!requireAuthor(res, session)) return
        await handleUpload(req, res)
        return
    }

    if (path === '/backup' && req.method === 'GET') {
        if (!requireAuthor(res, session)) return
        await handleBackup(req, res)
        return
    }

    if (path === '/announcement' && req.method === 'POST') {
        if (!requireAuthor(res, session)) return
        await handleAnnouncementPost(req, res)
        return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error: 'API not found' }))
}
