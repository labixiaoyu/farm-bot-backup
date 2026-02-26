import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../App.css'
import { isCardAuthed, setAuthToken } from '../auth'

const API_BASE_URL = '/api'

import ReactMarkdown from 'react-markdown'

function NoticeContent({ type }: { type: 'noticeCardLogin' | 'noticeAppLogin' }) {
  const [notice, setNotice] = useState('Loading notice...')
  useEffect(() => {
    fetch(`${API_BASE_URL}/system/settings`).then(r => r.json()).then(d => {
      if (d.ok) setNotice(d.data[type] || '暂无公告')
    }).catch(() => setNotice('获取公告失败'))
  }, [type])
  const normalized = String(notice || '').replace(/\\n/g, '\n')
  return <div className="markdown-body" style={{ textAlign: 'left', fontSize: '0.8rem' }}><ReactMarkdown>{normalized}</ReactMarkdown></div>
}

function CardLogin() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [successInfo, setSuccessInfo] = useState<{
    cardType: string
    expiresAt?: number
  } | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (isCardAuthed()) {
      navigate('/login', { replace: true })
    }
  }, [navigate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch(`${API_BASE_URL}/auth/card-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const result = await response.json().catch(() => null)
      if (response.ok && result?.ok && result?.data?.token) {
        setAuthToken(result.data.token)
        // 显示成功弹窗
        const profile = result.data.profile
        setSuccessInfo({
          cardType: profile?.cardType || '未知',
          expiresAt: profile?.expiresAt,
        })
        // 2秒后跳转
        setTimeout(() => {
          navigate('/login')
        }, 2000)
      } else {
        setError(result?.error || '卡密错误，请重试')
      }
    } catch {
      setError('登录失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app retro-bg">
      <div className="background-blur retro-overlay" />
      <div className="retro-shell retro-auth-shell">
        <section className="retro-panel retro-auth-panel">
          <h1 className="retro-auth-title">卡密登录</h1>
          <form onSubmit={handleSubmit} className="retro-auth-form">
            <label htmlFor="password">请输入卡密</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入卡密"
              className="retro-auth-input"
              disabled={loading}
            />
            {error ? <div className="retro-auth-error">{error}</div> : null}
            <button type="submit" className="retro-auth-btn" disabled={loading}>
              {loading ? '验证中...' : '进入登录方式选择'}
            </button>
          </form>

          {/* 成功弹窗 */}
          {successInfo && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
              <div className="retro-panel p-6 max-w-md w-full mx-4 animate-pulse-slow">
                <div className="text-center">
                  <div className="text-6xl mb-4">✅</div>
                  <h2 className="text-2xl font-bold text-green-500 mb-4">登录成功！</h2>
                  <div className="text-left space-y-2 mb-6">
                    <div className="flex justify-between border-b border-green-900/30 pb-2">
                      <span className="text-green-300/70">卡密类型：</span>
                      <span className="text-green-400 font-bold">{successInfo.cardType}</span>
                    </div>
                    <div className="flex justify-between border-b border-green-900/30 pb-2">
                      <span className="text-green-300/70">到期时间：</span>
                      <span className="text-green-400 font-bold">
                        {successInfo.expiresAt
                          ? new Date(successInfo.expiresAt).toLocaleString('zh-CN')
                          : '永久有效'}
                      </span>
                    </div>
                  </div>
                  <div className="text-sm text-green-300/70 animate-pulse">
                    即将跳转到登录页面...
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* System Notice */}
          <div className="mt-6 p-4 bg-black/30 rounded border border-green-900/50 text-xs text-green-300/80 font-mono leading-relaxed whitespace-pre-wrap">
            <div className="font-bold flex items-center gap-2 mb-2 text-green-500">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              系统公告
            </div>
            <NoticeContent type="noticeCardLogin" />
          </div>
          <div className="retro-auth-footer">通过卡密验证后才可访问业务接口</div>
        </section>

      </div>
    </div>
  )
}

export default CardLogin
