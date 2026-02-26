import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody } from '../utils.js'
import { getSessions, removeAccount } from '../../core/account.js'
import { loadCardDb, saveCardDbAsync } from '../../api/card-store.js'
import { removeFromAccountCacheByGid } from './dashboard.js'
import { accountStore } from '../../store/index.js'

export async function handleAccountStop(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req)
    const id = String(body.id || '')
    const s = getSessions().get(id)
    if (s) {
        s.stop()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
    } else {
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
    }
}

export async function handleAccountRemove(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req)
    const id = String(body.id || '')
    if (!id) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'Missing account id' }))
        return
    }

    const account = accountStore.getAccounts().find((a) => a.id === id)
    const gid = Number(account?.gid || 0)

    // Remove running session + account store entry.
    removeAccount(id)

    // Unbind this gid from all cards so user can rebind correctly.
    if (gid > 0) {
        const db = loadCardDb()
        let changed = false
        for (const card of db.cards) {
            if (!Array.isArray(card.boundAccountGids)) continue
            const next = card.boundAccountGids.filter((x) => Number(x || 0) !== gid)
            if (next.length !== card.boundAccountGids.length) {
                card.boundAccountGids = next
                changed = true
            }
        }
        if (changed) await saveCardDbAsync(db)
        removeFromAccountCacheByGid(gid)
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
}
