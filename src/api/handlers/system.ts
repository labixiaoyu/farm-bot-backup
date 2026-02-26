import { connect as tlsConnect } from 'node:tls'
import { getAllPlants } from '../../config/game-data.js'
import { config, versionData } from '../../config/index.js'
import { getSessions } from '../../core/account.js'
import { ProxyPool } from '../../core/proxy-pool.js'
import { accountStore, getSessionStore } from '../../store/index.js'
import { getLogCount, getRecentLogs } from '../../utils/logger.js'


import { Socks5Client } from '../../utils/socks5.js'
import { probeExitIpViaSocks5 } from '../../utils/proxy-probe.js'


export async function handleSystemLogs(body: any): Promise<Response> {
  const { limit = 50, offset = 0, accountId } = body ?? {}

  if (accountId) {
    const store = getSessionStore(accountId)
    const all = store.state.logs || []
    const end = Math.max(0, all.length - Number(offset || 0))
    const start = Math.max(0, end - Number(limit || 50))
    const rows = all.slice(start, end)
    return Response.json({ ok: true, data: { rows, total: all.length } })
  }

  const rows = getRecentLogs(limit, offset)
  return Response.json({ ok: true, data: { rows, total: getLogCount() } })
}

export async function handleSystemConfig(): Promise<Response> {
  const { deviceInfo: _d, ...safeConfig } = config
  return Response.json({ ok: true, data: safeConfig })
}

export async function handleSystemVersion(): Promise<Response> {
  return Response.json({ ok: true, data: versionData })
}

export async function handleSystemSeeds(): Promise<Response> {
  const rows = getAllPlants()
    .map((p) => ({
      plantId: Number(p.id) || 0,
      seedId: Number(p.seed_id) || 0,
      name: String(p.name || ''),
      landLevelNeed: Number(p.land_level_need) || 0,
    }))
    .filter((x) => x.seedId > 0)
    .sort((a, b) => a.seedId - b.seedId)

  return Response.json({ ok: true, data: rows })
}

export async function handleSystemProxy(): Promise<Response> {
  const pool = ProxyPool.getStatus()
  const accounts = accountStore.getAccounts()
  const sessions = [...getSessions().values()].map((s) => ({
    id: s.id,
    gid: Number(s.conn.userState.gid || 0),
    qqNumber: accounts.find((a) => a.id === s.id)?.qqNumber || '',
    platform: accounts.find((a) => a.id === s.id)?.platform || 'qq',
    name: s.conn.userState.name || '',
    proxyUrl: s.conn.getProxyUrlMasked?.() || s.getProxyUrl() || '',
    proxyDebug: s.conn.getProxyDebug?.() || null,
  }))
  return Response.json({
    ok: true,
    data: {
      pool,
      sessions,
    },
  })
}

export async function handleSystemProxyRemove(body: any): Promise<Response> {
  const { proxy } = body ?? {}
  if (!proxy) return Response.json({ ok: false, error: '缺少参数' }, { status: 400 })

  const res = await ProxyPool.removeProxy(String(proxy))
  if (!res.ok) return Response.json({ ok: false, error: res.error || '删除失败' }, { status: 400 })
  return Response.json({ ok: true })
}

export async function handleSystemProxyProbe(body: any): Promise<Response> {
  const { accountId } = body ?? {}
  const sessions = getSessions()

  // Prefer probing a live session's proxyUrl, because that's what the WS will use.
  if (accountId && sessions.has(String(accountId))) {
    const s = sessions.get(String(accountId))!
    const proxyUrl = s.getProxyUrl() || ''
    if (!proxyUrl) return Response.json({ ok: false, error: '该账号未配置代理' }, { status: 400 })
    const masked = s.conn.getProxyUrlMasked?.() || proxyUrl
    const result = await probeExitIpViaSocks5(proxyUrl)
    if (result.ok) {
      ProxyPool.markSuccess(proxyUrl, result.elapsedMs)
    } else {
      ProxyPool.markFailed(proxyUrl)
    }
    return Response.json({ ok: true, data: { accountId: s.id, proxyUrl: masked, result } })
  }

  // Fallback: probe the first configured proxy in pool.
  const all = ProxyPool.getProxyUrls?.() || []
  const proxyUrl = all[0] || ''
  if (!proxyUrl) return Response.json({ ok: false, error: '代理池为空' }, { status: 400 })
  const result = await probeExitIpViaSocks5(proxyUrl)
  if (result.ok) {
    ProxyPool.markSuccess(proxyUrl, result.elapsedMs)
  } else {
    ProxyPool.markFailed(proxyUrl)
  }
  return Response.json({ ok: true, data: { proxyUrl, result } })
}

export async function handleSystemProxyHealth(body: any): Promise<Response> {
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

  return Response.json({ ok: true, data: { rows: results, checkedAt: Date.now() } })
}

import { loadSystemSettings, loadAnnouncement } from '../system-store.js'

export async function handleSystemSettings(): Promise<Response> {
  const settings = loadSystemSettings()
  const publicData = {
    noticeCardLogin: settings.noticeCardLogin || '',
    noticeAppLogin: settings.noticeAppLogin || '',
    backgroundImageUrl: settings.backgroundImageUrl || '',
  }
  return Response.json({ ok: true, data: publicData })
}

export async function handleSystemAnnouncement(): Promise<Response> {
  const data = await loadAnnouncement()
  return Response.json({ ok: true, data })
}
