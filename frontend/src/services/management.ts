import type { AIShare, AIShareScope, EventDraft, EventUpdatePatch, ManagementAttachment, ManagementEvent, ManagementFilters, ManagementHistory, ManagementProject, ManagementProjectSummary, ManagementStats, ManagementTableConfig, ManagementMember, ManagementNotification, ManagementWorkRecords, ProjectInvite, ProjectInvitePreview, MutationOptions, ProjectDraft } from '@/types/management'

export class ManagementRequestError extends Error {
  status: number
  currentRevision?: number
  constructor(status: number, message: string, currentRevision?: number) { super(message); this.name = 'ManagementRequestError'; this.status = status; this.currentRevision = currentRevision }
}
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(url, { ...init, credentials: 'same-origin', signal: init.signal ?? AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', ...init.headers } })
    const data = await response.json().catch(() => ({})) as T & { error?: string; currentRevision?: number }
    if (!response.ok) throw new ManagementRequestError(response.status, data.error ?? `请求失败 (${response.status})`, data.currentRevision)
    return data
  } catch (error) {
    if (error instanceof ManagementRequestError) throw error
    throw new ManagementRequestError(0, error instanceof Error && error.name === 'TimeoutError' ? '保存请求超时，请检查连接后重试；编辑内容仍保留在页面中。' : '连接暂时中断，请检查网络后重试。')
  }
}
const base = '/api/management/projects'
const path = (id: string) => `${base}/${encodeURIComponent(id)}`
export function mutationId(): string { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(3))).join('-')}` }
const body = (value: object, options: MutationOptions = {}) => JSON.stringify({ ...value, ...options, mutationId: options.mutationId ?? mutationId() })
function query(filters: ManagementFilters = {}, days?: number): string {
  const values = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) if (value) values.set(key, String(value))
  if (days) values.set('days', String(days))
  return values.size ? `?${values}` : ''
}
export const listProjects = () => request<ManagementProjectSummary[]>(base)
export const getProject = (id: string) => request<ManagementProject>(path(id))
export const createProject = (draft: ProjectDraft, options?: MutationOptions) => request<ManagementProject>(base, { method: 'POST', body: body(draft, options) })
export const updateProject = (id: string, patch: Partial<ProjectDraft>, options?: MutationOptions) => request<ManagementProject>(path(id), { method: 'PATCH', body: body(patch, options) })
export const getStats = (id: string, filters: ManagementFilters = {}, days = 14) => request<ManagementStats>(`${path(id)}/stats${query(filters, days)}`)
export const getEvents = (id: string, filters: ManagementFilters = {}) => request<ManagementEvent[]>(`${path(id)}/events${query(filters)}`)
export const getHistory = (id: string) => request<ManagementHistory[]>(`${path(id)}/history`)
export const createEvent = (id: string, draft: EventDraft & { id?: string }, options?: MutationOptions) => request<ManagementProject>(`${path(id)}/events`, { method: 'POST', body: body({ ...draft, attachments: draft.attachments.map(item => ({ id: item.id })) }, options) })
export const updateEvent = (id: string, eventId: string, patch: EventUpdatePatch, options?: MutationOptions) => request<ManagementProject>(`${path(id)}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: body({ ...patch, ...(patch.attachments ? { attachments: patch.attachments.map(item => ({ id: item.id })) } : {}) }, options) })
export const deleteEvent = (id: string, eventId: string, options?: MutationOptions) => request<ManagementProject>(`${path(id)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', body: body({}, options) })
export const createTag = (id: string, kind: 'roles' | 'categories', value: { name: string; color: string }, options?: MutationOptions) => request<ManagementProject>(`${path(id)}/${kind}`, { method: 'POST', body: body(value, options) })
export const updateTag = (id: string, kind: 'roles' | 'categories', tagId: string, value: { name: string; color: string }, options?: MutationOptions) => request<ManagementProject>(`${path(id)}/${kind}/${encodeURIComponent(tagId)}`, { method: 'PATCH', body: body(value, options) })
export const deleteTag = (id: string, kind: 'roles' | 'categories', tagId: string, options?: MutationOptions) => request<ManagementProject>(`${path(id)}/${kind}/${encodeURIComponent(tagId)}`, { method: 'DELETE', body: body({}, options) })
export async function uploadAttachment(id: string, file: File): Promise<ManagementAttachment> {
  if (file.size > 8 * 1024 * 1024) throw new Error('单个附件请控制在 8 MB 内。')
  const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('附件读取失败')); reader.readAsDataURL(file) })
  return request<ManagementAttachment>(`${path(id)}/assets`, { method: 'POST', body: JSON.stringify({ name: file.name, dataUrl }) })
}
export const getAIShares = (kind: 'management' | 'canvas', resourceId: string) => request<AIShare[]>(`/api/ai-shares?${new URLSearchParams({ kind, resourceId })}`)
export const createAIShare = (kind: 'management' | 'canvas', resourceId: string, scope: AIShareScope) => request<AIShare>('/api/ai-shares', { method: 'POST', body: JSON.stringify({ kind, resourceId, scope }) })
export const revokeAIShare = (id: string) => request<{ ok: boolean }>(`/api/ai-shares/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const setupTable = (id: string, roles: Array<{ name: string; color?: string; memberIds?: string[] }>, tableConfig: ManagementTableConfig, options?: MutationOptions) => request<ManagementProject>(`${path(id)}/table-setup`, { method: 'POST', body: body({ roles, tableConfig }, options) })
export const getMembers = () => request<ManagementMember[]>('/api/management/members')
export const notifyEvent = (id: string, eventId: string, recipientIds: string[], actionId: string, revision?: number) => request<{ ok: true; notificationIds: string[]; count: number }>(`${path(id)}/events/${encodeURIComponent(eventId)}/notify`, { method: 'POST', body: JSON.stringify({ recipientIds, mutationId: actionId, ...(revision !== undefined ? { revision } : {}) }) })
export const getNotifications = (unread = false) => request<ManagementNotification[]>(`/api/management/notifications${unread ? '?unread=1' : ''}`)
export const readNotification = (id: string) => request<{ ok: true }>(`/api/management/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH', body: '{}' })

export const getWorkRecords = (id: string, options: { roleId?: string; date?: string; offset?: number; limit?: number } = {}) => request<ManagementWorkRecords>(`${path(id)}/work-records${query(options as ManagementFilters)}`)

export const getProjectInvites = (id: string) => request<ProjectInvite[]>(`${path(id)}/invites`)
export const createProjectInvite = (id: string, input: { permission: 'view' | 'edit'; roleIds: string[]; maxUses: number; expiresAt: number }, actionId: string) => request<ProjectInvite>(`${path(id)}/invites`, { method: 'POST', body: JSON.stringify({ ...input, mutationId: actionId }) })
export const revokeProjectInvite = (id: string, inviteId: string) => request<{ ok: boolean }>(`${path(id)}/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' })
export const previewProjectInvite = (token: string) => request<ProjectInvitePreview>(`/api/management/invites/${encodeURIComponent(token)}`)
export const acceptProjectInvite = (token: string, actionId: string) => request<ManagementProject>(`/api/management/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body: JSON.stringify({ mutationId: actionId }) })

export const deleteProject = (id: string, options?: MutationOptions) => request<{ ok: true }>(path(id), { method: 'DELETE', body: body({}, options) })
export const createExampleProject = (actionId: string) => request<ManagementProject>(`${base}/example`, { method: 'POST', body: JSON.stringify({ mutationId: actionId }) })
