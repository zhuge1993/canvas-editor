export interface CanvasDraft { content: string; updatedAt?: number }
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const canvasDraftKey = (id: string) => `flowboard_draft_${id}`
/** Old builds wrote the raw canvas while their reader expected an envelope.
 * Treat those recoverable raw canvases as untimed drafts, never as disposable
 * stale cache. No unsaved draft is evicted to make room for another. */
export function parseCanvasDraft(raw: string | null): CanvasDraft | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (typeof value.content === 'string' && Number.isSafeInteger(value.updatedAt) && (value.updatedAt as number) >= 0) {
      JSON.parse(value.content)
      return { content: value.content, updatedAt: value.updatedAt as number }
    }
    if (value.shapes && typeof value.shapes === 'object' && Array.isArray(value.order)) return { content: raw }
  } catch { /* A corrupt draft remains untouched for manual recovery. */ }
  return null
}
export function writeCanvasDraft(storage: DraftStorage, id: string, content: string, now = Date.now()): void {
  storage.setItem(canvasDraftKey(id), JSON.stringify({ content, updatedAt: now }))
}
/** The save ACK authorizes removal only of the same content, so a newer local
 * edit made while the network write was pending remains recoverable. */
export function clearSavedCanvasDraft(storage: DraftStorage, id: string, savedContent: string): boolean {
  const key = canvasDraftKey(id), current = parseCanvasDraft(storage.getItem(key))
  if (current?.content !== savedContent) return false
  storage.removeItem(key)
  return true
}
