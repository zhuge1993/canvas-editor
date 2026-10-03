import { randomBytes } from 'node:crypto'
import type { ManagementEvent, ManagementFieldDefinition, ManagementProject } from './managementTypes.js'
import { MANAGEMENT_STATUS_DEFINITIONS, validateManagementStageMetadata } from './managementWorkflow.js'

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`
/** Stored sample records, owned by the authenticated creator. Counts/times are
 * calculated by normal server statistics; this helper never creates reports,
 * recipients, attachments, invitations or fabricated verification results. */
export function createManagementExample(owner: { id: string; email: string }, now: number): ManagementProject {
  validateManagementStageMetadata({ stageChangedAt: now })
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(owner.id) || typeof owner.email !== 'string' || !owner.email || /\0/.test(owner.email))
    throw new Error('示例项目需要有效创建者')
  const roles = [
    { id: id('role'), name: '设计（示例）', color: '#7c3aed' },
    { id: id('role'), name: '开发（示例）', color: '#2563eb' },
    { id: id('role'), name: '验收（示例）', color: '#059669' },
  ]
  const categories = [
    { id: id('cat'), name: '缺陷（示例）', color: '#dc2626' },
    { id: id('cat'), name: '改进（示例）', color: '#0891b2' },
    { id: id('cat'), name: '发布（示例）', color: '#16a34a' },
  ]
  const definitions: ManagementFieldDefinition[] = [
    { id: id('field'), name: '说明（示例）', type: 'text' },
    { id: id('field'), name: '工作量（示例）', type: 'number' },
    { id: id('field'), name: '计划日期（示例）', type: 'date' },
    { id: id('field'), name: '环境（示例）', type: 'select', options: ['网页', 'Linux服务', '移动端'] },
    { id: id('field'), name: '复核标记（示例）', type: 'checkbox' },
  ]
  const dateParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now))
  const datePart = (part: string) => dateParts.find(item => item.type === part)!.value
  const today = `${datePart('year')}-${datePart('month')}-${datePart('day')}`
  const roleIndices = [0, 1, 2, 1, 1, 2, 2, 1, 0, 0]
  const events: ManagementEvent[] = MANAGEMENT_STATUS_DEFINITIONS.map((stage, index) => ({
    id: id('event'), title: `示例 ${index + 1}：${stage.label}事项`,
    description: `这是“${stage.label}”阶段的可编辑示例记录，用来了解表格、看板、角色统计及流转说明。它不代表真实工作或验收结果。可修改或删除此记录；保存本身不会发送站内通知。`,
    roleId: roles[roleIndices[index]!]!.id, categoryId: categories[index % categories.length]!.id,
    source: '示例初始化', recorder: owner.email, assignee: '', assigneeId: '', recipientIds: [],
    priority: (['low', 'medium', 'high', 'urgent'] as const)[index % 4]!, status: stage.id,
    transitionNote: '示例初始阶段，用于演示；不是实际执行记录。',
    createdAt: now, updatedAt: now, stageChangedAt: now, stageTimes: {},
    ...(stage.id === 'done' ? { completedAt: now } : {}), attachments: [],
    values: { [definitions[0]!.id]: `示例说明 ${index + 1}`, [definitions[1]!.id]: index + 1,
      [definitions[2]!.id]: today, [definitions[3]!.id]: definitions[3]!.options![index % 3]!,
      [definitions[4]!.id]: ['ready', 'released', 'done'].includes(stage.id) },
  }))
  return { id: id('mproj'), ownerId: owner.id, name: '示例项目：从角色到工作记录',
    description: '持久化示例项目：所有事项都是演示数据，可以正常编辑、流转或直接删除。请按需要调整角色和字段，再记录自己的真实工作。只有你拥有此项目；不会自动添加成员或推送通知。',
    color: '#2563eb', icon: 'folder', roles, categories, canvasIds: [], members: [], events,
    history: events.map(event => ({ id: id('hist'), eventId: event.id, action: 'example.seed', at: now, actorId: owner.id,
      actorName: owner.email.split('@')[0]!.slice(0, 80), note: '创建演示数据，不代表真实验收。',
      changes: [{ field: 'event', before: null, after: JSON.parse(JSON.stringify(event)) as ManagementEvent }] })),
    createdAt: now, updatedAt: now, revision: 1, isExample: true, guideVersion: 1,
    tableConfig: { configured: true, visibleBaseFields: ['title', 'roleId', 'categoryId', 'status', 'priority', 'createdAt'],
      baseLabels: { title: '示例事项' }, customFields: definitions } }
}
