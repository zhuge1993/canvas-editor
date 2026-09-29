import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Copy, Download, KeyRound, Pencil, Plus, ShieldCheck, Trash2, Upload, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  adminCopyDoc,
  adminCopyGroup,
  adminCreateInvite,
  adminDeleteUser,
  adminDisableInvite,
  adminGetAllDocs,
  adminGetDocGroups,
  adminGetInvites,
  adminGetUsers,
  adminUpdateUser,
  getCurrentUser,
  type AdminDocGroup,
  type AdminInvite,
  type AdminUser,
  type AuthUser,
} from '@/services/auth'

interface AdminDoc {
  id: string
  title: string
  ownerEmail: string
  updatedAt: number
  createdAt: number
}

type AdminTab = 'users' | 'invites' | 'docs'

export default function AdminPage() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [invites, setInvites] = useState<AdminInvite[]>([])
  const [docs, setDocs] = useState<AdminDoc[]>([])
  const [tab, setTab] = useState<AdminTab>('users')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')
  const [inviteUses, setInviteUses] = useState(1)
  const [groupSourceDoc, setGroupSourceDoc] = useState<AdminDoc | null>(null)
  const [groups, setGroups] = useState<AdminDocGroup[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [targetDocId, setTargetDocId] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const ownDocs = useMemo(() => docs.filter(doc => doc.ownerEmail === user?.email), [docs, user?.email])

  useEffect(() => {
    void getCurrentUser().then(({ user: currentUser }) => {
      if (!currentUser) {
        navigate('/register?next=/admin', { replace: true })
        return
      }
      if (!currentUser.isAdmin) {
        setError('需要管理员权限')
        setUser(currentUser)
        setLoading(false)
        return
      }
      setUser(currentUser)
      void loadAll()
    }).catch(() => navigate('/register', { replace: true }))
  }, [navigate])

  async function loadAll() {
    setLoading(true)
    try {
      setError('')
      const [nextUsers, nextInvites, nextDocs] = await Promise.all([
        adminGetUsers(),
        adminGetInvites(),
        adminGetAllDocs(),
      ])
      setUsers(nextUsers)
      setInvites(nextInvites)
      setDocs(nextDocs)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载管理数据失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateInvite() {
    setBusyId('invite-create')
    setNotice('')
    try {
      const invite = await adminCreateInvite(inviteUses)
      setInvites(previous => [invite, ...previous])
      setNotice(`已生成邀请码：${invite.code}`)
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '生成邀请码失败')
    } finally {
      setBusyId('')
    }
  }

  async function handleDisableInvite(invite: AdminInvite) {
    setBusyId(`invite-${invite.code}`)
    try {
      await adminDisableInvite(invite.code)
      setInvites(previous => previous.map(item => item.code === invite.code ? { ...item, disabled: true } : item))
      setNotice(`已停用邀请码 ${invite.code}`)
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '停用失败')
    } finally {
      setBusyId('')
    }
  }

  async function handleToggleAdmin(target: AdminUser) {
    setBusyId(`user-${target.id}`)
    try {
      const result = await adminUpdateUser(target.id, { isAdmin: !target.isAdmin })
      setUsers(previous => previous.map(item => item.id === target.id ? { ...item, isAdmin: result.user.isAdmin === true } : item))
      setNotice(`${target.email} 已${result.user.isAdmin ? '设为' : '取消'}管理员`)
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '权限修改失败')
    } finally {
      setBusyId('')
    }
  }

  async function handleDeleteUser(target: AdminUser) {
    if (!window.confirm(`确定删除用户 ${target.email}？该用户的全部画布也会删除，此操作不可恢复。`)) return
    setBusyId(`user-${target.id}`)
    try {
      const result = await adminDeleteUser(target.id)
      setUsers(previous => previous.filter(item => item.id !== target.id))
      setDocs(previous => previous.filter(doc => doc.ownerEmail !== target.email))
      setNotice(`已删除 ${target.email}，同时删除 ${result.deletedDocs} 个画布`)
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '删除用户失败')
    } finally {
      setBusyId('')
    }
  }

  async function handleCopyDoc(doc: AdminDoc) {
    setBusyId(`doc-${doc.id}`)
    try {
      const result = await adminCopyDoc(doc.id)
      setNotice(`已复制「${doc.title}」到你的画册（${result.id}）`)
      await loadAll()
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '复制失败')
    } finally {
      setBusyId('')
    }
  }

  async function openGroupCopy(doc: AdminDoc) {
    setBusyId(`groups-${doc.id}`)
    setNotice('')
    try {
      const nextGroups = await adminGetDocGroups(doc.id)
      setGroupSourceDoc(doc)
      setGroups(nextGroups)
      setSelectedGroupId(nextGroups[0]?.id ?? '')
      setTargetDocId(ownDocs[0]?.id ?? '')
      if (nextGroups.length === 0) setNotice('这个画布没有可复制的分组')
      if (ownDocs.length === 0) setNotice('请先在自己的账号下创建一个目标画布')
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '读取分组失败')
    } finally {
      setBusyId('')
    }
  }

  async function handleCopyGroup() {
    if (!groupSourceDoc || !selectedGroupId || !targetDocId) return
    setBusyId('group-copy')
    try {
      const result = await adminCopyGroup(groupSourceDoc.id, targetDocId, selectedGroupId)
      setNotice(`已把分组「${result.groupName}」复制到你的目标画布`)
      setGroupSourceDoc(null)
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '复制分组失败')
    } finally {
      setBusyId('')
    }
  }

  function formatTime(timestamp?: number): string {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  const tabButton = (value: AdminTab, label: string, icon: ReactNode) => (
    <button className={`btn-ghost border ${tab === value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border'}`} onClick={() => setTab(value)}>
      {icon}{label}
    </button>
  )

  return (
    <div className="flex h-full flex-col bg-surface-muted">
      <header className="flex h-14 items-center justify-between border-b border-surface-border bg-surface px-6">
        <div className="flex items-center gap-3">
          <button className="tool-btn" title="返回" onClick={() => navigate('/')}><ArrowLeft size={16} /></button>
          <ShieldCheck size={18} className="text-brand-600" />
          <h1 className="text-lg font-semibold text-ink">FlowBoard 管理后台</h1>
        </div>
        <span className="text-xs text-ink-muted">{user?.email}</span>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl">
          {error && <div className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {notice && <div className="mb-4 border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>}

          <div className="mb-5 flex flex-wrap gap-2">
            {tabButton('users', '用户管理', <Users size={14} />)}
            {tabButton('invites', '邀请码', <KeyRound size={14} />)}
            {tabButton('docs', '全部画布', <ShieldCheck size={14} />)}
          </div>

          {loading ? <div className="flex h-40 items-center justify-center text-ink-muted">加载中...</div> : null}

          {!loading && tab === 'users' && (
            <div className="space-y-2">
              <div className="mb-3 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs text-ink-muted">
                默认根管理员为 804559340@qq.com。根管理员不可取消管理员权限或删除。
              </div>
              {users.map(target => (
                <div key={target.id} className="panel flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{target.email}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      注册 {formatTime(target.createdAt)} · 最近登录 {formatTime(target.lastLoginAt)}
                      {target.isRootAdmin ? ' · 根管理员' : target.isAdmin ? ' · 管理员' : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {!target.isRootAdmin && target.id !== user?.id && (
                      <button className="btn-ghost !h-7" disabled={busyId === `user-${target.id}`} onClick={() => void handleToggleAdmin(target)}>
                        <ShieldCheck size={13} />{target.isAdmin ? '取消管理员' : '设为管理员'}
                      </button>
                    )}
                    {!target.isRootAdmin && target.id !== user?.id && (
                      <button className="btn-ghost !h-7 text-red-600" disabled={busyId === `user-${target.id}`} onClick={() => void handleDeleteUser(target)}>
                        <Trash2 size={13} />删除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && tab === 'invites' && (
            <div>
              <div className="mb-4 flex flex-wrap items-end gap-2">
                <label className="text-xs text-ink-muted">可使用次数
                  <input className="mt-1 block h-9 w-28 rounded border border-surface-border bg-surface px-2 text-sm text-ink" type="number" min={1} max={100} value={inviteUses} onChange={event => setInviteUses(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} />
                </label>
                <button className="btn-primary h-9" disabled={busyId === 'invite-create'} onClick={() => void handleCreateInvite()}><Plus size={14} />生成邀请码</button>
              </div>
              <div className="space-y-2">
                {invites.length === 0 && <div className="py-10 text-center text-sm text-ink-muted">还没有邀请码</div>}
                {invites.map(invite => {
                  const exhausted = invite.usedCount >= invite.maxUses
                  return (
                    <div key={invite.code} className="panel flex items-center justify-between gap-3 p-3">
                      <div>
                        <button className="font-mono text-sm font-semibold text-brand-700 hover:underline" title="点击复制" onClick={() => void navigator.clipboard?.writeText(invite.code)}>{invite.code}</button>
                        <p className="mt-0.5 text-xs text-ink-muted">
                          已用 {invite.usedCount}/{invite.maxUses} · 创建 {formatTime(invite.createdAt)}
                          {invite.disabled ? ' · 已停用' : exhausted ? ' · 已耗尽' : ' · 可用'}
                        </p>
                      </div>
                      {!invite.disabled && !exhausted && <button className="btn-ghost !h-7" disabled={busyId === `invite-${invite.code}`} onClick={() => void handleDisableInvite(invite)}>停用</button>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!loading && tab === 'docs' && (
            <div>
              <div className="mb-4 flex flex-wrap gap-2">
                <button className="btn-ghost border border-surface-border text-sm" onClick={() => { window.open('/api/admin/backup', '_blank') }}><Download size={14} />备份所有数据</button>
                <button className="btn-ghost border border-surface-border text-sm" onClick={() => fileInputRef.current?.click()}><Upload size={14} />恢复数据</button>
                <input ref={fileInputRef} type="file" accept=".json,.gz" className="hidden" onChange={async event => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  try {
                    const body = await file.arrayBuffer()
                    const response = await fetch('/api/admin/restore', { method: 'POST', body, credentials: 'same-origin' })
                    const payload = await response.json() as { error?: string; restored?: number }
                    if (!response.ok) setNotice(`恢复失败：${payload.error ?? '未知错误'}`)
                    else { setNotice(`恢复成功：共 ${payload.restored ?? 0} 个文件`); await loadAll() }
                  } catch (restoreError) {
                    setNotice(`恢复失败：${restoreError instanceof Error ? restoreError.message : '未知错误'}`)
                  }
                  event.target.value = ''
                }} />
              </div>

              {groupSourceDoc && (
                <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 p-4">
                  <p className="mb-3 text-sm font-medium text-ink">从「{groupSourceDoc.title}」复制一个分组到我的画布</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-xs text-ink-muted">源分组
                      <select className="mt-1 block h-9 min-w-56 rounded border border-surface-border bg-surface px-2 text-sm" value={selectedGroupId} onChange={event => setSelectedGroupId(event.target.value)}>
                        {groups.map(group => <option key={group.id} value={group.id}>{group.name}（{group.shapeCount} 图形 / {group.groupCount} 分组）</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-ink-muted">复制到我的画布
                      <select className="mt-1 block h-9 min-w-56 rounded border border-surface-border bg-surface px-2 text-sm" value={targetDocId} onChange={event => setTargetDocId(event.target.value)}>
                        {ownDocs.map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
                      </select>
                    </label>
                    <button className="btn-primary h-9" disabled={!selectedGroupId || !targetDocId || busyId === 'group-copy'} onClick={() => void handleCopyGroup()}><Copy size={14} />复制分组</button>
                    <button className="btn-ghost h-9" onClick={() => setGroupSourceDoc(null)}>取消</button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {docs.length === 0 && <div className="py-10 text-center text-sm text-ink-muted">暂无画布</div>}
                {docs.map(doc => (
                  <div key={doc.id} className="panel flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{doc.title}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">{doc.ownerEmail} · 更新 {formatTime(doc.updatedAt)} · {doc.id}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1">
                      <button className="btn-ghost !h-7" onClick={() => navigate(`/editor/${doc.id}`)}><Pencil size={13} />编辑</button>
                      {doc.ownerEmail !== user?.email && <button className="btn-ghost !h-7" disabled={busyId === `doc-${doc.id}`} onClick={() => void handleCopyDoc(doc)}><Copy size={13} />整张复制到我</button>}
                      <button className="btn-ghost !h-7" disabled={busyId === `groups-${doc.id}`} onClick={() => void openGroupCopy(doc)}><Copy size={13} />复制某个组</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
