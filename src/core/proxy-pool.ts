import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { log, logWarn } from '../utils/logger.js'
import { Socks5Client } from '../utils/socks5.js'

type LoadedProxy = {
  raw: string
  proxyUrl: string
}

export type ProxyPoolStatus = {
  initialized: boolean
  loadedAt: number
  total: number
  index: number
  proxies: Array<{
    proxyUrl: string
    stats?: { success: number; fail: number; rate: string; avgDuration: number }
    maxUsers: number
  }>
}

export type ProxyAdminRow = {
  raw: string
  masked: string
  maxUsers: number
}

export type ProxyImportResult = {
  ok: boolean
  error?: string
  total: number
  added: number
  skipped: number
}

function maskProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return proxyUrl.replace(/:([^:@/]+)@/g, ':***@')
  }
}

function normalizeProxyLine(rawLine: string): string | null {
  const raw = rawLine.trim()
  if (!raw) return null
  if (raw.startsWith('#')) return null

  try {
    // Try to parse it. If it throws, it's invalid.
    // If it succeeds, reconstruct a canonical URL.
    const p = Socks5Client.parseProxy(raw)
    let base = `socks5://${p.host}:${p.port}`
    if (p.username) {
      const auth = `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}`
      base = `socks5://${auth}@${p.host}:${p.port}`
    }
    return base
  } catch {
    return null
  }
}

class StaticSocks5ProxyPool {
  private readonly proxiesPath = join(process.cwd(), '.proxies.txt')
  private initialized = false
  private loadedAt = 0
  private proxies: LoadedProxy[] = []
  private usage = new Map<string, number>()
  private settings = new Map<string, { maxUsers: number }>()

  // New Stats Tracking
  private failCounts = new Map<string, number>()
  private lastFailAt = new Map<string, number>()
  private successCounts = new Map<string, number>()
  private latencies = new Map<string, number[]>()
  private cooldown = new Map<string, number>()
  private readonly COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

  private readonly settingsPath = join(process.cwd(), '.proxy-settings.json')

  private ensureConfigDir(): void {
    const dir = join(process.cwd(), 'config')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  private async persistCurrentToDisk(): Promise<void> {
    this.ensureConfigDir()
    const text = this.proxies.map((p) => p.raw).join('\n')
    await fs.writeFile(this.proxiesPath, text ? `${text}\n` : '', 'utf8')
  }

  /**
   * Initialize the proxy pool asynchronously.
   * Should be called at application startup.
   */
  async initAsync(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await this.reloadAsync()
    await this.loadSettingsAsync()
  }

  /** @deprecated Use initAsync instead */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.reload()
    this.loadSettings()
  }

  private async loadSettingsAsync(): Promise<void> {
    if (!existsSync(this.settingsPath)) return
    try {
      const content = await fs.readFile(this.settingsPath, 'utf8')
      const json = JSON.parse(content)
      if (typeof json === 'object' && json) {
        for (const [key, val] of Object.entries(json)) {
          if (typeof val === 'object' && val && 'maxUsers' in val) {
            this.settings.set(key, { maxUsers: Number((val as any).maxUsers) || 10 })
          }
        }
      }
    } catch { }
  }

  private loadSettings(): void {
    if (!existsSync(this.settingsPath)) return
    try {
      const json = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
      if (typeof json === 'object' && json) {
        for (const [key, val] of Object.entries(json)) {
          if (typeof val === 'object' && val && 'maxUsers' in val) {
            this.settings.set(key, { maxUsers: Number((val as any).maxUsers) || 10 })
          }
        }
      }
    } catch { }
  }

  private async saveSettingsAsync(): Promise<void> {
    this.ensureConfigDir()
    const obj: Record<string, any> = {}
    for (const [key, val] of this.settings.entries()) {
      obj[key] = val
    }
    await fs.writeFile(this.settingsPath, JSON.stringify(obj, null, 2), 'utf8')
  }

  async updateLimits(updates: Record<string, number>): Promise<void> {
    let changed = false
    for (const [rawOrUrl, limit] of Object.entries(updates)) {
      const normalized = normalizeProxyLine(rawOrUrl) || rawOrUrl
      const val = Math.max(1, Number(limit))
      this.settings.set(normalized, { maxUsers: val })
      changed = true
    }
    if (changed) {
      await this.saveSettingsAsync()
      log('代理池', `已更新 ${Object.keys(updates).length} 个代理的负载限制`)
    }
  }

  async reloadAsync(): Promise<void> {
    if (!existsSync(this.proxiesPath)) {
      this.proxies = []
      this.loadedAt = Date.now()
      logWarn('代理池', `未找到 proxies.txt: ${this.proxiesPath}`)
      return
    }

    const content = await fs.readFile(this.proxiesPath, 'utf8')
    const lines = content.split(/\r?\n/)
    const proxies: LoadedProxy[] = []
    for (const line of lines) {
      const normalized = normalizeProxyLine(line)
      if (!normalized) continue
      proxies.push({ raw: line.trim(), proxyUrl: normalized })
    }
    this.proxies = proxies
    this.loadedAt = Date.now()
    log('代理池', `已加载 ${this.proxies.length} 个静态 SOCKS5 代理`)
  }

  reload(): void {
    if (!existsSync(this.proxiesPath)) {
      this.proxies = []
      this.loadedAt = Date.now()
      logWarn('代理池', `未找到 proxies.txt: ${this.proxiesPath}`)
      return
    }

    const content = readFileSync(this.proxiesPath, 'utf8')
    const lines = content.split(/\r?\n/)
    const proxies: LoadedProxy[] = []
    for (const line of lines) {
      const normalized = normalizeProxyLine(line)
      if (!normalized) continue
      proxies.push({ raw: line.trim(), proxyUrl: normalized })
    }
    this.proxies = proxies
    this.loadedAt = Date.now()
    log('代理池', `已加载 ${this.proxies.length} 个静态 SOCKS5 代理`)
  }

  async addProxy(rawInput: string): Promise<{ ok: boolean; error?: string; proxyUrl?: string }> {
    const normalized = normalizeProxyLine(rawInput)
    if (!normalized) return { ok: false, error: '代理格式无效（支持 host:port 或 socks5://user:pass@host:port）' }

    const exists = this.proxies.some((p) => p.proxyUrl === normalized)
    if (exists) return { ok: false, error: '代理已存在', proxyUrl: normalized }

    this.proxies.push({ raw: normalized, proxyUrl: normalized })
    this.loadedAt = Date.now()
    await this.persistCurrentToDisk()
    log('代理池', `已新增代理: ${maskProxyUrl(normalized)}`)
    return { ok: true, proxyUrl: normalized }
  }

  async removeProxy(rawOrUrl: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeProxyLine(rawOrUrl)
    if (!normalized) return { ok: false, error: '代理格式无效' }

    const before = this.proxies.length
    this.proxies = this.proxies.filter((p) => p.proxyUrl !== normalized)
    this.usage.delete(normalized)
    this.failCounts.delete(normalized)
    this.lastFailAt.delete(normalized)
    this.successCounts.delete(normalized)
    this.latencies.delete(normalized)

    if (this.proxies.length === before) {
      return { ok: false, error: '未找到该代理' }
    }

    this.loadedAt = Date.now()
    await this.persistCurrentToDisk()
    log('代理池', `已移除代理: ${maskProxyUrl(normalized)}`)
    return { ok: true }
  }

  listForAdmin(): ProxyAdminRow[] {
    return this.proxies.map((p) => ({
      raw: p.raw,
      masked: maskProxyUrl(p.proxyUrl),
      maxUsers: this.settings.get(p.proxyUrl)?.maxUsers || 10,
    }))
  }

  exportText(): string {
    const text = this.proxies.map((p) => p.raw).join('\n')
    return text ? `${text}\n` : ''
  }

  async importFromText(text: string, mode: 'append' | 'replace' = 'append'): Promise<ProxyImportResult> {
    const src = String(text || '')
    const lines = src.split(/\r?\n/)
    const normalizedList = lines.map((line) => normalizeProxyLine(line)).filter((x): x is string => Boolean(x))

    if (normalizedList.length === 0) {
      return { ok: false, error: '未解析到有效代理', total: this.proxies.length, added: 0, skipped: 0 }
    }

    const uniqIncoming = [...new Set(normalizedList)]
    if (mode === 'replace') {
      this.proxies = uniqIncoming.map((x) => ({ raw: x, proxyUrl: x }))
      this.usage.clear()
      this.failCounts.clear()
      this.lastFailAt.clear()
      this.successCounts.clear()
      this.latencies.clear()
      this.loadedAt = Date.now()
      await this.persistCurrentToDisk()
      return { ok: true, total: this.proxies.length, added: uniqIncoming.length, skipped: 0 }
    }

    const exists = new Set(this.proxies.map((p) => p.proxyUrl))
    let added = 0
    let skipped = 0
    for (const p of uniqIncoming) {
      if (exists.has(p)) {
        skipped++
        continue
      }
      this.proxies.push({ raw: p, proxyUrl: p })
      exists.add(p)
      added++
    }
    this.loadedAt = Date.now()
    await this.persistCurrentToDisk()
    return { ok: true, total: this.proxies.length, added, skipped }
  }

  // Feedback Methods
  markSuccess(proxyUrl: string, durationMs?: number) {
    this.failCounts.set(proxyUrl, 0)
    const s = this.successCounts.get(proxyUrl) || 0
    this.successCounts.set(proxyUrl, s + 1)

    if (typeof durationMs === 'number' && durationMs > 0) {
      const list = this.latencies.get(proxyUrl) || []
      list.push(durationMs)
      if (list.length > 20) list.shift() // Keep last 20
      this.latencies.set(proxyUrl, list)
    }
  }

  markFailed(proxyUrl: string) {
    const f = (this.failCounts.get(proxyUrl) || 0) + 1
    this.failCounts.set(proxyUrl, f)
    this.lastFailAt.set(proxyUrl, Date.now())

    // Set cooldown
    this.cooldown.set(proxyUrl, Date.now() + this.COOLDOWN_MS)
    log('代理池', `标记失效: ${maskProxyUrl(proxyUrl)} (冷却 5 分钟)`)
  }

  isCoolingDown(proxyUrl: string): boolean {
    const until = this.cooldown.get(proxyUrl)
    if (!until) return false
    if (Date.now() >= until) {
      this.cooldown.delete(proxyUrl) // expired, clean up
      return false
    }
    return true
  }

  alloc(exclude?: string): string | undefined {
    if (this.proxies.length === 0) return undefined

    const now = Date.now()

    // Strategy 1: Good Candidates (No cooldown, not excluded, usage < limit)
    let candidates = this.proxies.filter(p => {
      if (this.isCoolingDown(p.proxyUrl)) return false
      if (exclude && p.proxyUrl === exclude) return false
      const limit = this.settings.get(p.proxyUrl)?.maxUsers || 10
      return (this.usage.get(p.proxyUrl) || 0) < limit
    })

    // Strategy 2: Relax Exclusion (Allow excluded, but still NO cooldown, usage < limit)
    if (candidates.length === 0) {
      candidates = this.proxies.filter(p => {
        if (this.isCoolingDown(p.proxyUrl)) return false
        const limit = this.settings.get(p.proxyUrl)?.maxUsers || 10
        return (this.usage.get(p.proxyUrl) || 0) < limit
      })
    }

    // Strategy 3: Absolute Last Resort (Allow cooldown if nothing else works, usage < limit)
    if (candidates.length === 0) {
      candidates = this.proxies.filter(p => {
        const limit = this.settings.get(p.proxyUrl)?.maxUsers || 10
        return (this.usage.get(p.proxyUrl) || 0) < limit
      })
    }

    if (candidates.length === 0) {
      logWarn('代理池', '无可用代理 (所有代理负载已满)')
      return undefined
    }

    // Shuffle candidates to avoid "first proxy bias" when usages are equal
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    // 2. Sort: Least connections first
    candidates.sort((a, b) => {
      const uA = this.usage.get(a.proxyUrl) || 0
      const uB = this.usage.get(b.proxyUrl) || 0
      return uA - uB
    })

    // 3. Pick best
    const best = candidates[0]
    const currentUsage = this.usage.get(best.proxyUrl) || 0
    this.usage.set(best.proxyUrl, currentUsage + 1)

    const limit = this.settings.get(best.proxyUrl)?.maxUsers || 10
    const isCooling = this.isCoolingDown(best.proxyUrl)
    const isExcluded = exclude && best.proxyUrl === exclude

    log('代理池', `分配: ${maskProxyUrl(best.proxyUrl)} (负载: ${currentUsage + 1}/${limit}${isCooling ? ', 冷却中强制分配' : ''}${isExcluded ? ', 重复分配' : ''})`)
    return best.proxyUrl
  }

  release(proxyUrl?: string): void {
    if (!proxyUrl) return
    const count = this.usage.get(proxyUrl) || 0
    if (count > 0) {
      this.usage.set(proxyUrl, count - 1)
      log('代理池', `释放: ${maskProxyUrl(proxyUrl)} (负载: ${count - 1})`)
    }
  }

  getProxyUrls(): string[] {
    return this.proxies.map((p) => p.proxyUrl)
  }

  getStatus(): ProxyPoolStatus {
    return {
      initialized: this.initialized,
      loadedAt: this.loadedAt,
      total: this.proxies.length,
      index: 0,
      proxies: this.proxies.map((p) => {
        const lats = this.latencies.get(p.proxyUrl) || []
        const avg = lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0
        return {
          proxyUrl: maskProxyUrl(p.proxyUrl),
          maxUsers: this.settings.get(p.proxyUrl)?.maxUsers || 10,
          stats: {
            success: this.successCounts.get(p.proxyUrl) || 0,
            fail: this.failCounts.get(p.proxyUrl) || 0,
            rate: '-',
            avgDuration: avg
          }
        }
      }),
    }
  }

  stop(): void {
    this.initialized = false
    this.proxies = []
    this.usage.clear()
  }
}

export const ProxyPool = new StaticSocks5ProxyPool()
