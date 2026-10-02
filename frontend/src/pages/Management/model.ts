import { MANAGEMENT_STATUS_DEFINITIONS } from '@/types/management'
import type { ManagementHistory, ManagementPriority, ManagementStatus } from '@/types/management'
export const statuses = MANAGEMENT_STATUS_DEFINITIONS.map(item => ({ id: item.id, name: item.label, color: item.color }))
export const priorities: Array<{ id: ManagementPriority; name: string }> = [{ id: 'urgent', name: '紧急' }, { id: 'high', name: '高' }, { id: 'medium', name: '中' }, { id: 'low', name: '低' }]
export const statusName = (value: ManagementStatus) => statuses.find(item => item.id === value)?.name ?? value
export const priorityName = (value: ManagementPriority) => priorities.find(item => item.id === value)?.name ?? value
const fields: Record<string, string> = { title: '标题', description: '描述', roleId: '角色分类', categoryId: '事件分类', source: '来源', recorder: '记录人', assignee: '处理人', priority: '优先级', status: '处理状态', attachments: '附件', completedAt: '完成时间', name: '名称', canvasIds: '关联画布', archivedAt: '归档时间', color: '颜色', values: '自定义字段', recipientIds: '推送对象', assigneeId: '处理人', tableConfig: '表格字段', members: '协作权限', memberIds: '角色人员' }
export function historyTitle(item: ManagementHistory) { if (item.action.includes('delete')) return '删除了记录'; if (item.action.includes('create')) return '新增了记录'; if (item.action.includes('archive')) return '更新了归档状态'; return '更新了记录' }
export function historyChanges(item: ManagementHistory): string { return item.changes.map(change => `${fields[change.field] ?? '信息'}已更新`).join(' · ') || '操作已自动记录' }
export function bytesLabel(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }

export function durationLabel(value: number): string { if (value < 60000) return `${Math.floor(value / 1000)} 秒`; const minutes = Math.floor(value / 60000); return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` }
