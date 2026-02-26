import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLevelExpProgress, getPlantBySeedId, getPlantGrowTime, getPlantName, loadConfigs } from '../../config/game-data.js'
import { getSession } from '../../core/account.js'
import { accountStore, getSessionStore } from '../../store/index.js'
import { toNum } from '../../utils/long.js'
import { getServerTimeSec as getServerNowSec, toTimeSec } from '../../utils/time.js'
import { getAccountStat } from '../../store/account-cache.js'

let roleLevelTable: number[] | null = null

function getRoleLevelTable(): number[] {
  if (roleLevelTable) return roleLevelTable
  roleLevelTable = []
  try {
    const file = join(process.cwd(), 'game-config', 'RoleLevel.json')
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Array<{ level: number; exp: number }>
      for (const item of data || []) {
        if (typeof item?.level === 'number') {
          roleLevelTable[item.level] = Number(item.exp) || 0
        }
      }
    }
  } catch { }
  return roleLevelTable
}

function fallbackExpProgress(level: number, exp: number): { current: number; needed: number } {
  const table = getRoleLevelTable()
  if (!table.length || level <= 0) return { current: 0, needed: 0 }
  const start = table[level] || 0
  const next = table[level + 1] || (start > 0 ? start + 100000 : 0)
  if (next <= start) return { current: 0, needed: 0 }
  return {
    current: Math.max(0, exp - start),
    needed: next - start,
  }
}

function parseGrowPhasesSeconds(growPhases: string | undefined): number {
  if (!growPhases) return 0
  return String(growPhases)
    .split(';')
    .filter(Boolean)
    .reduce((total, phase) => {
      const match = phase.match(/:(\d+)/)
      return total + (match ? Number.parseInt(match[1], 10) : 0)
    }, 0)
}

function normalizeUser(connUser: any, storeUser?: any, levelHint = 0, withDebug = false) {
  const conn = {
    gid: toNum(connUser?.gid),
    name: connUser?.name || '',
    level: toNum(connUser?.level),
    gold: toNum(connUser?.gold),
    exp: toNum(connUser?.exp),
    coin: toNum(connUser?.coin),
  }
  const store = {
    gid: toNum(storeUser?.gid),
    name: storeUser?.name || '',
    level: toNum(storeUser?.level),
    gold: toNum(storeUser?.gold),
    exp: toNum(storeUser?.exp),
    coin: toNum(storeUser?.coin),
  }

  const level = conn.level > 0 ? conn.level : store.level > 0 ? store.level : Math.max(0, levelHint)
  const exp = conn.exp > 0 ? conn.exp : store.exp
  const gold = conn.gold > 0 ? conn.gold : store.gold
  const coin = conn.coin > 0 ? conn.coin : store.coin
  const gid = conn.gid || store.gid
  const name = conn.name || store.name

  const initial = getLevelExpProgress(level, exp)
  let progress = initial
  let usedReload = false
  let usedFallback = false

  if (level > 0 && progress.needed <= 0) {
    usedReload = true
    loadConfigs()
    progress = getLevelExpProgress(level, exp)
    if (progress.needed <= 0) {
      usedFallback = true
      progress = fallbackExpProgress(level, exp)
    }
  }

  const current = Math.max(0, progress.current)
  const needed = Math.max(0, progress.needed)
  const percent = needed > 0 ? Math.max(0, Math.min(100, Math.round((current / needed) * 100))) : 0

  const result: any = {
    gid,
    name,
    level,
    gold,
    exp,
    coin,
    expCurrent: current,
    expNeeded: needed,
    expPercent: percent,
    expProgress: { current, needed },
  }

  if (withDebug) {
    result.expDebug = {
      source: { conn, store, levelHint },
      progressInitial: initial,
      progressFinal: { current, needed, percent },
      usedReload,
      usedFallback,
    }
  }

  return result
}

function normalizeLand(land: any, nowSec: number) {
  const normalized: any = {
    id: toNum(land?.id),
    level: toNum(land?.level),
    unlocked: !!land?.unlocked,
  }

  if (land?.plant) {
    const plantId = toNum(land.plant.id)
    const phases = (land.plant.phases || []).map((p: any) => ({
      phase: toNum(p?.phase),
      begin_time: toTimeSec(p?.begin_time),
    }))
    let firstBegin = toTimeSec(phases[0]?.begin_time)
    let matureBegin = 0
    for (const p of phases) {
      if (toNum(p.phase) === 6) {
        matureBegin = toTimeSec(p.begin_time)
        break
      }
    }
    if (firstBegin <= 0) {
      const starts = phases.map((p: any) => toTimeSec(p.begin_time)).filter((x: number) => x > 0)
      if (starts.length > 0) firstBegin = Math.min(...starts)
    }
    if (firstBegin <= 0 && matureBegin > 0) {
      const growSec = toNum(land.plant.grow_sec)
      if (growSec > 0) firstBegin = Math.max(1, matureBegin - growSec)
    }
    let progressPercent = 0
    let remainSec = 0
    const baseGrowSecDirect = Math.max(0, getPlantGrowTime(plantId))
    let baseGrowSec = baseGrowSecDirect
    let baseGrowSecBySeed = 0
    if (baseGrowSec <= 0) {
      const bySeed = getPlantBySeedId(plantId)
      baseGrowSecBySeed = parseGrowPhasesSeconds(bySeed?.grow_phases)
      baseGrowSec = baseGrowSecBySeed
    }
    if (matureBegin > firstBegin && firstBegin > 0) {
      remainSec = Math.max(0, matureBegin - nowSec)
      const denomSec = baseGrowSec > 0 ? baseGrowSec : matureBegin - firstBegin
      if (denomSec > 0) {
        // Keep progress consistent with displayed remaining time: progress = (total - remaining) / total.
        progressPercent = Math.max(0, Math.min(100, Math.round(((denomSec - remainSec) / denomSec) * 100)))
      }
    }
    normalized.plant = {
      id: plantId,
      name: getPlantName(plantId),
      grow_sec: toNum(land.plant.grow_sec),
      base_grow_sec: baseGrowSec,
      base_grow_sec_direct: baseGrowSecDirect,
      base_grow_sec_by_seed: baseGrowSecBySeed,
      phases,
      progressPercent,
      remainSec,
      dry_num: toNum(land.plant.dry_num),
      weed_owners: (land.plant.weed_owners || []).map((x: any) => toNum(x)),
      insect_owners: (land.plant.insect_owners || []).map((x: any) => toNum(x)),
      mutant_config_ids: (land.plant.mutant_config_ids || []).map((x: any) => toNum(x)),
      stole_num: toNum(land.plant.stole_num),
      fruit_num: toNum(land.plant.fruit_num),
      left_fruit_num: toNum(land.plant.left_fruit_num),
      stealers: (land.plant.stealers || []).map((x: any) => toNum(x)),
    }
  }

  return normalized
}

export async function handleFarmStatus(body: any): Promise<Response> {
  const { accountId, debug, refresh } = body ?? {}
  if (!accountId) return Response.json({ ok: false, error: 'missing accountId' }, { status: 400 })

  const session = getSession(accountId)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })

  const store = getSessionStore(accountId)
  const accountLevel = accountStore.getAccounts().find((a) => a.id === accountId)?.level || 0
  // Always emit exp debug by default so web can diagnose mismatches reliably.
  // Allow explicit debug:false to turn it off if ever needed.
  const withDebug = debug !== false
  const cachedNowSec = getServerNowSec()
  const cachedLands = (store.state.lands || []).map((x) => normalizeLand(x, cachedNowSec))
  const needRealtime = !!refresh || cachedLands.length === 0

  try {
    if (needRealtime) await session.farm.checkFarm()

    // ...

    const nowSec = getServerNowSec()
    const user = normalizeUser(session.conn.userState, store.state.user, accountLevel, withDebug)

    // Calculate Income
    const gid = Number(user.gid || 0)
    let income = { gold: 0, exp: 0 }
    let levelUpEtaSec = 0
    if (gid > 0) {
      const stat = getAccountStat(gid)
      if (stat) {
        const curGold = Number(user.gold || 0)
        const curExp = Number(user.exp || 0)
        const baseGold = Number(stat.baseGold)
        const baseExp = Number(stat.baseExp)
        // Use 0 if base is undefined/NaN
        income.gold = Math.max(0, curGold - (isNaN(baseGold) ? curGold : baseGold))
        income.exp = Math.max(0, curExp - (isNaN(baseExp) ? curExp : baseExp))

        // Calculate ETA
        const account = accountStore.getAccounts().find((a) => a.id === accountId)
        if (account && income.exp > 0) {
          const runtime = (account.totalRuntime || 0) + (account.status === 'online' && account.statusAt ? Math.max(0, Math.floor((Date.now() - account.statusAt) / 1000)) : 0)
          if (runtime > 60) {
            const rate = income.exp / runtime
            const needed = Math.max(0, user.expNeeded || 0)
            if (rate > 0 && needed > 0) {
              levelUpEtaSec = Math.floor(needed / rate)
            }
          }
        }
      }
    }

    return Response.json({
      ok: true,
      data: {
        lands: (store.state.lands || []).map((x) => normalizeLand(x, nowSec)),
        user: { ...user, income, levelUpEtaSec },
        friendStats: store.state.friendStats,
        friendList: store.state.friendList,
        expDebug: user.expDebug || null,
        farmHandlerVersion: 'farm-status-debug-v2',
        serverTimeSec: nowSec,
        stale: !needRealtime,
      },
    })
  } catch (e: any) {
    if (cachedLands.length > 0) {
      const user = normalizeUser(session.conn.userState, store.state.user, accountLevel, withDebug)
      return Response.json({
        ok: true,
        data: {
          lands: cachedLands,
          user,
          expDebug: user.expDebug || null,
          farmHandlerVersion: 'farm-status-debug-v2',
          serverTimeSec: getServerNowSec(),
          stale: true,
          warning: e?.message || 'farm realtime fetch failed',
        },
      })
    }
    return Response.json({ ok: false, error: e?.message || 'farm fetch failed' }, { status: 500 })
  }
}

export async function handleFarmHarvest(body: any): Promise<Response> {
  const { accountId } = body ?? {}
  if (!accountId) return Response.json({ ok: false, error: 'missing accountId' }, { status: 400 })

  const session = getSession(accountId)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })

  try {
    await session.farm.checkFarm()
    return Response.json({ ok: true })
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'farm operation failed' }, { status: 500 })
  }
}

export async function handleFarmReplant(body: any): Promise<Response> {
  const { accountId } = body ?? {}
  if (!accountId) return Response.json({ ok: false, error: 'missing accountId' }, { status: 400 })

  const session = getSession(accountId)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })

  try {
    await session.farm.checkFarm()
    return Response.json({ ok: true })
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'farm operation failed' }, { status: 500 })
  }
}
