import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-dispatch-backup-'))
const require = createRequire(import.meta.url)
async function module(name) {
  const file = path.join(runtime, path.basename(name, '.ts') + '.cjs')
  await build({ entryPoints: [path.join(frontend, name)], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: file })
  return require(file)
}
const plain = value => JSON.parse(JSON.stringify(value))
const paths = { dataDirectory: path.join(runtime, 'data'), authDirectory: path.join(runtime, 'auth') }
const budget = { documentBudget: 1024 * 1024, assetBudget: 1024 * 1024, readCanvas: async () => null }
const writers = {
  async writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value), 'utf8') },
  async writeBuffer(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value) },
}

try {
  const backup = await module('managementBackup.ts'), notices = await module('managementNotifications.ts')
  const assigned = { id: 'assigned', title: 'Login is broken', description: 'The login screen reports an error', roleId: 'technical', categoryId: '',
    source: '', recorder: 'owner@example.test', assignee: 'Handler', assigneeId: 'handler', priority: 'medium', status: 'todo',
    createdAt: 10, updatedAt: 20, attachments: [], values: { effort: 2 }, recipientIds: [],
    dispatch: { status: 'assigned', reason: 'Matched the technical responsibility', model: 'bge-small-zh-v1.5', assignedAt: 20 } }
  const pending = { ...assigned, id: 'pending', title: 'Unclear requirement', roleId: '', assignee: '', assigneeId: '', values: {},
    dispatch: { status: 'pending', reason: 'No eligible role member', model: 'bge-small-zh-v1.5' } }
  const project = { schemaVersion: 1, id: 'project', ownerId: 'owner', name: 'Dispatch project', description: '', color: '#123456', icon: 'folder',
    roles: [{ id: 'technical', name: 'Technical', color: '#123456', description: 'Fix login errors, programming bugs and API failures', memberIds: ['handler'] },
      { id: 'design', name: 'Design', color: '#654321' }], categories: [], canvasIds: [],
    members: [{ userId: 'handler', permission: 'edit' }], events: [assigned, pending],
    history: [{ id: 'history', eventId: 'assigned', actorId: 'owner', action: 'event.create', at: 20,
      changes: [{ field: 'event', before: null, after: plain(assigned) }] }],
    createdAt: 10, updatedAt: 20, revision: 2, receipts: [],
    tableConfig: { configured: true, visibleBaseFields: ['title', 'roleId', 'assignee', 'status'], baseLabels: {},
      customFields: [{ id: 'details', name: 'Details', type: 'text', required: true },
        { id: 'effort', name: 'Effort', type: 'number', required: false },
        { id: 'technicalNotes', name: 'Technical notes', type: 'text', roleId: 'technical', required: false }] } }
  const noticeInput = { project, event: assigned, sender: { id: 'owner', email: 'owner@example.test' }, recipientIds: ['handler'],
    registeredUsers: [{ id: 'owner', email: 'owner@example.test' }, { id: 'handler', email: 'handler@example.test' }],
    mutationId: 'explicit_push', now: 30, existing: [] }
  const notice = notices.createNotifications(noticeInput)[0]
  assert.deepEqual(notice.snapshot.dispatch, assigned.dispatch)
  assert.notEqual(notice.snapshot.dispatch, assigned.dispatch)
  assert.equal(notice.snapshot.assigneeId, undefined, 'notification retains the existing account-ID projection boundary')
  assert.equal(notice.snapshot.recipientIds, undefined)
  assigned.dispatch.reason = 'Current responsibility after notification'
  assert.equal(notice.snapshot.dispatch.reason, 'Matched the technical responsibility', 'notification remains a historical snapshot')
  for (const values of [{ effort: '2' }, { unknown: true }, { details: {} }]) {
    assert.throws(() => notices.createNotifications({ ...noticeInput, event: { ...assigned, values } }))
  }
  // A saved notification can retain an old role even after the current catalog changes.
  notice.snapshot.roleId = 'historical_role'
  const section = { schemaVersion: 1, projects: { 'project.json': project }, assetMetadata: {}, assets: {}, aiShares: [],
    notifications: { schemaVersion: 1, notifications: [notice], receipts: [] } }
  const stage = await backup.stageManagementRestore(paths, plain(section), budget)
  assert.deepEqual(plain(stage.projects[0].value.events), plain(project.events))
  assert.deepEqual(plain(stage.projects[0].value.history), plain(project.history))
  assert.deepEqual(plain(stage.notifications.notifications[0]), plain(notice))
  await backup.commitManagementRestore(paths, stage, writers)
  const exported = await backup.exportManagementBackup(paths, budget.documentBudget, budget.assetBudget, writers)
  assert.deepEqual(exported, plain(section), 'backup/restore preserves responsibilities, partial intake fields and historical dispatch snapshots')
  const restaged = await backup.stageManagementRestore(paths, plain(exported), budget)
  assert.deepEqual(plain(restaged.projects), plain(stage.projects))
  assert.deepEqual(plain(restaged.notifications), plain(stage.notifications))

  const unchanged = await fs.readFile(path.join(paths.dataDirectory, 'management', 'projects', 'project.json'))
  const cases = [
    value => { value.projects['project.json'].roles[0].description = 'x'.repeat(501) },
    value => { value.projects['project.json'].roles[0].description = null },
    value => { value.projects['project.json'].roles[0].description = 'bad\0description' },
    value => { value.projects['project.json'].categories = [{ id: 'cat', name: 'Category', color: '#123456', description: 'role-only field' }] },
    value => { value.projects['project.json'].events[0].dispatch = null },
    value => { value.projects['project.json'].events[0].dispatch.status = 'unknown' },
    value => { value.projects['project.json'].events[0].dispatch.model = 'other-model' },
    value => { value.projects['project.json'].events[0].dispatch.reason = 'x'.repeat(501) },
    value => { value.projects['project.json'].events[0].dispatch.reason = '' },
    value => { value.projects['project.json'].events[0].dispatch.reason = 'bad\0reason' },
    value => { value.projects['project.json'].events[0].dispatch.untrusted = 'unknown' },
    value => { delete value.projects['project.json'].events[0].dispatch.assignedAt },
    value => { value.projects['project.json'].events[0].dispatch.assignedAt = -1 },
    value => { value.projects['project.json'].events[0].dispatch.assignedAt = 0.5 },
    value => { value.projects['project.json'].events[1].dispatch.assignedAt = 20 },
    value => { value.projects['project.json'].events[0].assigneeId = '' },
    value => { value.projects['project.json'].events[0].values.effort = '2' },
    value => { value.projects['project.json'].events[0].values.unknown = true },
    value => { value.projects['project.json'].events[1].values.technicalNotes = 'wrong role' },
    value => { value.notifications.notifications[0].snapshot.dispatch.model = 'other-model' },
    value => { value.notifications.notifications[0].snapshot.dispatch.reason = {} },
    value => { value.notifications.notifications[0].snapshot.dispatch.extra = 'unknown' },
    value => { value.notifications.notifications[0].snapshot.dispatch.assignedAt = '20' },
  ]
  for (const corrupt of cases) {
    const invalid = plain(section); corrupt(invalid)
    await assert.rejects(backup.stageManagementRestore(paths, invalid, budget))
    assert.deepEqual(await fs.readFile(path.join(paths.dataDirectory, 'management', 'projects', 'project.json')), unchanged, 'invalid restore never writes live data')
  }

  const legacy = plain(section)
  delete legacy.projects['project.json'].roles[0].description
  for (const event of legacy.projects['project.json'].events) { delete event.dispatch; event.values.details = 'Completed legacy field' }
  delete legacy.notifications.notifications[0].snapshot.dispatch
  assert.equal((await backup.stageManagementRestore(paths, legacy, budget)).projects.length, 1, 'legacy backups do not require new fields')
  delete legacy.projects['project.json'].events[0].values.details
  await assert.rejects(backup.stageManagementRestore(paths, legacy, budget), /必填/, 'ordinary legacy events retain required-field validation')
  console.log(`PASS dispatch backup: current and historical snapshot roundtrip, missing intake fields, supplied type/scope guards, legacy compatibility and ${cases.length} pre-write rejection cases`)
} finally {
  assert.ok(path.dirname(runtime) === path.resolve(os.tmpdir()) && path.basename(runtime).startsWith('flowboard-dispatch-backup-'))
  await fs.rm(runtime, { recursive: true, force: true })
}
