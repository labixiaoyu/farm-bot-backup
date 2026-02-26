import { config, getDefaultAccountConfig, loadAccountConfig, updateAccountConfig } from '../config/index.js'
import type { AccountConfig } from '../config/schema.js'
import { Connection } from '../protocol/connection.js'
import { SessionStore } from '../store/session-store.js'
import { log, logWarn, onLog } from '../utils/logger.js'
import { EmailManager } from './email.js'
import { FarmManager } from './farm.js'
import { FriendManager } from './friend.js'
import { IllustratedManager } from './illustrated.js'
import { processInviteCodes } from './invite.js'
import { ProxyPool } from './proxy-pool.js'
import { QQVipManager } from './qqvip.js'
import { ShopManager } from './shop.js'
import { TaskManager } from './task.js'
import { WarehouseManager } from './warehouse.js'
import { WeatherManager } from './weather.js'

export interface SessionOptions {
  onReconnectFailed?: (id: string) => void
  onRemoteLogin?: (id: string, name: string) => void
}

export class Session {
  readonly conn: Connection
  readonly store: SessionStore
  readonly farm: FarmManager
  readonly friend: FriendManager
  readonly task: TaskManager
  readonly warehouse: WarehouseManager
  readonly illustrated: IllustratedManager
  readonly email: EmailManager
  readonly weather: WeatherManager
  readonly qqvip: QQVipManager
  readonly shop: ShopManager

  accountConfig: AccountConfig

  private logUnsub: (() => void) | null = null
  private code = ''
  private stopped = false
  private suspended = false
  private reconnecting = false
  private readonly options: SessionOptions

  constructor(
    readonly id: string,
    readonly platform: 'qq' | 'wx',
    options?: SessionOptions,
  ) {
    this.options = options ?? {}
    this.accountConfig = getDefaultAccountConfig()
    const getAccountConfig = () => this.accountConfig
    // ProxyPool.initAsync() should be called in main.ts
    const proxyUrl = ProxyPool.alloc()
    this.conn = new Connection(config, { proxyUrl })
    if (proxyUrl) log('代理池', `会话 ${id} 已分配 ${this.conn.getProxyUrlMasked() || proxyUrl}`)

    // Update store with proxy
    import('../store/index.js').then(({ accountStore }) => {
      accountStore.updateAccount(id, { proxy: proxyUrl || '' })
    })

    this.store = new SessionStore()
    const label = this.getAccountLabel()
    this.farm = new FarmManager(this.conn, this.store, getAccountConfig, label)
    this.friend = new FriendManager(this.conn, this.store, this.farm, getAccountConfig, label)
    this.task = new TaskManager(this.conn, this.store, label)
    this.warehouse = new WarehouseManager(this.conn, this.store, label)
    this.illustrated = new IllustratedManager(this.conn)
    this.email = new EmailManager(this.conn)
    this.weather = new WeatherManager(this.conn, this.store, label)
    this.qqvip = new QQVipManager(this.conn)
    this.shop = new ShopManager(this.conn, getAccountConfig, label)

    // Forward connection events to store
    this.conn.on('login', (state) => {
      this.store.updateUser(state)
      import('../store/index.js').then(({ accountStore }) => {
        accountStore.updateAccount(id, {
          qqNumber: String(state.uin || ''),
          name: state.name || '',
          level: state.level || 0
        })
      })
    })
    this.conn.on('stateChanged', (state) => this.store.updateUser(state))
    this.conn.on('goldChanged', (gold) => this.store.updateUser({ gold }))
    this.conn.on('expChanged', (exp) => this.store.updateUser({ exp }))

    // Handle connection errors and close to prevent unhandled EventEmitter errors
    this.conn.on('error', (err) => {
      logWarn('会话', `连接错误: ${err.message}`)
    })
    this.conn.on('close', () => {
      if (!this.stopped && !this.reconnecting && !this.suspended) {
        this.attemptReconnect()
      }
    })
    this.conn.on('remoteLogin', () => {
      this.pauseAutomation('remote_login')
      this.options.onRemoteLogin?.(this.id, this.conn.userState.name || this.id)
    })

    // Restore persisted daily stats
    this.store.restoreFriendStats()

    // Forward logs to current account store only.
    this.logUnsub = onLog((entry) => {
      const gid = this.conn.userState.gid
      const name = this.conn.userState.name

      const label = entry.accountLabel || ''
      // Allow match if Name matches OR if GID matches
      // If name is empty, we don't match on empty name unless label is also empty (which shouldn't happen for active accounts)
      const nameMatch = name && label === name
      const gidMatch = gid && label === `GID:${gid}`

      if (nameMatch || gidMatch) {
        this.store.pushLog(entry)
      }
    })
  }

  async start(code: string): Promise<void> {
    try {
      this.code = code
      this.stopped = false
      this.suspended = false
      log('会话', `连接中... platform=${this.platform}`, this.getAccountLabel())
      await this.conn.connect(code)

      // Load per-account config
      const gid = this.conn.userState.gid
      if ((gid || 0) > 0) {
        this.accountConfig = loadAccountConfig(gid || 0)
        log('配置', `已加载账号配置 GID=${gid}`)
      }

      // Process invite codes (WX only)
      await processInviteCodes(this.conn)

      // 立即执行一次数据获取，确保前端能够快速看到真实数据
      log('会话', '立即执行数据初始化...', this.getAccountLabel())
      await Promise.all([
        this.farm.checkFarm().catch((e) => {
          logWarn('农场', `初始化失败: ${e.message}`)
          this.store.updateLands([])
        }),
        this.friend.checkFriends().catch((e) => {
          logWarn('好友', `初始化失败: ${e.message}`)
          this.store.updateFriendList([], 0)
        }),
        this.warehouse
          .getBag()
          .then((bag) => {
            const items = bag.item_bag?.items?.length ? bag.item_bag.items : bag.items || []
            this.store.updateBag(items)
          })
          .catch((e) => {
            logWarn('仓库', `初始化失败: ${e.message}`)
            this.store.updateBag([])
          }),
        this.task.checkAndClaimTasks().catch((e) => {
          logWarn('任务', `初始化失败: ${e.message}`)
          this.store.updateTaskList([])
        }),
      ])

      // Start all loops with original delays
      this.startManagers()

      log('会话', '所有模块已启动', this.getAccountLabel())
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  getAccountLabel(): string {
    const gid = this.conn.userState.gid
    const name = this.conn.userState.name
    if (gid && name) return name
    if (gid) return `GID:${gid}`
    return this.id
  }

  getProxyUrl(): string | undefined {
    return this.conn.getProxyUrl()
  }

  updateAccountConfig(partial: Partial<AccountConfig>): AccountConfig {
    const gid = this.conn.userState.gid
    if ((gid || 0) > 0) {
      this.accountConfig = updateAccountConfig(gid || 0, partial)
    } else {
      Object.assign(this.accountConfig, partial)
    }
    return this.accountConfig
  }

  stop(): void {
    this.stopped = true
    this.suspended = false
    this.stopManagers()
    const p = this.conn.getProxyUrl()
    if (p) ProxyPool.release(p)
    this.conn.close()
    if (this.logUnsub) {
      this.logUnsub()
      this.logUnsub = null
    }
    log('会话', '已停止')
  }

  pauseAutomation(reason = 'paused'): void {
    this.suspended = true
    this.stopManagers()
    const p = this.conn.getProxyUrl()
    if (p) ProxyPool.release(p)
    this.conn.close()
    logWarn('会话', `脚本已暂停: ${reason}`)
  }

  private async checkCardStatus(): Promise<boolean> {
    const gid = this.conn.userState.gid
    if (!gid) return true

    // Dynamically import to avoid circular dependency issues if any
    const { loadCardDb } = await import('../api/card-store.js')
    const db = loadCardDb()

    // Find card that binds this GID
    const card = db.cards.find(c => (c.boundAccountGids || []).includes(gid))

    if (!card) {
      this.pauseAutomation('No Card Bound')
      return false
    }

    if (card.status === 'disabled') {
      this.pauseAutomation('Card Disabled')
      return false
    }

    if (card.expiresAt && Date.now() > card.expiresAt) {
      this.pauseAutomation('Card Expired')
      return false
    }

    return true
  }

  private startManagers(): void {
    // Start a periodic check
    const checkLoop = async () => {
      // Give some time for initial binding to complete (especially for new accounts)
      await new Promise(r => setTimeout(r, 10000))
      while (!this.stopped && !this.suspended) {
        try {
          if (!(await this.checkCardStatus())) break
        } catch (e: any) {
          logWarn('会话', `卡密检查异常: ${e.message}`)
        }
        await new Promise(r => setTimeout(r, 60000)) // Check every minute
      }
    }
    checkLoop()

    this.farm.start()
    this.friend.start()
    this.task.start()
    this.warehouse.start()
    this.illustrated.start()
    this.email.start()
    this.weather.start()
    this.qqvip.start()
    this.shop.start()
  }

  private stopManagers(): void {
    this.farm.stop()
    this.friend.stop()
    this.task.stop()
    this.warehouse.stop()
    this.illustrated.stop()
    this.email.stop()
    this.weather.stop()
    this.qqvip.stop()
    this.shop.stop()
  }

  private async attemptReconnect(): Promise<void> {
    const maxRetries = 2
    const proxyRotateAfter = 0 // Rotate proxy immediately on every retry
    const delay = 1500
    this.reconnecting = true
    this.stopManagers()

    for (let i = 1; i <= maxRetries; i++) {
      // After proxyRotateAfter failures, try swapping to a different proxy
      if (i > proxyRotateAfter) {
        const oldProxy = this.conn.getProxyUrl()
        if (oldProxy) {
          ProxyPool.markFailed(oldProxy)
          ProxyPool.release(oldProxy)
          // Allocate new proxy, excluding the old one (Strict -> Relaxed fallback)
          const newProxy = ProxyPool.alloc(oldProxy)
          if (newProxy) {
            this.conn.setProxyUrl(newProxy)
            log('重连', `代理已切换: ${this.conn.getProxyUrlMasked()}`)
            // Update account store with new proxy
            import('../store/index.js').then(({ accountStore }) => {
              accountStore.updateAccount(this.id, { proxy: newProxy })
            })
          } else {
            logWarn('重连', '无可用替代代理，继续使用原代理')
          }
        }
      }

      log('重连', `第 ${i}/${maxRetries} 次尝试，${delay / 1000}s 后重连...`)
      await new Promise((r) => setTimeout(r, delay))

      if (this.stopped) {
        this.reconnecting = false
        return
      }

      try {
        this.conn.cleanup()
        await this.conn.connect(this.code)
        await processInviteCodes(this.conn)
        this.startManagers()
        log('重连', '重连成功，所有模块已恢复')
        this.reconnecting = false
        return
      } catch (e: any) {
        logWarn('重连', `第 ${i} 次失败: ${e.message}`)
      }
    }

    this.reconnecting = false
    logWarn('重连', `${maxRetries} 次重连全部失败`)
    this.options.onReconnectFailed?.(this.id)
  }
}
