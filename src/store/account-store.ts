import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ACCOUNT_DB_FILE = join(process.cwd(), '.farm-accounts.json')

export interface AccountInfo {
  id: string
  platform: 'qq' | 'wx'
  code: string
  qqNumber?: string
  gid?: number
  name: string
  level: number
  status: 'connecting' | 'online' | 'offline' | 'error'
  statusReason?: string
  statusAt?: number
  proxy?: string
  totalRuntime?: number // 累计运行时长 (秒)
  lastRuntimeUpdateAt?: number // 上次更新累计时常的时间戳
}

export class AccountStore extends EventEmitter {
  private accounts: AccountInfo[] = []
  private currentIndex = 0

  constructor() {
    super()
    this.load()
  }

  getAccounts(): readonly AccountInfo[] {
    return this.accounts
  }

  getCurrentAccount(): AccountInfo | undefined {
    return this.accounts[this.currentIndex]
  }

  getCurrentIndex(): number {
    return this.currentIndex
  }

  addAccount(account: AccountInfo): void {
    this.accounts.push(account)
    this.save()
    this.emit('change', 'accounts')
  }

  removeAccount(id: string): void {
    this.accounts = this.accounts.filter((a) => a.id !== id)
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1)
    }
    this.save()
    this.emit('change', 'accounts')
  }

  updateAccount(id: string, partial: Partial<AccountInfo>): void {
    const account = this.accounts.find((a) => a.id === id)
    if (account) {
      Object.assign(account, partial)
      this.save()
      this.emit('change', 'accounts')
    }
  }

  switchTo(index: number): void {
    if (index >= 0 && index < this.accounts.length) {
      this.currentIndex = index
      this.emit('change', 'currentAccount')
    }
  }

  private load() {
    if (existsSync(ACCOUNT_DB_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(ACCOUNT_DB_FILE, 'utf-8'))
        if (Array.isArray(raw)) {
          this.accounts = raw.map(a => ({
            ...a,
            status: 'offline', // 重启后默认为离线，等待重连或手动登录
            statusReason: 'server_restarted'
          }))
        }
      } catch (e) {
        console.error('Failed to load accounts:', e)
      }
    }
  }

  private save() {
    try {
      writeFileSync(ACCOUNT_DB_FILE, JSON.stringify(this.accounts, null, 2), 'utf-8')
    } catch (e) {
      console.error('Failed to save accounts:', e)
    }
  }
}
