import type { ManagementProject } from '@/types/management'
import { mutationId } from './management'
export interface OnlineMember { userId: string; name: string; sessions: number; lastSeenAt: number }
export function connectProjectLive(projectId: string, handlers: { snapshot: (project: ManagementProject) => void; revision: (revision: number, force?: boolean) => void; presence: (users: OnlineMember[]) => void; state: (connected: boolean) => void }) {
  const source = new EventSource(`/api/management/projects/${encodeURIComponent(projectId)}/live?${new URLSearchParams({ clientId: mutationId() })}`, { withCredentials: true })
  const parse = (event: MessageEvent) => JSON.parse(String(event.data)) as Record<string, unknown>
  source.onopen = () => handlers.state(true)
  source.onerror = () => { handlers.state(false); handlers.presence([]) }
  source.addEventListener('snapshot', event => { try { const data = parse(event as MessageEvent); const project = data.project as ManagementProject; if (data.refreshRequired === true || !Array.isArray(project.events)) handlers.revision(Number(data.revision) || project.revision || 0, true); else handlers.snapshot(project); const presence = data.presence as { users?: OnlineMember[] } | undefined; handlers.presence(presence?.users ?? []); handlers.state(true) } catch { handlers.state(false) } })
  source.addEventListener('revision', event => { try { const data = parse(event as MessageEvent); if (typeof data.revision === 'number') handlers.revision(data.revision) } catch { handlers.state(false) } })
  source.addEventListener('presence', event => { try { const data = parse(event as MessageEvent); handlers.presence((data.users ?? []) as OnlineMember[]) } catch { handlers.state(false) } })
  return () => source.close()
}
