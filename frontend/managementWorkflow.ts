/** Shared pure workflow contract. Durations count completed stage intervals;
 * stageChangedAt is the start of the currently active interval. */
export const MANAGEMENT_STATUSES = ['todo', 'doing', 'review', 'rejected', 'ready', 'released', 'done', 'blocked', 'on_hold', 'cancelled'] as const
export type ManagementStatus = typeof MANAGEMENT_STATUSES[number]
export const MANAGEMENT_STATUS_DEFINITIONS: ReadonlyArray<{ id: ManagementStatus; label: string; color: string }> = [
  { id: 'todo', label: '待处理', color: '#64748b' },
  { id: 'doing', label: '处理中', color: '#2563eb' },
  { id: 'review', label: '等待验收', color: '#7c3aed' },
  { id: 'rejected', label: '验收不合格', color: '#dc2626' },
  { id: 'ready', label: '已处理待发布', color: '#0891b2' },
  { id: 'released', label: '已发布', color: '#059669' },
  { id: 'done', label: '已完成', color: '#16a34a' },
  { id: 'blocked', label: '阻塞', color: '#ea580c' },
  { id: 'on_hold', label: '暂缓', color: '#a16207' },
  { id: 'cancelled', label: '取消', color: '#6b7280' },
]
export const MANAGEMENT_STATUS_LABELS: Record<ManagementStatus, string> = Object.fromEntries(
  MANAGEMENT_STATUS_DEFINITIONS.map(item => [item.id, item.label])) as Record<ManagementStatus, string>

export class ManagementWorkflowError extends Error {
  readonly status = 400
  constructor(message: string) { super(message); this.name = 'ManagementWorkflowError' }
}
const statusSet = new Set<string>(MANAGEMENT_STATUSES)
function invalid(message: string): never { throw new ManagementWorkflowError(message) }
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
    invalid('阶段开始时间必须是有效非负时间戳')
  return value
}
export function normalizeManagementStatus(raw: unknown, fallback: ManagementStatus = 'todo'): ManagementStatus {
  const value = raw === undefined ? fallback : raw
  if (typeof value !== 'string' || !statusSet.has(value)) invalid('处理状态无效')
  return value as ManagementStatus
}
export interface ManagementStageMetadata {
  stageChangedAt?: number
  stageTimes?: Partial<Record<ManagementStatus, number>>
}
/** Legacy events/snapshots may omit both fields. Present fields are strict. */
export function validateManagementStageMetadata(raw: { stageChangedAt?: unknown; stageTimes?: unknown }): ManagementStageMetadata {
  const result: ManagementStageMetadata = {}
  if (raw.stageChangedAt !== undefined) result.stageChangedAt = timestamp(raw.stageChangedAt)
  if (raw.stageTimes !== undefined) {
    if (!raw.stageTimes || typeof raw.stageTimes !== 'object' || Array.isArray(raw.stageTimes)) invalid('阶段时长必须是对象')
    const times: Partial<Record<ManagementStatus, number>> = {}
    for (const [key, value] of Object.entries(raw.stageTimes)) {
      if (!statusSet.has(key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        invalid('阶段时长包含未知阶段或无效非负毫秒数')
      times[key as ManagementStatus] = value
    }
    result.stageTimes = times
  }
  return result
}
export interface PreviousManagementStage extends ManagementStageMetadata {
  status: ManagementStatus; updatedAt?: number; createdAt?: number
}
/** Any known stage may transition to any other; permission policy belongs to
 * the authenticated route. Same-stage saves never restart the current clock. */
export function managementTransitionMetadata(previous: PreviousManagementStage | undefined, nextStatus: ManagementStatus,
  now: number): { stageChangedAt: number; stageTimes: Partial<Record<ManagementStatus, number>> } {
  const next = normalizeManagementStatus(nextStatus), currentTime = timestamp(now)
  if (!previous) return { stageChangedAt: currentTime, stageTimes: {} }
  const current = normalizeManagementStatus(previous.status)
  const metadata = validateManagementStageMetadata(previous)
  const started = metadata.stageChangedAt ?? timestamp(previous.updatedAt ?? previous.createdAt ?? currentTime)
  const times = { ...metadata.stageTimes }
  if (current === next) return { stageChangedAt: started, stageTimes: times }
  const duration = (times[current] ?? 0) + Math.max(0, currentTime - started)
  if (!Number.isSafeInteger(duration)) invalid('累计阶段时长超过有效整数范围')
  times[current] = duration
  return { stageChangedAt: currentTime, stageTimes: times }
}
