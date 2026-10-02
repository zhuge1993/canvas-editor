import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1] }
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-collaboration-'))
const fixture = option('--fixture') ? path.resolve(option('--fixture')) : path.join(runtime, 'fixture.cjs')
if (!option('--fixture')) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}
const rootEmail = `collaboration-root-${randomBytes(4).toString('hex')}@example.com`
const users = {}, streams = [], checks = []
let server, port
async function start() {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: rootEmail, FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_GUEST_MODE: '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  server.stderr.on('data', value => { errors += value })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${errors}`)), 15000)
    server.once('message', value => { clearTimeout(timer); resolve(value.port) })
    server.once('error', reject)
    server.once('exit', code => reject(new Error(`Fixture exited ${code}: ${errors}`)))
  })
}
async function stop() { for (const stream of streams) stream.abort.abort(); if (!server || server.exitCode !== null) return; const done = once(server, 'exit'); server.kill('SIGKILL'); await done }
async function request(route, { method = 'GET', user, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Cookie: users[user].cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const text = await response.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, text, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
async function expect(route, options, status = 200) { const value = await request(route, options); assert.equal(value.status, status, `${route}: ${value.text.slice(0, 1600)}`); return value.data }
async function register(name, email, inviteCode) {
  const code = await expect('/api/auth/send-code', { method: 'POST', body: { email, inviteCode } })
  const registered = await request('/api/auth/register', { method: 'POST', body: { email, inviteCode, code: code.developmentCode, password: randomBytes(20).toString('hex') } })
  assert.equal(registered.status, 201, registered.text)
  users[name] = { ...registered.data.user, cookie: registered.cookie }
}
function pass(name) { checks.push(name); console.log(`PASS: ${name}`) }
const op = (user, body, method = 'POST') => ({ user, body, method })
async function openLive(route, user) {
  const abort = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Cookie: users[user].cookie, Accept: 'text/event-stream' }, signal: abort.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const stream = { abort, events: [], ended: false, error: null }
  streams.push(stream)
  void (async () => {
    let buffer = ''
    try {
      for await (const bytes of response.body) {
        buffer += Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n')
        for (;;) {
          const end = buffer.indexOf('\n\n'); if (end < 0) break
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (data) stream.events.push({ event: block.match(/^event:\s*(.+)$/m)?.[1] ?? 'message', data: JSON.parse(data) })
        }
      }
    } catch (error) { if (!abort.signal.aborted) stream.error = error.message }
    finally { stream.ended = true }
  })()
  return stream
}
async function until(predicate, message, ms = 12000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
  assert.ok(predicate(), message)
}

try {
  await start(); await register('root', rootEmail)
  const invite = await expect('/api/admin/invites', op('root', { maxUses: 3 }), 201)
  for (const name of ['alice', 'bob', 'viewer']) await register(name, `${name}-${randomBytes(4).toString('hex')}@example.com`, invite.code)
  let project = await expect('/api/management/projects', op('alice', { name: '角色表格与多人协作验收' }), 201)
  const route = `/api/management/projects/${project.id}`
  assert.ok([403, 404].includes((await request(route, { user: 'bob' })).status))
  project = await expect(route, op('alice', { members: [{ userId: users.bob.id, permission: 'edit' }, { userId: users.viewer.id, permission: 'view' }], revision: project.revision }, 'PATCH'))
  assert.equal((await expect(route, { user: 'bob' })).access, 'edit')
  assert.equal((await expect(route, { user: 'viewer' })).access, 'view')
  assert.ok((await expect('/api/management/projects', { user: 'bob' })).some(item => item.id === project.id))
  await expect(route, op('bob', { name: 'No owner privilege' }, 'PATCH'), 403)
  await expect(`${route}/events`, op('viewer', { title: 'No write privilege' }), 403)
  pass('explicit ordinary-account edit/view membership works; membership and project administration remain owner-only')

  const tableConfig = { configured: true, visibleBaseFields: ['title', 'status', 'priority', 'source', 'recipients'], baseLabels: { title: '问题描述' }, customFields: [
    { id: 'points', name: '工作量', type: 'number' }, { id: 'platform', name: '运行环境', type: 'select', options: ['Linux', 'Web'] },
    { id: 'due', name: '预期日期', type: 'date' }, { id: 'reviewed', name: '已复核', type: 'checkbox' },
  ] }
  project = await expect(`${route}/table-setup`, op('alice', { roles: [{ name: '技术', memberIds: [users.bob.id] }, { name: '运维' }], tableConfig, revision: project.revision, mutationId: 'collaboration-table-setup' }))
  assert.equal(project.tableConfig.configured, true)
  assert.equal(project.tableConfig.customFields.length, 4)
  project = await expect(`${route}/events`, op('alice', { title: '自定义字段与并发编辑', description: '最初说明', roleId: project.roles[0].id, values: { points: 3, platform: 'Linux', due: '2026-10-02', reviewed: false }, recipientIds: [users.bob.id], mutationId: 'collaboration-event-create' }), 201)
  let event = project.events.at(-1)
  const eventRoute = `${route}/events/${event.id}`
  assert.deepEqual(event.values, { points: 3, platform: 'Linux', due: '2026-10-02', reviewed: false })
  assert.equal((await expect('/api/management/notifications', { user: 'bob' })).length, 0)
  await expect(eventRoute, op('alice', { values: { platform: 'Unknown' } }, 'PATCH'), 400)
  pass('role-first setup generates real configurable typed columns; autosave and assigned recipients do not push notifications')

  const old = event
  const edits = await Promise.all([
    request(eventRoute, op('alice', { title: '标题由 Alice 修改', expectedEventUpdatedAt: old.updatedAt, baseValues: { title: old.title }, revision: project.revision }, 'PATCH')),
    request(eventRoute, op('bob', { description: '说明由 Bob 修改', expectedEventUpdatedAt: old.updatedAt, baseValues: { description: old.description }, revision: project.revision }, 'PATCH')),
  ])
  assert.deepEqual(edits.map(value => value.status), [200, 200], edits.map(value => value.text).join('\n'))
  project = await expect(route, { user: 'alice' }); event = project.events.find(item => item.id === old.id)
  assert.equal(event.title, '标题由 Alice 修改'); assert.equal(event.description, '说明由 Bob 修改')
  const custom = await Promise.all([
    request(eventRoute, op('alice', { values: { points: 8 }, expectedEventUpdatedAt: event.updatedAt, baseValues: { values: { points: 3 } }, revision: project.revision }, 'PATCH')),
    request(eventRoute, op('bob', { values: { reviewed: true }, expectedEventUpdatedAt: event.updatedAt, baseValues: { values: { reviewed: false } }, revision: project.revision }, 'PATCH')),
  ])
  assert.deepEqual(custom.map(value => value.status), [200, 200], custom.map(value => value.text).join('\n'))
  project = await expect(route, { user: 'alice' }); event = project.events.find(item => item.id === old.id)
  assert.deepEqual(event.values, { points: 8, platform: 'Linux', due: '2026-10-02', reviewed: true })
  const collision = await Promise.all(['alice', 'bob'].map(user => request(eventRoute, op(user, { title: `${user} 想改同一个字段`, expectedEventUpdatedAt: event.updatedAt, baseValues: { title: event.title } }, 'PATCH'))))
  assert.deepEqual(collision.map(value => value.status).sort(), [200, 409])
  pass('simultaneous edits to different base/custom fields both persist; competing edits to the same field return one conflict')

  const liveAlice = await openLive(`${route}/live?clientId=collab-alice`, 'alice')
  const liveBob = await openLive(`${route}/live?clientId=collab-bob`, 'bob')
  await until(() => liveBob.events.some(value => value.event === 'snapshot'), 'Bob receives an initial live snapshot')
  const snapshot = liveBob.events.find(value => value.event === 'snapshot').data
  assert.equal((snapshot.project ?? snapshot).access, 'edit')
  await until(() => liveBob.events.some(value => value.event === 'presence' && JSON.stringify(value.data).includes(users.alice.id) && JSON.stringify(value.data).includes(users.bob.id)), 'Presence contains both connected users')
  project = await expect(route, { user: 'alice' }); event = project.events.find(item => item.id === old.id)
  await expect(eventRoute, op('alice', { status: 'doing', baseValues: { status: event.status }, expectedEventUpdatedAt: event.updatedAt }, 'PATCH'))
  await until(() => liveBob.events.some(value => value.event === 'revision'), 'Bob receives a live revision after Alice saves')
  pass('two authenticated live streams report online members and deliver another editor save without page reload')

  project = await expect(route, { user: 'alice' })
  const pushBody = { recipientIds: [users.bob.id, users.viewer.id], mutationId: 'collaboration-explicit-push' }
  const pushed = await expect(`${eventRoute}/notify`, op('alice', pushBody))
  const retry = await expect(`${eventRoute}/notify`, op('alice', pushBody))
  assert.deepEqual(retry.notificationIds, pushed.notificationIds)
  const bobNotices = await expect('/api/management/notifications?unread=1', { user: 'bob' })
  const viewerNotices = await expect('/api/management/notifications?unread=1', { user: 'viewer' })
  assert.equal(bobNotices.length, 1); assert.equal(viewerNotices.length, 1)
  assert.equal(bobNotices[0].recipientId, users.bob.id)
  assert.equal(bobNotices[0].snapshot.values.points, 8)
  assert.equal(bobNotices[0].snapshot.recipientIds, undefined)
  assert.equal((await expect('/api/management/notifications', { user: 'root' })).length, 0)
  await expect(`/api/management/notifications/${bobNotices[0].id}/read`, op('viewer', undefined, 'PATCH'), 404)
  await expect(`/api/management/notifications/${bobNotices[0].id}/read`, op('bob', undefined, 'PATCH'))
  assert.equal((await expect('/api/management/notifications?unread=1', { user: 'bob' })).length, 0)
  pass('only explicit save-and-push creates recipient-only in-app snapshots; retries deduplicate and read state is private')

  project = await expect(route, { user: 'alice' })
  await expect(route, op('alice', { members: [{ userId: users.viewer.id, permission: 'view' }], revision: project.revision }, 'PATCH'))
  assert.ok([403, 404].includes((await request(route, { user: 'bob' })).status))
  await until(() => liveBob.ended, 'Revoked editor live stream must close', 20000)
  assert.equal(liveAlice.error, null); assert.equal(liveBob.error, null)
  pass('revoking project access prevents future reads and closes the existing live subscription')
  const report = { status: 'PASS_MANAGEMENT_COLLABORATION', checks, count: checks.length, actualHttp: true, notifications: 'in-app only', emailSent: false, isolatedRuntime: true }
  if (option('--report')) await fs.writeFile(path.resolve(option('--report')), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await stop() }
