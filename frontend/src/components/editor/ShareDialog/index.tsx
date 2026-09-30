/**
 * =============================================================
 * ShareDialog —— 项目分享链接管理对话框
 * =============================================================
 * 职责:
 *   创建 / 查看 / 撤销 / 复制分享链接。权限分 view(仅查看) / edit(可编辑)
 *   两档, 由服务端校验, 撤销后立即失效。
 * Props:
 *   - projectId: 被分享的项目 ID
 *   - onClose: 关闭对话框
 * API(均在 @/services/auth):
 *   getShareLinks / createShareLink / updateShareLink / revokeShareLink
 * 错误处理:
 *   - 502 → 提示重启 FlowBoard.exe
 *   - 401 → 提示重新登录
 * 复制策略:
 *   优先 navigator.clipboard, 失败降级 document.execCommand('copy')。
 * 区域划分:
 *   ① 链接增删改查 (loadLinks / createLink / changePermission / revokeLink)
 *   ② 剪贴板复制 (markCopied / copyLink)
 *   ③ 对话框 UI (JSX)
 * =============================================================
 */
import { useEffect, useState } from 'react'
import { Copy, Link2, RefreshCw, Trash2, X } from 'lucide-react'
import {
  AuthRequestError,
  createShareLink,
  getShareLinks,
  revokeShareLink,
  updateShareLink,
  type ShareLink,
} from '@/services/auth'

interface ShareDialogProps {
  projectId: string
  onClose: () => void
}

export default function ShareDialog({ projectId, onClose }: ShareDialogProps) {
  const [links, setLinks] = useState<ShareLink[]>([])
  const [permission, setPermission] = useState<'view' | 'edit'>('view')
  const [password, setPassword] = useState('')
  const [expiresInHours, setExpiresInHours] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copiedToken, setCopiedToken] = useState<string | null>(null)

  /* ===== ① 链接增删改查(调 @/services/auth) ===== */
  async function loadLinks() {
    setLoading(true)
    setError('')
    try {
      setLinks(await getShareLinks(projectId))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '分享链接加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadLinks()
  }, [projectId])

  async function createLink() {
    setBusy(true)
    setError('')
    try {
      if (password && (password.length < 4 || password.length > 64)) {
        setError('分享密码长度需在 4-64 位之间')
        return
      }
      const expiry = expiresInHours ? Number(expiresInHours) : undefined
      const link = await createShareLink(projectId, permission, {
        ...(password ? { password } : {}),
        ...(expiry ? { expiresInHours: expiry } : {}),
      })
      setLinks(previous => [link, ...previous])
      setPassword('')
    } catch (requestError) {
      if (requestError instanceof AuthRequestError && requestError.status === 502) setError('服务器暂时不可用，请重启最新 FlowBoard.exe 后重试')
      else if (requestError instanceof AuthRequestError && requestError.status === 401) setError('登录已失效，请重新登录后再创建分享链接')
      else setError(requestError instanceof Error ? requestError.message : '分享链接创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function changePermission(link: ShareLink) {
    const nextPermission = link.permission === 'view' ? 'edit' : 'view'
    setBusy(true)
    setError('')
    try {
      const updated = await updateShareLink(projectId, link.token, nextPermission)
      setLinks(previous => previous.map(item => item.token === updated.token ? updated : item))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '分享权限更新失败')
    } finally {
      setBusy(false)
    }
  }

  async function changePassword(link: ShareLink) {
    const nextPassword = window.prompt(
      link.hasPassword ? '输入新的分享密码（4-64 位；留空可清除密码）：' : '输入分享密码（4-64 位）：',
      '',
    )
    if (nextPassword === null) return
    if (nextPassword && (nextPassword.length < 4 || nextPassword.length > 64)) {
      setError('分享密码长度需在 4-64 位之间')
      return
    }
    setBusy(true)
    setError('')
    try {
      const updated = await updateShareLink(
        projectId,
        link.token,
        link.permission,
        nextPassword ? { password: nextPassword } : { clearPassword: true },
      )
      setLinks(previous => previous.map(item => item.token === updated.token ? updated : item))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '分享密码更新失败')
    } finally {
      setBusy(false)
    }
  }

  async function changeExpiry(link: ShareLink) {
    const currentHours = link.expiresAt ? Math.max(1, Math.round((link.expiresAt - Date.now()) / 3600000)) : ''
    const raw = window.prompt('输入新的有效小时数；留空改为永久有效：', String(currentHours))
    if (raw === null) return
    const trimmed = raw.trim()
    const hours = trimmed ? Number(trimmed) : undefined
    if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365)) {
      setError('有效期需为 1 到 8760 小时')
      return
    }
    setBusy(true)
    setError('')
    try {
      const updated = await updateShareLink(
        projectId,
        link.token,
        link.permission,
        hours ? { expiresInHours: hours } : { clearExpires: true },
      )
      setLinks(previous => previous.map(item => item.token === updated.token ? updated : item))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '分享有效期更新失败')
    } finally {
      setBusy(false)
    }
  }

  async function revokeLink(link: ShareLink) {
    setBusy(true)
    setError('')
    try {
      await revokeShareLink(projectId, link.token)
      setLinks(previous => previous.filter(item => item.token !== link.token))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '分享链接撤销失败')
    } finally {
      setBusy(false)
    }
  }

  /* ===== ② 剪贴板复制(clipboard 优先, execCommand 兜底) ===== */
  function markCopied(token: string) {
    setCopiedToken(token)
    window.setTimeout(() => setCopiedToken(current => current === token ? null : current), 1600)
  }

  async function copyLink(link: ShareLink) {
    let copied = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link.url)
        copied = true
      }
    } catch {
      copied = false
    }
    if (!copied) {
      const helper = document.createElement('textarea')
      helper.value = link.url
      helper.setAttribute('readonly', '')
      helper.style.position = 'fixed'
      helper.style.left = '-9999px'
      helper.style.opacity = '0'
      document.body.appendChild(helper)
      helper.select()
      helper.setSelectionRange(0, helper.value.length)
      try { copied = document.execCommand('copy') } catch { copied = false }
      helper.remove()
    }
    if (copied) {
      setError('')
      markCopied(link.token)
    } else {
      setError('自动复制不可用，请选中链接后手动复制')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onClick={onClose}>
      <section className="w-full max-w-lg rounded-lg border border-surface-border bg-white p-5 shadow-float" onClick={event => event.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink">分享项目</h2>
            <p className="mt-1 text-xs text-ink-muted">链接权限由服务端校验，撤销后立即失效。</p>
          </div>
          <button className="tool-btn !h-8 !w-8" title="关闭" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="mb-5 space-y-2 rounded-md border border-surface-border bg-surface-muted p-3">
          <div className="flex items-center gap-2">
            <select className="h-9 flex-1 rounded border border-surface-border bg-white px-2 text-sm text-ink" value={permission} onChange={event => setPermission(event.target.value as 'view' | 'edit')}>
              <option value="view">仅查看和阅读</option>
              <option value="edit">允许编辑和保存</option>
            </select>
            <select className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-ink" value={expiresInHours} onChange={event => setExpiresInHours(event.target.value)}>
              <option value="">永久有效</option>
              <option value="1">1 小时</option>
              <option value="24">24 小时</option>
              <option value="168">7 天</option>
              <option value="720">30 天</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="可选：4-64 位分享密码"
              className="h-9 min-w-0 flex-1 rounded border border-surface-border bg-white px-2 text-sm text-ink outline-none focus:border-brand-400"
            />
            <button className="btn-primary whitespace-nowrap" disabled={busy} onClick={() => void createLink()}><Link2 size={15} />创建链接</button>
          </div>
        </div>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        {loading ? <p className="py-6 text-center text-sm text-ink-muted">加载分享链接...</p> : links.length === 0 ? <p className="py-6 text-center text-sm text-ink-muted">还没有分享链接</p> : <div className="max-h-72 space-y-2 overflow-y-auto">{links.map(link => <div key={link.token} className="rounded-md border border-surface-border p-3"><div className="flex items-center gap-2"><div className="min-w-0 flex-1"><input aria-label={`分享链接 ${link.token}`} value={link.url} readOnly onFocus={event => event.currentTarget.select()} className="h-7 w-full min-w-0 rounded border border-surface-border bg-surface-muted px-2 text-xs text-ink outline-none focus:border-brand-400" /><p className="mt-1 text-xs text-ink-muted">权限：{link.permission === 'view' ? '仅查看' : '可编辑'} · {link.hasPassword ? '密码保护' : '无密码'} · {link.expired ? '已过期' : link.expiresAt ? `到期：${new Date(link.expiresAt).toLocaleString('zh-CN')}` : '永久有效'}</p><div className="mt-2 flex gap-2"><button className="text-xs text-brand-600 hover:underline" disabled={busy} onClick={() => void changePassword(link)}>{link.hasPassword ? '修改/清除密码' : '设置密码'}</button><button className="text-xs text-brand-600 hover:underline" disabled={busy} onClick={() => void changeExpiry(link)}>修改有效期</button></div></div><div className="flex shrink-0 items-center gap-1"><button className="tool-btn !h-8 !w-8" title="复制链接" onClick={() => void copyLink(link)}><Copy size={14} /></button><button className="tool-btn !h-8 !w-8" title="切换查看/编辑权限" disabled={busy} onClick={() => void changePermission(link)}><RefreshCw size={14} /></button><button className="tool-btn !h-8 !w-8 text-red-500" title="撤销链接" disabled={busy} onClick={() => void revokeLink(link)}><Trash2 size={14} /></button></div></div>{copiedToken === link.token && <p className="mt-2 text-xs text-green-600">链接已复制</p>}</div>)}</div>}
      </section>
    </div>
  )
}
