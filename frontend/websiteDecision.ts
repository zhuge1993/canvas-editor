import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { RuntimePaths, StoredDocument } from './runtimeCore.js'
import type { ManagementProject, ManagementEvent } from './managementTypes.js'
import { MANAGEMENT_STATUS_DEFINITIONS } from './managementWorkflow.js'
import { BoundedTtlMap } from './runtimeGrowth.js'

export const DECISION_LIMITS = Object.freeze({ stateCharacters: 3000, questionCharacters: 500, candidates: 16, requestsPerMinute: 20 })
interface DecisionActor { id: string }
interface DecisionServices {
  currentUser(req: IncomingMessage, paths: RuntimePaths): Promise<DecisionActor | null>
  ownerExists(paths: RuntimePaths, ownerId: string): Promise<boolean>
  canvasAccess(req: IncomingMessage, paths: RuntimePaths, actor: DecisionActor, canvas: StoredDocument): Promise<boolean>
  sendJson(res: ServerResponse, status: number, value: unknown): void
  origin(req: IncomingMessage): string
}
type Scope = { kind: 'workspace' | 'project' | 'canvas'; id?: string }
interface Source { kind: 'project' | 'canvas'; id: string; title: string }
interface Snapshot { answer: string; context: string; sources: Source[]; grants: string[] }
class DecisionError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
const userWindows = new BoundedTtlMap<{ count: number; until: number }>(512, 60000)
const activeUsers = new Set<string>()
let activeRequests = 0
const ID = /^[A-Za-z0-9_-]{1,120}$/
const JSON_BYTES = 16384
const MAX_READ_BYTES = 12 * 1024 * 1024
const MAX_SCAN_FILES = 512
const MAX_SCAN_BYTES = 32 * 1024 * 1024
const SOURCE_COUNT = 24
const clipText = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')
const safeText = (value: unknown, max: number) => typeof value === 'string' ? clipText(Array.from(value).map(char => char.charCodeAt(0) < 32 ? ' ' : char).join(''), max) : ''
const statusLabel = (status: string) => MANAGEMENT_STATUS_DEFINITIONS.find(item => item.id === status)?.label ?? '未知状态'
function fail(status: number, text: string): never { throw new DecisionError(status, text) }

function takeUserSlot(id: string): () => void {
  const now = Date.now()
  const window = userWindows.get(id, now)
  if (window && window.until > now && window.count >= DECISION_LIMITS.requestsPerMinute) fail(429, '决策请求较多，请稍后再试')
  if (!userWindows.hasCapacity(id, now)) fail(503, '决策服务当前繁忙，请稍后再试')
  if (activeRequests >= 2 || activeUsers.has(id)) fail(429, '正在处理决策，请等待完成或取消')
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
    req.resume(); return Promise.reject(new DecisionError(413, '决策请求体超过大小限制'))
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    req.resume(); return Promise.reject(new DecisionError(415, '决策接口不支持压缩请求体'))
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
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) finish(new DecisionError(413, '决策请求体超过大小限制')); else chunks.push(chunk) }
    const end = () => finish()
    const error = () => finish(new DecisionError(400, '决策上传未完成'))
    const abort = () => finish(new DecisionError(499, '决策请求已取消'))
    const timer = setTimeout(() => finish(new DecisionError(408, '决策上传超时，请重试')), 12000)
    timer.unref()
    req.on('data', data); req.once('end', end); req.once('error', error); signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function json(bytes: Buffer): Record<string, unknown> {
  try { const value: unknown = JSON.parse(bytes.toString('utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown> } catch { /* bounded validation message */ }
  return fail(400, '决策请求格式无效')
}
function inputText(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes(String.fromCharCode(0))) return fail(400, `请输入1至${max}字的文本`)
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
    if (error instanceof DecisionError) throw error
    return fail(503, '资料暂时无法读取，请稍后重试')
  } finally { await handle?.close() }
}

type Question = { id: string; type: 'choice' | 'boolean' | 'score'; question: string; options?: Record<string, string>; levels?: string[] }
function questions(value: unknown): Question[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) fail(400, '每次提交1至4个判断问题')
  const ids = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, '判断问题格式无效')
    const id = inputText(item.id, 80)
    if (!ID.test(id) || ids.has(id)) fail(400, '问题标识必须有效且不重复')
    ids.add(id)
    const question = inputText(item.question, DECISION_LIMITS.questionCharacters)
    if (item.type === 'boolean') return { id, type: 'boolean', question }
    if (item.type === 'score') {
      if (!Array.isArray(item.levels) || item.levels.length < 2 || item.levels.length > 10) fail(400, '评分需要2至10个从低到高的等级')
      const levels = item.levels.map((level: unknown) => inputText(level, 160))
      if (new Set(levels).size !== levels.length) fail(400, '评分等级不能重复')
      return { id, type: 'score', question, levels }
    }
    if (item.type !== 'choice' || !item.options || typeof item.options !== 'object' || Array.isArray(item.options)) fail(400, '选择判断需要选项')
    const entries = Object.entries(item.options)
    if (entries.length < 2 || entries.length > DECISION_LIMITS.candidates) fail(400, '选择判断需要2至16个选项')
    const options = Object.fromEntries(entries.map(([key, description]) => {
      if (!ID.test(key)) fail(400, '选项标识无效')
      return [key, inputText(description, 160)]
    }))
    if (new Set(Object.values(options)).size !== entries.length) fail(400, '选项描述不能重复')
    return { id, type: 'choice', question, options }
  })
}

async function modelRequest(route: string, signal: AbortSignal, payload?: unknown): Promise<Record<string, unknown>> {
  const base = new URL(process.env.FLOWBOARD_DECISION_URL?.trim() || 'http://127.0.0.1:8149')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.username || base.password) fail(503, '决策服务地址需要配置为本机接口')
  const timeout = AbortSignal.timeout(payload ? 60000 : 3000)
  try {
    const response = await fetch(new URL(route, base), { method: payload ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.any([signal, timeout]), headers: { 'Content-Type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) })
    if (!response.body) fail(502, '决策模型没有返回结果')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > 65536) { await reader.cancel(); fail(502, '决策模型返回结果过大') }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    const result = json(Buffer.concat(chunks, bytes))
    if (!response.ok) {
      if (result.code === 'cooling') fail(503, '手机温度偏高，模型正在冷却，请稍后再试')
      if (result.code === 'timeout') fail(504, '判断超时，请缩短输入或减少选项')
      fail(response.status === 429 ? 429 : response.status === 400 ? 400 : 503, response.status === 400 ? '文字超出模型范围，请缩短输入或选项' : '决策模型当前繁忙或尚未就绪')
    }
    return result
  } catch (error) {
    if (error instanceof DecisionError) throw error
    if (signal.aborted) fail(499, '判断已取消')
    if (timeout.aborted) fail(504, '判断超时，请缩短输入后重试')
    return fail(503, '决策模型尚未就绪')
  }
}

function results(value: Record<string, unknown>, requested: Question[]) {
  const rows = value.results as Array<{ id: string; answers: Array<Record<string, unknown>> }> | undefined
  const usage = value.usage as Record<string, unknown> | undefined
  if (value.model !== 'AgentJev-0.6B' || value.api_version !== 'agentjev.decision.v1' || !Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== 'decision'
      || !Array.isArray(rows[0].answers) || rows[0].answers.length !== requested.length || usage?.generated_tokens !== 0 || usage?.truncated_inputs !== 0) fail(502, '决策模型返回格式不符合约定')
  return requested.map(q => {
    const matching = rows[0].answers.filter(a => a.id === q.id)
    if (matching.length !== 1 || matching[0].type !== q.type) fail(502, '决策模型返回的问题不匹配')
    const d = matching[0].distribution
    const keys = q.type === 'choice' ? Object.keys(q.options!) : q.type === 'boolean' ? ['true', 'false'] : q.levels!.map((_, i) => String(i))
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length !== keys.length) fail(502, '决策概率格式无效')
    const dist = d as Record<string, number>
    const probabilities = keys.map(key => dist[key])
    if (probabilities.some(p => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.0001) fail(502, '决策概率分布无效')
    const ranked = keys.slice().sort((a, b) => dist[b] - dist[a])
    const distribution = Object.fromEntries(keys.map(key => [key, dist[key]]))
    return { id: q.id, type: q.type, distribution, value: q.type === 'boolean' ? dist.true >= 0.5 : ranked[0],
      ...(q.type === 'choice' ? { description: q.options![ranked[0]], top_probability: dist[ranked[0]], margin: dist[ranked[0]] - dist[ranked[1]] } : {}),
      ...(q.type === 'boolean' ? { probability: dist.true } : {}),
      ...(q.type === 'score' ? { score: probabilities.reduce((sum, p, i) => sum + i * p, 0), level: Number(ranked[0]), legend: q.levels } : {}) }
  })
}

export async function handleWebsiteDecision(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, services: DecisionServices): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://flowboard.local').pathname
  if (!pathname.startsWith('/api/decision/')) return false
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
  const cancel = cancellation(req, res)
  let release: (() => void) | undefined
  try {
    const actor = await services.currentUser(req, paths)
    if (!actor) fail(401, '请登录后使用概率判断')
    if (!['/api/decision/status', '/api/decision/evaluate'].includes(pathname)) fail(404, '决策接口不存在')
    if (req.method !== (pathname.endsWith('/status') ? 'GET' : 'POST')) fail(405, '请求方法不支持')
    release = takeUserSlot(actor.id)
    if (pathname.endsWith('/status')) {
      let ready = false, cooling = false
      try { const info = await modelRequest('/health', cancel.signal); cooling = info.cooling === true; ready = !cooling && info.status === 'ready' && info.model === 'AgentJev-0.6B' && info.output_token_decoding === false } catch (error) { if (cancel.signal.aborted) throw error }
      services.sendJson(res, 200, { available: ready, cooling, model: 'AgentJev-0.6B', types: ['choice', 'boolean', 'score'], limits: DECISION_LIMITS })
      return true
    }
    const origin = req.headers.origin
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== services.origin(req) && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`)) fail(403, '请在本站页面提交判断')
    if ((req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') fail(415, '请求需要JSON格式')
    const input = json(await body(req, JSON_BYTES, cancel.signal))
    const state = inputText(input.state, DECISION_LIMITS.stateCharacters), selected = scope(input.context), qs = questions(input.questions)
    const data = await snapshot(req, paths, actor, selected, qs.map(q => q.question).join(' '), services)
    const result = await modelRequest('/api/evaluate', cancel.signal, { id: 'decision', state: { text: state, data: data.context }, questions: qs })
    const answers = results(result, qs)
    const fresh = await services.currentUser(req, paths)
    if (!fresh || fresh.id !== actor.id) fail(401, '登录已失效，请重新登录')
    const checked = await snapshot(req, paths, fresh, selected, qs.map(q => q.question).join(' '), services)
    if (data.grants.some(grant => !checked.grants.includes(grant))) fail(404, '查询权限已变更，请重新判断')
    services.sendJson(res, 200, { model: 'AgentJev-0.6B', answers, sources: data.sources, readOnly: true, summaryOnly: true, generatedTokens: 0 })
    return true
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) services.sendJson(res, error instanceof DecisionError ? error.status : 503,
      { error: error instanceof DecisionError ? error.message : '决策服务暂不可用' })
    return true
  } finally { release?.(); cancel.cleanup() }
}

function projectVisible(project: ManagementProject, actor: DecisionActor): boolean {
  return project.ownerId === actor.id || Boolean(project.members?.some(member => member.userId === actor.id && (member.permission === 'view' || member.permission === 'edit')))
}
function today(at: number) { return new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) }
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

async function snapshot(req: IncomingMessage, paths: RuntimePaths, actor: DecisionActor, selected: Scope, question: string, services: DecisionServices): Promise<Snapshot> {
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
