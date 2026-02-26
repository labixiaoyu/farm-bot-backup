import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isLowDiskSpace } from './storage-guard.js'

const LOG_DIR = join(process.cwd(), 'logs')
const DUMP_DIR = join(process.cwd(), 'dumps')
const CACHE_FILES = [join(process.cwd(), '.farm-code.json'), join(process.cwd(), '.farm-stats.json')]

const CLEAN_INTERVAL_MS = 15 * 60 * 1000
const LOG_KEEP_MS_NORMAL = 7 * 24 * 60 * 60 * 1000
const LOG_KEEP_MS_LOW = 24 * 60 * 60 * 1000
const DUMP_KEEP_MS_NORMAL = 2 * 24 * 60 * 60 * 1000

function removeOldFilesInDir(dir: string, maxAgeMs: number): void {
  if (!existsSync(dir)) return
  const now = Date.now()
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    return
  }

  for (const name of files) {
    const path = join(dir, name)
    try {
      const st = statSync(path)
      const mtime = st.mtimeMs || 0
      if (maxAgeMs <= 0 || now - mtime > maxAgeMs) {
        if (st.isDirectory()) rmSync(path, { recursive: true, force: true })
        else unlinkSync(path)
      }
    } catch {}
  }
}

function removeIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {}
}

export function runHousekeeping(): void {
  const low = isLowDiskSpace()

  // Always trim logs; low disk keeps only last 1 day.
  removeOldFilesInDir(LOG_DIR, low ? LOG_KEEP_MS_LOW : LOG_KEEP_MS_NORMAL)

  if (low) {
    // Aggressive cleanup mode under low disk.
    removeOldFilesInDir(DUMP_DIR, 0)
    for (const file of CACHE_FILES) removeIfExists(file)
    return
  }

  // Normal mode: keep short dump history.
  removeOldFilesInDir(DUMP_DIR, DUMP_KEEP_MS_NORMAL)
}

export function startHousekeeping(): () => void {
  runHousekeeping()
  const timer = setInterval(runHousekeeping, CLEAN_INTERVAL_MS)
  return () => clearInterval(timer)
}

