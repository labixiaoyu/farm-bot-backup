import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../App.css'

type AccountSummary = {
  id: string
  gid: number
  qqNumber?: string
  name: string
  platform: 'qq' | 'wx'
  level: number
  status: 'online' | 'offline'
  statusReason?: string
  runtimeSec: number
  proxy?: string
  latestLog?: string
}

type CardData = {
  id: string
  code?: string
  type: string
  expiresAt?: number
  maxBind: number
  boundCount: number
  onlineCount: number
  status: 'active' | 'disabled'
  note?: string
  accounts: AccountSummary[]
}

type DashboardData = {
  cards: CardData[]
  totalSessions: number
  unboundAccounts: AccountSummary[]
}

type BotConfig = {
  enabled: boolean
  adminUrl: string
  adminToken: string
  groupId: string
  groupIds: string
  adText: string
  adIntervalMin: number
  reportIntervalSec: number
  buyText: string
  alertEnabled: boolean
  alertOnlyWhenAtPossible: boolean
  renewalReminderDays: number
}

type SystemSettings = {
  noticeCardLogin: string
  noticeAppLogin: string
  backgroundImageUrl: string
  botConfig: BotConfig
}

type ProxySession = {
  id: string
  gid: number
  qqNumber?: string
  platform?: 'qq' | 'wx'
  name: string
  proxy: string
  runtimeSec: number
  proxyDebug?: {
    remoteAddress?: string
    remotePort?: number
    verdict?: string
  } | null
}

type ProxyStats = { success: number; fail: number; rate: string; avgDuration: number }

type ProxyData = {
  pool: {
    initialized: boolean
    loadedAt: number
    total: number
    index: number
    proxies: Array<{ proxyUrl: string; stats?: ProxyStats }>
  }
  configRows?: Array<{ raw: string; masked: string; maxUsers: number }>
  sessions: ProxySession[]
}

type ProxyHealthRow = {
  raw: string
  masked: string
  ok: boolean
  elapsedMs: number
  ip?: string
  error?: string
  maxUsers?: number
}

type AdminAlert = {
  id: string
  ts: number
  level: 'warn' | 'critical'
  kind: 'disconnect' | 'remote_login' | 'reconnect_failed'
  gid: number
  qqNumber?: string
  accountId: string
  accountName: string
  statusReason?: string
  message: string
}

type LeaderboardItem = {
  gid: number
  name: string
  level: number
  value: number
  label: string
}

type LeaderboardData = {
  onlineTime: LeaderboardItem[]
  level: LeaderboardItem[]
  goldGain: LeaderboardItem[]
  expGain: LeaderboardItem[]
}

const CARDS_PER_PAGE = 9  // 每页显示9个卡密块 (3x3)
const ACCOUNTS_PER_CARD_PAGE = 2

function formatDuration(sec: number): string {
  const total = Math.max(0, Number(sec) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${m}m${s}s`
  return `${m}m${s}s`
}

function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, size)))
}

function getAlertLevel(acc: AccountSummary): 'normal' | 'warn' | 'critical' {
  const reason = String(acc.statusReason || '').toLowerCase()
  if (reason.includes('remote') || reason.includes('reconnect_failed') || reason.includes('error')) return 'critical'
  if (acc.status === 'offline') return 'warn'
  return 'normal'
}

function accountIdentity(platform: 'qq' | 'wx', qqNumber: string | undefined, gid: number): string {
  if (platform === 'qq' && qqNumber) return `QQ:${qqNumber}`
  return `GID:${gid}`
}

export function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [proxyData, setProxyData] = useState<ProxyData | null>(null)
  const [alerts, setAlerts] = useState<AdminAlert[]>([])
  const [alertQueue, setAlertQueue] = useState<AdminAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showGenerate, setShowGenerate] = useState(false)
  const [showProxyModal, setShowProxyModal] = useState(false)
  const [showProxyImport, setShowProxyImport] = useState(false)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [leaderboardData, setLeaderboardData] = useState<LeaderboardData | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [realtimeLogs, setRealtimeLogs] = useState<string[]>([])
  const [showAlertPanel, setShowAlertPanel] = useState(false)
  const [settings, setSettings] = useState<SystemSettings>({
    noticeCardLogin: '',
    noticeAppLogin: '',
    backgroundImageUrl: '',
    botConfig: {
      enabled: false,
      adminUrl: '',
      adminToken: '',
      groupId: '',
      groupIds: '',
      adText: '',
      adIntervalMin: 60,
      reportIntervalSec: 300,
      buyText: '云端代挂购买链接：\nhttps://example.com/buy',
      alertEnabled: true,
      alertOnlyWhenAtPossible: false,
      renewalReminderDays: 3
    }
  })
  const [genConfig, setGenConfig] = useState({ type: '月卡', days: 30, count: 1, maxBindAccounts: 1, note: '' })
  const [proxyInput, setProxyInput] = useState('')
  const [proxyImportText, setProxyImportText] = useState('')
  const [proxyImportMode, setProxyImportMode] = useState<'append' | 'replace'>('append')
  const [proxyHealthMap, setProxyHealthMap] = useState<Record<string, ProxyHealthRow>>({})
  const [proxyHealthCheckedAt, setProxyHealthCheckedAt] = useState<number>(0)
  const [proxyLimitBatch, setProxyLimitBatch] = useState<number>(10)
  const [proxyLimitMap, setProxyLimitMap] = useState<Record<string, number>>({}) // local edits
  const [cardPage, setCardPage] = useState(1)
  const [accountPageMap, setAccountPageMap] = useState<Record<string, number>>({})
  const [maxBindDraftMap, setMaxBindDraftMap] = useState<Record<string, number>>({})
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cardId: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ cardId: string; cardType: string } | null>(null)
  const [editingNote, setEditingNote] = useState<{ cardId: string; note: string } | null>(null)
  const [tablePage, setTablePage] = useState(1)
  const TABLE_ITEMS_PER_PAGE = 10


  const fileInputRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const wsRetryRef = useRef<number | null>(null)
  const seenAlertIdsRef = useRef<Set<string>>(new Set())
  const navigate = useNavigate()

  const getToken = () => localStorage.getItem('adminToken') || ''

  const syncMaxBindDraft = (cards: CardData[]) => {
    setMaxBindDraftMap((prev) => {
      const next: Record<string, number> = {}
      for (const card of cards || []) {
        next[card.id] = typeof prev[card.id] === 'number' ? prev[card.id] : Number(card.maxBind || 1)
      }
      return next
    })
  }

  const enqueueAlerts = (list: AdminAlert[]) => {
    if (!Array.isArray(list) || list.length === 0) return
    const incoming: AdminAlert[] = []
    for (const a of list) {
      if (!a?.id) continue
      if (seenAlertIdsRef.current.has(a.id)) continue
      seenAlertIdsRef.current.add(a.id)
      incoming.push(a)
    }
    if (incoming.length > 0) {
      setAlertQueue((prev) => [...prev, ...incoming].slice(-30))
    }
  }

  const applyRealtimeSnapshot = (payload: any) => {
    const dash = payload?.dashboard
    const proxy = payload?.proxy
    const hist = Array.isArray(payload?.alerts) ? payload.alerts : []

    if (dash) {
      setData(dash)
      syncMaxBindDraft(dash.cards || [])
      setLoading(false)
      setError('')
    }
    if (proxy) setProxyData(proxy)
    if (hist.length > 0) {
      setAlerts(hist)
      for (const a of hist) {
        if (a?.id) seenAlertIdsRef.current.add(a.id)
      }
    }
  }

  const connectAdminWs = () => {
    const token = getToken()
    if (!token) return
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return
    if (wsRef.current && wsRef.current.readyState === WebSocket.CONNECTING) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setError('')
      ws.send(JSON.stringify({ type: 'auth', token }))
      if (wsRetryRef.current) {
        window.clearTimeout(wsRetryRef.current)
        wsRetryRef.current = null
      }
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || '{}'))
        if (msg?.type === 'auth_ok') {
          ws.send(JSON.stringify({ type: 'sub_log' }))
        } else if (msg?.type === 'snapshot') {
          applyRealtimeSnapshot(msg.data || {})
        } else if (msg?.type === 'alert' && msg?.data) {
          const next = msg.data as AdminAlert
          setAlerts((prev) => [...prev, next].slice(-200))
          enqueueAlerts([next])
        } else if (msg?.type === 'log' && msg?.data) {
          const entry = msg.data
          const line = `[${entry.timestamp}] [${entry.level?.toUpperCase()}] ${entry.tag ? `[${entry.tag}] ` : ''}${entry.message}`
          setRealtimeLogs((prev) => [...prev, line].slice(-500))
        }
      } catch { }
    }
    ws.onclose = () => {
      wsRef.current = null
      if (!wsRetryRef.current) {
        wsRetryRef.current = window.setTimeout(() => {
          wsRetryRef.current = null
          connectAdminWs()
        }, 1500)
      }
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  const fetchDashboard = async () => {
    try {
      const token = getToken()
      if (!token) {
        navigate('/admin')
        return
      }

      const [dashRes, proxyRes] = await Promise.all([
        fetch('/api/admin/dashboard', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/admin/proxy', { headers: { Authorization: `Bearer ${token}` } }),
      ])

      if (dashRes.status === 401 || proxyRes.status === 401) {
        localStorage.removeItem('adminToken')
        navigate('/admin')
        return
      }

      const dashJson = await dashRes.json().catch(() => null)
      const proxyJson = await proxyRes.json().catch(() => null)

      if (dashJson?.ok) {
        setData(dashJson.data)
        setError('')
        syncMaxBindDraft(dashJson.data.cards || [])
      } else {
        setError(dashJson?.error || '读取中控数据失败')
      }

      if (proxyJson?.ok) setProxyData(proxyJson.data)
    } catch (err: any) {
      setError(err?.message || '读取中控数据失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchLeaderboard = async () => {
    try {
      const token = getToken()
      if (!token) return
      const res = await fetch('/api/admin/leaderboard', { headers: { Authorization: `Bearer ${token}` } })
      const json = await res.json().catch(() => null)
      if (json?.ok) setLeaderboardData(json.data)
    } catch { }
  }

  const fetchSettings = async () => {
    const token = getToken()
    if (!token) return
    const res = await fetch('/api/admin/settings', { headers: { Authorization: `Bearer ${token}` } })
    const json = await res.json().catch(() => null)
    if (json?.ok) setSettings(json.data)
  }

  useEffect(() => {
    fetchDashboard()
    connectAdminWs()
    const timer = setInterval(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) fetchDashboard()
    }, 8000)
    return () => {
      clearInterval(timer)
      if (wsRetryRef.current) {
        window.clearTimeout(wsRetryRef.current)
        wsRetryRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (showSettings) fetchSettings()
  }, [showSettings])

  useEffect(() => {
    if (showLeaderboard) fetchLeaderboard()
  }, [showLeaderboard])

  const cardPages = useMemo(() => pageCount(data?.cards?.length || 0, CARDS_PER_PAGE), [data?.cards?.length])

  useEffect(() => {
    if (cardPage > cardPages) setCardPage(cardPages)
  }, [cardPage, cardPages])

  const visibleCards = useMemo(() => {
    const cards = data?.cards || []
    const start = (cardPage - 1) * CARDS_PER_PAGE
    return cards.slice(start, start + CARDS_PER_PAGE)
  }, [data?.cards, cardPage])

  const proxyGrouped = useMemo(() => {
    const result: Record<string, { proxyUrl: string; rawProxy: string; sessions: ProxySession[] }> = {}
    const configured = proxyData?.configRows?.length
      ? proxyData.configRows.map((x) => ({ show: x.masked, raw: x.raw }))
      : (proxyData?.pool?.proxies || []).map((x) => ({ show: x.proxyUrl, raw: x.proxyUrl }))
    for (const p of configured) {
      result[p.show] = { proxyUrl: p.show, rawProxy: p.raw, sessions: [] }
    }
    for (const s of proxyData?.sessions || []) {
      const key = s.proxy || '-'
      if (!result[key]) result[key] = { proxyUrl: key, rawProxy: key, sessions: [] }
      result[key].sessions.push(s)
    }
    return Object.values(result)
  }, [proxyData])

  const handleProxyAdd = async () => {
    const val = proxyInput.trim()
    if (!val) {
      alert('请输入代理，格式：host:port 或 socks5://user:pass@host:port')
      return
    }
    try {
      const res = await fetch('/api/admin/proxy/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ proxy: val }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '新增代理失败')
        return
      }
      setProxyInput('')
      fetchDashboard()
    } catch {
      alert('新增代理失败')
    }
  }

  const handleProxyRemove = async (rawOrMasked: string) => {
    if (!confirm(`确定删除代理：${rawOrMasked} ?`)) return
    try {
      const res = await fetch('/api/admin/proxy/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ proxy: rawOrMasked }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '删除代理失败')
        return
      }
      fetchDashboard()
    } catch {
      alert('删除代理失败')
    }
  }

  const handleUpdateProxyLimit = async (rawProxy: string, limit: number) => {
    try {
      const res = await fetch('/api/admin/proxy/limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ limits: { [rawProxy]: limit } }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '更新失败')
        return
      }
      setProxyData((prev) => prev ? { ...prev, configRows: json.data.rows } : null)
    } catch {
      alert('更新失败')
    }
  }

  const handleBatchUpdateProxyLimit = async () => {
    if (!proxyData?.configRows?.length) return
    const limit = Number(proxyLimitBatch) || 10
    if (!confirm(`确定将所有 ${proxyData.configRows.length} 个代理的负载上限设置为 ${limit}?`)) return

    const updates: Record<string, number> = {}
    for (const row of proxyData.configRows) {
      updates[row.raw] = limit
    }

    try {
      const res = await fetch('/api/admin/proxy/limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ limits: updates }),
      })
      const json = await res.json().catch(() => null)
      if (json?.ok) {
        setProxyData((prev) => prev ? { ...prev, configRows: json.data.rows } : null)
        alert('批量设置成功')
      } else {
        alert(json?.error || '批量设置失败')
      }
    } catch {
      alert('批量设置失败')
    }
  }

  const handleProxyReload = async () => {
    try {
      await fetch('/api/admin/proxy/reload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      fetchDashboard()
    } catch {
      alert('重载失败')
    }
  }

  const handleProxyExport = async () => {
    try {
      const res = await fetch('/api/admin/proxy/export', {
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '导出失败')
        return
      }
      const text = String(json?.data?.text || '')
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `proxies-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('导出失败')
    }
  }

  const handleProxyImport = async () => {
    if (!proxyImportText.trim()) {
      alert('请输入代理内容')
      return
    }
    try {
      const res = await fetch('/api/admin/proxy/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ text: proxyImportText, mode: proxyImportMode }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '导入失败')
        return
      }
      const r = json?.data?.result
      alert(`导入完成: 总数=${r?.total ?? '-'}，新增=${r?.added ?? '-'}，跳过=${r?.skipped ?? '-'}`)
      setProxyImportText('')
      setShowProxyImport(false)
      fetchDashboard()
    } catch {
      alert('导入失败')
    }
  }

  const handleProxyHealth = async () => {
    try {
      const res = await fetch('/api/admin/proxy/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ timeoutMs: 6000 }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '体检失败')
        return
      }
      const rows: ProxyHealthRow[] = Array.isArray(json?.data?.rows) ? json.data.rows : []
      const map: Record<string, ProxyHealthRow> = {}
      for (const row of rows) map[row.raw] = row
      setProxyHealthMap(map)
      setProxyHealthCheckedAt(Number(json?.data?.checkedAt || Date.now()))
    } catch {
      alert('体检失败')
    }
  }

  const getAccountPage = (cardId: string, total: number) => {
    const current = accountPageMap[cardId] || 1
    const max = pageCount(total, ACCOUNTS_PER_CARD_PAGE)
    return Math.min(current, max)
  }

  const setAccountPage = (cardId: string, next: number, total: number) => {
    const max = pageCount(total, ACCOUNTS_PER_CARD_PAGE)
    const val = Math.min(Math.max(1, next), max)
    setAccountPageMap((prev) => ({ ...prev, [cardId]: val }))
  }

  const handleSaveSettings = async () => {
    try {
      await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(settings),
      })
      setShowSettings(false)
      alert('设置已保存')
    } catch {
      alert('保存失败')
    }
  }

  /* New State for Card Export Modal */
  const [generatedCards, setGeneratedCards] = useState<string[]>([])
  const [showCardExport, setShowCardExport] = useState(false)

  const handleGenerate = async () => {
    try {
      const res = await fetch('/api/admin/card/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(genConfig),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '制卡失败')
        return
      }
      setShowGenerate(false)
      fetchDashboard()
      const cards = Array.isArray(json?.data?.cards) ? json.data.cards : [String(json?.data?.card || '')]
      setGeneratedCards(cards)
      setShowCardExport(true)
    } catch {
      alert('制卡失败')
    }
  }

  const handleCopyCards = () => {
    const text = generatedCards.join('\n')
    navigator.clipboard.writeText(text).then(() => alert('已复制到剪贴板')).catch(() => alert('复制失败'))
  }

  const handleUpdateMaxBind = async (cardId: string) => {
    const next = Math.min(Math.max(Number(maxBindDraftMap[cardId] || 1), 1), 50)
    try {
      const res = await fetch('/api/admin/card/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ id: cardId, maxBindAccounts: next }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '更新绑定数失败')
        return
      }
      fetchDashboard()
    } catch {
      alert('更新绑定数失败')
    }
  }

  const handleToggleCard = async (card: CardData) => {
    const nextStatus = card.status === 'active' ? 'disabled' : 'active'
    const action = nextStatus === 'disabled' ? '封停' : '解封'
    if (!confirm(`确认${action}卡密 ${card.id} ?`)) return

    try {
      const res = await fetch('/api/admin/card/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ id: card.id, status: nextStatus }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || `${action}失败`)
        return
      }
      fetchDashboard()
    } catch {
      alert(`${action}失败`)
    }
  }

  const handleCardOperation = async (operation: 'update' | 'delete', cardId: string, data: any) => {
    try {
      const endpoint = operation === 'delete' ? '/api/admin/card/delete' : '/api/admin/card/update'
      const payload = operation === 'delete' ? { id: cardId } : { id: cardId, ...data }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '操作失败')
        return
      }
      if (operation === 'delete') {
        // Optimistically remove from local state so card disappears immediately
        setData((prev) => prev ? {
          ...prev,
          cards: prev.cards.filter(c => c.id !== cardId)
        } : prev)
      } else {
        fetchDashboard()
      }
    } catch {
      alert('操作失败')
    }
  }

  const handleUploadBg = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async () => {
      const base64 = reader.result as string
      try {
        const res = await fetch('/api/admin/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ image: base64 }),
        })
        const json = await res.json().catch(() => null)
        if (json?.ok) {
          setSettings((prev) => ({ ...prev, backgroundImageUrl: json.data.url }))
          document.body.style.backgroundImage = `url(${json.data.url})`
          document.body.style.backgroundSize = 'cover'
          document.body.style.backgroundPosition = 'center'
          document.body.style.backgroundRepeat = 'no-repeat'
        } else {
          alert(json?.error || '上传失败')
        }
      } catch {
        alert('上传失败')
      }
    }
    reader.readAsDataURL(file)
  }

  const handleStopAccount = async (id: string, name: string) => {
    if (!confirm(`确定暂停账号脚本：${name} ?`)) return
    try {
      await fetch('/api/admin/account/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ id }),
      })
      fetchDashboard()
    } catch {
      alert('操作失败')
    }
  }

  const handleRemoveAccount = async (id: string, name: string) => {
    if (!confirm(`确定移除账号并解绑卡密：${name} ?`)) return
    try {
      const res = await fetch('/api/admin/account/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ id }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.ok) {
        alert(json?.error || '移除失败')
        return
      }
      fetchDashboard()
    } catch {
      alert('移除失败')
    }
  }

  const renderAccountTile = (acc: AccountSummary) => (
    <div key={acc.id} className={`admin-acc-tile ${acc.status === 'online' ? 'online' : 'offline'} alert-${getAlertLevel(acc)}`}>
      <div className="admin-acc-title">
        <span className={`dot ${acc.status === 'online' ? 'on' : 'off'}`} />
        <span className="admin-acc-name" title={acc.name}>{acc.name}</span>
      </div>
      <div className="admin-acc-meta">账号名称: {acc.name}</div>
      <div className="admin-acc-meta">{acc.platform === 'qq' ? 'QQ' : '微信'} · Lv{acc.level} · {accountIdentity(acc.platform, acc.qqNumber, acc.gid)}</div>
      <div className="admin-acc-meta">状态: {acc.status === 'online' ? '运行中' : '离线'} {acc.statusReason ? `(${acc.statusReason})` : ''}</div>
      <div className="admin-acc-meta">运行: {formatDuration(acc.runtimeSec)}</div>
      <div className="admin-acc-meta admin-acc-proxy" title={acc.proxy || '无代理'}>代理: {acc.proxy || '无'}</div>
      <div className="admin-acc-meta admin-acc-log" title={acc.latestLog || '-'}>{acc.latestLog || '-'}</div>
      <div className="admin-acc-actions">
        <button className="admin-mini-btn" onClick={() => handleStopAccount(acc.id, acc.name)}>暂停脚本</button>
        <button className="admin-mini-btn admin-mini-btn-danger" onClick={() => handleRemoveAccount(acc.id, acc.name)}>移除账号</button>
      </div>
    </div>
  )

  const renderCards = () => {
    if (!data?.cards?.length) return <div className="admin-empty">暂无卡密或绑定数据</div>

    return (
      <div className="admin-grid-section">
        <div className="admin-grid-3x3">
          {visibleCards.map((card) => {
            const accTotal = card.accounts.length
            const accPage = getAccountPage(card.id, accTotal)
            const accPages = pageCount(accTotal, ACCOUNTS_PER_CARD_PAGE)
            const start = (accPage - 1) * ACCOUNTS_PER_CARD_PAGE
            const visibleAcc = card.accounts.slice(start, start + ACCOUNTS_PER_CARD_PAGE)
            const expired = Boolean(card.expiresAt && Date.now() > card.expiresAt)

            // Fill with empty slots if less than 2
            const slots = [...visibleAcc]
            while (slots.length < 2) {
              slots.push(null as any)
            }

            return (
              <section key={card.id} className={`admin-card-layout ${expired ? 'is-expired' : ''} ${card.status === 'disabled' ? 'is-disabled' : ''}`}>
                {/* Top: Card Info */}
                <header className="admin-card-top">
                  <div className="admin-card-top-left">
                    <div className="admin-card-type">{card.type}</div>
                    <div className="admin-card-expire">到期: {card.expiresAt ? new Date(card.expiresAt).toLocaleDateString() : '永久'}</div>
                  </div>
                  <div className="admin-card-top-right">
                    <div className="admin-card-bind-edit">
                      <span>上限:</span>
                      <input
                        className="admin-bind-input"
                        type="number"
                        min={1}
                        max={50}
                        value={maxBindDraftMap[card.id] ?? card.maxBind}
                        onChange={(e) => setMaxBindDraftMap((prev) => ({ ...prev, [card.id]: Number(e.target.value) || 1 }))}
                      />
                      <button className="admin-mini-btn" onClick={() => handleUpdateMaxBind(card.id)}>保存</button>
                    </div>
                    <div className="admin-card-note" title={card.note || '无备注'}>{card.note || '无备注'}</div>
                  </div>
                </header>

                {/* Middle: Accounts (2 slots) */}
                <div className="admin-card-mid">
                  {slots.map((acc, idx) => (
                    <div key={idx} className="admin-acc-slot">
                      {acc ? renderAccountTile(acc) : <div className="admin-acc-empty-slot">空闲槽位</div>}
                    </div>
                  ))}
                </div>

                {/* Bottom: Operations & Pagination */}
                <div className="admin-card-bot">
                  <div className="admin-pager-simple">
                    <button className="admin-mini-btn" disabled={accPage <= 1} onClick={() => setAccountPage(card.id, accPage - 1, accTotal)}>◀</button>
                    <span>{accPage}/{accPages}</span>
                    <button className="admin-mini-btn" disabled={accPage >= accPages} onClick={() => setAccountPage(card.id, accPage + 1, accTotal)}>▶</button>
                  </div>
                  <div className="admin-card-actions">
                    <button className={`admin-mini-btn ${card.status === 'active' ? 'admin-mini-btn-warn' : 'admin-btn-ghost'}`} onClick={() => handleToggleCard(card)}>
                      {card.status === 'active' ? '封停' : '解封'}
                    </button>
                    <button className="admin-mini-btn admin-mini-btn-danger" onClick={() => { setDeleteConfirm({ cardId: card.id, cardType: card.type }) }}>删除</button>
                  </div>
                </div>
              </section>
            )
          })}
        </div>

        {/* Global Pagination for Cards */}
        <div className="admin-global-pager">
          <button className="admin-btn admin-btn-ghost" disabled={cardPage <= 1} onClick={() => setCardPage((p) => Math.max(1, p - 1))}>上一页</button>
          <span>卡密页 {cardPage}/{cardPages}</span>
          <button className="admin-btn admin-btn-ghost" disabled={cardPage >= cardPages} onClick={() => setCardPage((p) => Math.min(cardPages, p + 1))}>下一页</button>
        </div>
      </div>
    )
  }

  const popupAlert = alertQueue.length > 0 ? alertQueue[0] : null
  const closePopupAlert = () => setAlertQueue((prev) => prev.slice(1))

  return (
    <div className="app retro-bg">
      <div className="background-blur retro-overlay" />
      <div className="admin-shell admin-dashboard-shell admin-shell-wide">
        <header className="admin-panel admin-header-panel admin-header-v2">
          {/* Header content ... */}
          <div>
            <h1 className="admin-title">Farm 中控台</h1>
            <div className="admin-subtitle">在线脚本: {data?.totalSessions ?? 0}</div>
          </div>
          <div className="admin-proxy-brief">
            <div>代理池: {proxyData?.pool?.initialized ? '已初始化' : '未初始化'} / 数量 {proxyData?.pool?.total ?? 0}</div>
            <div>会话代理: {proxyData?.sessions?.length ?? 0}</div>
          </div>
          <div className="admin-actions">
            <button className="admin-btn" onClick={() => setShowGenerate(true)}>制卡</button>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowLeaderboard(true)}>🏆 排行榜</button>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowAlertPanel(true)}>告警中心{alerts.length ? `(${alerts.length})` : ''}</button>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowProxyModal(true)}>代理池弹窗</button>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowLogs(true)}>📜 日志</button>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowSettings(true)}>系统设置</button>
            <button className="admin-btn admin-btn-danger" onClick={() => { localStorage.removeItem('adminToken'); navigate('/admin') }}>退出</button>
          </div>
        </header>

        <main className="admin-panel admin-main-panel admin-main-fixed">
          {loading && !data ? <div className="admin-empty">加载中...</div> : null}
          {!loading && error ? <div className="admin-error">{error}</div> : null}
          {!loading && !error ? renderCards() : null}

          {/* 卡密管理表格 */}
          {!loading && !error && data?.cards?.length ? (
            <div className="admin-card-table-section">
              <h2 className="admin-section-title" style={{ marginBottom: '15px' }}>📋 卡密管理</h2>
              <div className="admin-card-table-wrapper" style={{ overflowX: 'auto' }}>
                <table className="admin-card-table" style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  background: 'rgba(0, 0, 0, 0.3)',
                  borderRadius: '8px',
                  overflow: 'hidden'
                }}>
                  <thead>
                    <tr style={{ background: 'rgba(76, 175, 80, 0.1)', borderBottom: '2px solid rgba(76, 175, 80, 0.3)' }}>
                      <th style={{ padding: '12px 8px', textAlign: 'left', fontSize: '0.9em', color: 'rgba(76, 175, 80, 0.9)' }}>卡密代码</th>
                      <th style={{ padding: '12px 8px', textAlign: 'left', fontSize: '0.9em', color: 'rgba(76, 175, 80, 0.9)' }}>类型</th>
                      <th style={{ padding: '12px 8px', textAlign: 'center', fontSize: '0.9em', color: 'rgba(76, 175, 80, 0.9)' }}>状态</th>
                      <th style={{ padding: '12px 8px', textAlign: 'left', fontSize: '0.9em', color: 'rgba(76, 175, 80, 0.9)' }}>到期时间</th>
                      <th style={{ padding: '12px 8px', textAlign: 'center', fontSize: '0.9em', color: 'rgba(76, 175, 80, 0.9)' }}>绑定数</th>
                      <th style={{ padding: '12px 8px', textAlign: 'center', fontSize: '0.9em', color: 'rgba(76, 175, 80, 0.9)' }}>在线数</th>
                      <th style={{ padding: '12px 8px', textAlign: 'left', fontSize: '0.9em', color: 'rgba(76, 175, 80, 0.9)' }}>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const tableStart = (tablePage - 1) * TABLE_ITEMS_PER_PAGE
                      const tableEnd = tableStart + TABLE_ITEMS_PER_PAGE
                      const paginatedCards = data.cards.slice(tableStart, tableEnd)

                      return paginatedCards.map((card) => {
                        const expired = Boolean(card.expiresAt && Date.now() > card.expiresAt)
                        return (
                          <tr
                            key={card.id}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              const menuHeight = 180 // 菜单大致高度
                              const windowHeight = window.innerHeight
                              const shouldOpenUpward = e.clientY + menuHeight > windowHeight
                              const menuY = shouldOpenUpward ? e.clientY - menuHeight : e.clientY
                              setContextMenu({ x: e.clientX, y: menuY, cardId: card.id })
                            }}
                            style={{
                              borderBottom: '1px solid rgba(76, 175, 80, 0.15)',
                              cursor: 'context-menu',
                              transition: 'background 0.2s',
                              background: card.status === 'disabled' ? 'rgba(255, 0, 0, 0.1)' : expired ? 'rgba(255, 165, 0, 0.1)' : 'transparent'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = 'rgba(76, 175, 80, 0.1)'
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = card.status === 'disabled' ? 'rgba(255, 0, 0, 0.1)' : expired ? 'rgba(255, 165, 0, 0.1)' : 'transparent'
                            }}
                          >
                            <td style={{ padding: '10px 8px', fontSize: '0.85em', fontFamily: 'monospace', color: 'rgba(150, 150, 150, 0.9)' }} title={card.code || card.id}>
                              {card.code || card.id.slice(0, 8)}
                            </td>
                            <td style={{ padding: '10px 8px', fontSize: '0.9em', color: 'rgba(200, 200, 200, 0.9)' }}>
                              {card.type}
                            </td>
                            <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                              <span style={{
                                padding: '4px 10px',
                                borderRadius: '12px',
                                fontSize: '0.8em',
                                fontWeight: 'bold',
                                background: card.status === 'active' ? 'rgba(76, 175, 80, 0.2)' : 'rgba(255, 0, 0, 0.2)',
                                color: card.status === 'active' ? '#4CAF50' : '#ff4444',
                                border: `1px solid ${card.status === 'active' ? 'rgba(76, 175, 80, 0.4)' : 'rgba(255, 0, 0, 0.4)'}`
                              }}>
                                {card.status === 'active' ? '启用' : '封停'}
                              </span>
                            </td>
                            <td style={{ padding: '10px 8px', fontSize: '0.85em', color: expired ? '#ff9800' : 'rgba(200, 200, 200, 0.9)' }}>
                              {card.expiresAt ? new Date(card.expiresAt).toLocaleString('zh-CN') : '永久有效'}
                            </td>
                            <td style={{ padding: '10px 8px', textAlign: 'center', fontSize: '0.9em', color: 'rgba(200, 200, 200, 0.9)' }}>
                              <span style={{ color: card.boundCount >= card.maxBind ? '#ff9800' : '#4CAF50' }}>
                                {card.boundCount}
                              </span>
                              <span style={{ opacity: 0.6 }}> / {card.maxBind}</span>
                            </td>
                            <td style={{ padding: '10px 8px', textAlign: 'center', fontSize: '0.9em', color: '#4CAF50', fontWeight: 'bold' }}>
                              {card.onlineCount}
                            </td>
                            <td style={{ padding: '10px 8px', fontSize: '0.85em', color: 'rgba(200, 200, 200, 0.7)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={card.note || ''}>
                              {card.note || '-'}
                            </td>
                          </tr>
                        )
                      })
                    })()}
                  </tbody>
                </table>
              </div>

              {/* 表格分页控件 */}
              <div style={{ marginTop: '15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <div style={{ fontSize: '0.85em', color: 'rgba(150, 150, 150, 0.7)' }}>
                  💡 提示：右键点击表格行可进行操作（封停/删除/修改绑定数/设置备注）
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <button
                    className="admin-btn admin-btn-ghost"
                    style={{ fontSize: '0.85em', padding: '6px 12px' }}
                    disabled={tablePage <= 1}
                    onClick={() => setTablePage(p => Math.max(1, p - 1))}
                  >
                    上一页
                  </button>
                  <span style={{ fontSize: '0.85em', color: 'rgba(200, 200, 200, 0.9)' }}>
                    第 {tablePage}/{Math.ceil(data.cards.length / TABLE_ITEMS_PER_PAGE)} 页
                  </span>
                  <button
                    className="admin-btn admin-btn-ghost"
                    style={{ fontSize: '0.85em', padding: '6px 12px' }}
                    disabled={tablePage >= Math.ceil(data.cards.length / TABLE_ITEMS_PER_PAGE)}
                    onClick={() => setTablePage(p => Math.min(Math.ceil(data.cards.length / TABLE_ITEMS_PER_PAGE), p + 1))}
                  >
                    下一页
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </main>

        {/* Unbound Accounts Section Removed as per User Request (Issue #5) */}

        {/* Leaderboard Modal */}
        {showLeaderboard && (
          <div className="admin-modal-mask" onClick={() => setShowLeaderboard(false)}>
            <section className="admin-panel admin-modal admin-modal-wide" onClick={(e) => e.stopPropagation()}>
              <h2 className="admin-modal-title">🏆 农场风云榜</h2>
              <div className="admin-leaderboard-grid">
                {['onlineTime', 'level', 'goldGain', 'expGain'].map((key) => {
                  const titleMap: any = { onlineTime: '⏱️ 在线时长', level: '🔝 等级排行', goldGain: '💰 金币收益', expGain: '📈 经验收益' }
                  const list = (leaderboardData as any)?.[key] || []
                  return (
                    <div key={key} className="leaderboard-col">
                      <h3>{titleMap[key]}</h3>
                      <div className="leaderboard-list">
                        {list.length === 0 ? <div className="admin-empty">暂无数据</div> : list.map((item: LeaderboardItem, i: number) => (
                          <div key={item.gid} className="leaderboard-item">
                            <span className={`lb-rank lb-rank-${i + 1}`}>{i + 1}</span>
                            <span className="lb-name" title={item.name}>{item.name}</span>
                            <span className="lb-val">{item.value > 10000 ? (item.value / 10000).toFixed(1) + 'w' : item.value} {item.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="admin-modal-actions">
                <button className="admin-btn" onClick={fetchLeaderboard}>刷新</button>
                <button className="admin-btn admin-btn-ghost" onClick={() => setShowLeaderboard(false)}>关闭</button>
              </div>
            </section>
          </div>
        )}

        {/* Card Export Modal (Issue #1) */}
        {showCardExport && (
          <div className="admin-modal-mask" onClick={() => setShowCardExport(false)}>
            <section className="admin-panel admin-modal" onClick={(e) => e.stopPropagation()}>
              <h2 className="admin-modal-title">制卡成功</h2>
              <div className="admin-card-export-area">
                <textarea
                  className="admin-textarea"
                  readOnly
                  value={generatedCards.join('\n')}
                  style={{ height: '200px' }}
                />
                <div className="admin-modal-actions">
                  <button className="admin-btn" onClick={handleCopyCards}>复制全部</button>
                  <button className="admin-btn admin-btn-ghost" onClick={() => setShowCardExport(false)}>关闭</button>
                </div>
              </div>
            </section>
          </div>
        )}

        {showProxyModal && (
          <div className="admin-modal-mask" onClick={() => setShowProxyModal(false)}>
            <section className="admin-panel admin-modal" onClick={(e) => e.stopPropagation()}>
              <h2 className="admin-modal-title">代理池管理</h2>
              <div className="admin-proxy-editor">
                <input
                  className="admin-input"
                  value={proxyInput}
                  onChange={(e) => setProxyInput(e.target.value)}
                  placeholder="host:port 或 socks5://user:pass@host:port"
                />
                <button className="admin-btn" onClick={handleProxyAdd}>新增</button>
                <button className="admin-btn admin-btn-ghost" onClick={handleProxyExport}>导出</button>
                <button className="admin-btn admin-btn-ghost" onClick={() => setShowProxyImport((v) => !v)}>导入</button>
                <button className="admin-btn admin-btn-ghost" onClick={handleProxyHealth}>体检</button>
                <button className="admin-btn admin-btn-ghost" onClick={handleProxyReload}>重载</button>
              </div>

              {showProxyImport ? (
                <div className="admin-proxy-import">
                  <div className="admin-proxy-import-head">
                    <label><input type="radio" checked={proxyImportMode === 'append'} onChange={() => setProxyImportMode('append')} /> 追加</label>
                    <label><input type="radio" checked={proxyImportMode === 'replace'} onChange={() => setProxyImportMode('replace')} /> 覆盖</label>
                  </div>
                  <textarea
                    className="admin-textarea admin-proxy-import-text"
                    value={proxyImportText}
                    onChange={(e) => setProxyImportText(e.target.value)}
                    placeholder={'每行一个代理\nhost:port\nsocks5://user:pass@host:port'}
                  />
                  <div className="admin-modal-actions">
                    <button className="admin-btn" onClick={handleProxyImport}>确认导入</button>
                    <button className="admin-btn admin-btn-ghost" onClick={() => setShowProxyImport(false)}>取消</button>
                  </div>
                </div>
              ) : (
                <div className="admin-proxy-list-modal">
                  <div className="admin-proxy-ctrl-row" style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
                    <label>批量设置负载上限:</label>
                    <input className="admin-input" type="number" min={1} style={{ width: '80px' }} value={proxyLimitBatch} onChange={(e) => setProxyLimitBatch(Number(e.target.value))} />
                    <button className="admin-btn admin-btn-sm" onClick={handleBatchUpdateProxyLimit}>应用全部</button>
                  </div>

                  {proxyHealthCheckedAt ? (
                    <div className="admin-proxy-health-tip">
                      上次体检: {new Date(proxyHealthCheckedAt).toLocaleString()}
                    </div>
                  ) : null}

                  {proxyGrouped.map((group) => {
                    const poolProxy = proxyData?.pool?.proxies?.find(p => p.proxyUrl === group.proxyUrl)
                    const health = proxyHealthMap[group.rawProxy]
                    return (
                      <div key={group.proxyUrl} className={`admin-proxy-group ${health?.ok === false ? 'is-bad' : ''}`}>
                        <div className="admin-proxy-group-head">
                          <div title={group.rawProxy} style={{ wordBreak: 'break-all' }}>{group.proxyUrl}</div>
                          <div>
                            {health ? (health.ok ? `✅ ${health.elapsedMs}ms` : `❌ ${health.error}`) : ''}
                            <span style={{ marginLeft: 10, fontSize: '0.85em', opacity: 0.8 }}>
                              上限:
                              <input
                                className="admin-mini-input"
                                type="number"
                                min={1}
                                style={{ width: '50px', marginLeft: '5px', padding: '2px 4px' }}
                                value={proxyLimitMap[group.rawProxy] ?? (proxyData?.configRows?.find(r => r.raw === group.rawProxy)?.maxUsers || 10)}
                                onChange={(e) => setProxyLimitMap(prev => ({ ...prev, [group.rawProxy]: Number(e.target.value) }))}
                                onBlur={(e) => {
                                  const val = Number(e.target.value) || 10
                                  if (val !== (proxyData?.configRows?.find(r => r.raw === group.rawProxy)?.maxUsers || 10)) {
                                    handleUpdateProxyLimit(group.rawProxy, val)
                                  }
                                }}
                              />
                            </span>
                            <button className="admin-mini-btn admin-mini-btn-danger" style={{ marginLeft: 8 }} onClick={() => handleProxyRemove(group.rawProxy)}>删除</button>
                          </div>
                        </div>
                        {poolProxy?.stats && (
                          <div className="admin-proxy-health-row">
                            成功 {poolProxy.stats.success} | 失败 {poolProxy.stats.fail} | 耗时 {poolProxy.stats.avgDuration}ms
                          </div>
                        )}
                        <div className="admin-proxy-sessions-modal">
                          {group.sessions.length ? group.sessions.map((s) => (
                            <div key={s.id} className="admin-proxy-row">
                              {s.name} ({accountIdentity(s.platform || 'qq', s.qqNumber, s.gid)}) · {formatDuration(s.runtimeSec)}
                            </div>
                          )) : <div className="admin-proxy-row">暂无会话</div>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="admin-modal-foot" style={{ marginTop: 10, textAlign: 'right' }}>
                <button className="admin-btn admin-btn-ghost" onClick={() => setShowProxyModal(false)}>关闭</button>
              </div>
            </section>
          </div>
        )}

        {
          showAlertPanel ? (
            <div className="admin-modal-mask" onClick={() => setShowAlertPanel(false)}>
              <section className="admin-panel admin-modal" onClick={(e) => e.stopPropagation()}>
                <h2 className="admin-modal-title">实时告警中心</h2>
                <div className="admin-alert-list">
                  {alerts.length ? [...alerts].slice().reverse().map((a) => (
                    <div key={a.id} className={`admin-alert-row ${a.level === 'critical' ? 'critical' : 'warn'}`}>
                      <div className="admin-alert-main">{a.message}</div>
                      <div className="admin-alert-sub">
                        {new Date(a.ts).toLocaleString()} · {a.kind} · {a.accountName} · {a.qqNumber ? `QQ:${a.qqNumber}` : `GID:${a.gid}`} {a.statusReason ? `· ${a.statusReason}` : ''}
                      </div>
                    </div>
                  )) : <div className="admin-empty">暂无告警</div>}
                </div>
                <div className="admin-actions">
                  <button className="admin-btn admin-btn-ghost" onClick={() => setShowAlertPanel(false)}>关闭</button>
                </div>
              </section>
            </div>
          ) : null
        }

        {
          showGenerate ? (
            <div className="admin-modal-mask" onClick={() => setShowGenerate(false)}>
              <section className="admin-panel admin-modal" onClick={(e) => e.stopPropagation()}>
                <h2 className="admin-modal-title">制卡</h2>
                <h2 className="admin-modal-title">制卡</h2>
                <label className="admin-label">卡密类型</label>
                <select className="admin-input" value={genConfig.type} onChange={(e) => {
                  const t = e.target.value
                  let d = 30
                  if (t === '测试卡') d = 0.25
                  else if (t === '1天卡') d = 1
                  else if (t === '3天卡') d = 3
                  else if (t === '5天卡') d = 5
                  else if (t === '周卡') d = 7
                  else if (t === '月卡') d = 30
                  else if (t === '永久卡') d = 999
                  else if (t === 'expansion') d = 0
                  setGenConfig((prev) => ({ ...prev, type: t, days: d }))
                }}>
                  <option>测试卡</option><option>1天卡</option><option>3天卡</option><option>5天卡</option><option>周卡</option><option>月卡</option><option>永久卡</option>
                  <option value="expansion">扩容卡 (增加绑定上限)</option>
                </select>

                {genConfig.type !== 'expansion' && (
                  <>
                    <label className="admin-label">有效天数 (测试卡0.25天)</label>
                    <input className="admin-input" type="number" min={0} step={0.01} value={genConfig.days} onChange={(e) => setGenConfig((prev) => ({ ...prev, days: Number(e.target.value) || 0 }))} />
                  </>
                )}

                <label className="admin-label">生成数量</label>
                <input className="admin-input" type="number" min={1} max={50} value={genConfig.count} onChange={(e) => setGenConfig((prev) => ({ ...prev, count: Number(e.target.value) || 1 }))} />

                <label className="admin-label">{genConfig.type === 'expansion' ? '增加绑定数 (默认+1)' : '最大绑定账号数（默认1）'}</label>
                <input className="admin-input" type="number" min={1} max={50} value={genConfig.maxBindAccounts} onChange={(e) => setGenConfig((prev) => ({ ...prev, maxBindAccounts: Number(e.target.value) || 1 }))} />
                <label className="admin-label">备注（可选）</label>
                <input className="admin-input" type="text" placeholder="为此卡密添加备注..." value={genConfig.note} onChange={(e) => setGenConfig((prev) => ({ ...prev, note: e.target.value }))} />
                <div className="admin-actions">
                  <button className="admin-btn admin-btn-ghost" onClick={() => setShowGenerate(false)}>取消</button>
                  <button className="admin-btn" onClick={handleGenerate}>生成</button>
                </div>
              </section>
            </div>
          ) : null
        }

        {
          showSettings ? (
            <div className="admin-modal-mask" onClick={() => setShowSettings(false)}>
              <section className="admin-panel admin-modal" onClick={(e) => e.stopPropagation()}>
                <h2 className="admin-modal-title">系统设置</h2>

                <h3 className="admin-section-title">界面配置</h3>
                <label className="admin-label">全局背景图</label>
                <div className="admin-upload-row">
                  <input className="admin-input" value={settings.backgroundImageUrl} readOnly />
                  <button className="admin-btn admin-btn-ghost" onClick={() => fileInputRef.current?.click()}>上传</button>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden-file" onChange={handleUploadBg} />
                </div>
                <label className="admin-label">卡密登录公告</label>
                <textarea className="admin-textarea" value={settings.noticeCardLogin} onChange={(e) => setSettings((prev) => ({ ...prev, noticeCardLogin: e.target.value }))} />
                <label className="admin-label">APP 登录说明</label>
                <textarea className="admin-textarea" value={settings.noticeAppLogin} onChange={(e) => setSettings((prev) => ({ ...prev, noticeAppLogin: e.target.value }))} />

                <h3 className="admin-section-title" style={{ marginTop: '20px' }}>机器人插件配置 (AstrBot)</h3>
                <div className="admin-switch-row" style={{ alignItems: 'center', marginBottom: '10px' }}>
                  <label className="admin-label" style={{ marginBottom: 0, marginRight: '10px' }}>启用机器人功能</label>
                  <label>
                    <input type="checkbox" checked={Boolean(settings.botConfig?.enabled)} onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, enabled: e.target.checked } }))} />
                    启用
                  </label>
                </div>
                <label className="admin-label">管理端地址 (供插件读取面板)</label>
                <input
                  className="admin-input"
                  type="text"
                  value={settings.botConfig?.adminUrl || ''}
                  onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, adminUrl: e.target.value } }))}
                  placeholder="例如: http://127.0.0.1:2222"
                />
                <label className="admin-label">QQ 群号 (多群用逗号分隔)</label>
                <input
                  className="admin-input"
                  type="text"
                  value={settings.botConfig?.groupIds || settings.botConfig?.groupId || ''}
                  onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, groupIds: e.target.value, groupId: e.target.value } }))}
                  placeholder="例如: 123456,789012"
                />
                <label className="admin-label">定时广告内容</label>
                <textarea className="admin-textarea" value={settings.botConfig?.adText || ''} onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, adText: e.target.value } }))} />
                <label className="admin-label">/buy 返回文案（支持换行）</label>
                <textarea className="admin-textarea" value={settings.botConfig?.buyText || ''} onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, buyText: e.target.value } }))} />
                <div className="admin-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div>
                    <label className="admin-label">随机榜单推送间隔 (秒)</label>
                    <input className="admin-input" type="number" min={30} value={settings.botConfig?.reportIntervalSec || 300} onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, reportIntervalSec: Number(e.target.value) || 300 } }))} />
                  </div>
                  <div>
                    <label className="admin-label">兼容间隔 (分钟，旧字段)</label>
                    <input className="admin-input" type="number" min={1} value={settings.botConfig?.adIntervalMin || 60} onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, adIntervalMin: Number(e.target.value) || 60 } }))} />
                  </div>
                </div>
                <div className="admin-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div>
                    <label className="admin-label">告警开关</label>
                    <label className="admin-switch-inline">
                      <input type="checkbox" checked={Boolean(settings.botConfig?.alertEnabled)} onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, alertEnabled: e.target.checked } }))} />
                      <span>启用告警消息推送</span>
                    </label>
                  </div>
                  <div>
                    <label className="admin-label">仅可@时发送告警</label>
                    <label className="admin-switch-inline">
                      <input type="checkbox" checked={Boolean(settings.botConfig?.alertOnlyWhenAtPossible)} onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, alertOnlyWhenAtPossible: e.target.checked } }))} />
                      <span>无 QQ 号则不推送</span>
                    </label>
                  </div>
                </div>
                <div className="admin-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div>
                    <label className="admin-label">续费提醒提前天数</label>
                    <input className="admin-input" type="number" value={settings.botConfig?.renewalReminderDays || 3} onChange={(e) => setSettings(prev => ({ ...prev, botConfig: { ...prev.botConfig, renewalReminderDays: Number(e.target.value) } }))} />
                  </div>
                </div>
                <p className="admin-hint" style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '10px' }}>注意：插件每约 15 秒热同步一次配置，无需重启。</p>

                <div className="admin-actions">
                  <button className="admin-btn admin-btn-ghost" onClick={() => setShowSettings(false)}>取消</button>
                  <button className="admin-btn" onClick={handleSaveSettings}>保存</button>
                </div>
              </section>
            </div>
          ) : null
        }

        {
          popupAlert ? (
            <div className="admin-alert-toast">
              <div className={`admin-alert-toast-inner ${popupAlert.level === 'critical' ? 'critical' : 'warn'}`}>
                <div className="admin-alert-toast-title">实时告警</div>
                <div className="admin-alert-toast-main">{popupAlert.message}</div>
                <div className="admin-alert-toast-sub">
                  {new Date(popupAlert.ts).toLocaleTimeString()} · {popupAlert.kind} · {popupAlert.qqNumber ? `QQ:${popupAlert.qqNumber}` : `GID:${popupAlert.gid}`}
                </div>
                <div className="admin-actions">
                  <button className="admin-btn admin-btn-ghost" onClick={() => setShowAlertPanel(true)}>查看历史</button>
                  <button className="admin-btn" onClick={closePopupAlert}>知道了</button>
                </div>
              </div>
            </div>
          ) : null
        }

        {
          showLogs ? (
            <div className="admin-modal-mask" onClick={() => setShowLogs(false)}>
              <section className="admin-panel admin-modal" style={{ width: '80%', maxWidth: '800px', height: '80vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
                <h2 className="admin-modal-title">实时终端日志</h2>
                <div className="terminal-container" style={{ flex: 1, border: '1px solid #334', background: '#0d1117', padding: '10px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px' }}>
                  {realtimeLogs.map((line, i) => (
                    <div key={i} style={{ color: line.includes('[ERROR]') ? '#ff6b6b' : line.includes('[WARN]') ? '#ffd93d' : '#eaf6ff', whiteSpace: 'pre-wrap' }}>{line}</div>
                  ))}
                  <div style={{ float: "left", clear: "both" }} ref={(el) => { el?.scrollIntoView({ behavior: "smooth" }); }}></div>
                </div>
                <div className="admin-actions" style={{ marginTop: '10px' }}>
                  <button className="admin-btn" onClick={() => setRealtimeLogs([])}>清空</button>
                  <button className="admin-btn admin-btn-ghost" onClick={() => setShowLogs(false)}>关闭</button>
                </div>
              </section>
            </div>
          ) : null
        }

        {/* 自定义右键菜单 */}
        {contextMenu && (
          <>
            <div
              style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
              onClick={() => setContextMenu(null)}
            />
            <div style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, background: 'rgba(30, 30, 30, 0.95)', border: '1px solid rgba(76, 175, 80, 0.3)', borderRadius: '6px', boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)', zIndex: 1000, minWidth: '180px', overflow: 'hidden' }}>
              {(() => {
                const card = data?.cards?.find(c => c.id === contextMenu.cardId)
                if (!card) return null
                return (
                  <>
                    <div style={{ padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid rgba(76, 175, 80, 0.1)', fontSize: '0.9em', color: card.status === 'active' ? '#ff6b6b' : '#4CAF50' }} onClick={() => { handleToggleCard(card); setContextMenu(null) }} onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(76, 175, 80, 0.15)' }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                      {card.status === 'active' ? '🚫 封停卡密' : '✅ 解除封停'}
                    </div>
                    <div style={{ padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid rgba(76, 175, 80, 0.1)', fontSize: '0.9em', color: 'rgba(200, 200, 200, 0.9)' }} onClick={() => { const newMax = prompt(`修改最大绑定数（当前: ${card.maxBind}）`, String(card.maxBind)); if (newMax && Number(newMax) > 0) { handleCardOperation('update', card.id, { maxBindAccounts: Number(newMax) }) }; setContextMenu(null) }} onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(76, 175, 80, 0.15)' }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                      📊 修改绑定数
                    </div>
                    <div style={{ padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid rgba(76, 175, 80, 0.1)', fontSize: '0.9em', color: 'rgba(200, 200, 200, 0.9)' }} onClick={() => { setEditingNote({ cardId: card.id, note: card.note || '' }); setContextMenu(null) }} onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(76, 175, 80, 0.15)' }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                      📝 设置备注
                    </div>
                    <div style={{ padding: '10px 16px', cursor: 'pointer', fontSize: '0.9em', color: '#ff4444' }} onClick={() => { setDeleteConfirm({ cardId: card.id, cardType: card.type }); setContextMenu(null) }} onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 68, 68, 0.15)' }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                      🗑️ 删除卡密
                    </div>
                  </>
                )
              })()}
            </div>
          </>
        )}

        {/* 删除确认弹窗 */}
        {deleteConfirm && (
          <div className="admin-modal-mask" onClick={() => setDeleteConfirm(null)}>
            <section className="admin-panel admin-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
              <h2 className="admin-modal-title" style={{ color: '#ff4444' }}>⚠️ 确认删除</h2>
              <p style={{ margin: '20px 0', color: 'rgba(200, 200, 200, 0.9)', lineHeight: '1.6' }}>
                确定要删除这张 <strong style={{ color: '#4CAF50' }}>{deleteConfirm.cardType}</strong> 卡密吗？<br /><span style={{ fontSize: '0.85em', opacity: 0.7 }}>此操作不可撤销！</span>
              </p>
              <div className="admin-actions">
                <button className="admin-btn admin-btn-ghost" onClick={() => setDeleteConfirm(null)}>取消</button>
                <button className="admin-btn" style={{ background: '#ff4444', borderColor: '#ff4444' }} onClick={() => { handleCardOperation('delete', deleteConfirm.cardId, {}); setDeleteConfirm(null) }}>确认删除</button>
              </div>
            </section>
          </div>
        )}

        {/* 备注编辑弹窗 */}
        {editingNote && (
          <div className="admin-modal-mask" onClick={() => setEditingNote(null)}>
            <section className="admin-panel admin-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
              <h2 className="admin-modal-title">📝 编辑备注</h2>
              <label className="admin-label">备注内容</label>
              <textarea className="admin-textarea" value={editingNote.note} onChange={(e) => setEditingNote({ ...editingNote, note: e.target.value })} placeholder="为卡密添加备注信息..." rows={4} style={{ resize: 'vertical', minHeight: '80px' }} />
              <div className="admin-actions">
                <button className="admin-btn admin-btn-ghost" onClick={() => setEditingNote(null)}>取消</button>
                <button className="admin-btn" onClick={() => { handleCardOperation('update', editingNote.cardId, { note: editingNote.note }); setEditingNote(null) }}>保存</button>
              </div>
            </section>
          </div>
        )}
      </div >
    </div >
  )
}
