import { BrowserRouter as Router, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import CardLogin from './pages/CardLogin'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import { AdminLogin } from './pages/AdminLogin'
import { AdminDashboard } from './pages/AdminDashboard'
import { isCardAuthed } from './auth'

function RequireCardAuth() {
  if (!isCardAuthed()) return <Navigate to="/" replace />
  return <Outlet />
}

function App() {
  useEffect(() => {
    fetch('/api/system/settings')
      .then(res => res.json())
      .then(json => {
        if (json.ok && json.data.backgroundImageUrl) {
          document.body.style.backgroundImage = `url(${json.data.backgroundImageUrl})`
          document.body.style.backgroundSize = 'cover'
          document.body.style.backgroundPosition = 'center'
          document.body.style.backgroundRepeat = 'no-repeat'
          const overlay = document.querySelector('.retro-overlay') as HTMLElement
          if (overlay) overlay.style.opacity = '0.3' // Reduce retro effect opacity if custom bg
        }
      })
      .catch(() => { })
  }, [])

  return (
    <Router>
      <Routes>
        {/* User Routes */}
        <Route path="/" element={<CardLogin />} />
        <Route element={<RequireCardAuth />}>
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<Dashboard />} />
        </Route>

        {/* Admin Routes */}
        <Route path="/admin" element={<AdminLogin />} />
        <Route path="/admin/dashboard" element={<AdminDashboard />} />
      </Routes>
    </Router>
  )
}



export default App
