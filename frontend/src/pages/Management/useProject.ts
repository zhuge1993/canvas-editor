import { useCallback, useEffect, useRef, useState } from 'react'
import { getProject, ManagementRequestError } from '@/services/management'
import type { ManagementProject } from '@/types/management'
export function useProject(id: string) {
  const [project, setProject] = useState<ManagementProject | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(0), [permissionDenied, setPermissionDenied] = useState(false)
  const current = useRef<ManagementProject | null>(null), activeId = useRef(id), queue = useRef<Promise<unknown>>(Promise.resolve())
  activeId.current = id
  const accept = useCallback((value: ManagementProject) => { if (value.id !== activeId.current) return; if (current.current && current.current.id === value.id && current.current.revision > value.revision) return; current.current = value; setProject(value) }, [])
  const reload = useCallback(async () => { setLoading(true); setError(''); try { const value = await getProject(id); if (activeId.current !== id) return false; accept(value); return true } catch (cause) { if (activeId.current === id) { setError(cause instanceof Error ? cause.message : '项目读取失败'); if (cause instanceof ManagementRequestError && [401, 403, 404].includes(cause.status)) { current.current = null; setProject(null); setPermissionDenied(true) } }; return false } finally { if (activeId.current === id) setLoading(false) } }, [id, accept])
  useEffect(() => { current.current = null; setProject(null); setBusy(0); setPermissionDenied(false); void reload() }, [reload])
  const invoke = useCallback((request: (project: ManagementProject) => Promise<ManagementProject>) => {
    const expectedId = activeId.current
    setBusy(value => value + 1)
    const job = queue.current.catch(() => {}).then(async () => { const value = current.current; if (!value || value.id !== expectedId || activeId.current !== expectedId) throw new Error('已切换到其他项目，先前尚未发送的保存已取消。'); const result = await request(value); accept(result); if (activeId.current === expectedId) setError(''); return result })
    queue.current = job
    return job.catch(cause => { if (activeId.current === expectedId) setError(cause instanceof Error ? cause.message : '保存失败，当前修改仍未确认。'); throw cause }).finally(() => { if (activeId.current === expectedId) setBusy(value => Math.max(0, value - 1)) })
  }, [accept])
  return { project, loading, error, busy: busy > 0, reload, invoke, accept, permissionDenied }
}
