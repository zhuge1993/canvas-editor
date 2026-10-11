import { BookmarkMinus, Layers, Star } from 'lucide-react'
import { timeLabel } from '@/components/workspace/ui'
import type { CanvasFavorite } from '@/utils/storage'

export default function FavoriteCanvasCard({ favorite, busy, onOpen, onRemove }: { favorite: CanvasFavorite; busy: boolean; onOpen: () => void; onRemove: () => void }) {
  const active = favorite.status === 'active'
  const title = active ? favorite.title || '共享画布' : '共享画布已不可用'
  return <article className="ws-panel ws-canvas-card"><button className="ws-canvas-preview" style={{ width: '100%', border: 0 }} aria-label={`打开收藏 ${title}`} disabled={!active} onClick={onOpen}>{active && favorite.thumbnail ? <img src={favorite.thumbnail} alt={title} /> : <div className="ws-canvas-blank"><Layers size={27} strokeWidth={1.3} /></div>}<span className="ws-tag"><Star size={11} />{active ? '共享引用 · 只读' : '分享已失效'}</span></button><div className="ws-canvas-info"><div style={{ minWidth: 0 }}><h3>{title}</h3><p>{active ? `${favorite.authorName ? `${favorite.authorName} · ` : ''}更新于 ${timeLabel(favorite.updatedAt ?? favorite.addedAt)}` : '原分享已撤销、过期或权限失效'}</p></div><div className="ws-canvas-card-actions"><button className="ws-icon-button" title="取消我的收藏，原画布仍保留" aria-label={`取消收藏 ${title}`} disabled={busy} onClick={onRemove}><BookmarkMinus size={13} /></button></div></div></article>
}
