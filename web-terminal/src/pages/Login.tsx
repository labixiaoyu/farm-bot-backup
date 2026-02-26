import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import '../App.css'
import { clearAuthToken, getAuthToken } from '../auth'

type LoginMethod = 'qr' | 'qqcode' | 'wxcode'

type Account = {
  id: string
  platform: 'qq' | 'wx'
  qqNumber?: string
  name: string
  level: number
  status: 'connecting' | 'online' | 'offline' | 'error'
}

const API_BASE_URL = '/api'

import ReactMarkdown from 'react-markdown'

function NoticeContent({ type }: { type: 'noticeCardLogin' | 'noticeAppLogin' }) {
  const [notice, setNotice] = useState('Loading...')
  useEffect(() => {
    fetch(`${API_BASE_URL}/system/settings`).then(r => r.json()).then(d => {
      if (d.ok) setNotice(d.data[type] || '暂无说明')
    }).catch(() => setNotice('获取说明失败'))
  }, [type])
  const normalized = String(notice || '').replace(/\\n/g, '\n')
  return <div className="markdown-body" style={{ textAlign: 'left' }}><ReactMarkdown>{normalized}</ReactMarkdown></div>
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
    throw new Error('未授权，请重新输入卡密')
  }
  if (!response.ok) {
    throw new Error(json?.error ? `${response.status} ${json.error}` : `${response.status}`)
  }
  if (!json?.ok) {
    throw new Error(json?.error || 'request failed')
  }
  return json.data as T
}

function Login() {
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('qr')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [qrLoginCode, setQrLoginCode] = useState('')
  const [qrUrl, setQrUrl] = useState('')
  const [qrStatus, setQrStatus] = useState('')
  const navigate = useNavigate()
  const location = useLocation()

  const loadAccounts = async () => {
    try {
      const data = await apiPost<Account[]>('/account/list')
      setAccounts(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setAccounts([])
      if (String(e?.message || '').includes('未授权')) {
        navigate('/', { replace: true })
      }
    }
  }

  useEffect(() => {
    loadAccounts()
  }, [])

  useEffect(() => {
    const state = (location.state || {}) as { reloginFailed?: boolean; reason?: string }
    if (state.reloginFailed) {
      setError(state.reason || '重新登录失败，请在本页重新登录')
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.pathname, location.state, navigate])

  const pollQrLogin = async (loginCode: string) => {
    setQrStatus('请使用手机QQ扫码...')

    // Loop until success, error, or unmount (checked via loginMethod/qrCode state)
    // Note: In a real app we'd use a useRef for cancellation, but checking state works for now.
    while (true) {
      if (loginMethod !== 'qr') break // User switched method

      try {
        const res = await apiPost<any>('/account/poll-qr', { loginCode })

        // Success case (account added)
        if (res && res.id) {
          setQrStatus('扫码成功，正在登录...')
          await loadAccounts()
          navigate('/dashboard')
          return
        }

        // Waiting case
        if (res && res.status === 'waiting') {
          await new Promise(r => setTimeout(r, 1000))
          continue
        }

        // Unknown response
        throw new Error('未知响应')

      } catch (e: any) {
        const msg = e.message || ''
        // If it's a network error or timeout that wasn't caught by status, we might want to retry?
        // But for now, fail on error.
        setError(msg || '扫码登录失败')
        setQrStatus('')
        setLoading(false)
        break
      }
    }
  }

  const generateQrcode = async () => {
    setError('')
    setLoading(true)
    setQrStatus('')

    try {
      const data = await apiPost<{ url: string; loginCode: string; qrText?: string }>('/account/qr-login')
      setQrLoginCode(data.loginCode || '')
      setQrUrl(data.url || '')
      if (!data.loginCode) throw new Error('服务端未返回 loginCode')
      pollQrLogin(data.loginCode)
    } catch (e: any) {
      setError(e?.message || '生成二维码失败，请重试')
      setLoading(false)
    }
  }

  const handleCodeLogin = async () => {
    if (!code.trim()) {
      setError('请输入登录 Code')
      return
    }

    setError('')
    setLoading(true)

    try {
      await apiPost<{ id: string }>('/account/add', {
        platform: loginMethod === 'qqcode' ? 'qq' : 'wx',
        code: code.trim(),
      })
      await loadAccounts()
      navigate('/dashboard')
    } catch (e: any) {
      setError(e?.message || '登录失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app retro-bg">
      <div className="background-blur retro-overlay" />
      <div className="retro-shell retro-auth-shell">
        <section className="retro-panel retro-auth-panel">
          <h1 className="retro-auth-title">选择登录方式</h1>

          <div className="retro-auth-tabs">
            <button className={`retro-auth-tab ${loginMethod === 'qr' ? 'active' : ''}`} onClick={() => setLoginMethod('qr')} disabled={loading}>
              QQ 扫码登录
            </button>
            <button className={`retro-auth-tab ${loginMethod === 'qqcode' ? 'active' : ''}`} onClick={() => setLoginMethod('qqcode')} disabled={loading}>
              QQ Code 登录
            </button>
            <button className={`retro-auth-tab ${loginMethod === 'wxcode' ? 'active' : ''}`} onClick={() => setLoginMethod('wxcode')} disabled={loading}>
              微信 Code 登录
            </button>
          </div>

          {error ? <div className="retro-auth-error">{error}</div> : null}

          {loginMethod === 'qr' ? (
            <div className="retro-auth-qr-area">
              {qrLoginCode ? (
                <>
                  <div className="retro-auth-qr-title">请使用 QQ 扫码登录</div>
                  <div className="retro-auth-qr-box">
                    {qrUrl ? (
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`}
                        alt="登录二维码"
                        className="qrcode-image"
                      />
                    ) : (
                      <div>二维码数据为空</div>
                    )}
                  </div>
                  {qrUrl ? <div className="retro-auth-hint">二维码链接: {qrUrl}</div> : null}
                  {qrStatus ? <div className="retro-auth-hint">{qrStatus}</div> : null}
                  <div className="retro-auth-actions">
                    <button className="retro-auth-btn" onClick={generateQrcode} disabled={loading}>
                      {loading ? '处理中...' : '重新生成二维码'}
                    </button>
                    {accounts.length > 0 ? (
                      <button className="retro-auth-btn secondary" onClick={() => navigate('/dashboard')} disabled={loading}>
                        返回仪表盘
                      </button>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="retro-auth-actions">
                  <button className="retro-auth-btn" onClick={generateQrcode} disabled={loading}>
                    {loading ? '处理中...' : '生成 QQ 登录二维码'}
                  </button>
                  {accounts.length > 0 ? (
                    <button className="retro-auth-btn secondary" onClick={() => navigate('/dashboard')} disabled={loading}>
                      返回仪表盘
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <div className="retro-auth-form">
              <label htmlFor="login-code">请输入{loginMethod === 'qqcode' ? 'QQ' : '微信'}登录 Code</label>
              <input
                id="login-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={`请输入${loginMethod === 'qqcode' ? 'QQ' : '微信'}登录 Code`}
                className="retro-auth-input"
                disabled={loading}
              />
              <div className="retro-auth-actions">
                <button className="retro-auth-btn" onClick={handleCodeLogin} disabled={loading}>
                  {loading ? '登录中...' : `使用${loginMethod === 'qqcode' ? 'QQ' : '微信'} Code 登录`}
                </button>
                {accounts.length > 0 ? (
                  <button className="retro-auth-btn secondary" onClick={() => navigate('/dashboard')} disabled={loading}>
                    返回仪表盘
                  </button>
                ) : null}
              </div>
            </div>
          )}

          <div className="retro-auth-footer">
            <div>当前账号数: {accounts.length}</div>
            <div>本页面用于新增账号或重新登录，不再提供跳过登录。</div>

            <div className="mt-4 pt-4 border-t border-green-900/30 text-left">
              <div className="text-xs font-bold text-green-500 mb-2">使用说明</div>
              <div className="text-xs text-green-300/70 whitespace-pre-wrap font-mono">
                <NoticeContent type="noticeAppLogin" />
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

export default Login
