import { randomBytes } from 'node:crypto'
import type { CardAuthProfile } from './card-store.js'

type SessionInfo = {
  createdAt: number
  lastSeenAt: number
  profile: CardAuthProfile
}

const sessions = new Map<string, SessionInfo>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

export const SESSION_TTL_SEC = Math.floor(SESSION_TTL_MS / 1000)

export function createAuthToken(profile: CardAuthProfile): string {
  cleanupExpiredSessions()
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  sessions.set(token, { createdAt: now, lastSeenAt: now, profile })
  return token
}

export function verifyAuthToken(token: string): boolean {
  const session = sessions.get(token)
  if (!session) return false
  const now = Date.now()
  if (now - session.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(token)
    return false
  }
  session.lastSeenAt = now
  return true
}

export function getAuthSessionByToken(token: string): SessionInfo | null {
  if (!verifyAuthToken(token)) return null
  return sessions.get(token) || null
}

export function extractAuthToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization')
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i)
    if (match?.[1]) return match[1].trim()
  }
  const xToken = req.headers.get('x-auth-token')
  return xToken?.trim() || null
}

export function getAuthorizedSession(req: Request): SessionInfo | null {
  const token = extractAuthToken(req)
  if (!token) return null
  return getAuthSessionByToken(token)
}

export function isAuthorized(req: Request): boolean {
  return !!getAuthorizedSession(req)
}

function cleanupExpiredSessions(): void {
  const now = Date.now()
  for (const [token, session] of sessions.entries()) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) sessions.delete(token)
  }
}
