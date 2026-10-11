import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-shared-restore-'))
const fixture = path.join(runtime, 'fixture.cjs'), users = {}, password = 'Isolated-restore-password-27'
await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
let server, port
async function request(route, method = 'GET', body, user = 'root', expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json',
    ...(users[user]?.cookie ? { Cookie: users[user].cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const bytes = Buffer.from(await response.arrayBuffer()); let data
  try { data = JSON.parse(bytes.toString('utf8')) } catch { data = bytes }
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`)
  if (users[user] && response.headers.get('set-cookie')) users[user].cookie = response.headers.get('set-cookie').split(';')[0]
  return data
}
async function register(user, inviteCode) {
  users[user] = { email: `restore-${user}@example.test`, cookie: '' }
  const sent = await request('/api/auth/send-code', 'POST', { email: users[user].email, ...(inviteCode ? { inviteCode } : {}) }, user)
  await request('/api/auth/register', 'POST', { email: users[user].email, password, code: sent.developmentCode, ...(inviteCode ? { inviteCode } : {}) }, user, 201)
}
async function put(id, content, user = 'author') {
  await request(`/api/projects/${id}`, 'PUT', { id, title: id, content: JSON.stringify(content), createdAt: 1, updatedAt: 1 }, user)
}
async function injectClockAhead(id) {
  // Only this disposable fixture's file is adjusted. A version ahead of the
  // wall clock makes same-millisecond/backwards-clock regression deterministic.
  const file = path.join(runtime, 'project-data', `${id}.json`)
  const value = JSON.parse(await fs.readFile(file, 'utf8'))
  value.updatedAt = Date.now() + 60000
  await fs.writeFile(file, JSON.stringify(value), 'utf8')
  return value.updatedAt
}
try {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime,
    FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'restore-root@example.test', FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_GUEST_MODE: '0', FLOWBOARD_TUNNEL_NOTIFY: 'false' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; server.stderr.on('data', value => { errors = (errors + value).slice(-8000) })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${errors}`)), 10000)
    server.once('message', value => { clearTimeout(timer); resolve(value.port) })
    server.once('error', reject); server.once('exit', code => reject(new Error(`fixture ${code}: ${errors}`)))
  })
  await register('root')
  const invite = await request('/api/admin/invites', 'POST', { maxUses: 1 }, 'root', 201)
  await register('author', invite.code)
  const first = { shapes: { note: { id: 'note', text: 'first version' } } }, second = { shapes: { note: { id: 'note', text: 'second version' } } }
  const sourceId = 'restore_cas_source'
  await put(sourceId, first)
  const version = await request(`/api/projects/${sourceId}/versions`, 'POST', { name: 'first snapshot', content: JSON.stringify(first) }, 'author', 201)
  await put(sourceId, second)
  const share = await request(`/api/projects/${sourceId}/shares`, 'POST', { permission: 'edit' }, 'author', 201)
  const ahead = await injectClockAhead(sourceId)
  const stale = await request(`/api/share/${share.token}`, 'GET', undefined, 'anonymous')
  await request(`/api/projects/${sourceId}/versions/${version.id}/restore`, 'POST', {}, 'author')
  const restored = await request(`/api/share/${share.token}`, 'GET', undefined, 'anonymous')
  assert.equal(restored.content, JSON.stringify(first)); assert.equal(restored.updatedAt, ahead + 1)
  await request(`/api/share/${share.token}`, 'PUT', { ...stale, expectedUpdatedAt: stale.updatedAt }, 'anonymous', 409)
  assert.equal((await request(`/api/share/${share.token}`, 'GET', undefined, 'anonymous')).content, JSON.stringify(first))

  const trashId = 'restore_cas_trash'
  await put(trashId, first); await request(`/api/projects/${trashId}`, 'DELETE', undefined, 'author')
  const trashAhead = await injectClockAhead(trashId)
  await request(`/api/projects/${trashId}/restore`, 'POST', {}, 'author')
  assert.equal((await request(`/api/projects/${trashId}`, 'GET', undefined, 'author')).updatedAt, trashAhead + 1)

  const graphId = 'restore_cas_graph', targetId = 'restore_cas_target'
  await put(graphId, { shapes: { shape: { id: 'shape', type: 'text', text: 'copy me', groupId: 'group' } },
    groups: { group: { id: 'group', name: 'group', childIds: ['shape'] } }, order: ['group'] })
  await put(targetId, { shapes: {}, groups: {}, order: [] }, 'root')
  const targetAhead = await injectClockAhead(targetId)
  await request('/api/admin/copy-group', 'POST', { sourceDocId: graphId, targetDocId: targetId, groupId: 'group' }, 'root', 201)
  const target = await request(`/api/projects/${targetId}`)
  assert.equal(target.updatedAt, targetAhead + 1); assert.ok(Object.keys(JSON.parse(target.content).shapes).length > 0)

  // Restoring an old backup must preserve its historical timestamp/content;
  // subsequent optimistic saves can start from that returned version.
  const backup = JSON.parse(gunzipSync(await request('/api/admin/backup')))
  backup.data[`${sourceId}.json`].updatedAt = 10.5
  backup.data[`${sourceId}.json`].canvas = second
  await request('/api/admin/restore', 'POST', backup)
  const old = await request(`/api/share/${share.token}`, 'GET', undefined, 'anonymous')
  assert.equal(old.updatedAt, 10.5); assert.equal(old.content, JSON.stringify(second))
  const written = await request(`/api/share/${share.token}`, 'PUT', { ...old, content: JSON.stringify(first), expectedUpdatedAt: old.updatedAt }, 'anonymous')
  assert.ok(written.updatedAt > old.updatedAt)
  assert.equal((await request(`/api/share/${share.token}`, 'GET', undefined, 'anonymous')).content, JSON.stringify(first))
  console.log('PASS shared restore CAS: version restore rejects stale editor, restore/trash/admin-copy versions advance past clock, historical finite backup timestamps and old content remain compatible')
} finally {
  if (server?.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGKILL'); await done }
  assert.ok(path.dirname(runtime) === path.resolve(os.tmpdir()) && path.basename(runtime).startsWith('flowboard-shared-restore-'))
  await fs.rm(runtime, { recursive: true, force: true })
}
