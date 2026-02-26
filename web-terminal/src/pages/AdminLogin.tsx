import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../App.css'

export function AdminLogin() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })

      const data = await res.json().catch(() => null)
      if (data?.ok) {
        localStorage.setItem('adminToken', data.token)
        localStorage.setItem('adminRole', data.role || 'author')
        navigate('/admin/dashboard')
      } else {
        setError(data?.error || '登录失败')
      }
    } catch (err: any) {
      setError(err?.message || '网络错误')
    }
  }

  return (
    <div className="app retro-bg">
      <div className="background-blur retro-overlay" />
      <div className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h1 className="admin-title">Farm 中控台</h1>
          <p className="admin-subtitle">请输入管理员账号和密码</p>

          <form onSubmit={handleLogin} className="admin-form">
            <div className="admin-field-group">
              <label className="admin-label" htmlFor="admin-username">
                账号 (默认 admin)
              </label>
              <input
                id="admin-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="admin-input"
                placeholder="请输入账号"
                autoFocus
              />
            </div>

            <div className="admin-field-group" style={{ marginTop: '1rem' }}>
              <label className="admin-label" htmlFor="admin-password">
                密码
              </label>
              <input
                id="admin-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="admin-input"
                placeholder="请输入密码"
              />
            </div>

            {error ? <div className="admin-error">{error}</div> : null}

            <button type="submit" className="admin-btn">
              登录中控
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}
