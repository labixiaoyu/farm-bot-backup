import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ADMIN_ACCOUNT_CACHE_FILE = join(process.cwd(), '.admin-account-cache.json')

export type AccountCacheRow = {
    gid: number
    qqNumber?: string
    name: string
    platform: 'qq' | 'wx'
    level: number
    lastSeenAt: number
    // Leaderboard / Stats
    baseGold?: number
    baseExp?: number
    gold?: number
    exp?: number
    totalRuntimeSec?: number
}

type AccountCacheDb = {
    version: 1
    rows: AccountCacheRow[]
}

let dbCache: AccountCacheDb | null = null

export function loadAccountCache(): AccountCacheDb {
    if (dbCache) return dbCache
    if (!existsSync(ADMIN_ACCOUNT_CACHE_FILE)) {
        dbCache = { version: 1, rows: [] }
        return dbCache
    }
    try {
        const raw = JSON.parse(readFileSync(ADMIN_ACCOUNT_CACHE_FILE, 'utf8'))
        const rows = Array.isArray(raw?.rows) ? raw.rows : []
        dbCache = {
            version: 1,
            rows: rows
                .map((x: any) => ({
                    gid: Number(x?.gid || 0),
                    qqNumber: String(x?.qqNumber || ''),
                    name: String(x?.name || ''),
                    platform: x?.platform === 'wx' ? 'wx' : 'qq',
                    level: Number(x?.level || 0),
                    lastSeenAt: Number(x?.lastSeenAt || 0),
                    baseGold: x?.baseGold,
                    baseExp: x?.baseExp,
                    gold: x?.gold,
                    exp: x?.exp,
                    totalRuntimeSec: Number(x?.totalRuntimeSec || 0),
                }))
                .filter((x: AccountCacheRow) => x.gid > 0),
        }
    } catch {
        dbCache = { version: 1, rows: [] }
    }
    return dbCache!
}

export function saveAccountCache(db: AccountCacheDb): void {
    dbCache = db
    writeFileSync(ADMIN_ACCOUNT_CACHE_FILE, JSON.stringify(db, null, 2), 'utf8')
}

export function getAccountStat(gid: number): AccountCacheRow | undefined {
    const db = loadAccountCache()
    return db.rows.find((r) => r.gid === gid)
}

export function updateAccountStat(gid: number, patch: Partial<AccountCacheRow>): void {
    const db = loadAccountCache()
    let row = db.rows.find((r) => r.gid === gid)
    if (!row) {
        row = {
            gid,
            name: '',
            platform: 'qq',
            level: 0,
            lastSeenAt: Date.now(),
            totalRuntimeSec: 0,
        }
        db.rows.push(row)
    }
    Object.assign(row, patch)
    // Auto-set base values if strict update
    if (typeof patch.gold === 'number' && typeof row.baseGold !== 'number') {
        row.baseGold = patch.gold
    }
    if (typeof patch.exp === 'number' && typeof row.baseExp !== 'number') {
        row.baseExp = patch.exp
    }
    saveAccountCache(db)
}

export function incrementRuntime(gid: number, seconds: number): void {
    const db = loadAccountCache()
    const row = db.rows.find((r) => r.gid === gid)
    if (row) {
        row.totalRuntimeSec = (row.totalRuntimeSec || 0) + seconds
        saveAccountCache(db)
    }
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
