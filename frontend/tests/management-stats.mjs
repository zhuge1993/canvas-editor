import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const moduleIndex = process.argv.indexOf('--module')
const compiledModule = moduleIndex < 0 ? undefined : process.argv[moduleIndex + 1]
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-stats-'))
try {
  const file = compiledModule ? path.resolve(compiledModule) : path.join(temporary, 'management.cjs')
  if (!compiledModule) {
    const { build } = await import('esbuild')
    await build({ entryPoints: [path.join(frontend, 'managementCore.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: file })
  }
  const { managementStats, filterManagementEvents } = createRequire(import.meta.url)(file)
  const now = Date.parse('2026-10-02T16:05:00Z') // Shanghai: Oct 3, 00:05.
  const event = (id, created, status, completed, roleId = 'technical', categoryId = 'feature') => ({ id, title: id, description: '项目统计', roleId, categoryId, source: '', recorder: 'fixture', assignee: 'fixture', priority: id === 'B' || id === 'D' ? 'high' : 'medium', status, createdAt: Date.parse(created), updatedAt: now, ...(completed ? { completedAt: Date.parse(completed) } : {}), attachments: [] })
  const project = { id: 'stats_project', ownerId: 'fixture', name: '统计时区验收', description: '', color: '#6366f1', icon: 'folder', roles: [{ id: 'technical', name: '技术', color: '#6366f1' }], categories: [{ id: 'feature', name: '开发', color: '#059669' }], canvasIds: [], history: [], createdAt: now, updatedAt: now, revision: 1, events: [
    event('A', '2026-10-02T15:59:00Z', 'done', '2026-10-02T16:02:00Z'),
    event('B', '2026-10-02T16:01:00Z', 'todo'),
    event('C', '2026-10-02T14:00:00Z', 'doing'),
    event('D', '2026-10-02T16:03:00Z', 'done', '2026-10-02T16:04:00Z'),
  ] }
  const stats = managementStats(project, {}, 2, now)
  assert.equal(stats.today, '2026-10-03')
  assert.equal(stats.total, 4); assert.equal(stats.todo, 1); assert.equal(stats.doing, 1); assert.equal(stats.done, 2)
  assert.equal(stats.newToday, 2); assert.equal(stats.completedToday, 2); assert.equal(stats.completionPercent, 50)
  assert.deepEqual(stats.trend, [{ date: '2026-10-02', created: 2, completed: 0 }, { date: '2026-10-03', created: 2, completed: 2 }])
  const selected = managementStats(project, { status: 'done', priority: 'high' }, 2, now)
  assert.equal(selected.total, 1); assert.equal(selected.done, 1); assert.equal(selected.newToday, 1)
  assert.equal(selected.byCategory.find(item => item.id === 'feature').count, 1)
  assert.equal(filterManagementEvents(project.events, { status: 'done', priority: 'high' })[0].id, 'D')
  const empty = managementStats({ ...project, events: [] }, {}, 2, now)
  assert.equal(empty.completionPercent, 0)
  assert.ok(Object.values(empty).every(value => typeof value !== 'number' || Number.isFinite(value)))
  console.log('PASS: Shanghai midnight boundaries, cross-day completion, filtered totals/distributions/trends, and empty progress')

  const many = { ...project, events: Array.from({ length: 10000 }, (_, i) => ({ ...project.events[i % 4], id: `load_${i}`, createdAt: now - i * 60000, completedAt: i % 4 === 0 || i % 4 === 3 ? now - i * 60000 : undefined })) }
  const begin = performance.now()
  const manyStats = managementStats(many, {}, 90, now)
  const elapsedMs = Math.round((performance.now() - begin) * 100) / 100
  assert.equal(manyStats.total, 10000); assert.equal(manyStats.done, 5000); assert.equal(manyStats.trend.length, 90)
  assert.equal(manyStats.byCategory.find(item => item.id === 'feature').count, 10000)
  console.log(JSON.stringify({ status: 'PASS_MANAGEMENT_STATS', actualModule: true, events: 10000, trendDays: 90, elapsedMs, performanceMeasurementHost: process.platform }))
} finally {
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await fs.rm(temporary, { recursive: true, force: true })
}
