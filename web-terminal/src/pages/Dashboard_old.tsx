﻿import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../App.css'
import { clearAuthToken, getAuthToken } from '../auth'

const API_BASE_URL = '/api'
const LOGS_PAGE_SIZE = 18
const TOTAL_LANDS = 24
const PHASE_MATURE = 6
const PHASE_DEAD = 7
const DEBUG_FARM_PROGRESS = false

type Account = {
  id: string
  platform: 'qq' | 'wx'
  qqNumber?: string
  name: string
  level: number
  status: 'connecting' | 'online' | 'offline' | 'error'
  statusReason?: string
  statusAt?: number
  totalRuntime?: number
}

type User = {
  gid: number
  name: string
  level: number
  gold: number
  exp: number
  coin?: number
  expCurrent?: number
  expNeeded?: number
  expPercent?: number
  expProgress?: { current: number; needed: number }
  income?: { gold: number; exp: number }
}

type Land = {
  id: number
  level: number
  unlocked: boolean
  plant?: {
    id: number
    name: string
    grow_sec?: number
    base_grow_sec?: number
    base_grow_sec_direct?: number
    base_grow_sec_by_seed?: number
    progressPercent?: number
    remainSec?: number
    phases: { phase: number; begin_time: number }[]
    dry_num: number
    weed_owners?: number[]
    insect_owners?: number[]
    mutant_config_ids?: number[]
    stole_num: number
    fruit_num: number
    left_fruit_num: number
    stealers?: number[]
  }
}

type Item = { id: number; count: number; name: string }
type Task = { id: number; desc: string; isUnlocked: boolean; isClaimed: boolean; progress: number; totalProgress: number }
type Friend = { gid: number; name: string; level: number }
type FriendStats = { weed: number; bug: number; water: number; steal: number }
type FriendProgress = { current: number; total: number }
type LogRow = { timestamp: string; tag: string; message: string }
type LogsPayload = LogRow[] | { rows?: LogRow[]; total?: number }
type AuthProfile = {
  cardId: string
  userId: string
  cardType: '1天卡' | '3天卡' | '5天卡' | '周卡' | '月卡' | '永久卡'
  expiresAt?: number
  maxBindAccounts: number
  boundAccountCount: number
}

type AccountConfig = {
  manualSeedId: number
  forceLowestLevelCrop: boolean
  autoReplantMode: 'levelup' | 'always' | false
  replantProtectPercent: number
  useOrganicFertilizer: boolean
  autoRefillFertilizer: boolean
  enablePutBadThings: boolean
  autoClaimFreeGifts: boolean
}

type SeedOption = {
  plantId: number
  seedId: number
  name: string
  landLevelNeed: number
}



const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
  manualSeedId: 0,
  forceLowestLevelCrop: false,
  autoReplantMode: 'levelup',
  replantProtectPercent: 80,
  useOrganicFertilizer: false,
  autoRefillFertilizer: false,
  enablePutBadThings: false,
  autoClaimFreeGifts: true,
}

const REPLANT_MODE_OPTIONS: Array<{ value: AccountConfig['autoReplantMode']; label: string }> = [
  { value: 'levelup', label: '升级时' },
  { value: 'always', label: '始终' },
  { value: false, label: '关闭' },
]

function isFatalPausedReason(reason?: string): boolean {
  return reason === 'remote_login' || reason === 'reconnect_failed'
}

function getFatalPauseTitle(reason?: string): string {
  if (reason === 'reconnect_failed') return '账号 Code 失效'
  return '账号异地登录'
}

function getFatalPauseMessage(account: Account | null): string {
  if (!account) return ''
  if (account.statusReason === 'reconnect_failed') {
    return `账号 [${account.name || account.id}] Code 已失效，已暂停该账号脚本。是否重新登录该账号？`
  }
  return `检测到账号 [${account.name || account.id}] 在其他地方登录，已暂停该账号脚本。是否重新登录该账号？`
}

const LAND_LEVEL_NAMES: Record<number, string> = {
  1: '普通',
  2: '红土',
  3: '黑土',
  4: '金土',
}

const LAND_LEVEL_CLASS: Record<number, string> = {
  1: 'is-normal',
  2: 'is-red',
  3: 'is-black',
  4: 'is-gold',
}

async function apiPost<T>(path: string, body?: any): Promise<T> {
  const token = getAuthToken()
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })

  const json = await response.json().catch(() => null)
  if (response.status === 401) {
    clearAuthToken()
    throw new Error('UNAUTHORIZED')
  }
  if (!response.ok) throw new Error(json?.error ? `${response.status} ${json.error}` : `${response.status}`)
  if (!json?.ok) throw new Error(json?.error || 'request failed')
  return json.data as T
}

function formatRemain(sec: number): string {
  if (sec <= 0) return '0s'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h${m}m${s}s`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

function formatDuration(sec: number): string {
  if (sec <= 0) return '0s'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h${m}m${s}s`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

function normalizeTaskDesc(desc: string): string {
  const raw = String(desc || '').trim()
  if (!raw) return raw
  const lines = raw
    .split(/\r?\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (lines.length <= 1) return lines[0]
  const uniq: string[] = []
  for (const line of lines) {
    if (!uniq.includes(line)) uniq.push(line)
  }
  return uniq[0]
}

function formatAccountIdentity(platform: 'qq' | 'wx' | undefined, qqNumber: string | undefined, gid: number | undefined): string {
  if (platform === 'qq' && qqNumber) return `QQ:${qqNumber}`
  return `GID:${Number(gid || 0)}`
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [user, setUser] = useState<User>({ gid: 0, name: '未登录', level: 0, gold: 0, exp: 0 })
  const [lands, setLands] = useState<Land[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [friends, setFriends] = useState<Friend[]>([])
  const [friendStats, setFriendStats] = useState<FriendStats>({ weed: 0, bug: 0, water: 0, steal: 0 })
  const [friendProgress, setFriendProgress] = useState<FriendProgress>({ current: 0, total: 0 })
  const [logs, setLogs] = useState<LogRow[]>([])
  const [logPage, setLogPage] = useState(0)
  const [logTotal, setLogTotal] = useState(0)
  const [serverTimeSec, setServerTimeSec] = useState(0)
  const [syncAtMs, setSyncAtMs] = useState(0)
  const [tick, setTick] = useState(0)
  const [switchLockUntil, setSwitchLockUntil] = useState(0)
  const [pausing, setPausing] = useState(false)
  const [relogging, setRelogging] = useState(false)
  const [authProfile, setAuthProfile] = useState<AuthProfile | null>(null)

  const [dashboardRunSec, setDashboardRunSec] = useState(0)
  const [remoteAlert, setRemoteAlert] = useState<Account | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [accountConfig, setAccountConfig] = useState<AccountConfig>(DEFAULT_ACCOUNT_CONFIG)
  const [seedPickerOpen, setSeedPickerOpen] = useState(false)
  const [seedLoading, setSeedLoading] = useState(false)
  const [seedOptions, setSeedOptions] = useState<SeedOption[]>([])

  const [expansionOpen, setExpansionOpen] = useState(false)
  const [expansionCode, setExpansionCode] = useState('')
  const [expansionRedeeming, setExpansionRedeeming] = useState(false)
  const [systemSettings, setSystemSettings] = useState<any>({})

  const remoteAlertHandledAtRef = useRef<Record<string, number>>({})
  const accountsRef = useRef<Account[]>([])
  const currentAccountStatusRef = useRef<Account['status'] | undefined>(undefined)
  const remoteAlertRef = useRef<Account | null>(null)

  const currentAccount = accounts[currentIndex]
  const currentAccountIdRef = useRef('')
  const switchLocked = Date.now() < switchLockUntil

  useEffect(() => {
    currentAccountIdRef.current = currentAccount?.id || ''
  }, [currentAccount?.id])

  useEffect(() => {
    accountsRef.current = accounts
  }, [accounts])

  useEffect(() => {
    currentAccountStatusRef.current = currentAccount?.status
  }, [currentAccount?.status])

  useEffect(() => {
    remoteAlertRef.current = remoteAlert
  }, [remoteAlert])

  useEffect(() => {
    let timer: number | null = null
    let stopped = false
    let lastSec = Math.floor(Date.now() / 1000)

    const schedule = () => {
      const delay = 1000 - (Date.now() % 1000) + 2
      timer = window.setTimeout(tickOnce, delay)
    }

    const tickOnce = () => {
      if (stopped) return
      const now = Math.floor(Date.now() / 1000)
      const delta = now - lastSec
      lastSec = now
      if (delta > 0) {
        setTick((v) => v + 1)
        if (!remoteAlertRef.current) {
          if (currentAccountStatusRef.current === 'online') {
            setDashboardRunSec((v) => v + delta)
          }
        }
      }
      schedule()
    }

    schedule()
    return () => {
      stopped = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!switchLockUntil) return
    const left = switchLockUntil - Date.now()
    if (left <= 0) return
    const timer = window.setTimeout(() => setSwitchLockUntil(0), left + 20)
    return () => window.clearTimeout(timer)
  }, [switchLockUntil])

  const nowSec = useMemo(() => {
    if (!serverTimeSec) return Math.floor(Date.now() / 1000)
    return serverTimeSec + Math.floor((Date.now() - syncAtMs) / 1000)
  }, [serverTimeSec, syncAtMs, tick])

  const handleUnauthorized = () => {
    clearAuthToken()
    navigate('/', { replace: true })
  }

  const redirectToLoginAfterReloginFail = (message?: string) => {
    const reason = (message || '重新登录失败，请在登录页重新获取登录凭据').trim()
    navigate('/login', { replace: true, state: { reloginFailed: true, reason } })
  }

  const loadAccounts = async () => {
    try {
      const data = await apiPost<Account[]>('/account/list')
      const list = data || []
      setAccounts(list)
      for (const a of list) {
        if (a.status !== 'offline' || !isFatalPausedReason(a.statusReason)) continue
        const at = Number(a.statusAt || 0)
        const handled = remoteAlertHandledAtRef.current[a.id] || 0
        if (at > handled) {
          setRemoteAlert(a)
          break
        }
      }
      if (currentIndex >= list.length) setCurrentIndex(0)
      if (list.length === 0) navigate('/login', { replace: true })
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    }
  }

  const loadAuthProfile = async () => {
    try {
      const data = await apiPost<AuthProfile>('/auth/profile')
      setAuthProfile(data || null)
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    }
  }

  const loadAccountConfig = async (accountId: string) => {
    try {
      const data = await apiPost<AccountConfig>('/account/config/get', { id: accountId })
      if (accountId !== currentAccountIdRef.current) return
      setAccountConfig({ ...DEFAULT_ACCOUNT_CONFIG, ...(data || {}) })
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    }
  }

  const updateAccountConfig = async (patch: Partial<AccountConfig>) => {
    if (!currentAccount?.id) return
    const id = currentAccount.id
    const next = { ...accountConfig, ...patch }
    setAccountConfig(next)
    try {
      setSettingsSaving(true)
      const saved = await apiPost<AccountConfig>('/account/config/update', { id, config: patch })
      if (id !== currentAccountIdRef.current) return
      setAccountConfig({ ...DEFAULT_ACCOUNT_CONFIG, ...(saved || next) })
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
      await loadAccountConfig(id)
    } finally {
      setSettingsSaving(false)
    }
  }

  const loadSeedOptions = async () => {
    try {
      setSeedLoading(true)
      const rows = await apiPost<SeedOption[]>('/system/seeds')
      setSeedOptions(Array.isArray(rows) ? rows : [])
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    } finally {
      setSeedLoading(false)
    }
  }

  const loadSystemSettings = async () => {
    try {
      const data = await apiPost<any>('/system/settings')
      setSystemSettings(data || {})
    } catch (e) {
      console.error('failed to load settings', e)
    }
  }

  const handleRedeemExpansion = async () => {
    if (!expansionCode.trim()) return
    try {
      setExpansionRedeeming(true)
      const res = await apiPost<{ message: string; profile?: AuthProfile }>('/auth/redeem', { code: expansionCode })
      alert(res?.message || '扩容成功')
      setExpansionOpen(false)
      setExpansionCode('')
      if (res?.profile) setAuthProfile(res.profile)
      else loadAuthProfile()
    } catch (e: any) {
      alert(e.message || '扩容失败')
    } finally {
      setExpansionRedeeming(false)
    }
  }



  const loadFarm = async (accountId: string) => {
    try {
      const data = await apiPost<{ lands: Land[]; user: User; serverTimeSec?: number }>('/farm/status', { accountId })
      if (accountId !== currentAccountIdRef.current) return

      setLands(Array.isArray(data.lands) ? data.lands : [])
      setUser(data.user || { gid: 0, name: '未知', level: 0, gold: 0, exp: 0 })

      if (typeof data.serverTimeSec === 'number' && data.serverTimeSec > 0) {
        setServerTimeSec(data.serverTimeSec)
        setSyncAtMs(Date.now())
      }
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    }
  }

  const loadBag = async (accountId: string) => {
    try {
      const data = await apiPost<{ items: Item[] }>('/warehouse/bag', { accountId })
      if (accountId !== currentAccountIdRef.current) return
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    }
  }

  const loadTasks = async (accountId: string) => {
    try {
      const data = await apiPost<{ tasks: Task[] }>('/task/list', { accountId })
      if (accountId !== currentAccountIdRef.current) return
      setTasks(Array.isArray(data.tasks) ? data.tasks : [])
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    }
  }

  const loadFriends = async (accountId: string) => {
    try {
      const data = await apiPost<{ friends: Friend[]; progress: FriendProgress; stats: FriendStats }>('/friend/list', { accountId })
      if (accountId !== currentAccountIdRef.current) return
      setFriends(Array.isArray(data.friends) ? data.friends : [])
      setFriendProgress(data.progress || { current: 0, total: 0 })
      setFriendStats(data.stats || { weed: 0, bug: 0, water: 0, steal: 0 })
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    }
  }

  const loadLogs = async (accountId?: string) => {
    try {
      const data = await apiPost<LogsPayload>('/system/logs', { limit: 5000, offset: 0, accountId })
      if (Array.isArray(data)) {
        setLogs(data)
        setLogTotal(data.length)
      } else {
        const rows = Array.isArray(data?.rows) ? data.rows : []
        setLogs(rows)
        setLogTotal(typeof data?.total === 'number' ? data.total : rows.length)
      }
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    }
  }

  useEffect(() => {
    loadAccounts()
    loadAuthProfile()
    loadSystemSettings() // Load settings for buy link

    const timer = setInterval(() => {
      loadAccounts()
      loadAuthProfile()

    }, 3000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!currentAccount?.id) return
    setLogPage(0)

    loadFarm(currentAccount.id)
    loadBag(currentAccount.id)
    loadTasks(currentAccount.id)
    loadFriends(currentAccount.id)
    loadLogs(currentAccount.id)

    const timer = setInterval(() => {
      loadFarm(currentAccount.id)
      loadBag(currentAccount.id)
      loadTasks(currentAccount.id)
      loadFriends(currentAccount.id)
      loadLogs(currentAccount.id)
    }, 5000)

    return () => clearInterval(timer)
  }, [currentAccount?.id])

  useEffect(() => {
    if (!settingsOpen || !currentAccount?.id) return
    loadAccountConfig(currentAccount.id)
  }, [settingsOpen, currentAccount?.id])

  useEffect(() => {
    if (!seedPickerOpen) return
    if (seedOptions.length > 0) return
    loadSeedOptions()
  }, [seedPickerOpen])

  const maxLogPage = useMemo(() => Math.max(0, Math.ceil(logTotal / LOGS_PAGE_SIZE) - 1), [logTotal])

  const logRows = useMemo(() => {
    const end = Math.max(0, logs.length - logPage * LOGS_PAGE_SIZE)
    const start = Math.max(0, end - LOGS_PAGE_SIZE)
    const rows = logs.slice(start, end)
    const pad = Array.from({ length: Math.max(0, LOGS_PAGE_SIZE - rows.length) }, () => null)
    return [...rows, ...pad]
  }, [logs, logPage])

  useEffect(() => {
    if (logPage > maxLogPage) setLogPage(maxLogPage)
  }, [logPage, maxLogPage])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const up = e.key === 'ArrowUp' || e.code === 'Numpad8'
      const down = e.key === 'ArrowDown' || e.code === 'Numpad2'
      if (!up && !down) return

      e.preventDefault()
      if (up) setLogPage((p) => Math.min(maxLogPage, p + 1))
      if (down) setLogPage((p) => Math.max(0, p - 1))
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [maxLogPage])

  const allLands = useMemo(() => {
    const byId = new Map<number, Land>()
    for (const land of lands) byId.set(land.id, land)
    return Array.from({ length: TOTAL_LANDS }, (_, i) => byId.get(i + 1) || { id: i + 1, level: 1, unlocked: false })
  }, [lands])

  const unlockedCount = allLands.filter((x) => x.unlocked).length
  const plantedCount = allLands.filter((x) => x.unlocked && x.plant?.phases?.length).length
  const farmTitle = `农场 (${plantedCount}/${unlockedCount}块已种植，总${TOTAL_LANDS}块)`

  const expCurrent = Math.max(0, user.expProgress?.current ?? user.expCurrent ?? 0)
  const expNeeded = Math.max(0, user.expProgress?.needed ?? user.expNeeded ?? 0)
  const expPercent = expNeeded > 0 ? Math.max(0, Math.min(100, user.expPercent ?? Math.round((expCurrent / expNeeded) * 100))) : 0
  const couponCount = useMemo(
    () => (items || []).filter((it) => it.name.includes('点券')).reduce((sum, it) => sum + (it.count || 0), 0),
    [items],
  )
  const filteredBagItems = useMemo(() => {
    const hiddenIds = new Set<number>([1, 2, 1001, 1101])
    const hiddenNameKeywords = ['金币', '点券', '经验', '种植经验', '普通收藏点', '收藏点']
    return (items || []).filter((it) => {
      if (hiddenIds.has(it.id)) return false
      const n = String(it.name || '')
      return !hiddenNameKeywords.some((k) => n.includes(k))
    })
  }, [items])
  const displayedTasks = useMemo(() => {
    const dailyKeywords = ['每日登录游戏', '采摘1次果实', '在1个好友农场进行互动']
    const nonDaily = (tasks || []).filter((t) => !dailyKeywords.some((k) => t.desc.includes(k)))
    const uniq = new Map<string, Task>()
    for (const t of nonDaily) {
      const key = `${t.desc}|${t.totalProgress}`
      const prev = uniq.get(key)
      if (!prev || t.progress > prev.progress) uniq.set(key, t)
    }
    return Array.from(uniq.values()).slice(0, 1)
  }, [tasks])
  const primaryTask = displayedTasks[0]

  const addDisabledByBind = !!authProfile && authProfile.maxBindAccounts > 0 && authProfile.boundAccountCount >= authProfile.maxBindAccounts
  const cardExpireText = authProfile?.expiresAt ? new Date(authProfile.expiresAt).toLocaleString() : '永久'

  const handleSwitchAccount = (idx: number) => {
    if (switchLocked || idx === currentIndex) return
    setCurrentIndex(idx)
    setSwitchLockUntil(Date.now() + 5000)
  }

  const handlePauseCurrentAccount = async () => {
    if (!currentAccount?.id || pausing) return
    if (!window.confirm(`确认暂停当前帐号脚本: ${currentAccount.name || currentAccount.id} ?`)) return

    try {
      setPausing(true)
      await apiPost('/account/pause', { id: currentAccount.id })
      await loadAccounts()
    } catch (e: any) {
      if (String(e?.message || '').includes('UNAUTHORIZED')) handleUnauthorized()
    } finally {
      setPausing(false)
    }
  }

  const handleResumeCurrentAccount = async () => {
    if (!currentAccount?.id || relogging) return
    if (currentAccount.status !== 'offline') return
    try {
      setRelogging(true)
      await apiPost('/account/relogin', { id: currentAccount.id })
      await loadAccounts()
      await loadFarm(currentAccount.id)
      await loadBag(currentAccount.id)
      await loadTasks(currentAccount.id)
      await loadFriends(currentAccount.id)
      await loadLogs(currentAccount.id)
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (msg.includes('UNAUTHORIZED')) handleUnauthorized()
      else redirectToLoginAfterReloginFail(msg)
    } finally {
      setRelogging(false)
    }
  }

  const handleReloginCurrentAccount = async () => {
    if (!currentAccount?.id || relogging) return
    try {
      setRelogging(true)
      await apiPost('/account/relogin', { id: currentAccount.id })
      await loadAccounts()
      await loadFarm(currentAccount.id)
      await loadBag(currentAccount.id)
      await loadTasks(currentAccount.id)
      await loadFriends(currentAccount.id)
      await loadLogs(currentAccount.id)
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (msg.includes('UNAUTHORIZED')) handleUnauthorized()
      else redirectToLoginAfterReloginFail(msg)
    } finally {
      setRelogging(false)
    }
  }

  const handleRemoteRelogin = async () => {
    if (!remoteAlert?.id) return
    try {
      setRelogging(true)
      await apiPost('/account/relogin', { id: remoteAlert.id })
      remoteAlertHandledAtRef.current[remoteAlert.id] = Date.now()
      setRemoteAlert(null)
      await loadAccounts()
      if (currentAccount?.id === remoteAlert.id) {
        await loadFarm(remoteAlert.id)
        await loadBag(remoteAlert.id)
        await loadTasks(remoteAlert.id)
        await loadFriends(remoteAlert.id)
        await loadLogs(remoteAlert.id)
      }
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (msg.includes('UNAUTHORIZED')) handleUnauthorized()
      else redirectToLoginAfterReloginFail(msg)
    } finally {
      setRelogging(false)
    }
  }

  const handleRemoteStay = () => {
    if (remoteAlert?.id) {
      remoteAlertHandledAtRef.current[remoteAlert.id] = Date.now()
    }
    setRemoteAlert(null)
  }

  // 计算当前账号的脚本运行时长（基于 statusAt + nowSec）
  // statusAt 是 UTC 时间戳 (ms)，nowSec 是基于 serverTimeSec 校准后的秒数
  // 注意: statusAt 可能是 0 或 undefined

  return (
    <div className="app retro-bg">
      <div className="background-blur retro-overlay" />

      <div className="retro-shell">
        <div className="retro-panel retro-tabs">
          {accounts.map((a, i) => (
            <button
              key={a.id}
              className={`retro-tab ${i === currentIndex ? 'active' : ''} ${switchLocked ? 'locked' : ''}`}
              onClick={() => handleSwitchAccount(i)}
              disabled={switchLocked}
            >
              [{i + 1}] {a.name || '未命名'}({a.platform.toUpperCase()})
            </button>
          ))}
          <button
            className="retro-tab muted"
            onClick={() => {
              if (addDisabledByBind) {
                setExpansionOpen(true)
              } else {
                navigate('/login')
              }
            }}
            title={addDisabledByBind ? '已达到最大绑定数，点击使用扩容卡' : '添加账号'}
          >
            {addDisabledByBind ? '[↑] 扩容账号' : '[+] 添加账号'}
          </button>
          <button
            className="retro-tab muted"
            onClick={handlePauseCurrentAccount}
            disabled={!currentAccount?.id || pausing}
          >
            [||] {pausing ? '暂停中...' : '暂停当前帐号脚本'}
          </button>
          <button
            className="retro-tab muted"
            onClick={handleResumeCurrentAccount}
            disabled={!currentAccount?.id || relogging || currentAccount?.status !== 'offline'}
            title={currentAccount?.status === 'offline' ? '继续运行当前账号脚本' : '仅离线/暂停状态可继续'}
          >
            [▶] {relogging ? '继续中...' : '继续当前帐号脚本'}
          </button>
          <button
            className="retro-tab muted"
            onClick={handleReloginCurrentAccount}
            disabled={!currentAccount?.id || relogging}
          >
            [↻] {relogging ? '重登中...' : '重新登录当前帐号'}
          </button>
          <button
            className="retro-tab accent"
            onClick={() => setSettingsOpen(true)}
            disabled={!currentAccount?.id}
            title="打开当前账号设置"
          >
            [⚙] 配置
          </button>
        </div>

        <div className="retro-panel retro-status">
          <span>{currentAccount?.platform?.toUpperCase() || 'QQ'} {user.name} ({formatAccountIdentity(currentAccount?.platform, currentAccount?.qqNumber, user.gid)})</span>
          <span>Lv{user.level}</span>
          <span className="gold">金币 {user.gold.toLocaleString()}</span>
          <span className="gold">点券 {couponCount.toLocaleString()}</span>
          <div className="status-exp">
            <span>经验</span>
            <span className="status-exp-bar"><i style={{ width: `${expPercent}%` }} /></span>
            <span className="status-exp-text">{expNeeded > 0 ? `(${expCurrent}/${expNeeded})` : '(--/--)'}</span>
          </div>
          <div className="retro-income">
            <span>本次收益: <span className="gold">+{user.income?.gold || 0} 金币</span> / <span className="exp">+{user.income?.exp || 0} 经验</span></span>
          </div>
          <div className="retro-runtime-pack">
            <span>当前账号挂机时长: {formatDuration((currentAccount?.totalRuntime || 0) + dashboardRunSec)}</span>
          </div>
        </div>

        <div className="retro-panel retro-card-info">
          <span className="retro-meta">卡密类型: {authProfile?.cardType || '-'}</span>
          <span className="retro-meta">卡密到期时间: {cardExpireText}</span>
          <span className="retro-meta">该卡密最大绑定账号数: {authProfile?.maxBindAccounts ?? '-'}</span>
          <span className="retro-meta">已绑定账号数: {authProfile?.boundAccountCount ?? '-'}</span>
          <span className="retro-meta">用户编号: {authProfile?.userId || '-'}</span>
        </div>

        <div className="retro-main">
          <section className="retro-panel retro-farm">
            <h3>{farmTitle}</h3>
            <div className="retro-grid">
              {allLands.map((land) => {
                const levelName = LAND_LEVEL_NAMES[land.level] || `L${land.level}`
                const levelClass = LAND_LEVEL_CLASS[land.level] || ''
                const plant = land.plant

                if (!land.unlocked) {
                  return (
                    <div key={land.id} className="retro-land">
                      <div className="line1">#{String(land.id).padStart(2, '0')} 未解锁</div>
                      <div className="line4">&nbsp;</div>
                    </div>
                  )
                }

                if (!plant || !plant.phases?.length) {
                  return (
                    <div key={land.id} className="retro-land">
                      <div className="line1">#{String(land.id).padStart(2, '0')} <span className={levelClass}>{levelName}</span> 空地</div>
                      <div className="line4">&nbsp;</div>
                    </div>
                  )
                }

                const phases = plant.phases
                let current = phases[0]
                for (let i = phases.length - 1; i >= 0; i--) {
                  if (phases[i].begin_time > 0 && phases[i].begin_time <= nowSec) {
                    current = phases[i]
                    break
                  }
                }

                let pct = 0
                let remain = '--'
                let dbgStart = 0
                let dbgMature = 0
                let dbgRemainSec = -1
                let dbgBaseGrow = Number(plant.base_grow_sec || 0)
                const dbgBaseDirect = Number(plant.base_grow_sec_direct || 0)
                const dbgBaseBySeed = Number(plant.base_grow_sec_by_seed || 0)
                let dbgSource = 'server'
                if (typeof plant.progressPercent === 'number') {
                  pct = Math.max(0, Math.min(100, Math.round(plant.progressPercent)))
                }
                if (typeof plant.remainSec === 'number') {
                  dbgRemainSec = Math.max(0, Math.round(plant.remainSec))
                  remain = formatRemain(dbgRemainSec)
                }
                // Live refresh every second using local server-time clock.
                const mature = phases.find((p) => p.phase === PHASE_MATURE)
                const matureAt = mature?.begin_time || 0
                const baseGrow = Number(plant.base_grow_sec || 0)
                if (matureAt > 0) {
                  const remainLive = Math.max(0, matureAt - nowSec)
                  dbgRemainSec = remainLive
                  remain = formatRemain(remainLive)
                  if (baseGrow > 0) {
                    pct = Math.max(0, Math.min(100, Math.round(((baseGrow - remainLive) / baseGrow) * 100)))
                  }
                }
                // Fallback for old/abnormal payloads: compute from phase timestamps.
                if (remain === '--' && current.phase !== PHASE_MATURE && current.phase !== PHASE_DEAD) {
                  const start = phases[0]?.begin_time || 0
                  dbgStart = start
                  dbgMature = matureAt
                  if (matureAt > start && start > 0) {
                    dbgSource = 'fallback'
                    dbgRemainSec = Math.max(0, matureAt - nowSec)
                    remain = formatRemain(dbgRemainSec)
                    pct = Math.max(0, Math.min(100, Math.round(((nowSec - start) / (matureAt - start)) * 100)))
                  }
                }
                if (dbgStart === 0 || dbgMature === 0) {
                  const mature = phases.find((p) => p.phase === PHASE_MATURE)
                  dbgStart = phases[0]?.begin_time || 0
                  dbgMature = mature?.begin_time || 0
                }

                const flags = [
                  plant.dry_num > 0 ? `缺水x${plant.dry_num}` : '',
                  (plant.weed_owners?.length || 0) > 0 ? '杂草' : '',
                  (plant.insect_owners?.length || 0) > 0 ? '虫害' : '',
                  (plant.mutant_config_ids?.length || 0) > 0 ? '变异' : '',
                ].filter(Boolean)

                return (
                  <div key={land.id} className="retro-land">
                    <div className="line1">#{String(land.id).padStart(2, '0')} <span className={levelClass}>{levelName}</span> {plant.name}</div>
                    {current.phase === PHASE_MATURE ? (
                      <div className="line2 mature">可收获</div>
                    ) : current.phase === PHASE_DEAD ? (
                      <div className="line2 dead">已枯萎</div>
                    ) : (
                      <div className="line2">
                        <span className="bar"><i style={{ width: `${pct}%` }} /></span>
                        <span className="pct">{pct}%</span>
                      </div>
                    )}
                    <div className="line3">
                      <span className="remain-label">剩余</span>
                      <span className="remain-val">{remain}</span>
                      {flags.length ? <span className="line3-status">{flags.join(' ')}</span> : null}
                    </div>
                    <div className="line4">
                      {DEBUG_FARM_PROGRESS ? `DBG id:${plant.id} s:${dbgStart} m:${dbgMature} n:${nowSec} b:${dbgBaseGrow}(d:${dbgBaseDirect}/s:${dbgBaseBySeed}) r:${dbgRemainSec} p:${pct}% src:${dbgSource}` : '\u00A0'}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <aside className="retro-side">
            <section className="retro-panel">
              <h3>背包</h3>
              {filteredBagItems.slice(0, 12).map((it) => (
                <div key={`${it.id}-${it.name}`} className="kv"><span>{it.name}</span><b>x{it.count}</b></div>
              ))}
            </section>

            <section className="retro-panel">
              <h3>任务</h3>
              <div className="task-head">可领 {displayedTasks.filter((t) => t.isUnlocked && !t.isClaimed && t.progress >= t.totalProgress).length} / 总 {displayedTasks.length}</div>
              {primaryTask ? (
                <div className="task-row">
                  {primaryTask.isClaimed ? '✓' : primaryTask.isUnlocked ? '•' : '·'} {normalizeTaskDesc(primaryTask.desc)} ({primaryTask.progress}/{primaryTask.totalProgress})
                </div>
              ) : null}
            </section>
          </aside>
        </div>

        <section className="retro-panel retro-friends">
          <h3>好友 ({friends.length}人) 巡查 {friendProgress.current}/{friendProgress.total}</h3>
          <div className="friend-stats-inline">
            <span>除草 {friendStats.weed}</span>
            <span>除虫 {friendStats.bug}</span>
            <span>浇水 {friendStats.water}</span>
            <span>偷菜 {friendStats.steal}</span>
          </div>
          <div className="friend-list-grid">
            {friends.map((f) => (
              <div key={f.gid} className="friend-chip">
                <span className="friend-chip-name" title={f.name}>{f.name}</span>
                <span className="friend-chip-lv">Lv{f.level}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="retro-panel retro-logs">
          <h3>日志 {maxLogPage > 0 ? `(第${logPage + 1}/${maxLogPage + 1}页 · ↑上翻 ↓下翻)` : ''}</h3>
          <div className="log-box">
            {logRows.map((row, i) => (
              row ? (
                <div key={`${row.timestamp}-${i}`} className="log-line">
                  <span className="time">{row.timestamp}</span>
                  <span className="tag">[{row.tag}]</span>
                  <span className="msg">{row.message}</span>
                </div>
              ) : (
                <div key={`empty-${i}`} className="log-line empty">&nbsp;</div>
              )
            ))}
          </div>
        </section>


      </div>
      {settingsOpen && currentAccount ? (
        <div className="retro-modal-mask">
          <div className="retro-panel retro-modal retro-settings-modal">
            <h3>设置（{currentAccount.name || currentAccount.id}）</h3>
            <div className="retro-settings-note">鼠标切换开关/拖动滑块，修改实时保存 {settingsSaving ? '· 保存中...' : ''}</div>
            <div className="retro-settings-grid">
              <div className="retro-setting-row">
                <label>手动种子ID（0=自动）</label>
                <div className="retro-setting-inline">
                  <input
                    className="retro-setting-number"
                    type="number"
                    min={0}
                    max={99999}
                    step={1}
                    value={accountConfig.manualSeedId}
                    onChange={(e) => updateAccountConfig({ manualSeedId: Math.max(0, Math.min(99999, Number(e.target.value) || 0)) })}
                  />
                  <button className="retro-setting-link" onClick={() => setSeedPickerOpen(true)}>
                    查看种子ID
                  </button>
                </div>
              </div>

              <div className="retro-setting-row">
                <label>强制最低等级作物</label>
                <label className="retro-toggle">
                  <input
                    type="checkbox"
                    checked={!!accountConfig.forceLowestLevelCrop}
                    onChange={(e) => updateAccountConfig({ forceLowestLevelCrop: e.target.checked })}
                  />
                  <span className="retro-toggle-slider" />
                </label>
              </div>

              <div className="retro-setting-row">
                <label>换种模式</label>
                <select
                  className="retro-setting-select"
                  value={String(accountConfig.autoReplantMode)}
                  onChange={(e) => {
                    const v = e.target.value
                    updateAccountConfig({ autoReplantMode: v === 'false' ? false : (v as 'levelup' | 'always') })
                  }}
                >
                  {REPLANT_MODE_OPTIONS.map((op) => (
                    <option key={String(op.value)} value={String(op.value)}>
                      {op.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="retro-setting-row">
                <label>换种保护（{accountConfig.replantProtectPercent}%）</label>
                <input
                  className="retro-setting-range"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={accountConfig.replantProtectPercent}
                  onChange={(e) => updateAccountConfig({ replantProtectPercent: Number(e.target.value) || 0 })}
                />
              </div>

              <div className="retro-setting-row">
                <label>有机肥料</label>
                <label className="retro-toggle">
                  <input
                    type="checkbox"
                    checked={!!accountConfig.useOrganicFertilizer}
                    onChange={(e) => updateAccountConfig({ useOrganicFertilizer: e.target.checked })}
                  />
                  <span className="retro-toggle-slider" />
                </label>
              </div>

              <div className="retro-setting-row">
                <label>自动补充肥料</label>
                <label className="retro-toggle">
                  <input
                    type="checkbox"
                    checked={!!accountConfig.autoRefillFertilizer}
                    onChange={(e) => updateAccountConfig({ autoRefillFertilizer: e.target.checked })}
                  />
                  <span className="retro-toggle-slider" />
                </label>
              </div>

              <div className="retro-setting-row">
                <label>放虫放草</label>
                <label className="retro-toggle">
                  <input
                    type="checkbox"
                    checked={!!accountConfig.enablePutBadThings}
                    onChange={(e) => updateAccountConfig({ enablePutBadThings: e.target.checked })}
                  />
                  <span className="retro-toggle-slider" />
                </label>
              </div>

              <div className="retro-setting-row">
                <label>自动领取礼包</label>
                <label className="retro-toggle">
                  <input
                    type="checkbox"
                    checked={!!accountConfig.autoClaimFreeGifts}
                    onChange={(e) => updateAccountConfig({ autoClaimFreeGifts: e.target.checked })}
                  />
                  <span className="retro-toggle-slider" />
                </label>
              </div>
            </div>
            <div className="retro-modal-actions">
              <button className="retro-auth-btn secondary" onClick={() => setSettingsOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {seedPickerOpen ? (
        <div className="retro-modal-mask">
          <div className="retro-panel retro-modal retro-seed-modal">
            <h3>种子ID对照表</h3>
            <div className="retro-settings-note">点击一项即可回填“手动种子ID”</div>
            <div className="retro-seed-list">
              {seedLoading ? <div className="retro-seed-row">加载中...</div> : null}
              {!seedLoading &&
                seedOptions.slice(0, 200).map((s) => (
                  <button
                    key={`${s.seedId}-${s.plantId}`}
                    className="retro-seed-row"
                    onClick={() => {
                      updateAccountConfig({ manualSeedId: s.seedId })
                      setSeedPickerOpen(false)
                    }}
                  >
                    <span>#{s.seedId}</span>
                    <span>{s.name}</span>
                    <span>需地块Lv{s.landLevelNeed}</span>
                  </button>
                ))}
            </div>
            <div className="retro-modal-actions">
              <button className="retro-auth-btn secondary" onClick={() => setSeedPickerOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {expansionOpen ? (
        <div className="retro-modal-mask">
          <div className="retro-panel retro-modal">
            <h3>账号额度扩容</h3>
            <div className="retro-modal-body">
              <p style={{ marginBottom: '10px' }}>当前已绑定 {authProfile?.boundAccountCount}/{authProfile?.maxBindAccounts} 个账号。</p>
              <p style={{ marginBottom: '15px', color: '#aaa' }}>如需添加更多账号，请使用扩容卡增加绑定上限。</p>

              {systemSettings?.noticeCardLogin && (
                <div className="retro-settings-note" style={{ marginBottom: '15px', whiteSpace: 'pre-wrap' }}>
                  {systemSettings.noticeCardLogin}
                </div>
              )}

              <input
                className="retro-input"
                autoFocus
                placeholder="请输入扩容卡密..."
                value={expansionCode}
                onChange={(e) => setExpansionCode(e.target.value)}
              />
            </div>
            <div className="retro-modal-actions">
              <button className="retro-auth-btn" onClick={handleRedeemExpansion} disabled={expansionRedeeming}>
                {expansionRedeeming ? '兑换中...' : '立即扩容'}
              </button>
              <button className="retro-auth-btn secondary" onClick={() => setExpansionOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {remoteAlert ? (
        <div className="retro-modal-mask">
          <div className="retro-panel retro-modal">
            <h3>{getFatalPauseTitle(remoteAlert.statusReason)}</h3>
            <div className="retro-modal-body">{getFatalPauseMessage(remoteAlert)}</div>
            <div className="retro-modal-actions">
              <button className="retro-auth-btn" onClick={handleRemoteRelogin} disabled={relogging}>
                {relogging ? '重登中...' : '是，重新登录该账号'}
              </button>
              <button className="retro-auth-btn secondary" onClick={handleRemoteStay} disabled={relogging}>
                否，保持暂停
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

