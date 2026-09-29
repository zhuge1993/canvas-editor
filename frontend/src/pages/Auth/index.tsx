import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, KeyRound, Mail, ShieldCheck } from 'lucide-react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { getCurrentUser, login, register, resetPassword, sendVerificationCode } from '@/services/auth'

type AuthMode = 'login' | 'register' | 'reset'

export default function AuthPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [mode, setMode] = useState<AuthMode>(() => {
    if (location.pathname === '/register' || searchParams.get('mode') === 'register') return 'register'
    if (searchParams.get('mode') === 'reset') return 'reset'
    return searchParams.has('next') ? 'register' : 'login'
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [codeBusy, setCodeBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    void getCurrentUser().then(({ user }) => {
      if (user) navigate('/', { replace: true })
    }).catch(() => undefined)
  }, [navigate])

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown(value => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode)
    setSearchParams(previous => {
      if (nextMode === 'register') previous.set('mode', 'register')
      else if (nextMode === 'reset') previous.set('mode', 'reset')
      else previous.delete('mode')
      return previous
    }, { replace: true })
    setError('')
    setMessage('')
    setCode('')
    setPassword('')
  }

  async function handleCode() {
    setError('')
    setMessage('')
    if (!email.trim()) {
      setError('请先填写邮箱地址')
      return
    }
    setCodeBusy(true)
    try {
      const purpose = mode === 'reset' ? 'reset' : 'register'
      const result = await sendVerificationCode(email.trim(), purpose)
      setCooldown(result.resendAfter)
      setMessage(result.developmentCode ? `开发模式验证码：${result.developmentCode}` : '验证码已发送，请查收邮箱')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '验证码发送失败')
    } finally {
      setCodeBusy(false)
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (mode === 'register') await register(email.trim(), code.trim(), password)
      else if (mode === 'reset') {
        await resetPassword(email.trim(), code.trim(), password)
        setMessage('密码已重置，请使用新密码登录')
        switchMode('login')
        return
      }
      else await login(email.trim(), password)
      const target = new URLSearchParams(location.search).get('next')
      navigate(target?.startsWith('/') ? target : '/', { replace: true })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const showCode = mode === 'register' || mode === 'reset'
  const submitLabel = mode === 'register' ? <><ArrowRight size={16} />创建账号</> : mode === 'reset' ? <><KeyRound size={16} />重置密码</> : <><ShieldCheck size={16} />登录 FlowBoard</>

  return (
    <div className="flex h-full items-center justify-center bg-surface-muted px-4">
      <main className="w-full max-w-md rounded-xl border border-surface-border bg-surface p-8 shadow-panel">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold text-white">F</div>
          <div>
            <h1 className="text-xl font-semibold text-ink">FlowBoard</h1>
            <p className="text-xs text-ink-muted">账号与项目权限管理</p>
          </div>
        </div>
        <div className="mb-6 grid grid-cols-2 border-b border-surface-border">
          <button type="button" className={`border-b-2 pb-2 text-sm ${mode === 'login' ? 'border-brand-600 text-brand-600' : 'border-transparent text-ink-muted'}`} onClick={() => switchMode('login')}>登录</button>
          <button type="button" className={`border-b-2 pb-2 text-sm ${mode === 'register' ? 'border-brand-600 text-brand-600' : 'border-transparent text-ink-muted'}`} onClick={() => switchMode('register')}>邮箱注册</button>
        </div>
        {mode === 'reset' && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            输入注册邮箱，发送验证码后用验证码设置新密码。
          </div>
        )}
        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block text-sm text-ink-muted">邮箱地址<input className="mt-1 h-10 w-full rounded-md border border-surface-border px-3 text-sm text-ink outline-none focus:border-brand-500" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.com" required /></label>
          {showCode && <label className="block text-sm text-ink-muted">邮箱验证码<div className="mt-1 flex gap-2"><input className="h-10 min-w-0 flex-1 rounded-md border border-surface-border px-3 text-sm text-ink outline-none focus:border-brand-500" inputMode="numeric" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} placeholder="6 位数字" required /><button type="button" className="btn-ghost whitespace-nowrap border border-surface-border" disabled={codeBusy || cooldown > 0} onClick={() => void handleCode()}>{cooldown > 0 ? `${cooldown}s 后重发` : <><Mail size={15} />发送验证码</>}</button></div></label>}
          <label className="block text-sm text-ink-muted">{mode === 'reset' ? '新密码' : '密码'}<input className="mt-1 h-10 w-full rounded-md border border-surface-border px-3 text-sm text-ink outline-none focus:border-brand-500" type="password" autoComplete={mode === 'register' ? 'new-password' : mode === 'reset' ? 'new-password' : 'current-password'} minLength={8} value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 8 位" required /></label>
          {message && <p className="flex items-center gap-2 text-sm text-green-600"><CheckCircle2 size={15} />{message}</p>}
          {error && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? '处理中...' : submitLabel}</button>
        </form>
        <div className="mt-5 flex items-center justify-between text-sm">
          {mode === 'login' && <button type="button" className="text-brand-600 hover:underline" onClick={() => switchMode('register')}>还没有账号？立即注册</button>}
          {mode === 'login' && <button type="button" className="text-ink-muted hover:text-brand-600 hover:underline" onClick={() => switchMode('reset')}>忘记密码？</button>}
          {(mode === 'register' || mode === 'reset') && <button type="button" className="text-brand-600 hover:underline" onClick={() => switchMode('login')}>返回登录</button>}
        </div>
        <p className="mt-6 text-xs leading-5 text-ink-muted">注册和重置密码需要邮箱验证码。服务器需配置 SMTP 后才能发送验证码。</p>
      </main>
    </div>
  )
}