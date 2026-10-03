import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { RuntimePaths, StoredDocument } from './runtimeCore.js'
import type {
  AIShare, AIShareScope, ManagementAttachment, ManagementEvent, ManagementFilters,
  ManagementHistory, ManagementProject, ManagementProjectSummary, ManagementStats, ManagementTag, ManagementRole, ManagementNotification, ManagementStatus, ManagementWorkRecord, ManagementWorkRecords,
} from './managementTypes.js'
import { ManagementFieldError, normalizeTableConfig, validateFieldValues } from './managementFields.js'
import { createManagementExample } from './managementExample.js'
import { ManagementInviteError, createProjectInvite, validateProjectInvite, normalizeStoredProjectInvite } from './managementInvites.js'
import type { InviteStored } from './managementInvites.js'
import { MANAGEMENT_STATUSES, MANAGEMENT_STATUS_DEFINITIONS, ManagementWorkflowError, normalizeManagementStatus, managementTransitionMetadata } from './managementWorkflow.js'
import { attachProjectLive, publishProjectChange } from './managementLive.js'
import { ManagementNotificationError, createNotifications, filterNotificationsForRecipient, markNotificationsRead } from './managementNotifications.js'
import { buildManagementExport, collectCanvasAssetRefs, renderCanvasPreview, renderManagementMarkdown } from './managementExport.js'
import { managementPendingUploads, sweepManagementUploads, MANAGEMENT_PENDING_UPLOAD_BYTES, MANAGEMENT_PENDING_UPLOAD_COUNT } from './managementMaintenance.js'

export interface ManagementActor { id: string; email: string; projectInviteId?: string }
export interface ManagementServices {
  currentUser(req: IncomingMessage, paths: RuntimePaths): Promise<ManagementActor | null>
  ownerExists(paths: RuntimePaths, ownerId: string): Promise<boolean>
  registeredUsers(paths: RuntimePaths): Promise<ManagementActor[]>
  readCanvas(paths: RuntimePaths, id: string): Promise<StoredDocument | null>
  readBody(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>>
  writeJson(file: string, value: unknown): Promise<void>
  writeBuffer(file: string, value: Buffer): Promise<void>
  origin(req: IncomingMessage): string
  sendJson(res: ServerResponse, status: number, value: unknown): void
}
interface Receipt { id: string; digest: string }
interface StoredManagement extends ManagementProject { schemaVersion: 1; deletedAt?: number; receipts: Receipt[]; inviteAcceptances?: Array<{inviteId:string;userId:string;at:number}> }
interface StoredAIShare extends Omit<AIShare, 'url' | 'jsonUrl'> { ownerId: string }
interface StoredAttachment extends ManagementAttachment { ownerId: string; projectId: string; file: string }
class ManagementError extends Error {
  readonly status: number
  readonly currentRevision?: number
  constructor(status: number, message: string, currentRevision?: number) {
    super(message); this.status = status; this.currentRevision = currentRevision
  }
}
const queues = new Map<string, Promise<void>>()
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_PROJECT_BYTES = 12 * 1024 * 1024
const JSON_BODY_BYTES = 128 * 1024
export const MAX_AI_SHARES_PER_RESOURCE = 32
export const MAX_AI_SHARES_PER_OWNER = 128
export const MAX_AI_SHARES = 2048
const MAX_CAPABILITY_STORE_BYTES = 2 * 1024 * 1024
export const MAX_PROJECT_INVITES = 100
export const MAX_INVITE_RECEIPTS = 4096
const maintenanceStates = new Map<string, { nextAt: number; afterProject?: string }>()
const MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000
const mimeExtensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
  'application/json': 'jsondata', 'application/zip': 'zip', 'application/octet-stream': 'bin',
  'image/svg+xml': 'svg', 'text/html': 'html',
}
function fail(status: number, message: string): never { throw new ManagementError(status, message) }
function id(prefix: string) { return `${prefix}_${randomBytes(12).toString('hex')}` }
function validId(value: unknown): value is string { return typeof value === 'string' && ID_PATTERN.test(value) }
function text(value: unknown, label: string, max: number, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) fail(400, `${label}格式无效`)
  return value.trim()
}
function name(value: unknown, fallback = '') { const result = text(value, '名称', 200, fallback); if (!result) fail(400, '名称不能为空'); return result }
function color(value: unknown, fallback = '#3b63f6') { const result = text(value, '颜色', 7, fallback); if (!/^#[a-fA-F0-9]{6}$/.test(result)) fail(400, '颜色必须是六位十六进制'); return result }
function stringIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some(item => !validId(item))) fail(400, `${label}格式无效`)
  return [...new Set(value as string[])]
}
function rootDir(paths: RuntimePaths) { return path.join(paths.dataDirectory, 'management') }
function projectsDir(paths: RuntimePaths) { return path.join(rootDir(paths), 'projects') }
function projectFile(paths: RuntimePaths, projectId: string) { if (!validId(projectId)) fail(404, '项目不存在'); return path.join(projectsDir(paths), `${projectId}.json`) }
function sharesFile(paths: RuntimePaths) { return path.join(paths.authDirectory, 'ai-shares.json') }
function invitesFile(paths: RuntimePaths) { return path.join(paths.authDirectory, 'management-invites.json') }
function notificationsFile(paths: RuntimePaths) { return path.join(paths.authDirectory, 'management-notifications.json') }
function assetDir(paths: RuntimePaths, projectId: string) { if (!validId(projectId)) fail(404, '项目不存在'); return path.join(paths.dataDirectory, 'management-assets', projectId) }
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  queues.set(key, tail)
  await previous.catch(() => undefined)
  try { return await work() } finally { release(); void tail.finally(() => { if (queues.get(key) === tail) queues.delete(key) }) }
}
export function withManagementDataset<T>(paths: RuntimePaths, operation: () => Promise<T>): Promise<T> {
  return serial(`${rootDir(paths)}:dataset`, operation)
}
function publicProject(project: StoredManagement, actor?: ManagementActor): ManagementProject {
  const { schemaVersion: _schema, receipts: _receipts, deletedAt: _deleted, inviteAcceptances: _acceptances, ...value } = project
  return { ...value, ...(actor ? { access: projectAccess(project, actor) } : {}) }
}
function projectAccess(project: StoredManagement, actor: ManagementActor): ManagementProject['access'] {
  return project.ownerId === actor.id ? 'owner' : project.members?.find(item => item.userId === actor.id)?.permission
}
function requireProjectOwner(project: StoredManagement, actor: ManagementActor) { if (project.ownerId !== actor.id) fail(403, '只有项目所有者可以更改此设置') }
async function readableProject(paths: RuntimePaths, projectId: string, actor: ManagementActor, services: ManagementServices) {
  const project = await loadProject(paths, projectId)
  if (!await services.ownerExists(paths, project.ownerId)) fail(404, '项目所有者已不存在')
  if (!projectAccess(project, actor)) fail(403, '没有项目权限')
  return project
}
async function loadProject(paths: RuntimePaths, projectId: string): Promise<StoredManagement> {
  const value = await readJson<StoredManagement | null>(projectFile(paths, projectId), null)
  if (!value || value.deletedAt || value.id !== projectId) fail(404, '项目不存在')
  return value
}
async function ownedProject(paths: RuntimePaths, projectId: string, actor: ManagementActor) {
  const project = await loadProject(paths, projectId)
  if (project.ownerId !== actor.id) fail(403, '没有项目权限')
  return project
}
function receipt(body: Record<string, unknown>, action: string): Receipt | undefined {
  if (body.mutationId === undefined) return undefined
  if (!validId(body.mutationId)) fail(400, 'mutationId格式无效')
  const { mutationId, revision: _revision, expectedRevision: _expectedRevision, ...data } = body
  const canonical = (value: unknown, depth = 0): string => {
    if (depth > 40) fail(400, '请求嵌套层次过深')
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
    return JSON.stringify(value) ?? 'null'
  }
  return { id: mutationId, digest: createHash('sha256').update(canonical([action, data])).digest('hex') }
}
function checkReceipt(project: StoredManagement, operation: Receipt | undefined): boolean {
  if (!operation) return false
  const previous = project.receipts?.find(item => item.id === operation.id)
  if (!previous) return false
  if (previous.digest !== operation.digest) fail(409, '同一mutationId不能提交不同操作')
  return true
}
function checkRevision(project: StoredManagement, body: Record<string, unknown>) {
  if (body.revision !== undefined && body.expectedRevision !== undefined && body.revision !== body.expectedRevision) fail(400, 'revision与expectedRevision不一致')
  const revision = body.revision ?? body.expectedRevision
  if (revision === undefined) return
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) fail(400, 'revision格式无效')
  if (revision !== project.revision) throw new ManagementError(409, '项目已更新，请刷新后重试', project.revision)
}
function validateRevisionShape(body: Record<string, unknown>) {
  if (body.revision !== undefined && body.expectedRevision !== undefined && body.revision !== body.expectedRevision) fail(400, 'revision与expectedRevision不一致')
  for (const key of ['revision', 'expectedRevision']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || (body[key] as number) < 1)) fail(400, `${key}格式无效`)
}
const EDITABLE_EVENT_FIELDS = ['title','description','roleId','categoryId','source','assignee','priority','status','attachments','values','assigneeId','recipientIds']
function checkEventGuard(project: StoredManagement, eventId: string, body: Record<string, unknown>, action: string): boolean {
  if (body.expectedEventUpdatedAt === undefined && body.baseValues === undefined) return false
  const event = project.events.find(value => value.id === eventId)
  if (!event) fail(404, '事件不存在')
  if (body.expectedEventUpdatedAt !== undefined && (!Number.isSafeInteger(body.expectedEventUpdatedAt) || (body.expectedEventUpdatedAt as number) < 0)) fail(400, 'expectedEventUpdatedAt格式无效')
  if (body.baseValues !== undefined) {
    if (!body.baseValues || typeof body.baseValues !== 'object' || Array.isArray(body.baseValues)) fail(400, 'baseValues格式无效')
    const values = body.baseValues as Record<string, unknown>
    if (Object.keys(values).some(key => !EDITABLE_EVENT_FIELDS.includes(key))) fail(400, 'baseValues包含未知或不可编辑字段')
    const edited = EDITABLE_EVENT_FIELDS.filter(key => body[key] !== undefined)
    if (!action.startsWith('events.PATCH.') || !edited.length || edited.some(key => !Object.hasOwn(values, key))) fail(400, 'baseValues必须覆盖此次修改的全部字段')
    for (const field of Object.keys(values)) {
      if (field === 'values') {
        const before = values.values, updates = body.values
        if (!before || typeof before !== 'object' || Array.isArray(before) || !updates || typeof updates !== 'object' || Array.isArray(updates)) fail(400, '自定义字段的局部修改和原值必须是对象')
        const defs = new Set((project.tableConfig?.customFields ?? []).map(field => field.id))
        const guards = before as Record<string, unknown>, patch = updates as Record<string, unknown>
        if (Object.keys(guards).some(key => !defs.has(key)) || Object.keys(patch).some(key => !defs.has(key) || !Object.hasOwn(guards, key))) fail(400, '自定义字段原值必须覆盖此次修改且不能包含未知字段')
        for (const key of Object.keys(guards)) if (JSON.stringify(event.values?.[key] ?? null) !== JSON.stringify(guards[key] ?? null))
          throw new ManagementError(409, '自定义字段已被其他人更新，请刷新后重试', project.revision)
      } else if (JSON.stringify((event as unknown as Record<string, unknown>)[field] ?? null) !== JSON.stringify(values[field] ?? null))
        throw new ManagementError(409, '事件字段已被其他人更新，请刷新后重试', project.revision)
    }
    return true
  }
  if (event.updatedAt !== body.expectedEventUpdatedAt) throw new ManagementError(409, '事件已被其他人更新，请刷新后重试', project.revision)
  return true
}
async function writeProject(paths: RuntimePaths, project: StoredManagement, services: ManagementServices) {
  if (Buffer.byteLength(JSON.stringify(project), 'utf8') > MAX_PROJECT_BYTES) fail(413, '项目及历史超过12MiB，未保存此次修改')
  await services.writeJson(projectFile(paths, project.id), project)
  publishProjectChange(project.id, project.revision)
}
function changed(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(field => ({ field, before: before[field] ?? null, after: after[field] ?? null }))
}
function history(project: StoredManagement, actor: ManagementActor, action: string, changes: ManagementHistory['changes'], eventId?: string, note?: string) {
  if (!changes.length) return
  project.history.push({ id: id('hist'), action, at: Date.now(), actorId: actor.id, actorName: actor.email.split('@')[0]?.slice(0,80), ...(eventId ? { eventId } : {}), ...(note ? { note } : {}), changes })
}
async function mutate(paths: RuntimePaths, projectId: string, actor: ManagementActor, body: Record<string, unknown>, action: string, services: ManagementServices, work: (project: StoredManagement) => Promise<boolean> | boolean, editedEventId?: string) {
  return serial(projectFile(paths, projectId), async () => {
    const project = await readableProject(paths, projectId, actor, services)
    if (editedEventId) { if (!['owner','edit'].includes(projectAccess(project, actor) ?? '')) fail(403, '没有编辑权限') }
    else requireProjectOwner(project, actor)
    if (!await services.ownerExists(paths, actor.id)) fail(401, '账号已不存在')
    validateRevisionShape(body)
    const operation = receipt(body, `${actor.id}:${action}`)
    if (checkReceipt(project, operation)) return publicProject(project, actor)
    if (!editedEventId || !checkEventGuard(project, editedEventId, body, action)) checkRevision(project, body)
    const draft = structuredClone(project)
    const modified = await work(draft)
    if (!await services.ownerExists(paths, actor.id) || !await services.ownerExists(paths, draft.ownerId)) fail(401, '账号已不存在')
    if (modified) { draft.updatedAt = Date.now(); draft.revision++ }
    if (operation) draft.receipts = [...(draft.receipts ?? []), operation]
    if (modified || operation) await writeProject(paths, draft, services)
    return publicProject(draft, actor)
  })
}
async function validateCanvases(paths: RuntimePaths, ownerId: string, ids: string[], services: ManagementServices) {
  for (const canvasId of ids) {
    const canvas = await services.readCanvas(paths, canvasId)
    if (!canvas || canvas.deletedAt) fail(400, '关联画布不存在')
    if (canvas.ownerId !== ownerId) fail(403, '只能关联当前账号自己的画布')
  }
}
function validateTagId(value: unknown, tags: ManagementTag[], label: string): string {
  const selected = text(value, label, 120)
  if (selected && !tags.some(tag => tag.id === selected)) fail(400, `${label}不存在`)
  return selected
}
interface InviteReceipt extends Receipt { ownerId:string; projectId:string; inviteId:string }
interface InviteStore { schemaVersion:1; invites:InviteStored[]; receipts:InviteReceipt[] }
function withInviteLock<T>(inviteId:string, work:()=>Promise<T>) { return serial(`management-invite:${inviteId}`,work) }
async function loadProjectInvites(paths: RuntimePaths):Promise<InviteStore> {
  return readJson(invitesFile(paths),{schemaVersion:1,invites:[],receipts:[]})
}
async function sweepExpiredProjectInvites(paths: RuntimePaths, writers: Pick<ManagementServices,'writeJson'>, now: number): Promise<number> {
  const candidates = (await loadProjectInvites(paths)).invites.filter(invite => {
    try { return normalizeStoredProjectInvite(invite).expiresAt <= now } catch { return false }
  }).slice(0, 64).map(invite => invite.id)
  const locked = async (index: number): Promise<number> => {
    if (index < candidates.length) return withInviteLock(candidates[index]!, () => locked(index + 1))
    const store = await loadProjectInvites(paths), removed = new Set(candidates)
    const kept = store.invites.filter(invite => !removed.has(invite.id) || invite.expiresAt > now)
    if (kept.length !== store.invites.length) await writers.writeJson(invitesFile(paths), { ...store, invites: kept })
    // Retain compact mutation digests: a late retry must never create a fresh
    // valid invitation. Receipts have a separate hard count/byte ceiling.
    return store.invites.length - kept.length
  }
  return candidates.length ? locked(0) : 0
}
async function performManagementMaintenance(paths: RuntimePaths, writers: Pick<ManagementServices,'writeJson'>, now = Date.now()) {
  const key = path.resolve(rootDir(paths)), state = maintenanceStates.get(key)
  if (state && state.nextAt > now) return undefined
  if (!state && maintenanceStates.size >= 16) maintenanceStates.delete(maintenanceStates.keys().next().value!)
  const next = { nextAt: now + MAINTENANCE_INTERVAL_MS, afterProject: state?.afterProject }
  maintenanceStates.set(key, next)
  const expiredInvites = await sweepExpiredProjectInvites(paths, writers, now)
  const uploads = await sweepManagementUploads(paths, { now, afterProject: state?.afterProject })
  next.afterProject = uploads.nextProject
  return { expiredInvites, ...uploads }
}
/** Startup/idle maintenance shares the same dataset serialization as uploads,
 * mutations and restore. No new timer is created by this module. */
export function maintainManagementStorage(paths: RuntimePaths, writers: Pick<ManagementServices,'writeJson'>) {
  return withManagementDataset(paths, async () => {
    await recoverPendingManagementDeletes(paths, writers)
    return performManagementMaintenance(paths, writers)
  })
}
function inviteUsers(project:StoredManagement,invite:InviteStored,users:ManagementActor[]) {
  return [...new Set([...(project.inviteAcceptances ?? []).filter(item=>item.inviteId===invite.id).map(item=>item.userId),
    ...users.filter(user=>user.projectInviteId===invite.id).map(user=>user.id)])]
}
async function activeProjectInvite(paths:RuntimePaths,token:unknown,actorId:string,users:ManagementActor[],now=Date.now()) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new ManagementInviteError('项目邀请链接无效',404)
  const invite=(await loadProjectInvites(paths)).invites.find(item=>item.token===token)
  if (!invite) throw new ManagementInviteError('项目邀请不存在或已撤销',404)
  let project:StoredManagement
  try { project=await loadProject(paths,invite.projectId) } catch(error) { if (error instanceof ManagementError) throw new ManagementInviteError('项目邀请对象已不存在',410); throw error }
  if (!users.some(user=>user.id===invite.ownerId)) throw new ManagementInviteError('项目创建者账号已不存在',410)
  validateProjectInvite(invite,{project,actorId,now,acceptedUserIds:inviteUsers(project,invite,users)})
  return {invite,project}
}
/** Register holds the auth lock, then this per-invite lock through users.json
 * commit. Accept holds dataset -> same invite lock, and never takes auth lock. */
export async function withProjectRegistrationInvite<T>(paths:RuntimePaths,token:unknown,users:ManagementActor[],operation:(invite:InviteStored)=>Promise<T>):Promise<T> {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new ManagementInviteError('项目邀请链接无效',403)
  const candidate=(await loadProjectInvites(paths)).invites.find(item=>item.token===token)
  if (!candidate) throw new ManagementInviteError('项目邀请不存在或已撤销',403)
  return withInviteLock(candidate.id,async()=>{
    const {invite}=await activeProjectInvite(paths,token,'registration_pending',users)
    if (invite.recipientId) throw new ManagementInviteError('指定账号邀请不能用于注册其他账号',403)
    return operation(invite)
  })
}
async function inviteRoutes(req:IncomingMessage,res:ServerResponse,paths:RuntimePaths,services:ManagementServices,actor:ManagementActor,url:URL):Promise<boolean> {
  const match=url.pathname.match(/^\/api\/management\/invites\/([A-Za-z0-9_-]{43})(?:\/(accept))?$/)
  if (!match) return false
  if ((!match[2] && req.method!=='GET') || (match[2] && req.method!=='POST')) fail(405,'请求方法不支持')
  const token=match[1]!,candidate=(await loadProjectInvites(paths)).invites.find(item=>item.token===token)
  if (!candidate) fail(404,'项目邀请不存在或已撤销')
  return withInviteLock(candidate.id,async()=>{
    const users=await services.registeredUsers(paths),{invite,project}=await activeProjectInvite(paths,token,actor.id,users)
    const accepted=(project.inviteAcceptances ?? []).some(item=>item.inviteId===invite.id && item.userId===actor.id)
    if (!match[2]) {
      services.sendJson(res,200,{projectId:project.id,projectName:project.name,permission:invite.permission,
        roles:project.roles.filter(role=>invite.roleIds.includes(role.id)).map(({id,name,color})=>({id,name,color})),expiresAt:invite.expiresAt,maxUses:invite.maxUses,
        remainingUses:Math.max(0,invite.maxUses-inviteUsers(project,invite,users).length),accepted})
      return true
    }
    await services.readBody(req,JSON_BODY_BYTES)
    if (actor.id===project.ownerId) {services.sendJson(res,200,publicProject(project,actor));return true}
    if (accepted) {
      if (!projectAccess(project,actor)) fail(403,'项目成员权限已被创建者移除，请申请新的邀请')
      services.sendJson(res,200,publicProject(project,actor));return true
    }
    const draft=structuredClone(project),before={members:structuredClone(draft.members ?? []),roles:structuredClone(draft.roles)}
    const member=draft.members?.find(item=>item.userId===actor.id)
    if (member) { if (invite.permission==='edit') member.permission='edit' }
    else draft.members=[...(draft.members ?? []),{userId:actor.id,permission:invite.permission}]
    for (const role of draft.roles) if (invite.roleIds.includes(role.id)) role.memberIds=[...new Set([...(role.memberIds ?? []),actor.id])]
    draft.inviteAcceptances=[...(draft.inviteAcceptances ?? []),{inviteId:invite.id,userId:actor.id,at:Date.now()}]
    if ((draft.members?.length ?? 0)>100) fail(413,'项目成员数超过100人')
    history(draft,actor,'member.invite_accept',changed(before,{members:draft.members,roles:draft.roles}))
    draft.revision++;draft.updatedAt=Date.now();await writeProject(paths,draft,services)
    services.sendJson(res,200,publicProject(draft,actor));return true
  })
}
function projectInviteResponse(req:IncomingMessage,invite:InviteStored,project:StoredManagement,users:ManagementActor[],services:ManagementServices) {
  const {ownerId:_owner,...value}=invite
  return {...value,uses:inviteUsers(project,invite,users).length,url:`${services.origin(req)}/project-invite/${invite.token}`}
}
async function projectInviteManagement(req:IncomingMessage,res:ServerResponse,paths:RuntimePaths,services:ManagementServices,actor:ManagementActor,project:StoredManagement,tail:string):Promise<boolean> {
  const match=tail.match(/^\/invites(?:\/([A-Za-z0-9_-]+))?$/)
  if (!match) return false
  requireProjectOwner(project,actor)
  const users=await services.registeredUsers(paths)
  if (req.method==='GET' && !match[1]) {
    const store=await loadProjectInvites(paths)
    services.sendJson(res,200,store.invites.filter(invite=>invite.projectId===project.id && invite.ownerId===actor.id).map(invite=>projectInviteResponse(req,invite,project,users,services)));return true
  }
  if (req.method==='DELETE' && match[1]) {
    await withInviteLock(match[1],async()=>{
      const store=await loadProjectInvites(paths),invite=store.invites.find(item=>item.id===match[1] && item.projectId===project.id && item.ownerId===actor.id)
      if (!invite) fail(404,'项目邀请不存在')
      await services.writeJson(invitesFile(paths),{...store,invites:store.invites.filter(item=>item.id!==invite.id)})
    })
    services.sendJson(res,200,{ok:true});return true
  }
  if (req.method!=='POST' || match[1]) fail(405,'请求方法不支持')
  const body=await services.readBody(req,JSON_BODY_BYTES),operation=receipt(body,`invite.create.${project.id}`),store=await loadProjectInvites(paths)
  if (operation) {
    const previous=store.receipts.find(item=>item.ownerId===actor.id && item.id===operation.id)
    if (previous) {
      if (previous.digest!==operation.digest) fail(409,'同一mutationId不能创建不同邀请')
      const invite=store.invites.find(item=>item.id===previous.inviteId)
      if (!invite) fail(410,'原邀请已撤销或过期，请使用新的操作创建邀请')
      services.sendJson(res,201,projectInviteResponse(req,invite,project,users,services));return true
    }
  }
  const config:Record<string,unknown>={}
  for (const key of ['permission','roleIds','recipientId','maxUses','expiresAt']) if (body[key]!==undefined) config[key]=body[key]
  const invite=createProjectInvite(config,{project,ownerId:actor.id,registeredUsers:users,now:Date.now()})
  if (store.invites.filter(item => item.projectId === project.id).length >= MAX_PROJECT_INVITES)
    fail(429,'此项目已有100个邀请，请撤销不再需要的邀请后继续')
  if (store.receipts.length >= MAX_INVITE_RECEIPTS) fail(429,'邀请操作记录已达到保护上限，未创建新的邀请')
  const next:InviteStore={schemaVersion:1,invites:[...store.invites,invite],receipts:[...store.receipts,...(operation ? [{...operation,ownerId:actor.id,projectId:project.id,inviteId:invite.id}] : [])]}
  if (Buffer.byteLength(JSON.stringify(next))>MAX_CAPABILITY_STORE_BYTES) fail(413,'项目邀请记录超过2MiB保护上限')
  await services.writeJson(invitesFile(paths),next)
  services.sendJson(res,201,projectInviteResponse(req,invite,project,users,services));return true
}
interface DeleteJournal { schemaVersion:1; projectId:string; ownerId:string; createdAt:number }
function deletionsDir(paths:RuntimePaths) { return path.join(rootDir(paths),'.deletions') }
async function syncManagementDirectory(directory:string) {
  if (process.platform==='win32') return
  const file=await fs.open(directory,'r')
  try { await file.sync() } finally { await file.close() }
}
async function pendingDeletes(paths:RuntimePaths) {
  const result:Array<{directory:string;journal:DeleteJournal}>=[]
  for (const entry of await fs.readdir(deletionsDir(paths),{withFileTypes:true}).catch(error=>{
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return []
    throw error
  })) {
    const match=entry.name.match(/^([A-Za-z0-9_-]{1,120})\.([a-f0-9]{24})$/)
    if (!match||!entry.isDirectory()||entry.isSymbolicLink()) fail(500,'删除记录目录无效')
    const directory=path.join(deletionsDir(paths),entry.name)
    const journal=await readJson<DeleteJournal|null>(path.join(directory,'journal.json'),null)
    if (!journal) {
      // SIGKILL before replaceFileDurably's intent rename can leave only its
      // preparation temp. No authority or detached project/assets exists yet.
      const preparation=await fs.readdir(directory,{withFileTypes:true})
      if (preparation.every(file=>file.isFile()&&!file.isSymbolicLink()&&/^journal\.json\.[0-9]+\.[a-f0-9]{12}\.tmp$/.test(file.name))) {
        for (const file of preparation) await fs.unlink(path.join(directory,file.name))
        await fs.rmdir(directory);await syncManagementDirectory(deletionsDir(paths));continue
      }
      fail(500,'删除记录缺失，未忽略残留数据')
    }
    if (journal.schemaVersion!==1||journal.projectId!==match[1]||!validId(journal.ownerId)||!Number.isSafeInteger(journal.createdAt)||journal.createdAt<0) fail(500,'删除记录无效')
    result.push({directory,journal})
  }
  return result
}
async function exists(file:string) { return fs.access(file).then(()=>true,error=>{if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;throw error}) }
async function withDeletionInviteLocks<T>(paths:RuntimePaths,projectId:string,work:()=>Promise<T>):Promise<T> {
  const ids=(await loadProjectInvites(paths)).invites.filter(invite=>invite.projectId===projectId).map(invite=>invite.id).sort()
  const locked=(offset:number):Promise<T>=>offset===ids.length ? work() : withInviteLock(ids[offset]!,()=>locked(offset+1))
  return locked(0)
}
async function completeProjectDelete(paths:RuntimePaths,directory:string,journal:DeleteJournal,writers:Pick<ManagementServices,'writeJson'>) {
  await withDeletionInviteLocks(paths,journal.projectId,async()=>{
    const original=projectFile(paths,journal.projectId),detached=path.join(directory,'project.json')
    if (await exists(original)) {
      const current=await readJson<StoredManagement|null>(original,null)
      if (!current||current.ownerId!==journal.ownerId) fail(409,'删除对象所有者已改变，未删除')
      if (await exists(detached)) fail(409,'删除对象ID存在冲突，未删除')
      await fs.rename(original,detached)
      await syncManagementDirectory(projectsDir(paths));await syncManagementDirectory(directory)
      publishProjectChange(journal.projectId,current.revision+1)
    }
    const assets=assetDir(paths,journal.projectId),detachedAssets=path.join(directory,'assets')
    if (await exists(assets)) {
      if (await exists(detachedAssets)) fail(409,'删除附件目录存在冲突')
      await fs.rename(assets,detachedAssets)
      await syncManagementDirectory(path.dirname(assets));await syncManagementDirectory(directory)
    }
    const shares=await readJson<StoredAIShare[]>(sharesFile(paths),[])
    const keptShares=shares.filter(share=>share.kind!=='management'||share.resourceId!==journal.projectId)
    if (keptShares.length!==shares.length) await writers.writeJson(sharesFile(paths),keptShares)
    const store=await loadProjectInvites(paths)
    const keptInvites=store.invites.filter(invite=>invite.projectId!==journal.projectId),keptInviteReceipts=store.receipts.filter(receipt=>receipt.projectId!==journal.projectId)
    if (keptInvites.length!==store.invites.length||keptInviteReceipts.length!==store.receipts.length)
      await writers.writeJson(invitesFile(paths),{...store,invites:keptInvites,receipts:keptInviteReceipts})
    const notifications=await loadNotifications(paths)
    const keptNotices=notifications.notifications.filter(note=>note.projectId!==journal.projectId),keptNoticeReceipts=notifications.receipts.filter(receipt=>receipt.projectId!==journal.projectId)
    if (keptNotices.length!==notifications.notifications.length||keptNoticeReceipts.length!==notifications.receipts.length)
      await writers.writeJson(notificationsFile(paths),{...notifications,notifications:keptNotices,receipts:keptNoticeReceipts})
    // This is an authorized, isolated deletion journal path. It can never
    // resolve to project-data, auth-data or another live project's directory.
    // Keep the durable intent until every deleted byte has been removed. A
    // failed asset cleanup must remain recoverable on the next request.
    await fs.rm(detachedAssets,{recursive:true,force:true})
    await fs.rm(detached,{force:true})
    await fs.unlink(path.join(directory,'journal.json'))
    await fs.rmdir(directory)
    await syncManagementDirectory(deletionsDir(paths))
  })
}
/** Caller holds the dataset queue. Recovery completes authorized destruction;
 * journals are neither visible projects nor restorable archive records. */
export async function recoverPendingManagementDeletes(paths:RuntimePaths,writers:Pick<ManagementServices,'writeJson'>) {
  for (const item of await pendingDeletes(paths)) await completeProjectDelete(paths,item.directory,item.journal,writers)
}
async function deleteManagementProject(paths:RuntimePaths,projectId:string,actor:ManagementActor,body:Record<string,unknown>,services:ManagementServices) {
  validateRevisionShape(body)
  const project=await readJson<StoredManagement|null>(projectFile(paths,projectId),null)
  if (!project) return
  requireProjectOwner(project,actor);checkRevision(project,body)
  const parent=deletionsDir(paths);await fs.mkdir(parent,{recursive:true,mode:0o700})
  const directory=path.join(parent,`${projectId}.${randomBytes(12).toString('hex')}`)
  await fs.mkdir(directory,{mode:0o700})
  const journal:DeleteJournal={schemaVersion:1,projectId,ownerId:actor.id,createdAt:Date.now()}
  try { await services.writeJson(path.join(directory,'journal.json'),journal) }
  catch(error) { await fs.rm(directory,{recursive:true,force:true});throw error }
  await syncManagementDirectory(parent)
  await completeProjectDelete(paths,directory,journal,services)
}
async function exampleProject(req:IncomingMessage,res:ServerResponse,paths:RuntimePaths,services:ManagementServices,actor:ManagementActor) {
  if (req.method!=='POST') fail(405,'请使用POST创建或读取当前账号的可编辑示例')
  await services.readBody(req,JSON_BODY_BYTES)
  for (const file of await fs.readdir(projectsDir(paths)).catch(()=>[] as string[])) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(file)) continue
    const existing=await readJson<StoredManagement|null>(path.join(projectsDir(paths),file),null)
    if (existing?.ownerId===actor.id&&existing.isExample&&!existing.deletedAt) {services.sendJson(res,201,publicProject(existing,actor));return}
  }
  const example=createManagementExample(actor,Date.now())
  const project:StoredManagement={...example,schemaVersion:1,receipts:[]}
  await writeProject(paths,project,services)
  services.sendJson(res,201,publicProject(project,actor))
}
async function validateMembers(paths: RuntimePaths, services: ManagementServices, ids: string[]) {
  if (ids.length > 100 || ids.some(value => !validId(value))) fail(400, '成员列表无效')
  if (!ids.length) return
  const registered = new Set((await services.registeredUsers(paths)).map(user => user.id))
  if (ids.some(value => !registered.has(value))) fail(400, '成员账号已不存在或未注册')
}
async function memberIds(paths: RuntimePaths, services: ManagementServices, value: unknown) {
  const ids = stringIds(value, '角色成员'); await validateMembers(paths, services, ids); return ids
}
function validateConfiguredEvents(project: StoredManagement, config: ManagementProject['tableConfig']) {
  for (const event of project.events) validateFieldValues(config?.customFields ?? [], event.values ?? {}, {}, false, event.roleId)
}
interface NotificationReceipt extends Receipt { senderId: string; projectId: string; eventId: string; notificationIds: string[] }
interface NotificationStore { schemaVersion: 1; notifications: ManagementNotification[]; receipts: NotificationReceipt[] }
async function loadNotifications(paths: RuntimePaths): Promise<NotificationStore> {
  return readJson(notificationsFile(paths), { schemaVersion: 1, notifications: [], receipts: [] })
}
async function writeNotifications(paths: RuntimePaths, value: NotificationStore, services: ManagementServices) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PROJECT_BYTES) fail(413, '站内通知超过12MiB，未发送此次推送')
  await services.writeJson(notificationsFile(paths), value)
}
async function notifyEvent(res: ServerResponse, paths: RuntimePaths, services: ManagementServices,
  actor: ManagementActor, project: StoredManagement, eventId: string, body: Record<string, unknown>) {
  if (!validId(body.mutationId) || body.mutationId.length > 100) fail(400, '推送必须提供有效的mutationId')
  const operation = receipt(body, `notify.${project.id}.${eventId}`)!
  const store = await loadNotifications(paths)
  const existing = store.receipts.find(item => item.senderId === actor.id && item.id === operation.id)
  validateRevisionShape(body)
  if (existing) {
    if (existing.digest !== operation.digest) fail(409, '同一推送mutationId不能提交不同操作')
    services.sendJson(res, 200, { ok: true, notificationIds: existing.notificationIds, count: existing.notificationIds.length }); return
  }
  checkRevision(project, body)
  const event = project.events.find(item => item.id === eventId)
  if (!event) fail(404, '事件不存在')
  if (!await services.ownerExists(paths, actor.id)) fail(401, '账号已不存在')
  const recipientIds = stringIds(body.recipientIds, '接收人')
  const additions = createNotifications({ project, event, sender: actor, recipientIds, mutationId: operation.id,
    registeredUsers: await services.registeredUsers(paths), now: Date.now(), existing: store.notifications })
  const notificationIds = additions.map(item => item.id)
  const next: NotificationStore = { schemaVersion: 1, notifications: [...store.notifications, ...additions],
    receipts: [...store.receipts, { ...operation, senderId: actor.id, projectId: project.id, eventId, notificationIds }] }
  await writeNotifications(paths, next, services)
  services.sendJson(res, 200, { ok: true, notificationIds, count: notificationIds.length })
}
async function notificationRoutes(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths,
  services: ManagementServices, actor: ManagementActor, url: URL): Promise<boolean> {
  if (url.pathname === '/api/management/members') {
    if (req.method !== 'GET') fail(405, '请求方法不支持')
    const values = (await services.registeredUsers(paths)).map(user => {
      const at = user.email.lastIndexOf('@'), local = user.email.slice(0, at), domain = user.email.slice(at + 1)
      const masked = `${local.slice(0, 3)}***${local.length > 5 ? local.slice(-2) : ''}@${domain}`
      return { id: user.id, name: local.slice(0, 80), emailMasked: masked, isSelf: user.id === actor.id }
    })
    services.sendJson(res, 200, values); return true
  }
  const prefix = '/api/management/notifications'
  if (!url.pathname.startsWith(prefix)) return false
  const store = await loadNotifications(paths)
  if (url.pathname === prefix) {
    if (req.method !== 'GET') fail(405, '请求方法不支持')
    const values = filterNotificationsForRecipient(store.notifications, actor.id)
    services.sendJson(res, 200, url.searchParams.get('unread') === '1' ? values.filter(value => value.readAt === undefined) : values); return true
  }
  const match = url.pathname.match(/^\/api\/management\/notifications\/([A-Za-z0-9_-]+)(.*)$/)
  if (!match) fail(404, '通知不存在')
  const notification = store.notifications.find(item => item.id === match[1] && item.recipientId === actor.id)
  if (!notification) fail(404, '通知不存在')
  if (match[2] === '/read' && req.method === 'PATCH') {
    const next = markNotificationsRead(store.notifications, actor.id, [notification.id], Date.now())
    await writeNotifications(paths, { ...store, notifications: next }, services)
    services.sendJson(res, 200, { ok: true }); return true
  }
  const assetMatch = match[2]?.match(/^\/assets\/([A-Za-z0-9_-]+)$/)
  if (assetMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const selected = notification.snapshot.attachments.find(asset => asset.id === assetMatch[1])
    if (!selected) fail(404, '附件不存在')
    const asset = await attachment(paths, notification.projectId, selected.id)
    const sourceProject = await readJson<StoredManagement | null>(projectFile(paths, notification.projectId), null)
    if (!sourceProject || asset.ownerId !== sourceProject.ownerId) fail(404, '附件不存在')
    await serveAttachment(req, res, path.join(assetDir(paths, notification.projectId), asset.file), asset); return true
  }
  fail(405, '请求方法不支持')
}
async function eventFields(body: Record<string, unknown>, project: StoredManagement, paths: RuntimePaths, services: ManagementServices, previous?: ManagementEvent) {
  const priority = body.priority ?? previous?.priority ?? 'medium'
  const status = normalizeManagementStatus(body.status, previous?.status ?? 'todo')
  if (body.stageChangedAt !== undefined || body.stageTimes !== undefined) fail(400, '阶段时间由服务器记录，不能由客户端修改')
  if (!['low', 'medium', 'high', 'urgent'].includes(String(priority))) fail(400, '优先级无效')
  const roleId = validateTagId(body.roleId ?? previous?.roleId ?? '', project.roles, '角色')
  const assigneeId = text(body.assigneeId, '处理人账号', 100, previous?.assigneeId)
  const recipientIds = body.recipientIds === undefined ? (previous?.recipientIds ?? []) : stringIds(body.recipientIds, '接收人')
  await validateMembers(paths, services, [...recipientIds, ...(assigneeId ? [assigneeId] : [])])
  return {
    values: validateFieldValues(project.tableConfig?.customFields ?? [], body.values, previous?.values ?? {}, Boolean(body.baseValues && typeof body.baseValues === 'object' && !Array.isArray(body.baseValues) && (body.baseValues as Record<string, unknown>).values !== undefined), roleId), assigneeId, recipientIds,
    title: name(body.title, previous?.title), description: text(body.description, '描述', 20000, previous?.description),
    roleId,
    categoryId: validateTagId(body.categoryId ?? previous?.categoryId ?? '', project.categories, '分类'),
    source: text(body.source, '来源', 200, previous?.source), assignee: text(body.assignee, '处理人', 200, previous?.assignee),
    priority: priority as ManagementEvent['priority'], status: status as ManagementEvent['status'],
  }
}
async function attachment(paths: RuntimePaths, projectId: string, assetId: string) {
  if (!validId(assetId)) fail(404, '附件不存在')
  const value = await readJson<StoredAttachment | null>(path.join(assetDir(paths, projectId), `${assetId}.json`), null)
  if (!value || value.id !== assetId || value.projectId !== projectId || !/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(value.file)) fail(404, '附件不存在')
  return value
}
function publicAttachment(value: StoredAttachment): ManagementAttachment {
  const { ownerId: _owner, projectId: _project, file: _file, ...result } = value
  return result
}
async function eventAttachments(paths: RuntimePaths, project: StoredManagement, value: unknown, existing: ManagementAttachment[] = []) {
  if (value === undefined) return existing
  if (!Array.isArray(value) || value.length > 30) fail(400, '附件列表无效')
  const result: ManagementAttachment[] = []
  for (const item of value) {
    const assetId = typeof item === 'string' ? item : (item as { id?: unknown })?.id
    if (!validId(assetId)) fail(400, '附件ID无效')
    const stored = await attachment(paths, project.id, assetId)
    if (stored.ownerId !== project.ownerId) fail(403, '附件不属于当前项目')
    if (!result.some(entry => entry.id === stored.id)) result.push(publicAttachment(stored))
  }
  return result
}
function filtersFrom(url: URL): ManagementFilters {
  const filters: ManagementFilters = {}
  for (const key of ['roleId', 'categoryId', 'status', 'priority', 'search'] as const) {
    const value = url.searchParams.get(key)
    if (value) (filters as Record<string, string>)[key] = value.slice(0, 200)
  }
  if (filters.status && !(MANAGEMENT_STATUSES as readonly string[]).includes(filters.status)) fail(400, '状态筛选无效')
  if (filters.priority && !['low', 'medium', 'high', 'urgent'].includes(filters.priority)) fail(400, '优先级筛选无效')
  return filters
}
export function filterManagementEvents(events: ManagementEvent[], filters: ManagementFilters) {
  const query = filters.search?.toLocaleLowerCase()
  return events.filter(event => (!filters.roleId || event.roleId === (filters.roleId === '__unassigned__' ? '' : filters.roleId))
    && (!filters.categoryId || event.categoryId === filters.categoryId)
    && (!filters.status || event.status === filters.status) && (!filters.priority || event.priority === filters.priority)
    && (!query || [event.title, event.description, event.source, event.recorder, event.assignee].join('\n').toLocaleLowerCase().includes(query)))
}
export function managementStats(project: ManagementProject, filters: ManagementFilters = {}, days = 14, now = Date.now()): ManagementStats {
  const timeZone = 'Asia/Shanghai'
  const events = filterManagementEvents(project.events, filters)
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const dateCache = new Map<number, string>()
  const dateKey = (value: number) => {
    let key = dateCache.get(value)
    if (key === undefined) {
      const parts = formatter.formatToParts(new Date(value))
      key = ['year', 'month', 'day'].map(kind => parts.find(part => part.type === kind)?.value ?? '').join('-')
      dateCache.set(value, key)
    }
    return key
  }
  const today = dateKey(now)
  const totals = { total: events.length, activeTotal: events.length, todo: 0, doing: 0, done: 0, cancelled: 0, completionPercent: 0, newToday: 0, completedToday: 0 }
  const emptyStatusCounts = () => Object.fromEntries(MANAGEMENT_STATUSES.map(status => [status,0])) as Record<ManagementStatus, number>
  const statusCounts = emptyStatusCounts()
  const roleStatuses = new Map<string, Record<ManagementStatus,number>>(), roleDurations = new Map<string, Partial<Record<ManagementStatus,number>>>()
  const createdCounts = new Map<string, number>(), completedCounts = new Map<string, number>()
  const roleCounts = new Map<string, number>(), categoryCounts = new Map<string, number>()
  for (const event of events) {
    statusCounts[event.status]++
    if (['todo','doing','done','cancelled'].includes(event.status)) totals[event.status as 'todo'|'doing'|'done'|'cancelled']++
    const createdDate = dateKey(event.createdAt)
    if (createdDate === today) totals.newToday++
    if (days > 0) {
      createdCounts.set(createdDate, (createdCounts.get(createdDate) ?? 0) + 1)
      roleCounts.set(event.roleId, (roleCounts.get(event.roleId) ?? 0) + 1)
      categoryCounts.set(event.categoryId, (categoryCounts.get(event.categoryId) ?? 0) + 1)
      const counts = roleStatuses.get(event.roleId) ?? emptyStatusCounts(); counts[event.status]++; roleStatuses.set(event.roleId, counts)
      const duration = roleDurations.get(event.roleId) ?? {}
      for (const status of MANAGEMENT_STATUSES) duration[status] = (duration[status] ?? 0) + (event.stageTimes?.[status] ?? 0)
      if (event.stageChangedAt !== undefined) duration[event.status] = (duration[event.status] ?? 0) + Math.max(0, now - event.stageChangedAt)
      roleDurations.set(event.roleId, duration)
    }
    if (event.status === 'done' && typeof event.completedAt === 'number') {
      const completedDate = dateKey(event.completedAt)
      if (completedDate === today) totals.completedToday++
      if (days > 0) completedCounts.set(completedDate, (completedCounts.get(completedDate) ?? 0) + 1)
    }
  }
  totals.activeTotal = totals.total - totals.cancelled
  totals.completionPercent = totals.activeTotal ? Math.round(totals.done / totals.activeTotal * 10000) / 100 : 0
  const distribution = (tags: ManagementTag[], counts: Map<string, number>) => days > 0
    ? [...tags, { id: '', name: '未分类', color: '#94a3b8' }].map(tag => ({ ...tag, count: counts.get(tag.id) ?? 0 })) : []
  const trend: ManagementStats['trend'] = []
  for (let ago = Math.max(0, Math.min(90, days)) - 1; ago >= 0; ago--) {
    const date = dateKey(now - ago * 86400000)
    trend.push({ date, created: createdCounts.get(date) ?? 0, completed: completedCounts.get(date) ?? 0 })
  }
  return { ...totals, today, timeZone, byStatus: MANAGEMENT_STATUS_DEFINITIONS.map(status => ({ ...status, count: statusCounts[status.id] })), byRole: distribution(project.roles, roleCounts).map(role => { const counts = roleStatuses.get(role.id) ?? emptyStatusCounts(), durations = roleDurations.get(role.id) ?? {}; return { ...role, statusCounts: counts, activeCount: role.count-counts.cancelled, handlingMs: durations.doing ?? 0, stageDurationMs: durations } }), byCategory: distribution(project.categories, categoryCounts), trend, filters }
}
function managementWorkRecords(project: StoredManagement, url: URL, users: ManagementActor[]): ManagementWorkRecords {
  const role = url.searchParams.get('roleId') || undefined, date = url.searchParams.get('date') || undefined
  if (role && !validId(role)) fail(400, '角色筛选无效')
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date)) fail(400, '工作记录日期无效')
  const offset = pageNumber(url, 'offset', 0, 1000000), limit = pageNumber(url, 'limit', 100, 200)
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' })
  const names = new Map(users.map(user => [user.id,user.email.split('@')[0]?.slice(0,80) ?? user.id]))
  const states = new Map<string,{ title:string; roleId:string; status:ManagementStatus }>()
  const eventState = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const data = value as Record<string,unknown>
    if (typeof data.title !== 'string' || typeof data.roleId !== 'string' || !(MANAGEMENT_STATUSES as readonly unknown[]).includes(data.status)) return undefined
    return { title:data.title, roleId:data.roleId, status:data.status as ManagementStatus }
  }
  const fallback = new Map(project.events.map(event => [event.id,{ title:event.title, roleId:event.roleId, status:event.status }]))
  const records: ManagementWorkRecord[] = []
  let total = 0
  for (const entry of project.history) {
    if (!entry.eventId) continue
    let previous = states.get(entry.eventId) ?? fallback.get(entry.eventId)
    const wholeEvent = entry.changes.find(change => change.field === 'event')
    if (wholeEvent) previous = eventState(wholeEvent.before) ?? previous
    // First isolated change carries its own before-values, so a legacy history
    // without a creation snapshot still reports the actual transition values.
    const roleChange = entry.changes.find(change => change.field === 'roleId')
    const statusChange = entry.changes.find(change => change.field === 'status')
    const titleChange = entry.changes.find(change => change.field === 'title')
    if (previous) previous = { ...previous,
      ...(typeof roleChange?.before === 'string' ? { roleId:roleChange.before } : {}),
      ...(typeof statusChange?.before === 'string' ? { status:normalizeManagementStatus(statusChange.before) } : {}),
      ...(typeof titleChange?.before === 'string' ? { title:titleChange.before } : {}),
    }
    let next = eventState(wholeEvent?.after) ?? previous
    if (next) next = { ...next,
      ...(typeof roleChange?.after === 'string' ? { roleId:roleChange.after } : {}),
      ...(typeof statusChange?.after === 'string' ? { status:normalizeManagementStatus(statusChange.after) } : {}),
      ...(typeof titleChange?.after === 'string' ? { title:titleChange.after } : {}),
    }
    if (next) states.set(entry.eventId,next)
    const roleId = next?.roleId ?? previous?.roleId ?? ''
    const previousRoleId = roleChange && previous?.roleId !== roleId ? previous?.roleId : undefined
    if (role && roleId !== (role === '__unassigned__' ? '' : role) && previousRoleId !== (role === '__unassigned__' ? '' : role)) continue
    if (date) {
      const parts = formatter.formatToParts(new Date(entry.at))
      const key = ['year','month','day'].map(type => parts.find(part => part.type === type)?.value ?? '').join('-')
      if (key !== date) continue
    }
    total++
    records.push({ id:entry.id, eventId:entry.eventId, eventTitle:next?.title ?? previous?.title ?? entry.eventId, roleId,
      ...(previousRoleId === undefined ? {} : { previousRoleId }), action:entry.action, at:entry.at, actorId:entry.actorId,
      ...(entry.actorName || names.get(entry.actorId) ? { actorName:entry.actorName ?? names.get(entry.actorId) } : {}),
      ...(entry.note ? { note:entry.note } : {}),
      ...(statusChange ? { statusBefore:normalizeManagementStatus(statusChange.before), statusAfter:normalizeManagementStatus(statusChange.after) } :
        wholeEvent?.after && next ? { statusAfter:next.status } : {}), changes:entry.changes,
    })
  }
  return { projectId:project.id, ...(role ? { roleId:role } : {}), ...(date ? { date } : {}), records: records.reverse().slice(offset,offset+limit),
    pagination:{offset,limit,total,...(offset+limit<total ? {nextOffset:offset+limit} : {})} }
}
function summary(project: StoredManagement, actor: ManagementActor): ManagementProjectSummary {
  const { events: _events, history: _history, ...metadata } = publicProject(project, actor)
  const { total, activeTotal, todo, doing, done, cancelled, completionPercent, newToday, completedToday } = managementStats(project, {}, 0)
  return { ...metadata, eventCount: project.events.length, stats: { total, activeTotal, todo, doing, done, cancelled, completionPercent, newToday, completedToday } }
}
function scopeValue(body: unknown): AIShareScope {
  if (body === undefined) return {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '分享范围无效')
  const input = body as Record<string, unknown>; const result: AIShareScope = {}
  for (const key of ['canvasIds', 'eventIds'] as const) if (input[key] !== undefined) result[key] = stringIds(input[key], key)
  for (const key of ['includeHistory', 'includeStats', 'includeAttachments', 'includePreview'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(400, `${key}必须是布尔值`)
    if (input[key] !== undefined) result[key] = input[key] as boolean
  }
  return result
}
function shareResponse(req: IncomingMessage, share: StoredAIShare, services: ManagementServices): AIShare {
  const { ownerId: _owner, ...value } = share
  const base = `${services.origin(req)}/ai/${share.token}`
  return { ...value, url: base, jsonUrl: `${base}/data.json` }
}
function canvasContent(canvas: StoredDocument): unknown {
  if (canvas.canvas !== undefined) return canvas.canvas
  if (canvas.content) { try { return JSON.parse(canvas.content) } catch { fail(400, '画布内容无效') } }
  return { version: 3, shapes: {}, groups: {}, order: [] }
}
async function shareData(paths: RuntimePaths, share: StoredAIShare, services: ManagementServices) {
  if (!await services.ownerExists(paths, share.ownerId)) fail(404, '分享不存在或已撤销')
  let project: StoredManagement | undefined
  let canvasIds: string[]
  if (share.kind === 'management') {
    project = await loadProject(paths, share.resourceId)
    if (project.ownerId !== share.ownerId) fail(404, '分享不存在或已撤销')
    canvasIds = share.scope.canvasIds ?? project.canvasIds
    if (canvasIds.some(value => !project!.canvasIds.includes(value))) fail(404, '关联画布已移除')
    if (share.scope.eventIds?.some(value => !project!.events.some(event => event.id === value))) fail(404, '分享事件已移除')
  } else canvasIds = share.scope.canvasIds ?? [share.resourceId]
  const canvases: StoredDocument[] = []
  for (const canvasId of canvasIds) {
    const canvas = await services.readCanvas(paths, canvasId)
    if (!canvas || canvas.deletedAt || canvas.ownerId !== share.ownerId || (share.kind === 'canvas' && canvas.id !== share.resourceId)) fail(404, '分享画布不存在')
    canvases.push(canvas)
  }
  if (share.kind === 'canvas') {
    const source = await services.readCanvas(paths, share.resourceId)
    if (!source || source.deletedAt || source.ownerId !== share.ownerId) fail(404, '分享画布不存在')
  }
  const events = project ? project.events.filter(event => share.scope.eventIds === undefined || share.scope.eventIds.includes(event.id)) : []
  const allowedAssets = new Map<string, { bufferPath: string; metadata: ManagementAttachment; original: string }>()
  const assetKey = (original: string) => createHmac('sha256', share.token).update(original).digest('hex').slice(0, 32)
  if (share.scope.includeAttachments !== false) {
    for (const event of events) for (const reference of event.attachments) {
      const stored = await attachment(paths, project!.id, reference.id)
      if (stored.ownerId !== share.ownerId) fail(404, '附件不存在')
      const key = assetKey(reference.url)
      allowedAssets.set(key, { bufferPath: path.join(assetDir(paths, project!.id), stored.file), metadata: publicAttachment(stored), original: reference.url })
    }
    for (const canvas of canvases) for (const original of collectCanvasAssetRefs(canvasContent(canvas))) {
      const filename = original.slice('/api/assets/'.length)
      if (!/^[a-f0-9]{16,64}\.(png|jpg|jpeg|webp|gif)$/.test(filename)) continue
      const bufferPath = path.join(paths.dataDirectory, 'assets', filename)
      const stat = await fs.stat(bufferPath).catch(() => null)
      if (!stat?.isFile()) continue
      const extension = filename.split('.').pop()!
      const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`
      const key = assetKey(original)
      allowedAssets.set(key, { bufferPath, original, metadata: { id: key, name: `画布图片.${extension}`, mime, bytes: stat.size, createdAt: canvas.updatedAt, url: '' } })
    }
  }
  return { project, canvases, events, allowedAssets }
}
function pageNumber(url: URL, name: string, fallback: number, max: number) {
  const value = url.searchParams.get(name)
  if (value === null) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < (name.toLowerCase().includes('limit') || name === 'days' ? 1 : 0) || number > max) fail(400, `${name}无效`)
  return number
}
function safeHeaders(res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'; sandbox")
}
async function serveAttachment(req: IncomingMessage, res: ServerResponse, file: string, metadata: ManagementAttachment) {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) fail(404, '附件不存在')
  safeHeaders(res)
  res.setHeader('Content-Type', metadata.mime)
  const inline = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(metadata.mime)
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(metadata.name)}`)
  res.setHeader('Content-Length', String(stat.size))
  res.statusCode = 200
  if (req.method === 'HEAD') res.end()
  else res.end(await fs.readFile(file))
}
async function publicAI(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, services: ManagementServices, url: URL): Promise<boolean> {
  const match = url.pathname.match(/^\/ai\/([A-Za-z0-9_-]+)(.*)$/)
  if (!match) return false
  safeHeaders(res)
  if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'AI分享仅允许只读GET或HEAD')
  if (!TOKEN_PATTERN.test(match[1]!)) fail(404, '分享不存在或已撤销')
  return serial(sharesFile(paths), async () => {
    const share = (await readJson<StoredAIShare[]>(sharesFile(paths), [])).find(item => item.token === match[1])
    if (!share) fail(404, '分享不存在或已撤销')
    const data = await shareData(paths, share, services)
    const baseUrl = `${services.origin(req)}/ai/${share.token}`
    const assetUrls: Record<string, string> = {}
    const assets: ManagementAttachment[] = []
    for (const [key, asset] of data.allowedAssets) {
      const assetUrl = `${baseUrl}/assets/${key}`; assetUrls[asset.original] = assetUrl
      assets.push({ ...asset.metadata, id: key, url: assetUrl })
    }
    const tail = match[2] || ''
    const assetMatch = tail.match(/^\/assets\/([a-f0-9]{32})$/)
    if (assetMatch) {
      const asset = data.allowedAssets.get(assetMatch[1]!)
      if (!asset) fail(404, '资源不在分享范围内')
      await serveAttachment(req, res, asset.bufferPath, asset.metadata); return true
    }
    const canvasMatch = tail.match(/^\/canvases\/([A-Za-z0-9_-]+)(\.json|\/preview\.svg)$/)
    if (canvasMatch) {
      const canvas = data.canvases.find(item => item.id === canvasMatch[1])
      if (!canvas) fail(404, '画布不在分享范围内')
      if (canvasMatch[2] === '/preview.svg') {
        if (share.scope.includePreview === false) fail(404, '预览不在分享范围内')
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
        res.end(req.method === 'HEAD' ? undefined : renderCanvasPreview(canvasContent(canvas), assetUrls))
      } else {
        const exported = buildManagementExport({ kind: 'canvas', resourceId: canvas.id, scope: { ...share.scope, canvasIds: [canvas.id], eventIds: [] }, canvases: [canvas], assets, assetUrls, baseUrl, now: Date.now(), offset: 0, limit: 100, historyOffset: 0, historyLimit: 100 })
        services.sendJson(res, 200, exported.canvas ?? {})
      }
      return true
    }
    if (tail !== '' && tail !== '/' && tail !== '/data.json') fail(404, '分享页面不存在')
    const scoped = data.project ? { ...publicProject(data.project), events: data.events } : undefined
    const exported = buildManagementExport({ kind: share.kind, resourceId: share.resourceId, scope: share.scope, project: scoped,
      canvases: data.canvases, assets, assetUrls, baseUrl, now: Date.now(), stats: scoped ? managementStats(scoped) : undefined,
      offset: pageNumber(url, 'offset', 0, 100000), limit: pageNumber(url, 'limit', 100, 200),
      historyOffset: pageNumber(url, 'historyOffset', 0, 1000000), historyLimit: pageNumber(url, 'historyLimit', 100, 200) })
    if (tail === '/data.json') services.sendJson(res, 200, exported)
    else { res.setHeader('Content-Type', 'text/markdown; charset=utf-8'); res.end(req.method === 'HEAD' ? undefined : renderManagementMarkdown(exported)) }
    return true
  })
}
async function aiManagement(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, services: ManagementServices, actor: ManagementActor, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/ai-shares')) return false
  const item = url.pathname.match(/^\/api\/ai-shares\/([A-Za-z0-9_-]+)$/)
  if (item && req.method === 'DELETE') {
    await serial(sharesFile(paths), async () => {
      const shares = await readJson<StoredAIShare[]>(sharesFile(paths), [])
      const current = shares.find(share => share.id === item[1])
      if (!current || current.ownerId !== actor.id) fail(404, '分享不存在')
      await services.writeJson(sharesFile(paths), shares.filter(share => share.id !== current.id))
    })
    services.sendJson(res, 200, { ok: true }); return true
  }
  if (url.pathname !== '/api/ai-shares') fail(404, '接口不存在')
  if (req.method === 'GET') {
    const kind = url.searchParams.get('kind'); const resourceId = url.searchParams.get('resourceId')
    const shares = (await readJson<StoredAIShare[]>(sharesFile(paths), [])).filter(share => share.ownerId === actor.id && (!kind || share.kind === kind) && (!resourceId || share.resourceId === resourceId))
    services.sendJson(res, 200, shares.map(share => shareResponse(req, share, services))); return true
  }
  if (req.method !== 'POST') fail(405, '请求方法不支持')
  const body = await services.readBody(req, JSON_BODY_BYTES)
  if (body.kind !== 'management' && body.kind !== 'canvas') fail(400, '分享类型无效')
  if (!validId(body.resourceId)) fail(400, '分享对象无效')
  const scope = scopeValue(body.scope)
  if (body.kind === 'management') {
    const project = await ownedProject(paths, body.resourceId, actor)
    if (scope.canvasIds?.some(value => !project.canvasIds.includes(value))) fail(403, '画布不在项目范围内')
    if (scope.eventIds?.some(value => !project.events.some(event => event.id === value))) fail(400, '事件不在项目范围内')
    await validateCanvases(paths, actor.id, scope.canvasIds ?? project.canvasIds, services)
  } else {
    const canvas = await services.readCanvas(paths, body.resourceId)
    if (!canvas || canvas.deletedAt) fail(404, '画布不存在')
    if (canvas.ownerId !== actor.id) fail(403, '只能分享自己的画布')
    if (scope.canvasIds?.some(value => value !== canvas.id)) fail(403, '画布超出分享范围')
  }
  const share: StoredAIShare = { id: id('ai'), token: randomBytes(32).toString('base64url'), kind: body.kind, resourceId: body.resourceId, ownerId: actor.id, scope, createdAt: Date.now() }
  await serial(sharesFile(paths), async () => {
    if (!await services.ownerExists(paths, actor.id)) fail(401, '账号已不存在')
    const existing = await readJson<StoredAIShare[]>(sharesFile(paths), [])
    if (existing.filter(item => item.ownerId === actor.id && item.kind === share.kind && item.resourceId === share.resourceId).length >= MAX_AI_SHARES_PER_RESOURCE ||
        existing.filter(item => item.ownerId === actor.id).length >= MAX_AI_SHARES_PER_OWNER || existing.length >= MAX_AI_SHARES)
      fail(429, 'AI分享链接已达到保护上限，请撤销不用的链接后继续；现有链接仍可读取')
    const next = [...existing, share]
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_CAPABILITY_STORE_BYTES) fail(413, 'AI分享记录超过2MiB保护上限，现有链接仍可读取')
    await services.writeJson(sharesFile(paths), next)
  })
  services.sendJson(res, 201, shareResponse(req, share, services)); return true
}
async function management(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, services: ManagementServices, actor: ManagementActor, url: URL): Promise<boolean> {
  const prefix = '/api/management/projects'
  if (!url.pathname.startsWith(prefix)) return false
  if (url.pathname === `${prefix}/example`) { await exampleProject(req,res,paths,services,actor);return true }
  if (url.pathname === prefix) {
    if (req.method === 'GET') {
      const values: ManagementProjectSummary[] = []
      for (const file of await fs.readdir(projectsDir(paths)).catch(() => [] as string[])) {
        if (!/^[A-Za-z0-9_-]+\.json$/.test(file)) continue
        const project = await readJson<StoredManagement | null>(path.join(projectsDir(paths), file), null)
        if (project && projectAccess(project, actor) && !project.deletedAt && await services.ownerExists(paths, project.ownerId)) values.push(summary(project, actor))
      }
      services.sendJson(res, 200, values.sort((a, b) => b.updatedAt - a.updatedAt)); return true
    }
    if (req.method !== 'POST') fail(405, '请求方法不支持')
    const body = await services.readBody(req, JSON_BODY_BYTES)
    const operation = receipt(body, 'project.create')
    const result = await serial(`${projectsDir(paths)}:create`, async () => {
      if (!await services.ownerExists(paths, actor.id)) fail(401, '账号已不存在')
      if (operation) {
        for (const file of await fs.readdir(projectsDir(paths)).catch(() => [] as string[])) {
          if (!/^[A-Za-z0-9_-]+\.json$/.test(file)) continue
          const project = await readJson<StoredManagement | null>(path.join(projectsDir(paths), file), null)
          if (project?.ownerId === actor.id && !project.deletedAt && checkReceipt(project, operation)) return publicProject(project, actor)
        }
      }
      const projectId = body.id === undefined ? id('mproj') : body.id
      if (!validId(projectId)) fail(400, '项目ID无效')
      if (await readJson(projectFile(paths, projectId), null)) fail(409, '项目ID已存在')
      const canvasIds = body.canvasIds === undefined ? [] : stringIds(body.canvasIds, '关联画布')
      await validateCanvases(paths, actor.id, canvasIds, services)
      const now = Date.now()
      const project: StoredManagement = { schemaVersion: 1, id: projectId, ownerId: actor.id, name: name(body.name), description: text(body.description, '描述', 20000), color: color(body.color), icon: text(body.icon, '图标', 60, 'folder'), members: [],
        roles: [], categories: [], canvasIds, events: [], history: [], receipts: operation ? [operation] : [], createdAt: now, updatedAt: now, revision: 1 }
      history(project, actor, 'project.create', [{ field: 'name', before: null, after: project.name }])
      await writeProject(paths, project, services); return publicProject(project, actor)
    })
    services.sendJson(res, 201, result); return true
  }
  const match = url.pathname.match(/^\/api\/management\/projects\/([A-Za-z0-9_-]+)(.*)$/)
  if (!match) fail(404, '接口不存在')
  const projectId = match[1]!; const tail = match[2] ?? ''
  if (tail==='' && req.method==='DELETE') {
    const body=await services.readBody(req,JSON_BODY_BYTES)
    await deleteManagementProject(paths,projectId,actor,body,services)
    services.sendJson(res,200,{ok:true});return true
  }
  const project = await readableProject(paths, projectId, actor, services)
  if (await projectInviteManagement(req,res,paths,services,actor,project,tail)) return true
  if (tail === '/live') {
    if (req.method !== 'GET') fail(405, '请求方法不支持')
    const clientId = url.searchParams.get('clientId') ?? id('client')
    if (!validId(clientId) || clientId.length > 100) fail(400, 'clientId格式无效')
    const fresh = async () => {
      const currentActor = await services.currentUser(req, paths)
      if (!currentActor || currentActor.id !== actor.id) fail(401, '登录已失效')
      return { actor: currentActor, project: await readableProject(paths, projectId, currentActor, services) }
    }
    const local = actor.email.split('@')[0] ?? actor.id
    await attachProjectLive(req, res, { projectId, clientId, actorId: actor.id, actorName: local.slice(0, 80),
      getSnapshot: async () => { const value = await fresh(); return { id: value.project.id, revision: value.project.revision, updatedAt: value.project.updatedAt, access: projectAccess(value.project, value.actor) } },
      canRead: async () => { try { await fresh(); return true } catch { return false } },
    })
    return true
  }
  if (req.method === 'GET' && tail === '') { services.sendJson(res, 200, publicProject(project, actor)); return true }
  if (req.method === 'GET' && tail === '/events') { services.sendJson(res, 200, filterManagementEvents(project.events, filtersFrom(url))); return true }
  if (req.method === 'GET' && tail === '/work-records') { services.sendJson(res, 200, managementWorkRecords(project, url, await services.registeredUsers(paths))); return true }
  if (req.method === 'GET' && tail === '/history') { services.sendJson(res, 200, project.history); return true }
  if (req.method === 'GET' && tail === '/stats') { services.sendJson(res, 200, managementStats(project, filtersFrom(url), pageNumber(url, 'days', 14, 90))); return true }
  const assetMatch = tail.match(/^\/assets\/([A-Za-z0-9_-]+)$/)
  if (assetMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const value = await attachment(paths, project.id, assetMatch[1]!)
    if (value.ownerId !== project.ownerId) fail(403, '没有附件权限')
    await serveAttachment(req, res, path.join(assetDir(paths, project.id), value.file), value); return true
  }
  if (tail === '/assets' && req.method === 'POST') {
    if (!['owner','edit'].includes(projectAccess(project, actor) ?? '')) fail(403, '没有编辑权限')
    const body = await services.readBody(req, Math.ceil(MAX_FILE_BYTES * 4 / 3) + 65536)
    const filename = name(body.name ?? '附件')
    if (/[\r\n\\/\u0000-\u001f]/.test(filename)) fail(400, '附件名称无效')
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
    const dataMatch = dataUrl.match(/^data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/]*={0,2})$/)
    const mime = dataMatch?.[1]?.toLowerCase(); const extension = mime && mimeExtensions[mime]
    if (!dataMatch || !mime || !extension || dataMatch[2]!.length % 4 !== 0) fail(400, '附件必须是支持的base64 dataURL')
    const bytes = Buffer.from(dataMatch[2]!, 'base64')
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) fail(413, '附件必须在8MiB以内')
    const assetId = id('asset')
    const stored: StoredAttachment = { id: assetId, ownerId: project.ownerId, projectId, file: `${assetId}.${extension}`, name: filename, mime, bytes: bytes.length, createdAt: Date.now(), url: `${prefix}/${projectId}/assets/${assetId}` }
    await serial(projectFile(paths, projectId), async () => {
      const current = await readableProject(paths, projectId, actor, services)
      if (!['owner','edit'].includes(projectAccess(current, actor) ?? '')) fail(403, '没有编辑权限')
      if (!await services.ownerExists(paths, actor.id)) fail(401, '账号已不存在')
      const pending = await managementPendingUploads(paths, projectId)
      if (pending.directoryFull) fail(429, '此项目附件目录已达到4096个文件保护上限，已有业务附件仍保留')
      if (pending.count >= MANAGEMENT_PENDING_UPLOAD_COUNT || pending.bytes + bytes.length > MANAGEMENT_PENDING_UPLOAD_BYTES)
        fail(429, '待提交附件已达到32个或64MiB保护上限，请先保存已有附件；未提交附件在7天后自动清理')
      const binaryPath = path.join(assetDir(paths, projectId), stored.file)
      await services.writeBuffer(binaryPath, bytes)
      try { await services.writeJson(path.join(assetDir(paths, projectId), `${assetId}.json`), stored) }
      catch (error) { await fs.unlink(binaryPath).catch(() => undefined); throw error }
    })
    services.sendJson(res, 201, publicAttachment(stored)); return true
  }
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) fail(405, '请求方法不支持')
  const body = await services.readBody(req, JSON_BODY_BYTES)
  const notifyMatch = tail.match(/^\/events\/([A-Za-z0-9_-]+)\/notify$/)
  if (notifyMatch && req.method === 'POST') {
    if (!['owner','edit'].includes(projectAccess(project, actor) ?? '')) fail(403, '没有编辑权限')
    await notifyEvent(res, paths, services, actor, project, notifyMatch[1]!, body); return true
  }
  if (tail === '/table-setup' && req.method === 'POST') {
    const response = await mutate(paths, projectId, actor, body, 'table.setup', services, async draft => {
      if (!Array.isArray(body.roles) || body.roles.length > 100) fail(400, '角色列表必须是最多100项的数组')
      const before = { roles: structuredClone(draft.roles), tableConfig: draft.tableConfig }
      for (const value of body.roles) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '角色格式无效')
        const role = value as Record<string, unknown>; const roleName = name(role.name)
        const existing = draft.roles.find(item => item.name === roleName)
        const ids = role.memberIds === undefined ? undefined : await memberIds(paths, services, role.memberIds)
        if (!existing) draft.roles.push({ id: id('role'), name: roleName, color: color(role.color), ...(ids ? { memberIds: ids } : {}) })
        else { if (role.color !== undefined) existing.color = color(role.color); if (ids) existing.memberIds = ids }
      }
      draft.tableConfig = normalizeTableConfig(body.tableConfig, draft.tableConfig, draft.roles)
      validateConfiguredEvents(draft, draft.tableConfig)
      const changes = changed(before, { roles: draft.roles, tableConfig: draft.tableConfig })
      history(draft, actor, 'table.setup', changes); return changes.length > 0
    })
    services.sendJson(res, 200, response); return true
  }
  let response: ManagementProject
  if (tail === '' && req.method === 'PATCH') {
    response = await mutate(paths, projectId, actor, body, 'project.update', services, async draft => {
      const fields: Record<string, unknown> = {}
      if (body.name !== undefined) fields.name = name(body.name)
      if (body.description !== undefined) fields.description = text(body.description, '描述', 20000)
      if (body.color !== undefined) fields.color = color(body.color)
      if (body.icon !== undefined) fields.icon = text(body.icon, '图标', 60)
      if (body.canvasIds !== undefined) { const ids = stringIds(body.canvasIds, '关联画布'); await validateCanvases(paths, actor.id, ids, services); fields.canvasIds = ids }
      if (body.members !== undefined) {
        if (!Array.isArray(body.members) || body.members.length > 100) fail(400, '项目成员列表无效')
        const seen = new Set<string>()
        const assignments = new Map<string,string[]>()
        const members = body.members.map(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '项目成员无效')
          const member = value as Record<string, unknown>
          if (!validId(member.userId) || !['view','edit'].includes(String(member.permission)) || seen.has(member.userId) || member.userId === draft.ownerId) fail(400, '项目成员权限或ID无效')
          if (member.roleIds !== undefined) { const roleIds=stringIds(member.roleIds,'成员角色'); if (roleIds.some(roleId=>!draft.roles.some(role=>role.id===roleId))) fail(400,'成员角色不属于项目'); assignments.set(member.userId,roleIds) }
          seen.add(member.userId); return { userId: member.userId, permission: member.permission as 'view' | 'edit' }
        })
        await validateMembers(paths, services, members.map(member => member.userId)); fields.members = members
        const removed=new Set((draft.members ?? []).filter(member=>!seen.has(member.userId)).map(member=>member.userId))
        fields.roles=draft.roles.map(role=>({ ...role, memberIds:[...new Set([...(role.memberIds ?? []).filter(userId=>!removed.has(userId) && (!assignments.has(userId) || assignments.get(userId)!.includes(role.id))), ...[...assignments].filter(([,roleIds])=>roleIds.includes(role.id)).map(([userId])=>userId)])] }))
      }
      if (body.tableConfig !== undefined) {
        fields.tableConfig = normalizeTableConfig(body.tableConfig, draft.tableConfig, draft.roles)
        validateConfiguredEvents(draft, fields.tableConfig as ManagementProject['tableConfig'])
      }
      if (body.archived !== undefined) fail(400,'项目使用直接删除，不再提供归档操作')
      const changes = changed(draft as unknown as Record<string, unknown>, fields)
      Object.assign(draft, fields); history(draft, actor, 'project.update', changes); return changes.length > 0
    })
  } else {
    const tagMatch = tail.match(/^\/(roles|categories)(?:\/([A-Za-z0-9_-]+))?$/)
    const eventMatch = tail.match(/^\/events(?:\/([A-Za-z0-9_-]+))?$/)
    if (tagMatch) {
      const collection = tagMatch[1] as 'roles' | 'categories'; const tagId = tagMatch[2]
      response = await mutate(paths, projectId, actor, body, `${collection}.${req.method}.${tagId ?? ''}`, services, async draft => {
        const tags = draft[collection]
        if (req.method === 'POST' && !tagId) {
          const tag: ManagementRole = { id: id(collection === 'roles' ? 'role' : 'cat'), name: name(body.name), color: color(body.color) }
          if (collection === 'roles' && body.memberIds !== undefined) tag.memberIds = await memberIds(paths, services, body.memberIds)
          tags.push(tag); history(draft, actor, `${collection}.create`, [{ field: collection, before: null, after: tag }]); return true
        }
        const existing = tags.find(tag => tag.id === tagId)
        if (!existing) fail(404, '标签不存在')
        if (req.method === 'DELETE') {
          const key = collection === 'roles' ? 'roleId' : 'categoryId'
          if (draft.events.some(event => event[key] === existing.id) || (collection === 'roles' && draft.tableConfig?.customFields.some(field => field.roleId === existing.id))) fail(409, '标签已被事件使用，请先调整事件分类')
          draft[collection] = tags.filter(tag => tag.id !== existing.id); history(draft, actor, `${collection}.delete`, [{ field: collection, before: existing, after: null }]); return true
        }
        if (req.method !== 'PATCH') fail(405, '请求方法不支持')
        const fields: Partial<ManagementRole> = { name: name(body.name, existing.name), color: color(body.color, existing.color) }
        if (collection === 'roles' && body.memberIds !== undefined) fields.memberIds = await memberIds(paths, services, body.memberIds)
        const changes = changed(existing as unknown as Record<string, unknown>, fields)
        Object.assign(existing, fields); history(draft, actor, `${collection}.update`, changes); return changes.length > 0
      })
    } else if (eventMatch) {
      const eventId = eventMatch[1]
      response = await mutate(paths, projectId, actor, body, `events.${req.method}.${eventId ?? ''}`, services, async draft => {
        if (req.method === 'POST' && !eventId) {
          const fields = await eventFields(body, draft, paths, services); const now = Date.now()
          const transitionNote = body.transitionNote === undefined ? undefined : text(body.transitionNote, '流转说明', 2000)
          const eventId = body.id === undefined ? id('event') : body.id
          if (!validId(eventId)) fail(400, '事件ID无效')
          if (draft.events.some(event => event.id === eventId)) fail(409, '事件ID已存在')
          const event: ManagementEvent = { id: eventId, ...fields, ...(transitionNote ? { transitionNote } : {}), recorder: actor.email, attachments: await eventAttachments(paths, draft, body.attachments), createdAt: now, updatedAt: now, ...managementTransitionMetadata(undefined, fields.status, now), ...(fields.status === 'done' ? { completedAt: now } : {}) }
          draft.events.push(event); history(draft, actor, 'event.create', [{ field: 'event', before: null, after: event }], event.id, transitionNote); return true
        }
        const existing = draft.events.find(event => event.id === eventId)
        if (!existing) fail(404, '事件不存在')
        if (req.method === 'DELETE') { draft.events = draft.events.filter(event => event.id !== eventId); history(draft, actor, 'event.delete', [{ field: 'event', before: existing, after: null }], existing.id); return true }
        if (req.method !== 'PATCH') fail(405, '请求方法不支持')
        const transitionNote = body.transitionNote === undefined ? undefined : text(body.transitionNote, '流转说明', 2000)
        const fields = { ...await eventFields(body, draft, paths, services, existing), attachments: await eventAttachments(paths, draft, body.attachments, existing.attachments) }
        if (body.transitionNote !== undefined && fields.status === existing.status) fail(400, '流转说明只能随实际阶段变更提交')
        const changes = changed(existing as unknown as Record<string, unknown>, fields)
        if (changes.length) {
          const now = Math.max(Date.now(), existing.updatedAt + 1)
          if (fields.status !== existing.status) {
            const completedAt = fields.status === 'done' ? now : undefined
            if ((existing.transitionNote ?? null) !== (transitionNote || null)) changes.push({ field:'transitionNote', before:existing.transitionNote ?? null, after:transitionNote || null })
            existing.transitionNote = transitionNote || undefined
            const metadata = managementTransitionMetadata(existing, fields.status, now)
            changes.push(...changed(existing as unknown as Record<string, unknown>, metadata))
            Object.assign(existing, metadata)
            if ((existing.completedAt ?? null) !== (completedAt ?? null)) changes.push({ field: 'completedAt', before: existing.completedAt ?? null, after: completedAt ?? null })
            existing.completedAt = completedAt
          }
          Object.assign(existing, fields, { updatedAt: now }); history(draft, actor, 'event.update', changes, existing.id, changes.some(change => change.field === 'status') ? transitionNote : undefined)
        }
        return changes.length > 0
      }, eventId ?? '*create*')
    } else fail(404, '接口不存在')
  }
  services.sendJson(res, req.method === 'POST' ? 201 : 200, response); return true
}
async function dispatchManagementRequest(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, services: ManagementServices): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://flowboard.local')
  if (!url.pathname.startsWith('/ai/') && !url.pathname.startsWith('/api/ai-shares') && !url.pathname.startsWith('/api/management/')) return false
  try {
    if (await publicAI(req, res, paths, services, url)) return true
    const actor = await services.currentUser(req, paths)
    if (!actor || !await services.ownerExists(paths, actor.id)) fail(401, 'Login required')
    if (await inviteRoutes(req, res, paths, services, actor, url)) return true
    if (await notificationRoutes(req, res, paths, services, actor, url)) return true
    if (await aiManagement(req, res, paths, services, actor, url)) return true
    if (await management(req, res, paths, services, actor, url)) return true
    fail(404, '接口不存在')
  } catch (error) {
    if (!(error instanceof ManagementError) && !(error instanceof ManagementFieldError) && !(error instanceof ManagementNotificationError) && !(error instanceof ManagementWorkflowError) && !(error instanceof ManagementInviteError)) throw error
    safeHeaders(res)
    services.sendJson(res, error.status, { error: error.message, ...(error instanceof ManagementError && error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}) })
    return true
  }
}
export async function handleManagementRequest(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, services: ManagementServices): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://flowboard.local').pathname
  if (!pathname.startsWith('/ai/') && !pathname.startsWith('/api/ai-shares') && !pathname.startsWith('/api/management/')) return false
  return withManagementDataset(paths, async () => {
    await recoverPendingManagementDeletes(paths,services)
    try { await performManagementMaintenance(paths, services) }
    catch { console.warn('Management maintenance deferred after storage validation or IO failure') }
    return dispatchManagementRequest(req,res,paths,services)
  })
}
