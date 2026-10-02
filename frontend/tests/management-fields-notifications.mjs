import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function module(name) {
  const result = await build({ entryPoints: [path.join(frontend, name)], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'))
}
const fields = await module('managementFields.ts')
const notices = await module('managementNotifications.ts')
const exports = await module('managementExport.ts')
const roles = [{ id: 'role_a' }, { id: 'role_b' }]
const definitions = fields.normalizeFieldDefinitions([
  { id: 'details', name: '说明', type: 'text', required: true },
  { id: 'amount', name: '数量', type: 'number' },
  { id: 'when', name: '日期', type: 'date' },
  { id: 'choice', name: '选择', type: 'select', options: ['甲', '乙'] },
  { id: 'checked', name: '勾选', type: 'checkbox', required: true },
  { id: 'role_only', name: '角色专用', type: 'text', required: true, roleId: 'role_b' },
], roles)
const complete = { details: '完整说明', amount: 0, when: '2024-02-29', choice: '乙', checked: false }
assert.deepEqual({ ...fields.validateFieldValues(definitions, complete, {}, false, 'role_a') }, complete)
assert.deepEqual({ ...fields.validateFieldValues(definitions, { amount: 12 }, complete, true, 'role_a') }, { ...complete, amount: 12 })
assert.equal(fields.validateFieldValues(definitions, undefined, { ...complete, role_only: 'old' }, false, 'role_a').role_only, undefined)
assert.throws(() => fields.validateFieldValues(definitions, { ...complete, role_only: 'wrong role' }, {}, false, 'role_a'), /不适用于/)
assert.throws(() => fields.validateFieldValues(definitions, complete, {}, false, 'role_b'), /必填/)
assert.throws(() => fields.validateFieldValues(definitions, { ...complete, details: ' ' }, {}, false, 'role_a'), /必填/)
for (const invalid of [Infinity, NaN, '1', true]) assert.throws(() => fields.validateFieldValues(definitions, { ...complete, amount: invalid }, {}, false, 'role_a'))
for (const date of ['2023-02-29', '2024-04-31', '2024-13-01', '2024-1-01', '2024-01-01T00:00Z'])
  assert.throws(() => fields.validateFieldValues(definitions, { ...complete, when: date }, {}, false, 'role_a'))
assert.throws(() => fields.validateFieldValues(definitions, { ...complete, choice: '丙' }, {}, false, 'role_a'))
assert.throws(() => fields.validateFieldValues(definitions, { ...complete, checked: 'true' }, {}, false, 'role_a'))
assert.throws(() => fields.validateFieldValues(definitions, { ...complete, unknown: 'secret' }, {}, false, 'role_a'))
for (const bad of [
  [{ id: 'same', name: 'A', type: 'text' }, { id: 'same', name: 'B', type: 'text' }],
  [{ id: '__proto__', name: 'Bad', type: 'text' }],
  [{ id: 'x', name: 'Bad', type: 'select', options: [' A ', 'A'] }],
  [{ id: 'x', name: 'Bad', type: 'select', options: [] }],
  [{ id: 'x', name: 'Bad', type: 'email' }],
  [{ id: 'x', name: 'Bad', type: 'text', roleId: 'missing' }],
]) assert.throws(() => fields.normalizeFieldDefinitions(bad, roles))
const table = fields.normalizeTableConfig({ configured: true, visibleBaseFields: ['title', 'recipients'],
  baseLabels: { title: '事项', recipients: '通知接收人' }, customFields: definitions }, undefined, roles)
assert.equal(table.configured, true)
assert.equal(fields.normalizeTableConfig({ baseLabels: { title: 'Renamed' } }, table, roles).configured, true)
assert.throws(() => fields.normalizeTableConfig({ customFields: null }, table, roles))
assert.throws(() => fields.normalizeTableConfig({ visibleBaseFields: null }, table, roles))
assert.equal(fields.normalizeTableConfig(undefined).configured, false)
assert.throws(() => fields.normalizeTableConfig({ configured: true, visibleBaseFields: [], customFields: [] }))
assert.throws(() => fields.normalizeTableConfig({ visibleBaseFields: ['ownerId'] }))

const attachment = { id: 'asset_x', name: 'Screenshot.png', mime: 'image/png', bytes: 20,
  url: '/api/management/projects/project_x/assets/asset_x', createdAt: 1 }
const event = { id: 'event_x', title: 'Current issue', description: 'Issue body', roleId: 'role_a', categoryId: 'cat', source: 'reported',
  recorder: 'owner@example.com', assignee: 'Responsible person', priority: 'high', status: 'doing', createdAt: 100, updatedAt: 120,
  attachments: [attachment], values: complete, recipientIds: ['recipient_a', 'recipient_b'] }
const project = { id: 'project_x', ownerId: 'owner', name: 'Team project', description: '', color: '#123456', icon: 'task',
  roles: [{ id: 'role_a', name: 'Role A', color: '#123456', memberIds: ['recipient_a', 'recipient_b'] },
    { id: 'role_b', name: 'Role B', color: '#123456' }], categories: [{ id: 'cat', name: 'Category', color: '#123456' }],
  canvasIds: [], events: [event], history: [], createdAt: 1, updatedAt: 120, revision: 1, tableConfig: table }
const input = { project, event, sender: { id: 'owner', email: 'owner@example.com' }, recipientIds: ['recipient_a', 'recipient_b', 'recipient_a'],
  registeredUsers: [{ id: 'owner', email: 'owner@example.com' }, { id: 'recipient_a', email: 'a@example.com' },
    { id: 'recipient_b', email: 'b@example.com' }], mutationId: 'manual_push_1', now: 200, existing: [] }
const created = notices.createNotifications(input)
assert.equal(created.length, 2)
assert.notEqual(created[0].id, created[1].id)
assert.deepEqual(notices.createNotifications({ ...input, existing: created }), [])
assert.deepEqual(notices.createNotifications(input).map(item => item.id), created.map(item => item.id))
assert.equal(notices.createNotifications({ ...input, mutationId: 'manual_push_2', existing: created }).length, 2)
assert.throws(() => notices.createNotifications({ ...input, recipientIds: ['non_registered'] }))
assert.throws(() => notices.createNotifications({ ...input, recipientIds: [] }))
assert.throws(() => notices.createNotifications({ ...input, sender: { id: 'foreign', email: 'foreign@example.com' } }))
const sharedProject = { ...project, members: [{ userId: 'recipient_a', permission: 'edit' }, { userId: 'recipient_b', permission: 'view' }] }
assert.equal(notices.createNotifications({ ...input, project: sharedProject, sender: { id: 'recipient_a', email: 'a@example.com' } }).length, 2)
assert.throws(() => notices.createNotifications({ ...input, project: sharedProject, sender: { id: 'recipient_b', email: 'b@example.com' } }))
assert.throws(() => notices.createNotifications({ ...input, mutationId: '' }))
const recipient = notices.filterNotificationsForRecipient(created, 'recipient_a')
assert.equal(recipient.length, 1)
assert.equal(notices.filterNotificationsForRecipient(created, 'owner').length, 0)
assert.deepEqual(recipient[0].snapshot.values, complete)
assert.equal(recipient[0].snapshot.recipientIds, undefined)
assert.equal(recipient[0].snapshotLabels.fields.role_only, undefined)
assert.equal(recipient[0].snapshot.attachments[0].url, `/api/management/notifications/${recipient[0].id}/assets/asset_x`)
assert.equal(JSON.stringify(recipient).includes(attachment.url), false)
event.title = 'Changed after notification'
event.values.amount = 999
assert.equal(recipient[0].snapshot.title, 'Current issue')
assert.equal(recipient[0].snapshot.values.amount, 0)
const read = notices.markNotificationsRead(created, 'recipient_a', [recipient[0].id], 300)
assert.equal(read.find(item => item.recipientId === 'recipient_a').readAt, 300)
assert.equal(read.find(item => item.recipientId === 'recipient_b').readAt, undefined)
assert.equal(notices.markNotificationsRead(read, 'recipient_a', [recipient[0].id], 400).find(item => item.id === recipient[0].id).readAt, 300)
assert.throws(() => notices.markNotificationsRead(created, 'recipient_a', [created.find(item => item.recipientId === 'recipient_b').id], 300))
assert.throws(() => notices.markNotificationsRead(created, 'recipient_a', ['missing'], 300))
assert.equal(created[0].readAt, undefined)

project.history = [{ id: 'history', at: 150, actorId: 'owner', action: 'event.update', eventId: event.id,
  changes: [{ field: 'recipientIds', before: [], after: ['recipient_a', 'recipient_b'] },
    { field: 'event', before: null, after: { ...event, inbox: ['private'] } }] }]
const ai = exports.buildManagementExport({ kind: 'management', resourceId: project.id, project, scope: {}, canvases: [], assets: [], assetUrls: {},
  baseUrl: 'https://draw.example.com/ai/test_token_abcdefgh', now: 200, offset: 0, limit: 100, historyOffset: 0, historyLimit: 100 })
assert.deepEqual({ ...ai.events[0].values }, event.values)
assert.equal(ai.project.tableConfig.customFields.length, definitions.length)
assert.equal(ai.events[0].recipientIds, undefined)
assert.equal(JSON.stringify(ai).includes('recipient_a'), false)
assert.equal(JSON.stringify(ai).includes('recipient_b'), false)
assert.equal(JSON.stringify(ai).includes('"inbox"'), false)
assert.equal(ai.project.roles[0].memberIds, undefined)
assert.ok(exports.renderManagementMarkdown(ai).includes('数量'))
console.log('PASS: dynamic field schemas/typed values/role applicability; manual recipient notifications/snapshots/proxy/idempotence/read isolation; AI custom values without inbox/recipient catalogs; no SMTP or network')
