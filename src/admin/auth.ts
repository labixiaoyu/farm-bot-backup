import { randomUUID } from 'node:crypto'
import { getAgentById } from '../api/agent-store.js'

// Simple in-memory token store for now
// Map<token, { role: 'author' | 'agent', id: string, name: string }>
export type AuthSession = {
    role: 'author' | 'agent'
    id: string
    name: string
    createdAt: number
}

const sessions = new Map<string, AuthSession>()

export function createAdminSession(role: 'author' | 'agent', id: string, name: string): string {
    const token = `adm-${randomUUID()}`
    sessions.set(token, { role, id, name, createdAt: Date.now() })
    return token
}

export function getAdminSession(token: string): AuthSession | null {
    const session = sessions.get(token)
    if (!session) return null
    return session
}

export function destroyAdminSession(token: string): void {
    sessions.delete(token)
}

// Helper to check if token is valid and return role
export function verifyAdminToken(token: string): AuthSession | null {
    return getAdminSession(token)
}

export function buildAdminToken(): string {
    // Legacy support or fallback? 
    // The previous implementation utilized a static token or generated one.
    // For dual role, we strictly need sessions.
    // But existing router might call this. Let's redirect to a new method or keep it for temporary fallback?
    // Actually, router needs update.
    return `legacy-token-do-not-use`
}
