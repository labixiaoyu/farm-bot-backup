import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import qrcodeTerminal from 'qrcode-terminal'

const QRLIB_BASE_URL = 'http://127.0.0.1:11451'
const CODE_FILE = join(process.cwd(), '.farm-code.json')

type QrCheckStatus = {
  status: 'Wait' | 'OK' | 'Used' | 'Error'
  ticket?: string
  uin?: string
}

async function requestLoginCode(): Promise<{ loginCode: string; url: string }> {
  try {
    const response = await axios.post(`${QRLIB_BASE_URL}/api/qr/create`, { preset: 'farm' })
    const { success, qrsig, url } = response.data || {}
    if (!success || !qrsig || !url) throw new Error('获取QQ扫码登录码失败')
    return { loginCode: qrsig, url }
  } catch (e: any) {
    if (e.code === 'ECONNREFUSED') {
      throw new Error('QRLib 服务未启动 (端口 11451)，请检查 qrlib 服务状态')
    }
    throw e
  }
}

export async function queryScanStatus(loginCode: string): Promise<QrCheckStatus> {
  try {
    const response = await axios.post(`${QRLIB_BASE_URL}/api/qr/check`, {
      qrsig: loginCode,
      preset: 'farm',
    })
    if (response.status !== 200) return { status: 'Error' }

    const { success, ret, code, uin } = response.data || {}
    if (!success) return { status: 'Error' }
    if (ret === '66') return { status: 'Wait' }
    if (ret === '0') return { status: 'OK', ticket: code, uin: uin ? String(uin) : '' }
    if (ret === '65') return { status: 'Used' }
    return { status: 'Error' }
  } catch {
    return { status: 'Error' }
  }
}

async function getAuthCode(ticket: string): Promise<string> {
  return ticket
}

export interface QRLoginInfo {
  loginCode: string
  url: string
  qrText: string
}

export async function requestQRLogin(): Promise<QRLoginInfo> {
  const { loginCode, url } = await requestLoginCode()
  const qrText = await new Promise<string>((resolve) => {
    qrcodeTerminal.generate(url, { small: true }, (text: string) => resolve(text))
  })
  return { loginCode, url, qrText }
}

export async function pollQRScanResultDetailed(
  loginCode: string,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<{ code: string; uin?: string }> {
  const pollIntervalMs = Number(opts.pollIntervalMs) > 0 ? Number(opts.pollIntervalMs) : 800
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 180000

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await queryScanStatus(loginCode)
    if (status.status === 'OK') {
      return {
        code: await getAuthCode(String(status.ticket || '')),
        uin: status.uin ? String(status.uin) : '',
      }
    }
    if (status.status === 'Used') throw new Error('二维码已失效，请重试')
    if (status.status === 'Error') throw new Error('扫码状态查询失败，请重试')
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  throw new Error('扫码超时，请重试')
}

export async function pollQRScanResult(
  loginCode: string,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const detailed = await pollQRScanResultDetailed(loginCode, opts)
  return detailed.code
}

export function saveCode(code: string, platform: string): void {
  try {
    writeFileSync(CODE_FILE, JSON.stringify({ code, platform, savedAt: Date.now() }))
  } catch { }
}

export function loadCode(platform: string): string | null {
  try {
    if (!existsSync(CODE_FILE)) return null
    const data = JSON.parse(readFileSync(CODE_FILE, 'utf-8'))
    if (data.code && data.platform === platform) return data.code
    return null
  } catch {
    return null
  }
}

export function clearCode(): void {
  try {
    unlinkSync(CODE_FILE)
  } catch { }
}
