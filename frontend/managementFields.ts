import type { ManagementFieldDefinition, ManagementTableConfig } from './managementTypes.js'

export const MANAGEMENT_BASE_FIELDS = ['title', 'description', 'roleId', 'categoryId', 'source', 'recorder', 'assignee',
  'priority', 'status', 'createdAt', 'updatedAt', 'completedAt', 'attachments', 'recipients'] as const
export const BASE_FIELDS = MANAGEMENT_BASE_FIELDS
export type ManagementFieldValues = Record<string, string | number | boolean>
const TYPES = new Set(['text', 'number', 'date', 'select', 'checkbox'])
const IDS = /^[A-Za-z0-9_-]{1,100}$/
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export class ManagementFieldError extends Error {
  readonly status = 400
  constructor(message: string) { super(message); this.name = 'ManagementFieldError' }
}
function invalid(message: string): never { throw new ManagementFieldError(message) }
function label(value: unknown, context: string, maximum = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /\0/.test(value)) invalid(`${context}格式无效`)
  return value.trim()
}
function validId(value: unknown): value is string { return typeof value === 'string' && IDS.test(value) && !FORBIDDEN.has(value) }

export function normalizeFieldDefinitions(raw: unknown, roles?: Array<{ id: string }>): ManagementFieldDefinition[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 100) invalid('自定义字段必须是最多100项的数组')
  const ids = new Set<string>(), roleIds = roles === undefined ? undefined : new Set(roles.map(role => role.id))
  return raw.map((value, index) => {
    if (!object(value) || !validId(value.id) || ids.has(value.id) || typeof value.type !== 'string' || !TYPES.has(value.type))
      invalid(`第${index + 1}项字段的id或类型无效，字段id不能重复`)
    ids.add(value.id)
    if (value.required !== undefined && typeof value.required !== 'boolean') invalid('字段必填标志必须为布尔值')
    if (value.roleId !== undefined && value.roleId !== '' && (!validId(value.roleId) || (roleIds && !roleIds.has(value.roleId))))
      invalid('字段关联的角色不存在')
    const definition: ManagementFieldDefinition = { id: value.id, name: label(value.name, '字段名称'),
      type: value.type as ManagementFieldDefinition['type'], required: value.required === true }
    if (typeof value.roleId === 'string' && value.roleId) definition.roleId = value.roleId
    if (definition.type === 'select') {
      if (!Array.isArray(value.options) || !value.options.length || value.options.length > 100) invalid('选择字段需要1-100个选项')
      const choices = value.options.map(option => label(option, '字段选项', 200))
      if (new Set(choices).size !== choices.length) invalid('字段选项不能重复')
      definition.options = choices
    }
    return definition
  })
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false
  const date = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function fieldValue(field: ManagementFieldDefinition, raw: unknown): string | number | boolean | undefined {
  if (raw === undefined || raw === null || (field.type !== 'text' && raw === '')) {
    if (field.required) invalid(`字段“${field.name}”为必填项`)
    return undefined
  }
  switch (field.type) {
    case 'text':
      if (typeof raw !== 'string' || raw.length > 20000 || /\0/.test(raw)) invalid(`字段“${field.name}”需要有效文本`)
      if (field.required && !raw.trim()) invalid(`字段“${field.name}”为必填项`)
      return raw
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) invalid(`字段“${field.name}”需要有限数字`)
      return raw
    case 'date':
      if (typeof raw !== 'string' || !validDate(raw)) invalid(`字段“${field.name}”需要有效的YYYY-MM-DD日期`)
      return raw
    case 'select':
      if (typeof raw !== 'string' || !field.options?.includes(raw)) invalid(`字段“${field.name}”的选项无效`)
      return raw
    case 'checkbox':
      if (typeof raw !== 'boolean') invalid(`字段“${field.name}”需要布尔值`)
      return raw
  }
}

export function validateFieldValues(defs: ManagementFieldDefinition[], raw: unknown,
  existing: ManagementFieldValues = {}, partial = false, roleId = ''): ManagementFieldValues {
  if (raw !== undefined && !object(raw)) invalid('字段值必须是对象')
  if (!object(existing)) invalid('已有字段值格式无效')
  const applicable = new Map(defs.filter(field => !field.roleId || field.roleId === roleId).map(field => [field.id, field]))
  const fields = new Map(defs.map(field => [field.id, field]))
  const candidate: Record<string, unknown> = Object.create(null)
  if (raw === undefined || partial) for (const [key, value] of Object.entries(existing)) if (applicable.has(key)) candidate[key] = value
  if (raw !== undefined) for (const [key, value] of Object.entries(raw)) {
    if (!fields.has(key)) invalid(`未知字段：${key}`)
    if (!applicable.has(key)) invalid(`字段“${fields.get(key)!.name}”不适用于当前角色`)
    candidate[key] = value
  }
  const result: ManagementFieldValues = Object.create(null)
  for (const [key, field] of applicable) {
    const value = fieldValue(field, candidate[key])
    if (value !== undefined) result[key] = value
  }
  return result
}

export function normalizeTableConfig(raw: unknown, existing?: ManagementTableConfig,
  roles?: Array<{ id: string }>): ManagementTableConfig {
  if (raw === undefined) raw = existing ?? { configured: false, visibleBaseFields: ['title', 'roleId', 'status', 'priority', 'createdAt'], baseLabels: {}, customFields: [] }
  if (!object(raw)) invalid('表格配置必须是对象')
  if (raw.configured !== undefined && typeof raw.configured !== 'boolean') invalid('表格生成状态必须为布尔值')
  const base = raw.visibleBaseFields === undefined ? existing?.visibleBaseFields ?? ['title', 'roleId', 'status', 'priority', 'createdAt'] : raw.visibleBaseFields
  if (!Array.isArray(base) || base.length > MANAGEMENT_BASE_FIELDS.length || base.some(key =>
    typeof key !== 'string' || !(MANAGEMENT_BASE_FIELDS as readonly string[]).includes(key))) invalid('基础字段列表无效')
  if (new Set(base).size !== base.length) invalid('基础字段不能重复')
  const labels = raw.baseLabels === undefined ? existing?.baseLabels ?? {} : raw.baseLabels
  if (!object(labels)) invalid('字段显示名称必须是对象')
  const baseLabels: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(labels)) {
    if (!(MANAGEMENT_BASE_FIELDS as readonly string[]).includes(key)) invalid('未知基础字段名称')
    baseLabels[key] = label(value, '字段显示名称')
  }
  const customFields = normalizeFieldDefinitions(raw.customFields === undefined ? existing?.customFields : raw.customFields, roles)
  const configured = raw.configured === undefined ? existing?.configured ?? false : raw.configured === true
  if (configured && base.length + customFields.length === 0) invalid('生成表格至少需要一个字段')
  return { configured, visibleBaseFields: [...base] as string[], baseLabels, customFields }
}
