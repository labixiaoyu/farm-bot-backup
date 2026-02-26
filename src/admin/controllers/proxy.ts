import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildProxyData } from './dashboard.js'
import { ProxyPool } from '../../core/proxy-pool.js'
import { probeExitIpViaSocks5 } from '../../utils/proxy-probe.js'
import { readBody } from '../utils.js'

export async function handleProxyGet(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: buildProxyData() }))
}

export async function handleProxyHealth(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req)
    const { timeoutMs = 5000 } = body ?? {}
    const proxies = ProxyPool.getProxyUrls()
    const results: any[] = []

    const BATCH_SIZE = 5
    for (let i = 0; i < proxies.length; i += BATCH_SIZE) {
        const chunk = proxies.slice(i, i + BATCH_SIZE)
        const promises = chunk.map(async (url) => {
            const res = await probeExitIpViaSocks5(url, timeoutMs / 1000)
            if (res.ok) {
                ProxyPool.markSuccess(url, res.elapsedMs)
            } else {
                ProxyPool.markFailed(url)
            }
            return { raw: url, ...res }
        })
        results.push(...(await Promise.all(promises)))
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: { rows: results, checkedAt: Date.now() } }))
}
