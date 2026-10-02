import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowUpRight, Check, Copy, FolderOpen, X } from 'lucide-react'

export function timeLabel(value: number, full = false): string { return new Date(value).toLocaleString('zh-CN', full ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
export function PageIntro({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="ws-page-intro"><div><p className="ws-eyebrow">{eyebrow}</p><h1>{title}</h1><p className="ws-page-description">{description}</p></div>{children && <div className="ws-intro-actions">{children}</div>}</div>
}
export function EmptyState({ title, description, children }: { title: string; description: string; children?: ReactNode }) { return <div className="ws-empty"><div className="ws-empty-art"><FolderOpen size={30} strokeWidth={1.4} /></div><h3>{title}</h3><p>{description}</p>{children}</div> }
export function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) { return error ? <div className="ws-error" role="alert"><span>{error}</span>{onRetry && <button onClick={onRetry}>重新加载 <ArrowUpRight size={14} /></button>}</div> : null }
const ModalCloseContext = createContext<() => void>(() => {})
export function ModalCancelButton({ label = '取消' }: { label?: string }) { const close = useContext(ModalCloseContext); return <button type="button" className="ws-button" onClick={close}>{label}</button> }
export function WorkspaceModal({ title, description, children, onClose, dirty = false, busy = false, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; dirty?: boolean; busy?: boolean; wide?: boolean }) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  function close() { if (busy) return; if (dirty) setConfirmClose(true); else onClose() }
  const closeRef = useRef(close); closeRef.current = close
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLElement>('input,textarea,button')?.focus()
    function keys(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
      if (event.key !== 'Tab') return
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]') ?? []).filter(node => node.offsetParent !== null)
      const first = nodes[0], last = nodes.at(-1)
      if (first && !panel.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); return }
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keys)
    return () => { document.removeEventListener('keydown', keys); previous?.focus() }
  }, [])
  return <ModalCloseContext.Provider value={close}><div className="ws-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}><div ref={panel} className={`ws-modal ${wide ? 'ws-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id}><div className="ws-modal-head"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div><button className="ws-icon-button" aria-label="关闭对话框" disabled={busy} onClick={close}><X size={19} /></button></div>{confirmClose ? <div className="ws-discard"><h3>还有未保存的修改</h3><p>继续编辑可以保留这些内容。放弃后，本次修改不会保存。</p><div className="ws-modal-actions"><button className="ws-button" onClick={() => setConfirmClose(false)}>继续编辑</button><button className="ws-button ws-button-danger" onClick={onClose}>放弃并关闭</button></div></div> : children}</div></div></ModalCloseContext.Provider>
}
export async function copyText(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value) } catch { const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select(); const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error('复制失败，请手动选择链接复制。') }
}
export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) { const [copied, setCopied] = useState(false); const [error, setError] = useState(''); return <><button className="ws-button ws-button-small" onClick={() => void copyText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000) }).catch(cause => setError(cause instanceof Error ? cause.message : '复制失败'))}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : label}</button>{error && <small role="alert">{error}</small>}</> }
