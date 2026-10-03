import { createHash } from 'node:crypto'
import type { ManagementEvent, ManagementNotification, ManagementProject } from './managementTypes.js'
import { validateFieldValues } from './managementFields.js'
import { normalizeManagementStatus, validateManagementStageMetadata } from './managementWorkflow.js'

export class ManagementNotificationError extends Error {
  readonly status = 400
  constructor(message: string) { super(message); this.name = 'ManagementNotificationError' }
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
function invalid(message: string): never { throw new ManagementNotificationError(message) }
export interface NotificationInput {
  project: ManagementProject; event: ManagementEvent; sender: { id: string; email: string }
  recipientIds: string[]; registeredUsers: Array<{ id: string; email: string }>
  mutationId: string; now: number; existing: ManagementNotification[]
}

/** Additions only. Caller persists notifications + operation receipt atomically.
 * No autosave hook, email, network, file I/O, or project permission grant. */
export function createNotifications(input: NotificationInput): ManagementNotification[] {
  if (!validId(input.mutationId) || !validId(input.sender.id) || !validId(input.project.id) || !validId(input.event.id)) invalid('推送操作id格式无效')
  if (!Number.isSafeInteger(input.now) || input.now < 0) invalid('推送时间无效')
  const editor = input.project.members?.some(member => member.userId === input.sender.id && member.permission === 'edit') === true
  if ((input.project.ownerId !== input.sender.id && !editor) || !input.project.events.some(event => event.id === input.event.id))
    invalid('当前账号无权推送此项目事件')
  if (!Array.isArray(input.recipientIds) || input.recipientIds.length > 100 || input.recipientIds.some(id => !validId(id))) invalid('请选择有效接收人')
  const recipients = [...new Set(input.recipientIds)]
  if (!recipients.length) invalid('请至少选择一位接收人')
  const registered = new Set(input.registeredUsers.map(user => user.id))
  if (!registered.has(input.sender.id)) invalid('推送账号已不存在或未注册')
  if (recipients.some(id => !registered.has(id))) invalid('接收人账号已不存在或未注册')
  const existing = new Set(input.existing.map(notification => notification.id))
  const definitions = input.project.tableConfig?.customFields ?? []
  const values = validateFieldValues(definitions, undefined, input.event.values ?? {}, false, input.event.roleId)
  const status = normalizeManagementStatus(input.event.status)
  const stageMetadata = validateManagementStageMetadata(input.event)
  const transitionNote = input.event.transitionNote
  if (transitionNote !== undefined && (typeof transitionNote !== 'string' || transitionNote.length > 2000 || /\0/.test(transitionNote)))
    invalid('流转说明必须是不超过2000字的文本')
  const role = input.project.roles.find(role => role.id === input.event.roleId)
  const category = input.project.categories.find(category => category.id === input.event.categoryId)
  const fieldLabels: Record<string, string> = Object.create(null)
  for (const field of definitions) if (Object.hasOwn(values, field.id)) fieldLabels[field.id] = field.name
  return recipients.flatMap(recipientId => {
    const id = 'notice_' + createHash('sha256').update(JSON.stringify([
      input.project.id, input.event.id, input.sender.id, input.mutationId, recipientId,
    ])).digest('hex').slice(0, 40)
    if (existing.has(id)) return []
    const source = input.event
    const snapshot: ManagementEvent = {
      id: source.id, title: source.title, description: source.description, roleId: source.roleId, categoryId: source.categoryId,
      source: source.source, recorder: source.recorder, assignee: source.assignee, priority: source.priority, status,
      createdAt: source.createdAt, updatedAt: source.updatedAt,
      ...(transitionNote === undefined ? {} : { transitionNote }),
      ...stageMetadata, ...(stageMetadata.stageTimes === undefined ? {} : { stageTimes: { ...stageMetadata.stageTimes } }),
      ...(source.completedAt === undefined ? {} : { completedAt: source.completedAt }), values: { ...values },
      attachments: source.attachments.map(asset => ({ id: asset.id, name: asset.name, mime: asset.mime, bytes: asset.bytes,
        createdAt: asset.createdAt, url: `/api/management/notifications/${id}/assets/${encodeURIComponent(asset.id)}` })),
    }
    return [{ id, recipientId, senderId: input.sender.id, senderName: input.sender.email,
      projectId: input.project.id, projectName: input.project.name, eventId: source.id, snapshot,
      snapshotLabels: { ...(role ? { role: role.name } : {}), ...(category ? { category: category.name } : {}), fields: { ...fieldLabels } },
      createdAt: input.now }]
  })
}

export function filterNotificationsForRecipient(notifications: ManagementNotification[], userId: string): ManagementNotification[] {
  return notifications.filter(notification => notification.recipientId === userId)
    .map(notification => JSON.parse(JSON.stringify(notification)) as ManagementNotification)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

/** Unknown/foreign ids are rejected atomically; retries retain the first readAt. */
export function markNotificationsRead(notifications: ManagementNotification[], userId: string,
  ids: string[], now: number): ManagementNotification[] {
  if (!validId(userId) || !Array.isArray(ids) || ids.length > 1000 || ids.some(id => !validId(id)) || !Number.isSafeInteger(now) || now < 0)
    invalid('通知已读请求格式无效')
  const requested = new Set(ids)
  const allowed = new Set(notifications.filter(notification => notification.recipientId === userId).map(notification => notification.id))
  if ([...requested].some(id => !allowed.has(id))) invalid('通知不存在或无权标记')
  return notifications.map(notification => requested.has(notification.id) && notification.recipientId === userId && notification.readAt === undefined
    ? { ...notification, readAt: now } : notification)
}
