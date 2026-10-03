import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import type { RuntimePaths, StoredDocument } from './runtimeCore.js'
import type { ManagementProject, ManagementEvent } from './managementTypes.js'
import { MANAGEMENT_STATUS_DEFINITIONS } from './managementWorkflow.js'
import { BoundedTtlMap } from './runtimeGrowth.js'

/** HTTP accepts browser-owned recordings only. The bridge has no microphone,
 * filesystem, administrative action, or arbitrary model/path selector. */
export const VOICE_LIMITS = Object.freeze({ recordingSeconds: 20, recordingBytes: 640000,
  questionCharacters: 1000, speechCharacters: 120, requestsPerMinute: 20 })
interface VoiceActor { id: string }
interface VoiceServices {
  currentUser(req: IncomingMessage, paths: RuntimePaths): Promise<VoiceActor | null>
  ownerExists(paths: RuntimePaths, ownerId: string): Promise<boolean>
  canvasAccess(req: IncomingMessage, paths: RuntimePaths, actor: VoiceActor, canvas: StoredDocument): Promise<boolean>
  sendJson(res: ServerResponse, status: number, value: unknown): void
  origin(req: IncomingMessage): string
}
type Scope = { kind: 'workspace' | 'project' | 'canvas'; id?: string }
interface Source { kind: 'project' | 'canvas'; id: string; title: string }
interface Snapshot { answer: string; context: string; sources: Source[]; grants: string[] }
class VoiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
const userWindows = new BoundedTtlMap<{ count: number; until: number }>(512, 60000)
const activeUsers = new Set<string>()
let activeRequests = 0
const ID = /^[A-Za-z0-9_-]{1,120}$/
const JSON_BYTES = 8192
const MAX_READ_BYTES = 12 * 1024 * 1024
const MAX_SCAN_FILES = 512
const MAX_SCAN_BYTES = 32 * 1024 * 1024
const SOURCE_COUNT = 24
const bridgePath = () => process.env.FLOWBOARD_VOICE_SOCKET?.trim() || '/run/dior-inference/inference.sock'
const clipText = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')
const safeText = (value: unknown, max: number) => typeof value === 'string' ? clipText(value.replace(/[\u0000-\u001f]/g, ' '), max) : ''
const statusLabel = (status: string) => MANAGEMENT_STATUS_DEFINITIONS.find(item => item.id === status)?.label ?? '未知状态'
const fail = (status: number, text: string): never => { throw new VoiceError(status, text) }

function takeUserSlot(id: string): () => void {
  const now = Date.now()
  const window = userWindows.get(id, now)
  if (window && window.until > now && window.count >= VOICE_LIMITS.requestsPerMinute) fail(429, '语音请求较多，请稍后再试')
  if (!userWindows.hasCapacity(id, now)) fail(503, '语音服务当前繁忙，请稍后再试')
  if (activeRequests >= 2 || activeUsers.has(id)) fail(429, '正在处理语音，请等待完成或取消')
  userWindows.set(id, { count: window && window.until > now ? window.count + 1 : 1, until: window && window.until > now ? window.until : now + 60000 }, now)
  activeRequests++; activeUsers.add(id)
  return () => { activeRequests--; activeUsers.delete(id) }
}

function cancellation(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => { if (!res.writableEnded) abort() }
  req.once('aborted', abort); res.once('close', close)
  if (req.aborted || res.destroyed) abort()
  return { signal: controller.signal, cleanup: () => { req.off('aborted', abort); res.off('close', close) } }
}

function body(req: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const rawLength = req.headers['content-length']
  if (rawLength && (!/^\d+$/.test(rawLength) || Number(rawLength) > maxBytes)) {
    req.resume(); return Promise.reject(new VoiceError(413, '语音请求体超过大小限制'))
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    req.resume(); return Promise.reject(new VoiceError(415, '语音接口不支持压缩请求体'))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0; let settled = false
    const cleanup = () => {
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); signal.removeEventListener('abort', abort)
    }
    const finish = (error?: Error) => {
      if (settled) return; settled = true; cleanup()
      if (error) { chunks.length = 0; req.resume(); reject(error) }
      else resolve(Buffer.concat(chunks, bytes))
    }
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) finish(new VoiceError(413, '语音请求体超过大小限制')); else chunks.push(chunk) }
    const end = () => finish()
    const error = () => finish(new VoiceError(400, '语音上传未完成'))
    const abort = () => finish(new VoiceError(499, '语音请求已取消'))
    const timer = setTimeout(() => finish(new VoiceError(408, '语音上传超时，请重试')), 12000)
    timer.unref()
    req.on('data', data); req.once('end', end); req.once('error', error); signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function json(bytes: Buffer): Record<string, unknown> {
  try { const value: unknown = JSON.parse(bytes.toString('utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown> } catch { /* bounded validation message */ }
  return fail(400, '语音请求格式无效')
}
function inputText(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value)) return fail(400, `请输入1至${max}字的文本`)
  return value.trim()
}
function scope(value: unknown): Scope {
  if (value === undefined) return { kind: 'workspace' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, '查询范围格式无效')
  const input = value as Record<string, unknown>
  if (input.kind === 'workspace' && input.id === undefined) return { kind: 'workspace' }
  if ((input.kind === 'project' || input.kind === 'canvas') && typeof input.id === 'string' && ID.test(input.id)) return { kind: input.kind, id: input.id }
  return fail(400, '请选择有效的项目或画布')
}

/** One JSONL exchange, bounded output and absolute deadline. Disconnecting the
 * browser destroys this Unix connection so the bridge cancels its own job. */
export function callVoiceBridge(op: string, data: Record<string, unknown>, signal: AbortSignal, deadlineMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = randomBytes(8).toString('hex')
    const socket = net.createConnection(bridgePath())
    const chunks: Buffer[] = []; let length = 0; let settled = false
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      socket.destroy(); chunks.length = 0
      if (error) reject(error); else resolve(value!)
    }
    const abort = () => finish(new VoiceError(499, '语音请求已取消'))
    const timer = setTimeout(() => finish(new VoiceError(504, '模型处理超时，请重试较短的内容')), deadlineMs)
    timer.unref()
    signal.addEventListener('abort', abort, { once: true })
    socket.once('connect', () => { if (!settled) socket.write(JSON.stringify({ v: 1, id, op, deadline_ms: Math.min(30000, deadlineMs - 1000), ...data }) + '\n') })
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 2 * 1024 * 1024) { finish(new VoiceError(502, '模型返回内容超过限制')); return }
      chunks.push(chunk)
      // Single final response only; no growing partial conversation cache.
      if (chunk.includes(10)) {
        const bytes = Buffer.concat(chunks, length); const newline = bytes.indexOf(10)
        if (newline !== bytes.length - 1) { finish(new VoiceError(502, '模型返回格式无效')); return }
        let value: Record<string, unknown>
        try { value = json(bytes.subarray(0, newline)) } catch { finish(new VoiceError(502, '模型返回格式无效')); return }
        if (value.id !== id || typeof value.ok !== 'boolean') { finish(new VoiceError(502, '模型返回标识无效')); return }
        if (!value.ok) {
          const code = value.error_code
          finish(new VoiceError(code === 'busy' || code === 'preempted' ? 429 : code === 'deadline' ? 504 : code === 'invalid_request' || code === 'audio_limit' ? 400 : 503,
            code === 'busy' || code === 'preempted' ? '手机语音助手或另一位用户正在使用模型，请稍后重试'
              : code === 'thermal' ? '手机温度较高，模型正在冷却，请稍后再试'
              : code === 'thermal_unavailable' ? '手机温度检测暂不可用，模型已暂停处理，请稍后再试'
              : code === 'audio_limit' ? '生成语音超过20秒，请缩短文本后重试'
              : code === 'deadline' ? '模型处理超时，请重试较短的内容' : '语音模型暂不可用，请稍后再试'))
          return
        }
        finish(undefined, value)
      }
    })
    socket.once('error', () => finish(new VoiceError(503, '手机语音模型尚未就绪，请稍后再试')))
    socket.once('end', () => { if (!settled) finish(new VoiceError(502, '模型连接提前关闭')) })
    if (signal.aborted) abort()
  })
}

async function readStored<T>(file: string, budget?: { bytes: number }): Promise<T | null> {
  let handle
  try {
    const link = await fs.lstat(file)
    if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_READ_BYTES) fail(413, '资料较大，请选择更小的查询范围')
    if (budget && budget.bytes + link.size > MAX_SCAN_BYTES) fail(413, '资料较多，请直接选择要查询的项目')
    handle = await fs.open(file, 'r')
    const size = (await handle.stat()).size
    if (size > MAX_READ_BYTES || (budget && budget.bytes + size > MAX_SCAN_BYTES)) fail(413, '资料较多，请直接选择要查询的项目')
    // Read only the agreed size plus one byte: a concurrently growing file
    // cannot turn an authorized summary into an unbounded allocation.
    const buffer = Buffer.alloc(size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > size) fail(409, '资料正在更新，请重试')
    if (budget) budget.bytes += size
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof VoiceError) throw error
    return fail(503, '资料暂时无法读取，请稍后重试')
  } finally { await handle?.close() }
}

function projectVisible(project: ManagementProject, actor: VoiceActor): boolean {
  return project.ownerId === actor.id || Boolean(project.members?.some(member => member.userId === actor.id && (member.permission === 'view' || member.permission === 'edit')))
}
function today(at: number) { return new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) }
const adviceQuestion = (question: string) => /分析|建议|怎么|怎样|如何|优先级|优先处理|改进|优化方案/.test(question)
function mutationRequest(question: string): boolean {
  if (!/删除|创建|修改|重启|关机|执行命令|运行命令/.test(question)) return false
  // Asking how to edit a layout, or who edited a record, does not request a
  // write. The web bridge exposes no write operation in either branch.
  return !adviceQuestion(question) && !/记录|历史|日志|谁|什么时候|是否|能否|可以吗|为什么|原理|风险|影响|方案|步骤|教程/.test(question)
}
function spokenSummary(text: string, source?: Source): string {
  const fullName = source ? safeText(source.title, 120) : ''
  const concise = fullName ? text.replace(fullName, safeText(fullName, 14)) : text
  if (concise.length <= 64) return concise
  const clipped = clipText(concise, 62)
  const boundary = Math.max(clipped.lastIndexOf('，'), clipped.lastIndexOf('；'), clipped.lastIndexOf('。'), clipped.lastIndexOf('：'))
  return `${boundary >= 20 ? clipped.slice(0, boundary) : clipped.replace(/\d+(?:[.%]|$)$/, '')}。`
}
function needsResourceContext(question: string, selected: Scope): boolean {
  const explicit = /项目|画布|工作区|角色|分类|需求|问题|进度|记录|任务|界面|布局|这些|这个|当前/.test(question)
  if (!explicit && /你好|您好|介绍自己|介绍你自己|你是谁|什么是|是什么|百科|科普/i.test(question)) return false
  return explicit || (selected.kind !== 'workspace' && adviceQuestion(question))
}
function projectModelContext(project: ManagementProject, question: string): string {
  const events = project.events ?? []
  const role = (project.roles ?? []).find(item => question.includes(item.name))
  const visible = events.filter(item => !role || item.roleId === role.id)
  const priorities: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 }
  const priorityLabels: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' }
  const important = visible.filter(item => item.status !== 'done' && item.status !== 'cancelled')
    .slice().sort((a, b) => (priorities[b.priority] ?? 0) - (priorities[a.priority] ?? 0) || b.updatedAt - a.updatedAt).slice(0, 2)
  // Put current actionable records before optional status distributions. The
  // native 224-byte data window must not fill with ten irrelevant zero counts.
  const header = `项目:${safeText(project.name, 16)}${role ? `;角色:${safeText(role.name, 12)}` : ''};问题${visible.length},完成${visible.filter(item => item.status === 'done').length}。`
  const items = important.map(item => `${safeText(item.title, 18)}(${priorityLabels[item.priority] ?? '未定'}优先,${statusLabel(item.status)})${/需求|描述|内容|怎么做|如何/.test(question) && item.description ? `:${safeText(item.description, 16)}` : ''}`).join(';')
  return `${header}${items ? `待办:${items}。` : '没有未完成待办。'}`
}
function projectSummary(project: ManagementProject, question: string): string {
  const roles = project.roles ?? [], categories = project.categories ?? [], events = project.events ?? []
  const nowDay = today(Date.now())
  const role = roles.find(item => question.includes(item.name))
  const category = categories.find(item => question.includes(item.name))
  const status = MANAGEMENT_STATUS_DEFINITIONS.find(item => question.includes(item.label))
  const todayRequested = /今天|今日/.test(question)
  const dateMode = /完成/.test(question) ? 'completed' : /更新|处理|验收|发布/.test(question) ? 'updated' : 'created'
  const filtered = events.filter(item => (!role || item.roleId === role.id) && (!category || item.categoryId === category.id)
    && (!status || item.status === status.id) && (!todayRequested || (dateMode === 'completed' ? typeof item.completedAt === 'number' && today(item.completedAt) === nowDay
      : today(dateMode === 'updated' ? item.stageChangedAt ?? item.updatedAt : item.createdAt) === nowDay)))
  const counts = MANAGEMENT_STATUS_DEFINITIONS.map(stage => ({ ...stage, count: filtered.filter(event => event.status === stage.id).length }))
  const dateLabel = dateMode === 'completed' ? '今日完成记录' : dateMode === 'updated' ? '今日更新记录' : '今日新增记录'
  const prefix = `${safeText(project.name, 120)}${role ? `，角色${safeText(role.name, 40)}` : ''}${category ? `，分类${safeText(category.name, 40)}` : ''}${todayRequested ? `，${dateLabel}` : '，问题记录'}共${filtered.length}条`
  const stages = counts.filter(stage => stage.count).map(stage => `${stage.label}${stage.count}条`).join('，')
  if (/工作记录|操作记录|修改记录|修改历史|变更记录|谁.*(修改|处理)|做了什么/.test(question)) {
    const recent = (project.history ?? []).filter(record => (!/今天|今日/.test(question) || today(record.at) === nowDay)
      && (!role || events.some(event => event.id === record.eventId && event.roleId === role.id))).slice(-6).reverse()
    return `${prefix}${stages ? `：${stages}` : '。'}。最近工作记录${recent.length}条：${recent.map(record => `${safeText(record.actorName, 40) || '项目成员'}${safeText(record.action, 40)}${record.note ? `，${safeText(record.note, 80)}` : ''}`).join('；') || '暂无'}。`
  }
  const examples = filtered.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
  const active = filtered.filter(item => item.status !== 'cancelled').length
  const completion = active ? Math.round(filtered.filter(item => item.status === 'done').length / active * 10000) / 100 : 0
  const progress = /进度|完成率/.test(question) ? `完成率${completion}%（取消记录不计入分母）。` : ''
  const roleLines = /角色|工作/.test(question) ? roles.slice(0, 6).map(item => `${safeText(item.name, 40)}${filtered.filter(event => event.roleId === item.id).length}条`).join('，') : ''
  return `${prefix}${stages ? `：${stages}` : '。'}。${progress}${roleLines ? `角色记录：${roleLines}。` : roles.length ? `角色有${roles.slice(0, 8).map(item => safeText(item.name, 40)).join('、')}。` : ''}${examples.length ? `最近记录：${examples.map(item => `${safeText(item.title, 70)}（${statusLabel(item.status)}${item.assignee ? `，${safeText(item.assignee, 24)}` : ''}）${/需求|描述|内容/.test(question) && item.description ? `：${safeText(item.description, 80)}` : ''}`).join('；')}。` : ''}`
}
function canvasFacts(canvas: StoredDocument): { count: number; labels: string[] } {
  let value: unknown = canvas.canvas
  if (value === undefined && canvas.content) { try { value = JSON.parse(canvas.content) } catch { value = {} } }
  const content = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const shapes = content.shapes && typeof content.shapes === 'object' ? Object.values(content.shapes) : []
  const labels: string[] = []
  for (const shape of shapes.slice(0, 4000)) {
    if (!shape || typeof shape !== 'object') continue
    const item = shape as Record<string, unknown>
    const label = safeText(item.text, 100) || safeText(item.content, 100) || safeText(item.name, 100)
    if (label && !labels.includes(label)) labels.push(label)
    if (labels.length >= 12) break
  }
  return { count: shapes.length, labels }
}
function canvasSummary(canvas: StoredDocument, facts = canvasFacts(canvas)): string {
  return `画布“${safeText(canvas.title, 120)}”有${facts.count}个图形。${facts.labels.length ? `可读取的文字包括：${facts.labels.join('；')}。` : '当前没有可读取的图形文字。'}图片内容需要视觉模型，此处不会猜测。`
}

async function snapshot(req: IncomingMessage, paths: RuntimePaths, actor: VoiceActor, selected: Scope, question: string, services: VoiceServices): Promise<Snapshot> {
  if (selected.kind === 'project') {
    const project = await readStored<ManagementProject & { deletedAt?: number }>(path.join(paths.dataDirectory, 'management', 'projects', `${selected.id}.json`))
    if (!project || project.deletedAt || project.id !== selected.id || !projectVisible(project, actor)
      || !await services.ownerExists(paths, project.ownerId)) return fail(404, '项目不存在或没有查询权限')
    const answer = projectSummary(project, question)
    return { answer, context: projectModelContext(project, question), sources: [{ kind: 'project', id: project.id, title: safeText(project.name, 200) }], grants: [`project:${project.id}`] }
  }
  if (selected.kind === 'canvas') {
    const canvas = await readStored<StoredDocument>(path.join(paths.dataDirectory, `${selected.id}.json`))
    if (!canvas || canvas.deletedAt || canvas.id !== selected.id || !await services.canvasAccess(req, paths, actor, canvas)) return fail(404, '画布不存在或没有查询权限')
    const facts = canvasFacts(canvas), answer = canvasSummary(canvas, facts)
    const context = `画布:${safeText(canvas.title, 16)};图形${facts.count};文字:${facts.labels.slice(0, 3).map(label => safeText(label, 18)).join(';') || '无'}。只读文字摘要。`
    return { answer, context, sources: [{ kind: 'canvas', id: canvas.id, title: safeText(canvas.title, 200) }], grants: [`canvas:${canvas.id}`] }
  }
  const budget = { bytes: 0 }, projects: ManagementProject[] = [], canvases: StoredDocument[] = [], sources: Source[] = []
  let scanned = 0
  for (const [directory, kind] of [[path.join(paths.dataDirectory, 'management', 'projects'), 'project'], [paths.dataDirectory, 'canvas']] as const) {
    let entries
    try { entries = await fs.opendir(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    for await (const entry of entries) {
      if (!entry.isFile() || !/^[A-Za-z0-9_-]{1,120}\.json$/.test(entry.name)) continue
      if (++scanned > MAX_SCAN_FILES) fail(413, '资料较多，请直接选择要查询的项目')
      const stored = await readStored<StoredDocument & ManagementProject>(path.join(directory, entry.name), budget)
      if (!stored || stored.deletedAt || typeof stored.id !== 'string' || !ID.test(stored.id) || entry.name !== `${stored.id}.json`) continue
      if (kind === 'project') {
        if (!projectVisible(stored, actor) || !await services.ownerExists(paths, stored.ownerId)) continue
        projects.push(stored)
        if (sources.length < SOURCE_COUNT) sources.push({ kind, id: stored.id, title: safeText(stored.name, 200) })
      } else if (stored.ownerId === actor.id) {
        canvases.push(stored)
        if (sources.length < SOURCE_COUNT) sources.push({ kind, id: stored.id, title: safeText(stored.title, 200) })
      }
    }
  }
  const events: ManagementEvent[] = projects.flatMap(project => project.events ?? [])
  const counts = MANAGEMENT_STATUS_DEFINITIONS.map(stage => `${stage.label}${events.filter(event => event.status === stage.id).length}条`).join('，')
  const answer = `你有权限访问${projects.length}个项目，拥有${canvases.length}张画布。项目问题共${events.length}条：${counts}。${projects.length ? `项目包括${projects.slice(0, 6).map(project => safeText(project.name, 60)).join('、')}。` : ''}选择具体项目后可以查询角色、今日记录和处理进度。`
  return { answer, context: `工作区：${projects.length}个项目、${canvases.length}张画布。`, sources,
    grants: [...projects.map(project => `project:${project.id}`), ...canvases.map(canvas => `canvas:${canvas.id}`)] }
}

function boundedContext(text: string): string {
  // The phone's 512-token context is small: reserve space for its instruction
  // and the user's question, and do not silently allocate a larger model.
  let output = clipText(text, 224)
  while (Buffer.byteLength(output, 'utf8') > 224) output = clipText(output, output.length - 1)
  return output
}

function validateAudio(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 1500000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return fail(502, '语音模型返回音频格式无效')
  const audio = Buffer.from(value, 'base64')
  if (audio.length < 44 || audio.length > 1000044 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE'
    || audio.readUInt32LE(4) + 8 !== audio.length) return fail(502, '语音模型返回音频格式无效')
  let format = false, samples = false
  for (let offset = 12; offset + 8 <= audio.length;) {
    const kind = audio.toString('ascii', offset, offset + 4), size = audio.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > audio.length) return fail(502, '语音模型返回音频格式无效')
    if (kind === 'fmt ') {
      if (size < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1 || audio.readUInt16LE(start + 14) !== 16
        || audio.readUInt32LE(start + 4) !== 16000 || audio.readUInt16LE(start + 12) !== 2) return fail(502, '语音模型返回音频格式无效')
      format = true
    }
    if (kind === 'data') { if (!format || size < 2 || size % 2 || size > 640000) return fail(502, '语音模型返回音频格式无效'); samples = true }
    offset = start + size + size % 2
  }
  if (!format || !samples) return fail(502, '语音模型返回音频格式无效')
  return audio
}

export async function handleWebsiteVoice(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, services: VoiceServices): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://flowboard.local').pathname
  if (!pathname.startsWith('/api/voice/')) return false
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const cancel = cancellation(req, res)
  let release: (() => void) | undefined
  try {
    const actor = await services.currentUser(req, paths)
    if (!actor) return fail(401, '请登录后使用语音与AI助手')
    if (pathname === '/api/voice/status' && req.method === 'GET') {
      release = takeUserSlot(actor.id)
      try {
        const status = await callVoiceBridge('status', {}, cancel.signal, 2000)
        const ready = status.ready === true || status.available === true
        const cooling = status.cooling === true || status.thermal_waiting === true || status.active_state === 'cooling'
          || (typeof status.thermal_c === 'number' && status.thermal_c > 65)
        services.sendJson(res, 200, { available: ready, capabilities: status.capabilities ?? { transcribe: ready, chat: ready, speech: ready },
          busy: cooling || status.busy === true || status.active != null || status.voice_asr_active === true, cooling,
          ...(cooling ? { message: '手机温度较高，模型正在冷却，请稍后再试' } : {}), limits: VOICE_LIMITS })
      } catch (error) {
        if (error instanceof VoiceError && error.status === 499) throw error
        services.sendJson(res, 200, { available: false, capabilities: { transcribe: false, chat: false, speech: false }, limits: VOICE_LIMITS })
      }
      return true
    }
    if (!['/api/voice/transcribe', '/api/voice/ask', '/api/voice/speech'].includes(pathname)) return fail(404, '语音接口不存在')
    if (req.method !== 'POST') return fail(405, '此语音接口需要POST请求')
    const origin = req.headers.origin
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== services.origin(req) && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`)) return fail(403, '请在本站页面使用语音功能')
    release = takeUserSlot(actor.id)
    if (pathname === '/api/voice/transcribe') {
      if ((req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream') return fail(415, '录音需要PCM16LE单声道16000Hz格式')
      const recording = await body(req, VOICE_LIMITS.recordingBytes, cancel.signal)
      if (recording.length < 3200 || recording.length % 2) return fail(400, '录音长度或PCM格式无效')
      const result = await callVoiceBridge('transcribe', { pcm16_base64: recording.toString('base64') }, cancel.signal, 45000)
      if (!await services.currentUser(req, paths)) return fail(401, '登录已失效，请重新登录')
      services.sendJson(res, 200, { text: safeText(result.text, 3000), durationMs: recording.length / 32 })
      return true
    }
    if ((req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail(415, '请求需要JSON格式')
    const input = json(await body(req, JSON_BYTES, cancel.signal))
    if (pathname === '/api/voice/speech') {
      const text = inputText(input.text, VOICE_LIMITS.speechCharacters)
      const result = await callVoiceBridge('tts', { text }, cancel.signal, 45000)
      if (!await services.currentUser(req, paths)) return fail(401, '登录已失效，请重新登录')
      const audio = validateAudio(result.audio_wav_base64)
      res.statusCode = 200; res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Content-Length', audio.length); res.end(audio)
      return true
    }
    const text = inputText(input.text, VOICE_LIMITS.questionCharacters), selected = scope(input.context)
    const data = await snapshot(req, paths, actor, selected, text, services)
    const mutation = mutationRequest(text)
    const modelAdvice = selected.kind !== 'workspace' && adviceQuestion(text) && !mutation
    const dataAnswer = mutation || (!modelAdvice && /项目|画布|状态|统计|角色|分类|今日|今天|进度|工作记录|操作记录|问题|需求|记录|待处理|处理中|验收|发布|完成|阻塞|暂缓|取消|网站|管理|做了什么/.test(text))
    let answer = mutation
      ? '当前网站语音助手支持只读查询和语音回答。修改、创建或删除数据，请使用页面中的操作按钮。' : data.answer
    let spoken = answer, dataSummary: string | undefined
    let contextTruncated = false, questionTruncated = false, modelContextUsed = false
    if (!dataAnswer) {
      const relevant = needsResourceContext(text, selected)
      modelContextUsed = relevant
      const context = relevant ? boundedContext(data.context) : ''
      const result = await callVoiceBridge('chat', { text, context }, cancel.signal, 40000)
      contextTruncated = result.context_truncated === true || (relevant && context !== data.context)
      questionTruncated = result.text_truncated === true
      answer = safeText(result.text, 1000).trim()
      if (!answer) return fail(503, '模型暂未生成回答，请重试较短的问题')
      spoken = answer
      if (modelAdvice) {
        dataSummary = clipText(data.answer, 600)
        answer = `${dataSummary}\n\n分析建议：${answer}`
      }
    }
    // Grants and sessions can change during inference. Re-read before returning
    // its answer, so a revoked member/share capability cannot use stale data.
    const fresh = await services.currentUser(req, paths)
    if (!fresh || fresh.id !== actor.id) return fail(401, '登录已失效，请重新登录')
    const checked = await snapshot(req, paths, fresh, selected, text, services)
    if (data.grants.some(grant => !checked.grants.includes(grant))) return fail(404, '查询权限已变更，请重新提问')
    services.sendJson(res, 200, { answer: clipText(answer, 1000), spokenAnswer: spokenSummary(spoken, dataAnswer ? data.sources[0] : undefined), sources: dataAnswer || modelContextUsed ? data.sources : [], dataAnswer,
      readOnly: true, summaryOnly: true, contextTruncated, questionTruncated, ...(dataSummary ? { dataSummary } : {}) })
    return true
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) services.sendJson(res, error instanceof VoiceError ? error.status : 503,
      { error: error instanceof VoiceError ? error.message : '语音服务暂不可用，请稍后再试' })
    return true
  } finally { release?.(); cancel.cleanup() }
}
