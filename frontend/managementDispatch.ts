import { createHash } from 'node:crypto'
import type { ManagementProject, ManagementRole } from './managementTypes.js'
import { BoundedTtlMap } from './runtimeGrowth.js'

export const DISPATCH_MODEL = 'bge-small-zh-v1.5' as const
export interface DispatchUser { id: string; email: string }
export interface DispatchCandidate { id: string; description: string; memberIds: string[] }
export interface DispatchMatch { roleId?: string; reason: string }
const windows = new BoundedTtlMap<{ count: number; until: number }>(512, 60000)
const activeUsers = new Set<string>()
let active = 0
const clip = (value: string, length: number) => Array.from(value.replace(/[\u0000-\u001f]/g, ' ').trim()).slice(0, length).join('')
const pending = (reason: string): DispatchMatch => ({ reason })

/** Membership never grants access: a handler must already be an owner/editor. */
export function dispatchCandidates(project: ManagementProject, users: DispatchUser[]): DispatchCandidate[] {
  const registered = new Set(users.map(user => user.id))
  const editors = new Set([project.ownerId, ...(project.members ?? []).filter(member => member.permission === 'edit').map(member => member.userId)])
  return project.roles.map(role => ({ id: role.id,
    description: clip(`${role.name}：${role.description || role.name}`, 96),
    memberIds: [...new Set(role.memberIds ?? [])].filter(id => registered.has(id) && editors.has(id)).sort(),
  })).filter(role => role.memberIds.length > 0).sort((a, b) => a.id.localeCompare(b.id))
}

/** Only routing configuration is guarded: unrelated new tasks can still save. */
export function dispatchConfiguration(project: ManagementProject, candidates: DispatchCandidate[]): string {
  return createHash('sha256').update(JSON.stringify({ ownerId: project.ownerId, roles: candidates, tableConfig: project.tableConfig,
    categories: project.categories.map(role => role.id).sort(),
  })).digest('hex')
}

export function dispatchAssignee(project: ManagementProject, role: ManagementRole, users: DispatchUser[]): DispatchUser | undefined {
  const candidate = dispatchCandidates({ ...project, roles: [role] }, users)[0]
  if (!candidate) return undefined
  const counts = new Map(candidate.memberIds.map(id => [id, 0]))
  for (const event of project.events) if (event.assigneeId && counts.has(event.assigneeId) && !['done', 'cancelled'].includes(event.status))
    counts.set(event.assigneeId, counts.get(event.assigneeId)! + 1)
  const id = candidate.memberIds.slice().sort((a, b) => counts.get(a)! - counts.get(b)! || a.localeCompare(b))[0]
  return users.find(user => user.id === id)
}

function releaseSlot(userId: string): (() => void) | undefined {
  const now = Date.now(), previous = windows.get(userId, now)
  if (active >= 2 || activeUsers.has(userId) || (previous && previous.until > now && previous.count >= 20) || !windows.hasCapacity(userId, now)) return undefined
  windows.set(userId, { count: previous && previous.until > now ? previous.count + 1 : 1, until: previous && previous.until > now ? previous.until : now + 60000 }, now)
  active++; activeUsers.add(userId)
  return () => { active--; activeUsers.delete(userId) }
}

async function boundedResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('empty model result')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.length
      if (bytes > 32768) { await reader.cancel(); throw new Error('large model result') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const result: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid model result')
  return result as Record<string, unknown>
}

/** The model receives role descriptions, never account records or API keys. */
export async function matchDispatchRole(userId: string, title: string, description: string, candidates: DispatchCandidate[], signal: AbortSignal): Promise<DispatchMatch> {
  if (!candidates.length) return pending('尚未设置有编辑权限的角色处理人，需求已保存，等待项目负责人配置。')
  if (candidates.length > 16) return pending('可分派角色超过16个，请项目负责人合并或调整角色后再分派。')
  if (new Set(candidates.map(role => role.description)).size !== candidates.length) return pending('角色职责描述重复，请项目负责人明确各角色职责后再分派。')
  if (candidates.length === 1) return { roleId: candidates[0].id, reason: '项目只有一个可处理角色，按当前待处理任务数量分派。' }
  const release = releaseSlot(userId)
  if (!release) return pending('自动分派正在处理其他需求，本需求已保存，等待分派。')
  const timeout = AbortSignal.timeout(5000)
  try {
    const base = new URL(process.env.FLOWBOARD_DECISION_URL?.trim() || 'http://127.0.0.1:8149')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.username || base.password)
      return pending('本机分派模型地址未正确配置，需求已保存，等待分派。')
    const response = await fetch(new URL('/api/evaluate', base), { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, timeout]),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'dispatch', state: clip(`${clip(title, 64)}\n${description}`, 96),
        questions: [{ id: 'role', type: 'choice', question: '此需求由哪个角色负责？', options: Object.fromEntries(candidates.map(role => [role.id, role.description])) }],
      }),
    })
    const result = await boundedResponse(response)
    if (!response.ok) return pending(result.code === 'cooling' ? '手机模型正在冷却，需求已保存，等待分派。' : '本机模型暂时不可用，需求已保存，等待分派。')
    const rows = result.results as Array<{ id: string; answers: Array<Record<string, unknown>> }> | undefined
    const usage = result.usage as Record<string, unknown> | undefined
    if (result.model !== DISPATCH_MODEL || result.api_version !== 'fast-decision.v1' || !Array.isArray(rows) || rows.length !== 1 || rows[0].id !== 'dispatch'
        || !Array.isArray(rows[0].answers) || rows[0].answers.length !== 1 || rows[0].answers[0].id !== 'role' || rows[0].answers[0].type !== 'choice'
        || usage?.generated_tokens !== 0 || usage?.truncated_inputs !== 0) throw new Error('invalid model contract')
    const distribution = rows[0].answers[0].distribution, similarities = rows[0].answers[0].similarities
    const keys = candidates.map(role => role.id)
    const values = (value: unknown, probability: boolean): Record<string, number> => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length) throw new Error('invalid model values')
      const data = value as Record<string, number>
      if (keys.some(key => typeof data[key] !== 'number' || !Number.isFinite(data[key]) || data[key] < (probability ? 0 : -1.0001) || data[key] > 1.0001)) throw new Error('invalid model values')
      if (probability && Math.abs(keys.reduce((sum, key) => sum + data[key], 0) - 1) > .0001) throw new Error('invalid distribution')
      return data
    }
    const probabilities = values(distribution, true), scores = values(similarities, false)
    const ranked = keys.slice().sort((a, b) => scores[b] - scores[a] || a.localeCompare(b))
    // A semantic similarity distribution is not calibrated correctness. Close
    // or unrelated matches stay pending rather than picking an arbitrary role.
    if (scores[ranked[0]] < .55 || scores[ranked[0]] - scores[ranked[1]] < .015 || probabilities[ranked[0]] - probabilities[ranked[1]] < .02)
      return pending('需求与角色职责的匹配不够明确，需求已保存，等待项目负责人分派。')
    return { roleId: ranked[0], reason: '已根据需求开头自动匹配角色职责，并按当前待处理任务数量分派。' }
  } catch {
    if (signal.aborted) throw new Error('dispatch cancelled')
    return pending(timeout.aborted ? '自动分派超过5秒，需求已保存，等待分派。' : '本机模型未返回有效匹配，需求已保存，等待分派。')
  } finally { release() }
}
