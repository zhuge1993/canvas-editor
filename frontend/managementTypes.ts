/** Shared, runtime-independent contracts for the FlowBoard management module. */
import type { ManagementStatus } from './managementWorkflow.js'
export type { ManagementStatus } from './managementWorkflow.js'
export type ManagementPriority = 'low' | 'medium' | 'high' | 'urgent'
export interface ManagementTag { id: string; name: string; color: string }
export interface ManagementRole extends ManagementTag { memberIds?: string[] }
export type ManagementCategory = ManagementTag
export interface ManagementFieldDefinition {
  id: string; name: string; type: 'text' | 'number' | 'date' | 'select' | 'checkbox'
  options?: string[]; required?: boolean; roleId?: string
}
export interface ManagementTableConfig {
  configured: boolean; visibleBaseFields: string[]; baseLabels: Record<string, string>
  customFields: ManagementFieldDefinition[]
}
export interface ManagementMember { id: string; name: string; emailMasked: string; isSelf: boolean }
export interface ManagementAttachment {
  id: string; name: string; mime: string; bytes: number; url: string; createdAt: number
}
export interface ManagementEvent {
  id: string; title: string; description: string; roleId: string; categoryId: string
  source: string; recorder: string; assignee: string; priority: ManagementPriority
  status: ManagementStatus; createdAt: number; updatedAt: number; completedAt?: number
  transitionNote?: string
  stageChangedAt?: number; stageTimes?: Partial<Record<ManagementStatus, number>>
  attachments: ManagementAttachment[]
  values?: Record<string, string | number | boolean>; assigneeId?: string; recipientIds?: string[]
}
export interface ManagementHistory {
  id: string; eventId?: string; action: string; at: number; actorId: string; actorName?: string; note?: string
  changes: Array<{ field: string; before: unknown; after: unknown }>
}
export interface ManagementProjectMember { userId: string; permission: 'view' | 'edit' }
export interface ManagementProject {
  id: string; ownerId: string; name: string; description: string; color: string; icon: string
  roles: ManagementRole[]; categories: ManagementCategory[]; canvasIds: string[]
  events: ManagementEvent[]; history: ManagementHistory[]
  createdAt: number; updatedAt: number; archivedAt?: number; revision: number
  tableConfig?: ManagementTableConfig
  members?: ManagementProjectMember[]; access?: 'owner' | 'view' | 'edit'
}
export interface ManagementNotification {
  id: string; recipientId: string; senderId: string; senderName: string
  projectId: string; projectName: string; eventId: string; snapshot: ManagementEvent
  snapshotLabels?: { role?: string; category?: string; fields?: Record<string, string> }
  createdAt: number; readAt?: number
}
export interface ManagementFilters {
  roleId?: string; categoryId?: string; status?: ManagementStatus
  priority?: ManagementPriority; search?: string
}
export interface ManagementStatTotals {
  total: number; activeTotal: number; todo: number; doing: number; done: number; cancelled: number; completionPercent: number
  newToday: number; completedToday: number
}
export interface ManagementStats extends ManagementStatTotals {
  today: string; timeZone: string; filters: ManagementFilters
  byStatus: Array<{ id: ManagementStatus; label: string; color: string; count: number }>
  byRole: Array<ManagementTag & { count: number; statusCounts: Record<ManagementStatus, number>; activeCount: number; handlingMs: number; stageDurationMs: Partial<Record<ManagementStatus, number>> }>
  byCategory: Array<ManagementTag & { count: number }>
  trend: Array<{ date: string; created: number; completed: number }>
}
export interface ManagementProjectSummary extends Omit<ManagementProject, 'events' | 'history'> {
  eventCount: number; stats: ManagementStatTotals
}
export interface AIShareScope {
  canvasIds?: string[]; eventIds?: string[]
  includeHistory?: boolean; includeStats?: boolean
  includeAttachments?: boolean; includePreview?: boolean
}
export interface AIShare {
  id: string; token: string; kind: 'management' | 'canvas'; resourceId: string
  createdAt: number; scope: AIShareScope; url: string; jsonUrl: string
}
export interface AIPagination {
  offset: number; limit: number; total: number; nextUrl?: string
}
export interface AIDataExport {
  kind: 'management' | 'canvas'; name: string; description: string
  project?: Omit<ManagementProject, 'events' | 'history' | 'ownerId'>
  events?: ManagementEvent[]; history?: ManagementHistory[]; stats?: ManagementStats
  canvas?: unknown
  canvases: Array<{ id: string; title: string; jsonUrl: string; previewUrl?: string }>
  assets: ManagementAttachment[]; pagination?: AIPagination; historyPagination?: AIPagination
  markdownUrl: string; jsonUrl: string; generatedAt: number
}

export interface ManagementWorkRecord {
  id: string; eventId?: string; eventTitle: string; roleId: string; previousRoleId?: string
  action: string; at: number; actorId: string; actorName?: string; note?: string
  statusBefore?: ManagementStatus; statusAfter?: ManagementStatus
  changes: ManagementHistory['changes']
}
export interface ManagementWorkRecords {
  projectId: string; roleId?: string; date?: string; records: ManagementWorkRecord[]
  pagination: { offset: number; limit: number; total: number; nextOffset?: number }
}
