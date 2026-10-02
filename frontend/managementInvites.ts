import { randomBytes } from 'node:crypto'
import type { ManagementProject } from './managementTypes.js'

export interface InviteStored {
  id: string; token: string; projectId: string; ownerId: string
  permission: 'view' | 'edit'; roleIds: string[]; recipientId?: string
  maxUses: number; expiresAt: number; createdAt: number
}
export class ManagementInviteError extends Error {
  readonly status: number
  constructor(message: string, status = 400) { super(message); this.name = 'ManagementInviteError'; this.status = status }
}
type InviteProject = Pick<ManagementProject, 'id' | 'ownerId' | 'roles'>
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9_-]{1,120}$/
const validId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
function invalid(message: string, status = 400): never { throw new ManagementInviteError(message, status) }
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
    invalid('邀请时间格式无效')
  return value
}
function permission(value: unknown): 'view' | 'edit' {
  if (value !== 'view' && value !== 'edit') invalid('邀请权限必须是查看或编辑')
  return value
}
function roleIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(id => !validId(id))) invalid('邀请角色列表格式无效')
  return [...new Set(value as string[])]
}
function maxUses(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) invalid('邀请使用次数必须在1至100之间')
  return value
}

/** The authenticated route supplies the current owner and registered accounts.
 * The token grants project membership only; it is not an account/admin invite. */
export function createProjectInvite(input: unknown, context: {
  project: InviteProject; ownerId: string; registeredUsers: Array<{ id: string }>; now: number
}): InviteStored {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('项目邀请必须是对象')
  const body = input as Record<string, unknown>
  if (Object.keys(body).some(key => !['permission', 'roleIds', 'recipientId', 'maxUses', 'expiresAt'].includes(key)))
    invalid('项目邀请包含未知字段')
  const now = timestamp(context.now), project = context.project
  if (!validId(project.id) || !validId(context.ownerId) || project.ownerId !== context.ownerId)
    invalid('只有项目创建者可以邀请成员', 403)
  const registered = new Set(context.registeredUsers.map(user => user.id))
  if (!registered.has(context.ownerId)) invalid('邀请创建者账号已不存在', 403)
  const selectedRoles = roleIds(body.roleIds === undefined ? [] : body.roleIds)
  const currentRoles = new Set(project.roles.map(role => role.id))
  if (selectedRoles.some(id => !currentRoles.has(id))) invalid('邀请角色不属于当前项目')
  const recipientId = body.recipientId === undefined || body.recipientId === '' ? undefined : body.recipientId
  if (recipientId !== undefined && (!validId(recipientId) || !registered.has(recipientId))) invalid('指定接收人必须是已注册账号')
  const expiresAt = timestamp(body.expiresAt === undefined ? now + DEFAULT_AGE_MS : body.expiresAt)
  if (expiresAt <= now || expiresAt - now > MAX_AGE_MS) invalid('邀请有效期必须大于当前时间且不超过30天')
  return { id: 'minvite_' + randomBytes(12).toString('hex'), token: randomBytes(32).toString('base64url'),
    projectId: project.id, ownerId: context.ownerId, permission: permission(body.permission === undefined ? 'view' : body.permission), roleIds: selectedRoles,
    ...(recipientId === undefined ? {} : { recipientId: recipientId as string }), maxUses: maxUses(body.maxUses === undefined ? 20 : body.maxUses),
    expiresAt, createdAt: now }
}

/** Strict backup/store schema, including expired invites. Resource existence,
 * account authentication and active usage are checked only at redemption. */
export function normalizeStoredProjectInvite(raw: unknown): InviteStored {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('项目邀请格式无效')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['id', 'token', 'projectId', 'ownerId', 'permission', 'roleIds', 'recipientId', 'maxUses', 'expiresAt', 'createdAt'].includes(key)))
    invalid('项目邀请存储包含未知字段')
  if (!validId(value.id) || !validId(value.projectId) || !validId(value.ownerId) || typeof value.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.token) || Buffer.from(value.token, 'base64url').toString('base64url') !== value.token)
    invalid('项目邀请标识格式无效')
  const createdAt = timestamp(value.createdAt), expiresAt = timestamp(value.expiresAt)
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_AGE_MS) invalid('项目邀请有效期格式无效')
  if (value.recipientId !== undefined && !validId(value.recipientId)) invalid('项目邀请接收人格式无效')
  const roles = roleIds(value.roleIds)
  if (roles.length !== (value.roleIds as string[]).length) invalid('项目邀请存储角色不能重复')
  return { id: value.id, token: value.token, projectId: value.projectId, ownerId: value.ownerId,
    permission: permission(value.permission), roleIds: roles, maxUses: maxUses(value.maxUses), createdAt, expiresAt,
    ...(value.recipientId === undefined ? {} : { recipientId: value.recipientId as string }) }
}

/** Validate an invite freshly loaded from the active store after normal account
 * authentication and owner-existence checks. Revoked entries must never be
 * passed here. Usage is the unique-user ledger committed with the project. */
export function validateProjectInvite(invite: InviteStored, context: {
  project: InviteProject; actorId: string; now: number; acceptedUserIds: string[]
}): void {
  const stored = normalizeStoredProjectInvite(invite)
  const selectedRoles = stored.roleIds, maximum = stored.maxUses, expiresAt = stored.expiresAt, now = timestamp(context.now)
  if (!validId(context.actorId)) invalid('请先注册并登录后接受邀请', 403)
  if (context.project.id !== invite.projectId || context.project.ownerId !== invite.ownerId)
    invalid('项目或邀请创建者已改变', 403)
  if (now >= expiresAt) invalid('项目邀请已过期', 410)
  if (invite.recipientId !== undefined && (!validId(invite.recipientId) || invite.recipientId !== context.actorId))
    invalid('此邀请仅允许指定接收人接受', 403)
  const currentRoles = new Set(context.project.roles.map(role => role.id))
  if (selectedRoles.some(id => !currentRoles.has(id))) invalid('邀请中的角色已不存在', 410)
  if (!Array.isArray(context.acceptedUserIds) || context.acceptedUserIds.length > 200 || context.acceptedUserIds.some(id => !validId(id)))
    invalid('项目邀请使用记录格式无效')
  const accepted = new Set(context.acceptedUserIds)
  if (accepted.size > 100) invalid('项目邀请使用记录格式无效')
  if (!accepted.has(context.actorId) && accepted.size >= maximum) invalid('项目邀请使用次数已用完', 410)
}
