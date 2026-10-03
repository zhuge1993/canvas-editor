import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function module(name) {
  const result = await build({ entryPoints: [path.join(frontend, name)], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'))
}
const workflow = await module('managementWorkflow.ts')
const notices = await module('managementNotifications.ts')
const exporter = await module('managementExport.ts')
const expected = ['todo', 'doing', 'review', 'rejected', 'ready', 'released', 'done', 'blocked', 'on_hold', 'cancelled']
assert.deepEqual(workflow.MANAGEMENT_STATUSES, expected)
assert.deepEqual(workflow.MANAGEMENT_STATUS_DEFINITIONS.map(item => item.id), expected)
assert.equal(workflow.MANAGEMENT_STATUS_LABELS.review, '等待验收')
for (const status of expected) assert.equal(workflow.normalizeManagementStatus(status), status)
assert.equal(workflow.normalizeManagementStatus(undefined), 'todo')
for (const value of [null, 'unknown', 'READY', '', 0, false]) assert.throws(() => workflow.normalizeManagementStatus(value))

assert.deepEqual(workflow.managementTransitionMetadata(undefined, 'todo', 100), { stageChangedAt: 100, stageTimes: {} })
const previous = { status: 'doing', createdAt: 100, updatedAt: 200, stageChangedAt: 150, stageTimes: { todo: 50, doing: 20 } }
const unchanged = workflow.managementTransitionMetadata(previous, 'doing', 250)
assert.deepEqual(unchanged, { stageChangedAt: 150, stageTimes: { todo: 50, doing: 20 } })
unchanged.stageTimes.todo = 999
assert.equal(previous.stageTimes.todo, 50)
const review = workflow.managementTransitionMetadata(previous, 'review', 250)
assert.deepEqual(review, { stageChangedAt: 250, stageTimes: { todo: 50, doing: 120 } })
const redo = workflow.managementTransitionMetadata({ ...previous, status: 'review', ...review }, 'doing', 300)
const ready = workflow.managementTransitionMetadata({ ...previous, status: 'doing', ...redo }, 'ready', 400)
assert.deepEqual(ready, { stageChangedAt: 400, stageTimes: { todo: 50, doing: 220, review: 50 } })
assert.deepEqual(workflow.managementTransitionMetadata({ status: 'todo', createdAt: 10, updatedAt: 40 }, 'done', 60),
  { stageChangedAt: 60, stageTimes: { todo: 20 } }, 'legacy fallback and direct todo to done remain supported')
assert.deepEqual(workflow.managementTransitionMetadata({ status: 'todo', stageChangedAt: 100 }, 'blocked', 90),
  { stageChangedAt: 90, stageTimes: { todo: 0 } }, 'backward clock contributes no negative duration')
assert.deepEqual(workflow.validateManagementStageMetadata({}), {})
assert.deepEqual(workflow.validateManagementStageMetadata({ stageChangedAt: 0, stageTimes: { ready: 0 } }), { stageChangedAt: 0, stageTimes: { ready: 0 } })
for (const metadata of [
  { stageChangedAt: -1 }, { stageChangedAt: NaN }, { stageChangedAt: 8640000000000001 }, { stageChangedAt: '1' },
  { stageTimes: null }, { stageTimes: [] }, { stageTimes: { unknown: 1 } }, { stageTimes: { ready: -1 } },
  { stageTimes: { ready: Infinity } }, { stageTimes: { ready: 0.5 } }, { stageTimes: { ready: '1' } },
  { stageTimes: JSON.parse('{"__proto__":0}') },
]) assert.throws(() => workflow.validateManagementStageMetadata(metadata))
assert.throws(() => workflow.managementTransitionMetadata({ status: 'todo', stageChangedAt: 0, stageTimes: { todo: Number.MAX_SAFE_INTEGER } }, 'doing', 1))

const event = { id: 'event', title: 'Issue', description: 'Detailed issue', roleId: '', categoryId: '', source: '', recorder: 'owner',
  assignee: '', priority: 'high', status: 'ready', createdAt: 100, updatedAt: 400, attachments: [], values: { score: 7 },
  stageChangedAt: ready.stageChangedAt, stageTimes: ready.stageTimes, transitionNote: '复核通过，准备发布', recipientIds: ['recipient'] }
const project = { id: 'project', ownerId: 'owner', name: 'Project', description: '', color: '#123456', icon: 'task',
  roles: [], categories: [], canvasIds: [], events: [event], history: [{ id: 'history', eventId: 'event', actorId: 'owner', at: 400,
    action: 'event.update', actorName: '实际处理人', note: '返工后复验通过', changes: [{ field: 'status', before: 'rejected', after: 'ready' },
      { field: 'stageTimes', before: { doing: 120 }, after: ready.stageTimes }] }], createdAt: 100, updatedAt: 400, revision: 2,
  tableConfig: { configured: true, visibleBaseFields: ['title', 'status'], baseLabels: {}, customFields: [{ id: 'score', name: '评分', type: 'number' }] } }
const notificationInput = { project, event, sender: { id: 'owner', email: 'owner@example.test' }, recipientIds: ['recipient'],
  registeredUsers: [{ id: 'owner', email: 'owner@example.test' }, { id: 'recipient', email: 'recipient@example.test' }],
  mutationId: 'workflow_push', now: 500, existing: [] }
for (const status of expected) {
  const fixture = { ...event, status }
  const notice = notices.createNotifications({ ...notificationInput, project: { ...project, events: [fixture] }, event: fixture })[0]
  assert.equal(notice.snapshot.status, status)
  assert.equal(notice.snapshot.stageChangedAt, 400)
  assert.equal(notice.snapshot.transitionNote, '复核通过，准备发布')
  assert.deepEqual(notice.snapshot.stageTimes, ready.stageTimes)
  assert.equal(notice.snapshot.recipientIds, undefined)
  assert.notEqual(notice.snapshot.stageTimes, fixture.stageTimes)
}
assert.throws(() => notices.createNotifications({ ...notificationInput, event: { ...event, status: 'invalid' } }))
assert.throws(() => notices.createNotifications({ ...notificationInput, event: { ...event, stageTimes: { ready: -1 } } }))
for (const transitionNote of ['x'.repeat(2001), null, 12, 'bad\0note'])
  assert.throws(() => notices.createNotifications({ ...notificationInput, event: { ...event, transitionNote } }))
const legacyEvent = { ...event }; delete legacyEvent.stageChangedAt; delete legacyEvent.stageTimes
assert.equal(notices.createNotifications({ ...notificationInput, event: legacyEvent })[0].snapshot.stageTimes, undefined)

const statusCounts = Object.fromEntries(expected.map(status => [status, status === 'ready' ? 1 : 0]))
const stats = { total: 1, activeTotal: 1, todo: 0, doing: 0, done: 0, cancelled: 0, completionPercent: 0,
  newToday: 1, completedToday: 0, today: '2026-10-03', timeZone: 'Asia/Shanghai', filters: {},
  byStatus: workflow.MANAGEMENT_STATUS_DEFINITIONS.map(stage => ({ ...stage, count: statusCounts[stage.id] })),
  byRole: [{ id: 'unassigned', name: '待分配', color: '#123456', count: 1, activeCount: 1, handlingMs: 220,
    statusCounts, stageDurationMs: ready.stageTimes }], byCategory: [], trend: [] }
const exportInput = { kind: 'management', resourceId: project.id, project, scope: {}, canvases: [], assets: [], assetUrls: {}, stats,
  baseUrl: 'https://draw.example.test/ai/workflow_test_token', now: 500, offset: 0, limit: 100, historyOffset: 0, historyLimit: 100 }
const exported = exporter.buildManagementExport(exportInput)
assert.equal(exported.events[0].status, 'ready')
assert.equal(exported.events[0].stageChangedAt, 400)
assert.equal(exported.events[0].transitionNote, '复核通过，准备发布')
assert.equal(exported.history[0].note, '返工后复验通过')
assert.deepEqual({ ...exported.events[0].stageTimes }, ready.stageTimes)
assert.deepEqual({ ...exported.events[0].values }, { score: 7 })
assert.equal(exported.events[0].recipientIds, undefined)
assert.deepEqual({ ...exported.history[0].changes[0] }, { field: 'status', before: 'rejected', after: 'ready' })
assert.deepEqual({ ...exported.history[0].changes[1].after }, ready.stageTimes)
const markdown = exporter.renderManagementMarkdown(exported)
assert.ok(markdown.includes('已处理待发布'))
assert.ok(markdown.includes('220 ms in completed intervals'))
assert.ok(markdown.includes('Current stage entered'))
assert.ok(markdown.includes('复核通过，准备发布'))
assert.ok(markdown.includes('返工后复验通过'))
assert.ok(markdown.includes('实际处理人'))
assert.ok(markdown.includes('handling 220 ms'))
for (const stage of workflow.MANAGEMENT_STATUS_DEFINITIONS) assert.ok(markdown.includes(stage.label))
for (const transitionNote of ['x'.repeat(2001), null, 12, 'bad\0note']) {
  assert.throws(() => exporter.buildManagementExport({ ...exportInput, project: { ...project, events: [{ ...event, transitionNote }] } }))
  assert.throws(() => exporter.buildManagementExport({ ...exportInput, project: { ...project, history: [{ ...project.history[0], note: transitionNote }] } }))
}
const noHistory = exporter.buildManagementExport({ ...exportInput, scope: { includeHistory: false, includeStats: false } })
assert.equal(noHistory.history, undefined)
assert.equal(noHistory.stats, undefined)
console.log('PASS: ten workflow states; cumulative completed-stage durations/reentry/same-stage/legacy validation; all-state immutable recipient snapshots and bounded notes; scoped AI fields/stage/history/notes/status and role statistics; no transition gates or SMTP')
