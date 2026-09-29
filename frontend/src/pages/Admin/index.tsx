import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, Download, ShieldCheck, Upload } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { adminCopyDoc, adminGetAllDocs, getCurrentUser, type AuthUser } from '@/services/auth'

interface AdminDoc {
  id: string
  title: string
  ownerEmail: string
  updatedAt: number
  createdAt: number
}

export default function AdminPage() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [docs, setDocs] = useState<AdminDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [notice, setNotice] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void getCurrentUser().then(({ user: currentUser }) => {
      if (!currentUser) {
        navigate('/register?next=/admin', { replace: true })
        return
      }
      if (!currentUser.isAdmin) {
        setError('需要管理员权限。命令行执行: FlowBoard.exe admin set-admin <你的邮箱>')
        setUser(currentUser)
        setLoading(false)
        return
      }
      setUser(currentUser)
      void loadDocs()
    }).catch(() => navigate('/register', { replace: true }))
  }, [navigate])

  async function loadDocs() {
    try {
      setError('')
      setDocs(await adminGetAllDocs())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载文档失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleCopy(doc: AdminDoc) {
    setBusyId(doc.id)
    setNotice('')
    try {
      const result = await adminCopyDoc(doc.id)
      setNotice(`已复制「${doc.title}」到你的画册（${result.id}）`)
      void loadDocs()
    } catch (copyError) {
      setNotice(copyError instanceof Error ? copyError.message : '复制失败')
    } finally {
      setBusyId('')
    }
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="flex h-full flex-col bg-surface-muted">
      <header className="flex h-14 items-center justify-between border-b border-surface-border bg-surface px-6">
        <div className="flex items-center gap-3">
          <button className="tool-btn" title="返回" onClick={() => navigate('/')}><ArrowLeft size={16} /></button>
          <ShieldCheck size={18} className="text-brand-600" />
          <h1 className="text-lg font-semibold text-ink">管理员 · 全部画册</h1>
        </div>
        <span className="text-xs text-ink-muted">{user?.email}</span>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          {error && <div className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {notice && <div className="mb-4 border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>}
          <div className="mb-4 flex gap-2">
            <button className="btn-ghost border border-surface-border text-sm" onClick={() => { window.open('/api/admin/backup', '_blank') }}><Download size={14} />备份所有数据</button>
            <button className="btn-ghost border border-surface-border text-sm" onClick={() => fileInputRef.current?.click()}><Upload size={14} />恢复数据</button>
            <input ref={fileInputRef} type="file" accept=".json,.gz" className="hidden" onChange={async (event) => {
              const file = event.target.files?.[0]; if (!file) return
              try {
                const body = await file.arrayBuffer()
                const res = await fetch('/api/admin/restore', { method: 'POST', body, credentials: 'same-origin' })
                const payload = await res.json()
                if (!res.ok) { setNotice(`恢复失败: ${payload.error}`); return }
                setNotice(`恢复成功: 共 ${payload.restored} 个文件`)
                void loadDocs()
              } catch (err) { setNotice(`恢复失败: ${err instanceof Error ? err.message : '未知错误'}`) }
              event.target.value = ''
            }} />
          </div>
          {!error && (
            <div className="mb-4 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs text-ink-muted">
              查看所有用户的画册；点「复制到我」可将任意画册复制到自己的账号下（含内容、分组、画布设置）。
            </div>
          )}
          {loading ? (
            <div className="flex h-40 items-center justify-center text-ink-muted">加载中...</div>
          ) : docs.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-ink-muted">暂无文档</div>
          ) : (
            <div className="space-y-2">
              {docs.map(doc => (
                <div key={doc.id} className="panel flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{doc.title}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {doc.ownerEmail} · 更新于 {formatTime(doc.updatedAt)} · {doc.id}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {doc.ownerEmail === user?.email ? (
                      <span className="rounded bg-surface-muted px-2 py-1 text-[11px] text-ink-muted">我的</span>
                    ) : (
                      <button className="btn-ghost !h-7" disabled={busyId === doc.id} onClick={() => void handleCopy(doc)}>
                        <Copy size={13} />{busyId === doc.id ? '复制中...' : '复制到我'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
