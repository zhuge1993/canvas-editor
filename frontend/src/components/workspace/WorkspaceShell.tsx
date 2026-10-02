import { createContext, useContext, useEffect, useState } from 'react'
import { Bell, FolderOpen, LayoutDashboard, Layers, LogOut, Menu, Moon, Plus, ShieldCheck, Sun, Trash2, X } from 'lucide-react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { getNotifications } from '@/services/management'
import { getCurrentUser, logout } from '@/services/auth'
import type { AuthUser } from '@/services/auth'
import { useEditorStore } from '@/store/useEditorStore'
import './workspace.css'

const WorkspaceContext = createContext<{ user: AuthUser } | null>(null)
export function useWorkspace() { const value = useContext(WorkspaceContext); if (!value) throw new Error('工作台尚未加载'); return value }
export default function WorkspaceShell() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [error, setError] = useState('')
  const [unread, setUnread] = useState<number | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const theme = useEditorStore(state => state.theme)
  const toggleTheme = useEditorStore(state => state.toggleTheme)
  const navigate = useNavigate(), location = useLocation()
  useEffect(() => { void getCurrentUser().then(result => { if (!result.user) { navigate(`/auth?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return }; setUser(result.user) }).catch(() => setError('无法连接工作台，请稍后刷新重试。')) }, [navigate])
  useEffect(() => setMobileOpen(false), [location.pathname])
  useEffect(() => { if (!user) return; let canceled = false; const load = () => { void getNotifications(true).then(items => { if (!canceled) setUnread(items.length) }).catch(() => { if (!canceled) setUnread(null) }) }; load(); const timer = window.setInterval(load, 30000); window.addEventListener('workspace:notifications-changed', load); return () => { canceled = true; window.clearInterval(timer); window.removeEventListener('workspace:notifications-changed', load) } }, [user?.id])
  async function leave() { try { await logout(); navigate('/auth', { replace: true }) } catch { setError('退出登录失败，请检查连接后重试。') } }
  if (!user) return <div className="ws-loading-screen"><span className="ws-logo"><Layers size={22} /></span><h1>FlowBoard</h1><p>{error || '正在打开你的工作台…'}</p>{error && <button className="ws-button" onClick={() => window.location.reload()}>重新加载</button>}</div>
  const section = location.pathname.startsWith('/projects') ? '项目管理' : location.pathname.startsWith('/canvases') ? '我的画布' : location.pathname.startsWith('/notifications') ? '站内通知' : '工作台总览'
  return <WorkspaceContext.Provider value={{ user }}><div className={`ws-shell ${mobileOpen ? 'ws-mobile-open' : ''}`}>
    {mobileOpen && <button className="ws-sidebar-scrim" aria-label="收起导航" onClick={() => setMobileOpen(false)} />}
    <aside className="ws-sidebar"><Link to="/" className="ws-brand"><span className="ws-logo"><Layers size={23} strokeWidth={1.8} /></span><span>FlowBoard<small>创作与协作工作台</small></span></Link><button className="ws-mobile-close ws-icon-button" aria-label="收起导航" onClick={() => setMobileOpen(false)}><X size={20} /></button>
      <p className="ws-nav-label">WORKSPACE</p><nav className="ws-navigation" aria-label="工作台导航"><NavLink to="/" end><LayoutDashboard size={19} />总览</NavLink><NavLink to="/canvases"><Layers size={19} />我的画布</NavLink><NavLink to="/projects"><FolderOpen size={19} />项目管理</NavLink><NavLink to="/notifications"><Bell size={18} />站内通知{Boolean(unread) && <span className="ws-unread-pill">{unread}</span>}</NavLink></nav>
      <div className="ws-sidebar-note"><span className="ws-note-line" /><h3>让想法有迹可循</h3><p>关联画布与项目，把设计、需求和下一步连接起来。</p><Link to="/projects">进入项目空间 <span>↗</span></Link></div>
      <div className="ws-sidebar-bottom"><nav className="ws-navigation"><Link to="/canvases?trash=1"><Trash2 size={17} />回收站</Link>{user.isAdmin && <Link to="/admin"><ShieldCheck size={17} />管理员控制台</Link>}<button onClick={toggleTheme}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}{theme === 'dark' ? '浅色外观' : '深色外观'}</button></nav><div className="ws-user"><span className="ws-avatar">{user.email.slice(0, 1).toUpperCase()}</span><div><strong>{user.email.split('@')[0]}</strong><small>{user.email}</small></div><button className="ws-icon-button" aria-label="退出登录" title="退出登录" onClick={() => void leave()}><LogOut size={16} /></button></div></div>
    </aside><div className="ws-main"><header className="ws-header"><div className="ws-header-left"><button className="ws-menu-button ws-icon-button" aria-label="展开导航" onClick={() => setMobileOpen(true)}><Menu size={21} /></button><span className="ws-breadcrumb">工作台 <span>/</span> <strong>{section}</strong></span></div><div className="ws-header-right"><Link className="ws-header-bell ws-icon-button" to="/notifications" aria-label={unread ? `站内通知，${unread} 条未读` : '站内通知'}><Bell size={18} />{Boolean(unread) && <i />}</Link><span className="ws-header-date">{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span><Link className="ws-button ws-button-primary" to="/projects?create=1"><Plus size={16} />新建项目</Link></div></header><main className="ws-content">{error && <div className="ws-error" role="alert">{error}</div>}<Outlet /></main></div>
  </div></WorkspaceContext.Provider>
}
