import { type WriteStream, createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getDateKey, getDateTime } from './format.js'
import { canWriteToDisk } from './storage-guard.js'

export type LogEntry = {
  timestamp: string
  tag: string
  message: string
  level: 'info' | 'warn' | 'error'
  accountLabel?: string
}

let _currentAccountLabel = ''

export function setCurrentAccountLabel(label: string): void {
  _currentAccountLabel = label
}

type LogListener = (entry: LogEntry) => void

const LOG_DIR = join(process.cwd(), 'logs')
const MAX_RING_SIZE = 5000

let stream: WriteStream | null = null
let currentDateKey = ''
let disabled = false
const ringBuffer: LogEntry[] = []
const listeners = new Set<LogListener>()
let broadcastCallback: ((entry: LogEntry) => void) | null = null

export function setLogBroadcastCallback(fn: (entry: LogEntry) => void): void {
  broadcastCallback = fn
}

function ensureStream(): void {
  if (disabled) return
  if (!canWriteToDisk(4096)) {
    if (stream) {
      stream.end()
      stream = null
    }
    return
  }
  const dateKey = getDateKey()
  if (stream && dateKey === currentDateKey) return
  if (stream) {
    stream.end()
    stream = null
  }
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    stream = createWriteStream(join(LOG_DIR, `${dateKey}.log`), { flags: 'a', encoding: 'utf8' })
    currentDateKey = dateKey
  } catch {
    disabled = true
  }
}

function shouldDropEntry(entry: LogEntry): boolean {
  const tag = entry.tag || ''
  const msg = entry.message || ''
  if (tag.includes('声明') || tag.includes('澹版槑')) return true
  if (msg.includes('开源免费') || msg.includes('严禁倒卖') || msg.includes('公开仓库')) return true
  return false
}

function pushEntry(entry: LogEntry): void {
  if (shouldDropEntry(entry)) return
  ringBuffer.push(entry)
  if (ringBuffer.length > MAX_RING_SIZE) ringBuffer.shift()
  for (const fn of listeners) {
    try {
      fn(entry)
    } catch { }
  }
  if (broadcastCallback) {
    try {
      broadcastCallback(entry)
    } catch { }
  }

  ensureStream()
  if (stream) {
    const level = entry.level === 'info' ? 'INFO' : entry.level === 'warn' ? 'WARN' : 'ERROR'
    const acct = entry.accountLabel ? ` [${entry.accountLabel}]` : ''
    const line = `[${entry.timestamp}] [${level}]${acct} [${entry.tag}] ${entry.message}\n`
    if (canWriteToDisk(Buffer.byteLength(line, 'utf8'))) {
      stream.write(line)
    }
  }
}

export function log(tag: string, msg: string, accountLabel?: string): void {
  const entry: LogEntry = { timestamp: getDateTime(), tag, message: msg, level: 'info' }
  const label = accountLabel || _currentAccountLabel
  if (label) entry.accountLabel = label
  pushEntry(entry)
}

export function logWarn(tag: string, msg: string, accountLabel?: string): void {
  const entry: LogEntry = { timestamp: getDateTime(), tag, message: `[WARN] ${msg}`, level: 'warn' }
  const label = accountLabel || _currentAccountLabel
  if (label) entry.accountLabel = label
  pushEntry(entry)
}

export function getLogRingBuffer(): readonly LogEntry[] {
  return ringBuffer
}

export function getRecentLogs(limit = 50, offset = 0): LogEntry[] {
  const start = Math.max(0, ringBuffer.length - offset - limit)
  const end = Math.max(0, ringBuffer.length - offset)
  return ringBuffer.slice(start, end)
}

export function getLogCount(): number {
  return ringBuffer.length
}

export function onLog(fn: LogListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Disabled: statement/runtime-hint output.
export async function emitRuntimeHint(force = false): Promise<void> {
  void force
}

export function cleanupLogger(): void {
  if (stream) {
    stream.end()
    stream = null
  }
}
