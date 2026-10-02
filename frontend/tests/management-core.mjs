import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-management-core-'))
const fixtureIndex = process.argv.indexOf('--fixture')
const fixture = fixtureIndex < 0 ? path.join(runtime, 'fixture.cjs') : path.resolve(process.argv[fixtureIndex + 1])
if (fixtureIndex < 0) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}
let server, port, cookie = ''
async function start() {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'management-core@example.com', FLOWBOARD_EMAIL_MODE: 'console' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  server.stderr.on('data', bytes => { errors += bytes.toString() })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture timeout: ${errors}`)), 10000)
    server.once('error', reject)
    server.once('message', message => { clearTimeout(timer); resolve(message.port) })
    server.once('exit', code => reject(new Error(`fixture exited ${code}: ${errors}`)))
  })
}
async function stop() {
  if (!server || server.exitCode !== null) return
  const done = once(server, 'exit'); server.kill('SIGKILL'); await done
}
async function request(route, method = 'GET', body, status = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const data = await response.json()
  assert.equal(response.status, status, JSON.stringify(data))
  const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]
  return data
}
async function failNextSync() {
  const id = `fail_${Date.now()}`
  const done = new Promise(resolve => {
    const handler = message => { if (message.id === id) { server.off('message', handler); resolve() } }
    server.on('message', handler)
  })
  server.send({ id, command: 'fail-next-sync' }); await done
}
try {
  await start()
  const sent = await request('/api/auth/send-code', 'POST', { email: 'management-core@example.com' })
  await request('/api/auth/register', 'POST', { email: 'management-core@example.com', password: 'Isolated-core-password-29', code: sent.developmentCode }, 201)
  const base = '/api/management/projects'
  let project = await request(base, 'POST', { name: 'Core durability', mutationId: 'create_core_1' }, 201)
  const replayProject = await request(base, 'POST', { mutationId: 'create_core_1', name: 'Core durability' }, 201)
  assert.equal(project.id, replayProject.id)
  assert.equal((await request(base)).length, 1)
  const projectRoute = `${base}/${project.id}`
  project = await request(`${projectRoute}/roles`, 'POST', { name: 'Development' }, 201)
  project = await request(`${projectRoute}/categories`, 'POST', { name: 'Bug' }, 201)
  const roleId = project.roles[0].id, categoryId = project.categories[0].id
  const create = { title: 'Recover acknowledgement', roleId, categoryId, status: 'todo', priority: 'high', revision: project.revision, mutationId: 'create_event_1' }
  project = await request(`${projectRoute}/events`, 'POST', create, 201)
  const eventId = project.events[0].id, initialHistory = project.history.length
  project = await request(`${projectRoute}/events`, 'POST', create, 201)
  assert.equal(project.events.length, 1); assert.equal(project.history.length, initialHistory)
  await request(`${projectRoute}/events`, 'POST', { ...create, title: 'Altered replay' }, 409)
  const oldRevision = project.revision
  project = await request(`${projectRoute}/events/${eventId}`, 'PATCH', { status: 'done', expectedRevision: project.revision, mutationId: 'mark_done_1' })
  assert.equal(project.events[0].status, 'done'); assert.ok(project.events[0].completedAt)
  await request(projectRoute, 'PATCH', { name: 'stale', expectedRevision: oldRevision }, 409)
  const completedAt = project.events[0].completedAt, completedHistory = project.history.length
  project = await request(`${projectRoute}/events/${eventId}`, 'PATCH', { mutationId: 'mark_done_1', status: 'done', revision: oldRevision })
  assert.equal(project.events[0].completedAt, completedAt); assert.equal(project.history.length, completedHistory)
  project = await request(`${projectRoute}/events/${eventId}`, 'PATCH', { status: 'todo', revision: project.revision, mutationId: 'reopen_1' })
  assert.equal(project.events[0].completedAt, undefined)
  assert.ok(project.history.some(entry => entry.changes.some(change => change.field === 'completedAt' && change.before === completedAt && change.after === null)))
  await request(`${projectRoute}/roles/${roleId}`, 'DELETE', undefined, 409)
  const before = await request(projectRoute)
  await failNextSync()
  await request(`${projectRoute}/events/${eventId}`, 'PATCH', { description: 'Do not acknowledge', mutationId: 'failed_write_1' }, 500)
  assert.deepEqual(await request(projectRoute), before)
  await stop(); await start()
  assert.deepEqual(await request(projectRoute), before)
  const stats = await request(`${projectRoute}/stats?status=todo&categoryId=${categoryId}`)
  assert.equal(stats.total, 1); assert.equal(stats.todo, 1); assert.equal(stats.done, 0)
  assert.equal(stats.byCategory.find(category => category.id === categoryId).count, 1)
  assert.equal((await request(`${projectRoute}/history`)).length, before.history.length)
  console.log('PASS management core: restart durability, failed fsync no ACK/state/history, canonical idempotency, stale alias conflict, server completion/reopen history, reference validation, scoped statistics')
} finally {
  await stop()
  assert.ok(path.dirname(runtime) === path.resolve(os.tmpdir()) && path.basename(runtime).startsWith('flowboard-management-core-'))
  await fs.rm(runtime, { recursive: true, force: true })
}
