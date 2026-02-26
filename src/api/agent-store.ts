import { existsSync, readFileSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

const AGENT_FILE = join(process.cwd(), 'config', 'agents.json')

export type Agent = {
    id: string
    username: string
    passwordHash: string
    balance: number
    remark: string
    status: 'active' | 'disabled'
    createdAt: number
    customPrices?: Record<string, number>
    allowedCardTypes?: string[]
}

export type AgentStore = {
    agents: Agent[]
}

let agentStore: AgentStore = {
    agents: [],
}

// Initialize
if (existsSync(AGENT_FILE)) {
    try {
        const data = JSON.parse(readFileSync(AGENT_FILE, 'utf-8'))
        agentStore = data
    } catch (e) {
        console.error('Failed to load agent store:', e)
    }
}

async function saveAgentStore() {
    await fs.writeFile(AGENT_FILE, JSON.stringify(agentStore, null, 2), 'utf-8')
}

function hashPassword(password: string): string {
    return createHash('sha256').update(password).digest('hex')
}

export async function createAgent(username: string, passwordPlain: string, remark: string): Promise<Agent> {
    const agent: Agent = {
        id: randomUUID(),
        username,
        passwordHash: hashPassword(passwordPlain),
        balance: 0,
        remark,
        status: 'active',
        createdAt: Date.now(),
    }
    agentStore.agents.push(agent)
    await saveAgentStore()
    return agent
}

export async function getAgentByUsername(username: string): Promise<Agent | undefined> {
    return agentStore.agents.find((a) => a.username === username)
}

export async function getAgentById(id: string): Promise<Agent | undefined> {
    return agentStore.agents.find((a) => a.id === id)
}

export async function updateAgentBalance(id: string, delta: number): Promise<boolean> {
    const agent = agentStore.agents.find((a) => a.id === id)
    if (!agent) return false
    agent.balance += delta
    await saveAgentStore()
    return true
}

export async function updateAgentPassword(id: string, newPasswordPlain: string): Promise<boolean> {
    const agent = agentStore.agents.find((a) => a.id === id)
    if (!agent) return false
    agent.passwordHash = hashPassword(newPasswordPlain)
    await saveAgentStore()
    return true
}

export async function updateAgentProfile(id: string, data: Partial<Agent>): Promise<boolean> {
    const agent = agentStore.agents.find((a) => a.id === id)
    if (!agent) return false
    if (data.remark !== undefined) agent.remark = data.remark
    if (data.customPrices !== undefined) agent.customPrices = data.customPrices
    if (data.allowedCardTypes !== undefined) agent.allowedCardTypes = data.allowedCardTypes
    if (data.status !== undefined) agent.status = data.status
    await saveAgentStore()
    return true
}

export function getAllAgents(): Agent[] {
    return agentStore.agents
}

export function verifyAgentPassword(agent: Agent, passwordPlain: string): boolean {
    return agent.passwordHash === hashPassword(passwordPlain)
}
