import { useEffect, useState } from 'react'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Clock, FileText, LogOut, Plus, Search, Share2, ShieldCheck, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import ShareDialog from '@/components/editor/ShareDialog'
import { getCurrentUser, logout, type AuthUser } from '@/services/auth'
import { deleteDocument, deleteDocumentForever, generateId, getAllDocuments, getTrashDocuments, restoreDocument, saveDocument } from '@/utils/storage'
import type { StoredDocument } from '@/utils/storage'

export default function HomePage() {
  const navigate = useNavigate()
  const [documents, setDocuments] = useState<StoredDocument[]>([])
  const [trashDocuments, setTrashDocuments] = useState<Array<StoredDocument & { deletedAt: number }>>([])
  const [trashOpen, setTrashOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [search, setSearch] = useState('')
  const [sortDesc, setSortDesc] = useState(true)
  const [error, setError] = useState('')
  const [shareProjectId, setShareProjectId] = useState<string | null>(null)

  useEffect(() => {
    void getCurrentUser().then(({ user: currentUser }) => {
      if (!currentUser) {
        navigate(`/register?next=${encodeURIComponent(window.location.pathname)}`, { replace: true })
        return
      }
      setUser(currentUser)
      void loadDocuments()
    }).catch(() => navigate('/register', { replace: true }))
  }, [navigate])

  async function loadDocuments() {
    try {
      setError('')
      const [docs, trash] = await Promise.all([getAllDocuments(), getTrashDocuments()])
      setDocuments(docs)
      setTrashDocuments(trash)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载文档列表失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate() {
    try {
      const id = generateId()
      const now = Date.now()
      const doc: StoredDocument = { id, title: '未命名画布', content: '', createdAt: now, updatedAt: now }
      await saveDocument(doc)
      navigate(`/editor/${id}`)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建文档失败')
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteDocument(id)
      setDocuments(previous => previous.filter(document => document.id !== id))
      void loadDocuments()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除文档失败')
    }
  }

  async function handleRestore(id: string) {
    try {
      await restoreDocument(id)
      void loadDocuments()
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : '恢复失败')
    }
  }

  async function handleDeleteForever(id: string) {
    try {
      await deleteDocumentForever(id)
      setTrashDocuments(previous => previous.filter(document => document.id !== id))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '彻底删除失败')
    }
  }

  async function handleLogout() {
    await logout()
    navigate('/auth', { replace: true })
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="flex h-full flex-col bg-surface-muted">
      <header className="flex h-14 items-center justify-between border-b border-surface-border bg-surface px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600"><span className="text-sm font-bold text-white">F</span></div>
          <h1 className="text-lg font-semibold text-ink">FlowBoard</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-ink-muted sm:block">{user?.email}</span>
          {user?.isAdmin && <button className="btn-ghost" title="管理员：查看/复制全部画册" onClick={() => navigate('/admin')}><ShieldCheck size={15} />管理</button>}
          <button className="btn-ghost" title="回收站" onClick={() => setTrashOpen(value => !value)}><Trash2 size={15} />回收站{trashDocuments.length > 0 ? ` (${trashDocuments.length})` : ''}</button>
          <button className="btn-ghost" title="退出登录" onClick={() => void handleLogout()}><LogOut size={15} />退出</button>
          <button className="btn-primary" onClick={() => void handleCreate()}><Plus size={16} />新建画布</button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {error && <div className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {trashOpen && (
          <div className="mb-4 rounded-md border border-surface-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">回收站</h2>
              <button className="text-xs text-ink-muted hover:text-ink" onClick={() => setTrashOpen(false)}>收起</button>
            </div>
            {trashDocuments.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-muted">回收站为空</p>
            ) : (
              <div className="space-y-2">
                {trashDocuments.map(document => (
                  <div key={document.id} className="flex items-center justify-between rounded border border-surface-border bg-surface-muted px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{document.title}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">删除于 {formatTime(document.deletedAt)}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button className="btn-ghost !h-7 !w-7 text-xs" title="恢复" onClick={() => void handleRestore(document.id)}>恢复</button>
                      <button className="btn-ghost !h-7 !w-7 text-red-500 text-xs" title="彻底删除" onClick={() => void handleDeleteForever(document.id)}>彻底删除</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {loading ? <div className="flex h-40 items-center justify-center text-ink-muted">加载中...</div> : documents.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-4">
            <FileText size={48} className="text-surface-border" />
            <p className="text-ink-muted">暂无文档，点击「新建画布」开始创作</p>
            <button className="btn-primary" onClick={() => void handleCreate()}><Plus size={16} />新建画布</button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2">
              <div className="relative flex-1 max-w-xs">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted" />
                <input aria-label="搜索文档" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文档标题..." className="h-8 w-full rounded border border-surface-border bg-surface pl-8 pr-2 text-xs text-ink outline-none focus:border-brand-400" />
              </div>
              <button className="btn-ghost !h-8" title={sortDesc ? '最新在前' : '最早在前'} onClick={() => setSortDesc(value => !value)}>{sortDesc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}{sortDesc ? '最新' : '最早'}</button>
            </div>
            {(() => {
              const filtered = documents.filter(document => !search || document.title.toLowerCase().includes(search.toLowerCase()))
              const sorted = [...filtered].sort((a, b) => sortDesc ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt)
              if (sorted.length === 0) return <div className="flex h-40 items-center justify-center text-ink-muted">{search ? `没有找到包含「${search}」的文档` : '暂无文档'}</div>
              return (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {sorted.map(document => (
              <div key={document.id} className="group panel cursor-pointer p-4 transition-shadow hover:shadow-float" onClick={() => navigate(`/editor/${document.id}`)}>
                <div className="mb-3 flex h-28 items-center justify-center overflow-hidden rounded-md border border-surface-border bg-surface-muted">
                  {document.thumbnail ? <img src={document.thumbnail} alt={document.title} className="h-full w-full object-cover" /> : <FileText size={32} className="text-surface-border" />}
                </div>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{document.title}</p>
                    <p className="mt-1 flex items-center gap-1 text-xs text-ink-muted"><Clock size={12} />{formatTime(document.updatedAt)}</p>
                  </div>
                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button className="tool-btn !h-7 !w-7" title="分享" onClick={event => { event.stopPropagation(); setShareProjectId(document.id) }}><Share2 size={14} /></button>
                    <button className="tool-btn !h-7 !w-7 text-red-500" title="删除" onClick={event => { event.stopPropagation(); void handleDelete(document.id) }}><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
              )
            })()}
          </>
        )}
      </main>
      {shareProjectId && <ShareDialog projectId={shareProjectId} onClose={() => setShareProjectId(null)} />}
    </div>
  )
}
