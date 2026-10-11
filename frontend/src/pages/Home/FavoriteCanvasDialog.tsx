import { useState } from 'react'
import { Star } from 'lucide-react'
import { ErrorNotice, ModalCancelButton, WorkspaceModal } from '@/components/workspace/ui'
import { addCanvasFavorite, sharedCanvasToken } from '@/utils/storage'

export default function FavoriteCanvasDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [link, setLink] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function add() {
    setBusy(true); setError('')
    try { await addCanvasFavorite(sharedCanvasToken(link), password || undefined); setPassword(''); onAdded() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '收藏失败，请检查分享链接与密码') }
    finally { setBusy(false) }
  }
  return <WorkspaceModal title="收藏共享画布" description="收藏后加入我的画布，打开时读取作者的最新版本。仅保存只读引用。" onClose={onClose} busy={busy}><form onSubmit={event => { event.preventDefault(); void add() }}><div className="ws-modal-body"><label className="ws-field"><span>画布分享链接</span><input required aria-label="画布分享链接" value={link} placeholder="粘贴 /share/ 分享链接" disabled={busy} onChange={event => setLink(event.target.value)} /></label><label className="ws-field"><span>分享密码（如有）</span><input aria-label="分享密码" type="password" autoComplete="off" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label><ErrorNotice error={error} /></div><div className="ws-modal-actions"><ModalCancelButton /><button className="ws-button ws-button-primary" type="submit" disabled={busy || !link.trim()}><Star size={14} />{busy ? '正在收藏…' : '加入我的画布'}</button></div></form></WorkspaceModal>
}
