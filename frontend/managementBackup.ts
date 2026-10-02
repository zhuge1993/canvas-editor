import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { RuntimePaths, StoredDocument } from './runtimeCore.js'
import { publishProjectChange } from './managementLive.js'
import { withManagementDataset } from './managementCore.js'
import { normalizeStoredProjectInvite } from './managementInvites.js'
import { normalizeManagementStatus, validateManagementStageMetadata } from './managementWorkflow.js'
import { normalizeTableConfig, validateFieldValues } from './managementFields.js'

type JsonRecord = Record<string, unknown>
export interface ManagementBackupSection {
  schemaVersion: 1
  projects: Record<string, unknown>
  assetMetadata: Record<string, unknown>
  assets: Record<string, { base64: string; sha256: string }>
  aiShares: unknown[]
  notifications?: unknown
  invites?: unknown
}
export interface ManagementRestoreStage {
  projects: Array<{ file: string; value: JsonRecord }>
  metadata: Array<{ file: string; value: JsonRecord }>
  assets: Array<{ file: string; buffer: Buffer }>
  aiShares: JsonRecord[]
  notifications?: JsonRecord
  invites?: JsonRecord
  documentBytes: number
  assetBytes: number
  fileCount: number
}
export class ManagementBackupError extends Error {
  readonly status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
const ID = /^[A-Za-z0-9_-]{1,120}$/
const MAX_FILE = 8 * 1024 * 1024
const MAX_COUNT = 10000
function bad(message: string, status = 400): never { throw new ManagementBackupError(message, status) }
function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${label}必须是对象`)
  return value as JsonRecord
}
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value) || value.length > MAX_COUNT) bad(`${label}数组无效`); return value }
function identifier(value: unknown, label: string): string { if (typeof value !== 'string' || !ID.test(value)) bad(`${label}ID无效`); return value }
function string(value: unknown, label: string, max = 200, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value) || (nonempty && !value.trim())) bad(`${label}文本无效`)
  return value
}
function timestamp(value: unknown, label: string, optional = false) {
  if (value === undefined && optional) return
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) bad(`${label}时间无效`)
}
function keys(value: JsonRecord, allowed: string[], label: string) { if (Object.keys(value).some(key => !allowed.includes(key))) bad(`${label}含未知字段`) }
function validateAttachment(value: unknown, projectId?: string): JsonRecord {
  const asset = record(value, '附件')
  identifier(asset.id, '附件'); string(asset.name, '附件名称', 200, true); string(asset.mime, '附件MIME', 100, true)
  if (!Number.isSafeInteger(asset.bytes) || (asset.bytes as number) <= 0 || (asset.bytes as number) > MAX_FILE) bad('附件大小无效')
  timestamp(asset.createdAt, '附件')
  const url = string(asset.url, '附件URL', 500)
  if (projectId && url !== `/api/management/projects/${projectId}/assets/${asset.id}`) bad('附件URL与项目不匹配')
  return asset
}
function validateEvent(value: unknown, projectId: string, roles: Set<string>, categories: Set<string>, config?: ReturnType<typeof normalizeTableConfig>, historicalSnapshot = false): JsonRecord {
  const event = record(value, '事件')
  keys(event, ['id','title','description','roleId','categoryId','source','recorder','assignee','priority','status','createdAt','updatedAt','completedAt','stageChangedAt','stageTimes','transitionNote','attachments','values','assigneeId','recipientIds'], '事件')
  identifier(event.id, '事件'); string(event.title, '事件标题', 200, true); string(event.description, '描述', 20000)
  string(event.source, '来源'); string(event.recorder, '记录人'); string(event.assignee, '处理人')
  if (typeof event.roleId !== 'string' || (event.roleId && !roles.has(event.roleId))) bad('事件角色引用无效')
  if (typeof event.categoryId !== 'string' || (event.categoryId && !categories.has(event.categoryId))) bad('事件分类引用无效')
  if (!['low','medium','high','urgent'].includes(String(event.priority))) bad('事件优先级无效')
  if (event.status === undefined) bad('事件必须包含处理状态')
  event.status = normalizeManagementStatus(event.status); validateManagementStageMetadata(event)
  if (event.transitionNote !== undefined) string(event.transitionNote, '流转说明', 2000)
  timestamp(event.createdAt, '事件创建'); timestamp(event.updatedAt, '事件更新'); timestamp(event.completedAt, '事件完成', true)
  if (event.status === 'done' && event.completedAt === undefined) bad('已完成事件缺少完成时间')
  if (event.status !== 'done' && event.completedAt !== undefined) bad('未完成事件不应有当前完成时间')
  for (const asset of array(event.attachments, '事件附件')) validateAttachment(asset, projectId)
  if (event.assigneeId !== undefined && event.assigneeId !== '') identifier(event.assigneeId, '处理人')
  if (event.recipientIds !== undefined) for (const value of array(event.recipientIds, '接收人')) identifier(value, '接收人')
  if (!historicalSnapshot) {
    const values = validateFieldValues(config?.customFields ?? [], event.values ?? {}, {}, false, event.roleId as string)
    if (event.values !== undefined) event.values = values
  }
  return event
}
function validateProject(value: unknown, expectedId: string): JsonRecord {
  const project = record(value, '管理项目')
  keys(project, ['schemaVersion','id','ownerId','name','description','color','icon','roles','categories','canvasIds','events','history','createdAt','updatedAt','archivedAt','revision','deletedAt','receipts','tableConfig','members','inviteAcceptances'], '管理项目')
  if (project.schemaVersion !== 1 || project.id !== expectedId) bad('管理项目ID或schemaVersion不匹配')
  identifier(project.ownerId, '所有者'); string(project.name, '项目名称', 200, true); string(project.description, '项目描述', 20000); string(project.icon, '图标', 60)
  if (typeof project.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(project.color)) bad('项目颜色无效')
  timestamp(project.createdAt, '创建'); timestamp(project.updatedAt, '更新'); timestamp(project.archivedAt, '归档', true); timestamp(project.deletedAt, '删除', true)
  if (!Number.isSafeInteger(project.revision) || (project.revision as number) < 1) bad('项目revision无效')
  if (project.members !== undefined) {
    const members = new Set<string>()
    for (const value of array(project.members, '项目成员')) {
      const member = record(value, '项目成员'); keys(member, ['userId','permission'], '项目成员')
      const userId = identifier(member.userId, '项目成员')
      if (!['view','edit'].includes(String(member.permission)) || userId === project.ownerId || members.has(userId)) bad('项目成员权限或ID无效'); members.add(userId)
    }
  }
  if (project.inviteAcceptances !== undefined) {
    const accepted=new Set<string>()
    for (const value of array(project.inviteAcceptances,'邀请接受记录')) {
      const entry=record(value,'邀请接受记录');keys(entry,['inviteId','userId','at'],'邀请接受记录')
      identifier(entry.inviteId,'邀请');identifier(entry.userId,'接受账号');timestamp(entry.at,'接受邀请')
      const key=`${entry.inviteId}:${entry.userId}`;if (accepted.has(key)) bad('邀请接受记录重复');accepted.add(key)
    }
  }
  const validateTags = (value: unknown, role: boolean) => {
    const set = new Set<string>()
    for (const item of array(value, '标签')) {
      const tag = record(item, '标签'); keys(tag, role ? ['id','name','color','memberIds'] : ['id','name','color'], '标签')
      const tagId = identifier(tag.id, '标签'); if (set.has(tagId)) bad('标签ID重复'); set.add(tagId)
      string(tag.name, '标签名称', 200, true)
      if (typeof tag.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(tag.color)) bad('标签颜色无效')
      if (tag.memberIds !== undefined) for (const member of array(tag.memberIds, '角色成员')) identifier(member, '角色成员')
    }
    return set
  }
  const roles = validateTags(project.roles, true), categories = validateTags(project.categories, false)
  for (const value of array(project.canvasIds, '关联画布')) identifier(value, '画布')
  const config = project.tableConfig === undefined ? undefined : normalizeTableConfig(project.tableConfig, undefined, [...roles].map(id => ({ id })))
  if (config) project.tableConfig = config
  const eventIds = new Set<string>()
  for (const item of array(project.events, '事件')) { const event = validateEvent(item, expectedId, roles, categories, config); if (eventIds.has(event.id as string)) bad('事件ID重复'); eventIds.add(event.id as string) }
  for (const item of array(project.history, '历史')) {
    const history = record(item, '历史'); keys(history, ['id','eventId','action','at','actorId','actorName','note','changes'], '历史')
    identifier(history.id, '历史'); identifier(history.actorId, '历史操作人'); if (history.eventId !== undefined) identifier(history.eventId, '历史事件')
    string(history.action, '历史动作', 200, true); timestamp(history.at, '历史')
    if (history.actorName !== undefined) string(history.actorName, '操作人名称', 80)
    if (history.note !== undefined) string(history.note, '流转说明', 2000)
    for (const change of array(history.changes, '历史变更')) {
      const data = record(change, '变更'); keys(data, ['field','before','after'], '变更'); string(data.field, '变更字段', 200, true)
      if (data.field === 'status') {
        if (typeof data.before !== 'string' || typeof data.after !== 'string') bad('历史阶段变更必须包含原值和新值')
        normalizeManagementStatus(data.before); normalizeManagementStatus(data.after)
      }
    }
  }
  const receiptIds = new Set<string>()
  for (const item of array(project.receipts, '幂等记录')) {
    const entry = record(item, '幂等记录'); keys(entry, ['id','digest'], '幂等记录'); const entryId = identifier(entry.id, '操作')
    if (receiptIds.has(entryId) || typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)) bad('幂等记录重复或摘要无效'); receiptIds.add(entryId)
  }
  return project
}
export async function exportManagementBackup(paths: RuntimePaths, documentBudget: number, assetBudget: number): Promise<ManagementBackupSection> {
  return withManagementDataset(paths, async () => {
    const result: ManagementBackupSection = { schemaVersion: 1, projects: {}, assetMetadata: {}, assets: {}, aiShares: [] }
    let jsonBytes = 0, assetBytes = 0, count = 0
    const addJson = async (file: string) => {
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) bad('管理备份遇到非普通文件')
      if ((jsonBytes += stat.size) > documentBudget || ++count > MAX_COUNT) bad('管理数据超过Web备份上限，请使用整目录备份', 413)
      return JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    }
    const projects = path.join(paths.dataDirectory, 'management', 'projects')
    for (const file of await fs.readdir(projects).catch(() => [] as string[])) if (/^[A-Za-z0-9_-]+\.json$/.test(file)) result.projects[file] = await addJson(path.join(projects, file))
    const assets = path.join(paths.dataDirectory, 'management-assets')
    for (const projectId of await fs.readdir(assets).catch(() => [] as string[])) {
      if (!ID.test(projectId)) continue
      const directory = path.join(assets, projectId); const dirStat = await fs.lstat(directory)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) bad('管理附件目录无效')
      for (const file of await fs.readdir(directory)) {
        if (!/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(file)) continue
        const relative = `${projectId}/${file}`, fullPath = path.join(directory, file)
        if (file.endsWith('.json')) result.assetMetadata[relative] = await addJson(fullPath)
        else {
          const stat = await fs.lstat(fullPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE || !stat.size) bad('附件文件无效')
          if ((assetBytes += stat.size) > assetBudget || ++count > MAX_COUNT) bad('管理附件超过Web备份上限，请使用整目录备份', 413)
          const buffer = await fs.readFile(fullPath)
          result.assets[relative] = { base64: buffer.toString('base64'), sha256: createHash('sha256').update(buffer).digest('hex') }
        }
      }
    }
    const sharePath = path.join(paths.authDirectory, 'ai-shares.json')
    if (await fs.access(sharePath).then(() => true, () => false)) result.aiShares = await addJson(sharePath) as unknown[]
    const notificationPath = path.join(paths.authDirectory, 'management-notifications.json')
    if (await fs.access(notificationPath).then(() => true, () => false)) result.notifications = await addJson(notificationPath)
    const invitePath=path.join(paths.authDirectory,'management-invites.json')
    if (await fs.access(invitePath).then(()=>true,()=>false)) result.invites=await addJson(invitePath)
    return result
  })
}
export async function stageManagementRestore(_paths: RuntimePaths, raw: unknown, options: {
  documentBudget: number; assetBudget: number; readCanvas(id: string): Promise<StoredDocument | null>
}): Promise<ManagementRestoreStage> {
  const section = record(raw, 'management'); keys(section, ['schemaVersion','projects','assetMetadata','assets','aiShares','notifications','invites'], 'management')
  if (section.schemaVersion !== 1) bad('management schemaVersion无效')
  const stage: ManagementRestoreStage = { projects: [], metadata: [], assets: [], aiShares: [], documentBytes: Buffer.byteLength(JSON.stringify(section.projects ?? {})) + Buffer.byteLength(JSON.stringify(section.assetMetadata ?? {})) + Buffer.byteLength(JSON.stringify(section.aiShares ?? [])) + Buffer.byteLength(JSON.stringify(section.notifications ?? {})) + Buffer.byteLength(JSON.stringify(section.invites ?? {})), assetBytes: 0, fileCount: 0 }
  if (stage.documentBytes > options.documentBudget) bad('管理JSON超过Web恢复上限', 413)
  const projects = new Map<string, JsonRecord>(), metadata = new Map<string, JsonRecord>()
  for (const [file, value] of Object.entries(record(section.projects, '管理项目集合'))) {
    if (!/^[A-Za-z0-9_-]{1,120}\.json$/.test(file)) bad('管理项目相对路径无效')
    const projectId = file.slice(0, -5); const project = validateProject(value, projectId)
    projects.set(projectId, project); stage.projects.push({ file, value: project }); stage.fileCount++
    for (const canvasId of project.canvasIds as string[]) {
      const canvas = await options.readCanvas(canvasId)
      if (!canvas || canvas.ownerId !== project.ownerId) bad('备份管理项目的关联画布所有者不一致')
    }
  }
  for (const [relative, value] of Object.entries(record(section.assetMetadata, '附件元数据'))) {
    const match = relative.match(/^([A-Za-z0-9_-]{1,120})\/([A-Za-z0-9_-]{1,120})\.json$/)
    if (!match) bad('附件元数据相对路径无效')
    const asset = validateAttachment(value, match[1]); keys(asset, ['id','name','mime','bytes','url','createdAt','ownerId','projectId','file'], '附件元数据')
    if (asset.id !== match[2] || asset.projectId !== match[1] || asset.ownerId !== projects.get(match[1]!)?.ownerId || typeof asset.file !== 'string' || !new RegExp(`^${match[2]}\\.[a-z0-9]+$`).test(asset.file)) bad('附件元数据关联无效')
    metadata.set(`${match[1]}/${asset.file}`, asset); stage.metadata.push({ file: relative, value: asset }); stage.fileCount++
  }
  for (const [relative, value] of Object.entries(record(section.assets, '私有附件'))) {
    if (!/^[A-Za-z0-9_-]{1,120}\/[A-Za-z0-9_-]{1,120}\.[a-z0-9]+$/.test(relative) || relative.endsWith('.json')) bad('私有附件相对路径无效')
    const data = record(value, '附件内容'); keys(data, ['base64','sha256'], '附件内容')
    if (typeof data.base64 !== 'string' || data.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64) || typeof data.sha256 !== 'string') bad('附件编码无效')
    const buffer = Buffer.from(data.base64, 'base64'), asset = metadata.get(relative)
    if (!asset || buffer.length !== asset.bytes || buffer.length > MAX_FILE || !buffer.length || createHash('sha256').update(buffer).digest('hex') !== data.sha256) bad('附件长度或SHA256不匹配')
    stage.assetBytes += buffer.length; if (stage.assetBytes > options.assetBudget) bad('私有附件超过Web恢复上限', 413)
    stage.assets.push({ file: relative, buffer }); stage.fileCount++
  }
  if (metadata.size !== stage.assets.length) bad('附件元数据与二进制必须一一对应')
  for (const project of projects.values()) for (const event of project.events as JsonRecord[]) for (const item of event.attachments as JsonRecord[]) {
    if (!stage.metadata.some(asset => asset.value.id === item.id && asset.value.projectId === project.id)) bad('事件引用的私有附件缺失')
  }
  const shareIds = new Set<string>(), tokens = new Set<string>()
  for (const item of array(section.aiShares, 'AI分享')) {
    const share = record(item, 'AI分享'); keys(share, ['id','token','kind','resourceId','ownerId','scope','createdAt'], 'AI分享')
    const shareId = identifier(share.id, 'AI分享'); identifier(share.resourceId, '分享对象'); identifier(share.ownerId, '分享所有者'); timestamp(share.createdAt, '分享')
    if (shareIds.has(shareId) || typeof share.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(share.token) || tokens.has(share.token)) bad('AI分享ID/token无效或重复')
    shareIds.add(shareId); tokens.add(share.token)
    const scope = record(share.scope, 'AI范围'); keys(scope, ['canvasIds','eventIds','includeHistory','includeStats','includeAttachments','includePreview'], 'AI范围')
    for (const flag of ['includeHistory','includeStats','includeAttachments','includePreview']) if (scope[flag] !== undefined && typeof scope[flag] !== 'boolean') bad('AI范围布尔值无效')
    for (const key of ['canvasIds','eventIds']) if (scope[key] !== undefined) for (const value of array(scope[key], key)) identifier(value, key)
    if (share.kind === 'management') {
      const project = projects.get(share.resourceId as string); if (!project || project.ownerId !== share.ownerId) bad('AI分享管理项目所有者不匹配')
      // A deleted selected event or removed link keeps an inactive capability in
      // the backup. Runtime revalidates current scope on every anonymous read.
      const ownedEventIds = new Set([...(project.events as JsonRecord[]).map(event => event.id), ...(project.history as JsonRecord[]).map(entry => entry.eventId).filter(Boolean)])
      if ((scope.eventIds as string[] | undefined)?.some(value => !ownedEventIds.has(value))) bad('AI事件范围超出管理项目')
      for (const canvasId of scope.canvasIds as string[] | undefined ?? []) {
        const canvas = await options.readCanvas(canvasId)
        if (!canvas || canvas.ownerId !== share.ownerId) bad('AI画布范围所有者无效')
      }
    } else if (share.kind === 'canvas') {
      const canvas = await options.readCanvas(share.resourceId as string)
      if (!canvas || canvas.ownerId !== share.ownerId || (scope.canvasIds as string[] | undefined)?.some(value => value !== canvas.id)) bad('AI画布分享范围或所有者无效')
    } else bad('AI分享kind无效')
    stage.aiShares.push(share)
  }
  if (section.notifications !== undefined) {
    const store = record(section.notifications, '通知存储'); keys(store, ['schemaVersion','notifications','receipts'], '通知存储')
    if (store.schemaVersion !== 1) bad('通知schemaVersion无效')
    const ids = new Set<string>()
    for (const item of array(store.notifications, '通知')) {
      const note = record(item, '通知'); keys(note, ['id','recipientId','senderId','senderName','projectId','projectName','eventId','snapshot','snapshotLabels','createdAt','readAt'], '通知')
      const noteId = identifier(note.id, '通知'); if (ids.has(noteId)) bad('通知ID重复'); ids.add(noteId)
      for (const key of ['recipientId','senderId','projectId','eventId']) identifier(note[key], key)
      string(note.senderName, '发送人'); string(note.projectName, '项目名称'); timestamp(note.createdAt, '通知'); timestamp(note.readAt, '已读', true)
      const snapshot = record(note.snapshot, '事件快照')
      if (snapshot.id !== note.eventId || snapshot.recipientIds !== undefined) bad('通知快照ID或接收人列表无效')
      const checkedSnapshot = { ...snapshot, attachments: [], values: undefined }
      validateEvent(checkedSnapshot, note.projectId as string, new Set(snapshot.roleId ? [identifier(snapshot.roleId, '角色')] : []), new Set(snapshot.categoryId ? [identifier(snapshot.categoryId, '分类')] : []), undefined, true)
      if (snapshot.values !== undefined) for (const [key, value] of Object.entries(record(snapshot.values, '快照字段值'))) {
        identifier(key, '快照字段'); if (!['string','number','boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && (value.length > 20000 || /\0/.test(value)))) bad('快照字段值无效')
      }
      for (const item of array(snapshot.attachments, '快照附件')) {
        const asset = validateAttachment(item)
        if (asset.url !== `/api/management/notifications/${noteId}/assets/${asset.id}` || !stage.metadata.some(value => value.value.id === asset.id && value.value.projectId === note.projectId)) bad('快照附件代理或源资源无效')
      }
      if (note.snapshotLabels !== undefined) {
        const labels = record(note.snapshotLabels, '快照标签'); keys(labels, ['role','category','fields'], '快照标签')
        for (const key of ['role','category']) if (labels[key] !== undefined) string(labels[key], '标签名称')
        if (labels.fields !== undefined) for (const [key, value] of Object.entries(record(labels.fields, '快照字段标签'))) { identifier(key, '快照字段'); string(value, '字段名称', 120, true) }
      }
    }
    const operations = new Set<string>()
    for (const item of array(store.receipts, '通知操作记录')) {
      const entry = record(item, '通知操作记录'); keys(entry, ['id','digest','senderId','projectId','eventId','notificationIds'], '通知操作记录')
      for (const key of ['id','senderId','projectId','eventId']) identifier(entry[key], key)
      const key = `${entry.senderId}:${entry.id}`; if (operations.has(key) || typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)) bad('通知操作重复或摘要无效'); operations.add(key)
      for (const value of array(entry.notificationIds, '通知操作结果')) {
        const note = (store.notifications as JsonRecord[]).find(item => item.id === value)
        if (!note || note.senderId !== entry.senderId || note.projectId !== entry.projectId || note.eventId !== entry.eventId) bad('通知操作结果关联无效')
      }
    }
    stage.notifications = store
  }
  if (section.invites !== undefined) {
    const store=record(section.invites,'项目邀请存储');keys(store,['schemaVersion','invites','receipts'],'项目邀请存储')
    if (store.schemaVersion!==1) bad('项目邀请schemaVersion无效')
    const ids=new Set<string>(),tokens=new Set<string>()
    const normalized=[]
    for (const raw of array(store.invites,'项目邀请')) {
      const invite=normalizeStoredProjectInvite(raw)
      if (ids.has(invite.id)||tokens.has(invite.token)) bad('项目邀请ID或token重复');ids.add(invite.id);tokens.add(invite.token)
      const project=projects.get(invite.projectId)
      if (!project||project.ownerId!==invite.ownerId) bad('项目邀请对象或创建者不一致')
      normalized.push(invite)
    }
    const receipts=new Set<string>()
    for (const value of array(store.receipts,'邀请操作记录')) {
      const entry=record(value,'邀请操作记录');keys(entry,['id','digest','ownerId','projectId','inviteId'],'邀请操作记录')
      for (const key of ['id','ownerId','projectId','inviteId']) identifier(entry[key],key)
      const key=`${entry.ownerId}:${entry.id}`
      if (receipts.has(key)||typeof entry.digest!=='string'||!/^[a-f0-9]{64}$/.test(entry.digest)) bad('邀请操作记录重复或摘要无效');receipts.add(key)
      if (projects.get(entry.projectId as string)?.ownerId!==entry.ownerId) bad('邀请操作记录创建者不一致')
    }
    stage.invites={...store,invites:normalized}
  }
  stage.fileCount += stage.aiShares.length + (stage.notifications ? 1 : 0) + (stage.invites ? 1 : 0)
  if (stage.fileCount > MAX_COUNT) bad('管理备份文件数量超限', 413)
  return stage
}
export async function commitManagementRestore(paths: RuntimePaths, stage: ManagementRestoreStage, writers: {
  writeJson(file: string, value: unknown): Promise<void>; writeBuffer(file: string, value: Buffer): Promise<void>
}): Promise<void> {
  await withManagementDataset(paths, async () => {
    for (const item of stage.projects) {
      await writers.writeJson(path.join(paths.dataDirectory, 'management', 'projects', item.file), item.value)
      publishProjectChange(item.value.id as string, item.value.revision as number)
    }
    for (const item of stage.assets) await writers.writeBuffer(path.join(paths.dataDirectory, 'management-assets', item.file), item.buffer)
    for (const item of stage.metadata) await writers.writeJson(path.join(paths.dataDirectory, 'management-assets', item.file), item.value)
    await writers.writeJson(path.join(paths.authDirectory, 'ai-shares.json'), stage.aiShares)
    if (stage.invites) await writers.writeJson(path.join(paths.authDirectory,'management-invites.json'),stage.invites)
    if (stage.notifications) await writers.writeJson(path.join(paths.authDirectory, 'management-notifications.json'), stage.notifications)
  })
}
