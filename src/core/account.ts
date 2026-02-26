import { config } from '../config/index.js'
import { type QRLoginInfo, clearCode, loadCode, pollQRScanResultDetailed, requestQRLogin, saveCode } from '../protocol/login.js'
import { loadProto } from '../protocol/proto-loader.js'
import { loadCardDb } from '../api/card-store.js'
import { accountStore, registerSessionStore, removeSessionStore } from '../store/index.js'
import { log, logWarn } from '../utils/logger.js'
import { Session } from './session.js'

const sessions = new Map<string, Session>()
let nextId = 1

// Initialize nextId based on existing accounts
const existingIds = accountStore.getAccounts()
  .map(a => Number(a.id.split('-')[1]))
  .filter(n => !isNaN(n))
if (existingIds.length > 0) {
  nextId = Math.max(...existingIds) + 1
}

export function getSessions(): Map<string, Session> {
  return sessions
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)
}

function findAccountById(id: string) {
  return accountStore.getAccounts().find((a) => a.id === id)
}

function findAccountByGid(gid: number, excludeId?: string) {
  if (!gid) return undefined
  return accountStore.getAccounts().find((a) => a.id !== excludeId && Number(a.gid || 0) === gid)
}

function createSession(id: string, platform: 'qq' | 'wx'): Session {
  return new Session(id, platform, {
    onReconnectFailed: (failedId) => {
      logWarn('账号', `账号 ${failedId} 重连失败，自动暂停`)
      pauseAccount(failedId, 'reconnect_failed')
    },
    onRemoteLogin: (failedId, name) => {
      logWarn('账号', `账号 ${name || failedId} 异地登录，已暂停脚本`)
      pauseAccount(failedId, 'remote_login')
    },
  })
}

function accumulateRuntime(id: string) {
  const account = findAccountById(id)
  if (!account || account.status !== 'online' || !account.statusAt) return
  const now = Date.now()
  const segment = Math.floor((now - account.statusAt) / 1000)
  if (segment > 0) {
    const total = (account.totalRuntime || 0) + segment
    accountStore.updateAccount(id, { totalRuntime: total, lastRuntimeUpdateAt: now })
  }
}

async function startSessionWithRetry(session: Session, code: string, maxRetries = 3) {
  let lastError: any
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (i > 0) {
        // Re-create connection if retrying??
        // session.start() creates new Connection if strictly followed?
        // Let's check session.ts. session.start() calls this.conn.connect().
        // If connection failed, we might need to reset it?
        // session.start() usually initializes logic.
        // Actually, session.ts:start() just calls conn.connect(). 
        // If conn is in bad state, does it reset? 
        // Connection.connect() creates new WebSocket. So it should be fine.
      }
      await session.start(code)
      return
    } catch (e: any) {
      lastError = e
      // Check for fatal errors where retry is useless
      const msg = e.message || ''
      const isFatal = msg.includes('密码错误') || msg.includes('冻结') || msg.includes('封号') || msg.includes('失效')

      if (isFatal) throw e

      if (i < maxRetries - 1) {
        const delay = (i + 1) * 1500 + Math.random() * 1000 // 1.5s - 2.5s base increment
        logWarn('账号', `登录失败，${Math.round(delay)}ms 后重试 (${i + 1}/${maxRetries}): ${msg}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}

export async function addAccount(platform: 'qq' | 'wx', code: string, opts?: { uin?: string }): Promise<Session> {
  const id = `account-${nextId++}`
  const session = createSession(id, platform)
  registerSessionStore(id, session.store)

  accountStore.addAccount({
    id,
    platform,
    code,
    gid: 0,
    name: '连接中...',
    level: 0,
    status: 'connecting',
    statusReason: '',
    statusAt: Date.now(),
    totalRuntime: 0,
  })
  sessions.set(id, session)

  try {
    await loadProto()
    await startSessionWithRetry(session, code)
    const user = session.conn.userState
    const gid = Number(user.gid || 0)
    // QQ number comes from QR login API (not from game server proto)
    const qqNumber = opts?.uin || ''

    // Check if card is disabled
    if (gid > 0) {
      const db = loadCardDb()
      const card = db.cards.find(c => c.boundAccountGids?.includes(gid))
      if (card && card.status === 'disabled') {
        throw new Error('Card Disabled by Admin')
      }
    }

    const duplicated = findAccountByGid(gid, id)
    if (duplicated) {
      // Replace strategy: if same GID already exists, keep old slot and refresh it with new code/session.
      accumulateRuntime(duplicated.id)
      removeAccount(id)
      accountStore.updateAccount(duplicated.id, { code, qqNumber: qqNumber || duplicated.qqNumber || '', statusReason: '', statusAt: Date.now() })
      log('账号', `检测到同GID(${gid})，使用新登录凭据覆盖旧槽位: ${duplicated.name || duplicated.id}`)
      return await reloginAccount(duplicated.id)
    }
    accountStore.updateAccount(id, {
      gid,
      name: user.name,
      level: user.level,
      status: 'online',
      statusReason: '',
      statusAt: Date.now(),
      qqNumber,
    })
    if (platform === 'qq') saveCode(code, platform)
    return session
  } catch (e: any) {
    logWarn('账号', `连接失败: ${e.message}`)
    removeAccount(id)
    throw e
  }
}

export function pauseAccount(id: string, reason = 'paused'): void {
  accumulateRuntime(id)
  const session = sessions.get(id)
  if (session) {
    session.pauseAutomation(reason)
    sessions.delete(id)
  }
  accountStore.updateAccount(id, { status: 'offline', statusReason: reason, statusAt: Date.now() })
}

export async function reloginAccount(id: string): Promise<Session> {
  accumulateRuntime(id)
  const account = findAccountById(id)
  if (!account) throw new Error('account not found')
  const code = account.code
  if (!code) throw new Error('account code missing')

  const old = sessions.get(id)
  if (old) {
    old.stop()
    sessions.delete(id)
  }

  const session = createSession(id, account.platform)
  registerSessionStore(id, session.store)
  sessions.set(id, session)
  accountStore.updateAccount(id, { status: 'connecting', statusReason: '', statusAt: Date.now() })

  try {
    await loadProto()
    await startSessionWithRetry(session, code)
    const user = session.conn.userState
    const gid = Number(user.gid || 0)

    // Check if card is disabled
    if (gid > 0) {
      const db = loadCardDb()
      const card = db.cards.find(c => c.boundAccountGids?.includes(gid))
      if (card && card.status === 'disabled') {
        throw new Error('Card Disabled by Admin')
      }
    }

    const duplicated = findAccountByGid(gid, id)
    if (duplicated) {
      // New-login-first strategy: if conflict still exists while relogin,
      // keep current target slot and drop the other one.
      logWarn('账号', `重登命中同GID(${gid})冲突，保留当前槽位 ${id}，移除冲突槽位 ${duplicated.id}`)
      accumulateRuntime(duplicated.id)
      removeAccount(duplicated.id)
    }
    // Preserve existing qqNumber (game server proto has no uin field)
    const existingQQ = account.qqNumber || ''
    accountStore.updateAccount(id, {
      gid,
      name: user.name,
      level: user.level,
      status: 'online',
      statusReason: '',
      statusAt: Date.now(),
      qqNumber: existingQQ,
    })
    return session
  } catch (e: any) {
    sessions.delete(id)
    accountStore.updateAccount(id, { status: 'error', statusReason: 'relogin_failed', statusAt: Date.now() })
    throw e
  }
}

export function removeAccount(id: string): void {
  const session = sessions.get(id)
  if (session) {
    session.stop()
    sessions.delete(id)
  }
  accountStore.removeAccount(id)
  removeSessionStore(id)
}

export async function autoLogin(): Promise<Session | null> {
  if (config.platform === 'qq') {
    const savedCode = loadCode('qq')
    if (savedCode) {
      try {
        return await addAccount('qq', savedCode)
      } catch {
        clearCode()
      }
    }
  }
  return null
}

export async function loginWithQR(): Promise<{
  qrInfo: QRLoginInfo
  poll: () => Promise<Session>
}> {
  log('扫码登录', '正在获取二维码...')
  const qrInfo = await requestQRLogin()
  log('扫码登录', '二维码已生成，等待扫码...')
  return {
    qrInfo,
    poll: async () => {
      const ret = await pollQRScanResultDetailed(qrInfo.loginCode)
      const code = ret.code
      log('扫码登录', `获取成功，code=${code.substring(0, 8)}...`)
      const session = await addAccount('qq', code, { uin: ret.uin ? String(ret.uin) : '' })
      return session
    },
  }
}

export function stopAll(): void {
  for (const session of sessions.values()) {
    session.stop()
  }
  sessions.clear()
}
