import { statfsSync } from 'node:fs'

const MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024
const CACHE_MS = 10_000

let cachedFreeBytes = Number.POSITIVE_INFINITY
let cachedAt = 0

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  return 0
}

export function getFreeDiskBytes(force = false): number {
  const now = Date.now()
  if (!force && now - cachedAt < CACHE_MS) return cachedFreeBytes

  try {
    const s = statfsSync(process.cwd()) as any
    const free = toNumber(s.bavail) * toNumber(s.bsize)
    cachedFreeBytes = Number.isFinite(free) && free >= 0 ? free : Number.POSITIVE_INFINITY
  } catch {
    // If unavailable on current runtime/platform, do not block writes.
    cachedFreeBytes = Number.POSITIVE_INFINITY
  }
  cachedAt = now
  return cachedFreeBytes
}

export function canWriteToDisk(bytesHint = 0): boolean {
  const free = getFreeDiskBytes()
  return free >= MIN_FREE_BYTES + Math.max(0, bytesHint)
}

export function isLowDiskSpace(): boolean {
  return !canWriteToDisk(0)
}

