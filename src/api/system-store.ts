import { existsSync, readFileSync, writeFileSync, promises as fs } from 'node:fs'
import { join } from 'node:path'

const ANNOUNCEMENT_FILE = join(process.cwd(), '.announcement.json')

export type Announcement = {
  id: string
  content: string
  level: 'info' | 'warning' | 'alert'
  enabled: boolean
  updatedAt: number
}

let cachedAnnouncement: Announcement | null = null

function getDefaultAnnouncement(): Announcement {
  return {
    id: 'default',
    content: '',
    level: 'info',
    enabled: false,
    updatedAt: 0
  }
}

export async function loadAnnouncement(): Promise<Announcement> {
  if (cachedAnnouncement) return cachedAnnouncement

  try {
    if (!existsSync(ANNOUNCEMENT_FILE)) {
      return getDefaultAnnouncement()
    }
    const data = JSON.parse(await fs.readFile(ANNOUNCEMENT_FILE, 'utf8'))
    cachedAnnouncement = data
    return data
  } catch {
    return getDefaultAnnouncement()
  }
}

export async function saveAnnouncement(data: Partial<Announcement>): Promise<Announcement> {
  const current = await loadAnnouncement()
  const next: Announcement = {
    ...current,
    ...data,
    updatedAt: Date.now()
  }

  // Ensure config dir exists
  const configDir = join(process.cwd(), 'config')
  if (!existsSync(configDir)) {
    await fs.mkdir(configDir, { recursive: true })
  }

  await fs.writeFile(ANNOUNCEMENT_FILE, JSON.stringify(next, null, 2), 'utf8')
  cachedAnnouncement = next
  return next
}

const SETTINGS_FILE = join(process.cwd(), '.system-settings.json')

export type SystemSettings = {
  noticeCardLogin?: string
  noticeAppLogin?: string
  backgroundImageUrl?: string
  botConfig?: {
    enabled: boolean
    adminUrl: string
    groupId: string
    groupIds: string
    adText: string
    adIntervalMin: number
    reportIntervalSec: number
    buyText: string
    alertEnabled: boolean
    functionImageUrl?: string
    functionText?: string
  }
}

let cachedSettings: SystemSettings | null = null

export function loadSystemSettings(): SystemSettings {
  if (cachedSettings) return cachedSettings
  try {
    if (existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
      cachedSettings = data
      return data
    }
  } catch { }
  return {}
}

export function saveSystemSettings(partial: Partial<SystemSettings>): SystemSettings {
  const current = loadSystemSettings()
  const next = { ...current, ...partial }

  const configDir = join(process.cwd(), 'config')
  if (!existsSync(configDir)) {
    // mkdirSync(configDir, { recursive: true }) 
    // Assuming handled by async version or exists
  }

  // Using sync for now to match signature if it was sync?
  // The errors said "Module ... has no exported member ...".
  // admin/system.ts calls `saveSystemSettings({...})`.
  // It doesn't await it? 
  // Let's check admin/controllers/system.ts: `saveSystemSettings({...})` no await.
  // So it should be sync or fire-and-forget.

  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
  cachedSettings = next
  return next
}
