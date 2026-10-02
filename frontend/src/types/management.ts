export type {
  ManagementProject, ManagementProjectSummary, ManagementEvent, ManagementTag,
  ManagementRole, ManagementCategory, ManagementAttachment, ManagementHistory,
  ManagementFieldDefinition, ManagementTableConfig, ManagementMember, ManagementNotification, ManagementProjectMember,
  ManagementStats, ManagementFilters, ManagementWorkRecord, ManagementWorkRecords, ManagementPriority, ManagementStatus, AIShare, AIShareScope,
} from '../../managementTypes'
import type { ManagementEvent, ManagementProjectMember } from '../../managementTypes'

export type EventDraft = Pick<ManagementEvent, 'title' | 'description' | 'roleId' | 'categoryId' | 'source' | 'assignee' | 'priority' | 'status' | 'attachments'> & Partial<Pick<ManagementEvent, 'values' | 'assigneeId' | 'recipientIds'>>
export interface ProjectDraft { name: string; description: string; color: string; icon?: string; canvasIds?: string[]; members?: ManagementProjectMember[] }
export interface MutationOptions { revision?: number; mutationId?: string; expectedEventUpdatedAt?: number; baseValues?: Record<string, unknown> }

export type EventUpdatePatch = Omit<Partial<EventDraft>, 'values'> & { values?: Record<string, string | number | boolean | null>; transitionNote?: string }

export { MANAGEMENT_STATUS_DEFINITIONS, MANAGEMENT_STATUSES } from '../../managementWorkflow'

/** Project membership inputs; role assignments are stored canonically in roles.memberIds. */
export interface ProjectMemberAssignment extends ManagementProjectMember { roleIds: string[] }
export interface ProjectInvite {
  id: string; token: string; projectId: string; permission: 'view' | 'edit'; roleIds: string[]
  recipientId?: string; maxUses: number; uses: number; expiresAt: number; createdAt: number; url: string
}
export interface ProjectInvitePreview {
  projectId: string; projectName: string; permission: 'view' | 'edit'
  roles: Array<{ id: string; name: string; color: string }>
  expiresAt: number; maxUses: number; remainingUses: number; accepted: boolean
}
