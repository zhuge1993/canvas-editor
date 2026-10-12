import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Real authenticated HTTP and durable storage in a disposable console-auth
// runtime. The model fixture controls results and concurrent configuration.
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-dispatch-'))
const fixture = path.join(runtime, 'fixture.cjs')
await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
let mode = 'valid', calls = 0, latest, wantedRole, callback, modelSeen, upstreamCancelled = false
const model = http.createServer(async (req, res) => {
  if (req.url !== '/api/evaluate') { res.statusCode = 404; res.end(); return }
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  latest = JSON.parse(Buffer.concat(chunks).toString('utf8')); calls++
  if (mode === 'cancel' || mode === 'timeout') {
    res.once('close', () => { upstreamCancelled = true }); modelSeen?.(); return
  }
  if (callback) { const fn = callback; callback = undefined; await fn() }
  const keys = Object.keys(latest.questions[0].options), best = wantedRole || keys[0]
  const probabilities = Object.fromEntries(keys.map(key => [key, mode === 'ambiguous' ? 1 / keys.length : key === best ? .85 : .15 / (keys.length - 1)]))
  const similarities = Object.fromEntries(keys.map(key => [key, mode === 'ambiguous' ? .5 : mode === 'unrelated' ? .1 : mode === 'weak' ? key === best ? .514 : .461 : key === best ? .72 : .3]))
  res.setHeader('Content-Type', 'application/json')
  if (mode === 'cooling') { res.statusCode = 503; res.end(JSON.stringify({ code: 'cooling' })); return }
  if (mode === 'large') { res.end(JSON.stringify({ padding: 'x'.repeat(40000) })); return }
  res.end(JSON.stringify({ model: mode === 'wrong-model' ? 'other' : 'bge-small-zh-v1.5', api_version: 'fast-decision.v1',
    results: [{ id: latest.id, answers: [{ id: 'role', type: 'choice', value: 'forged-role', distribution: probabilities,
      similarities: mode === 'bad-values' ? { 'forged-role': 1 } : similarities }] }], usage: { generated_tokens: 0, truncated_inputs: 0 } }))
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
let server, port, route, count = 0
const users = {}, rootEmail = `dispatch-root-${randomBytes(4).toString('hex')}@example.com`
async function start() {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: rootEmail,
    FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_GUEST_MODE: '0', FLOWBOARD_TUNNEL_NOTIFY: 'false', FLOWBOARD_DECISION_URL: `http://127.0.0.1:${model.address().port}` },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; server.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000) })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup timeout ${errors}`)), 15000)
    server.once('message', message => { clearTimeout(timer); resolve(message.port) })
    server.once('error', reject); server.once('exit', code => reject(new Error(`fixture exited ${code}: ${errors}`)))
  })
}
async function stop() { if (server?.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGKILL'); await done } }
async function request(resource, { method = 'GET', body, user = 'root', headers = {}, signal } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${resource}`, { method, headers: { 'Content-Type': 'application/json',
    ...(users[user] ? { Cookie: users[user].cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal || AbortSignal.timeout(12000) })
  const data = await response.json()
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
async function expect(resource, options = {}, status = 200) {
  const result = await request(resource, options); assert.equal(result.status, status, JSON.stringify(result.data)); return result.data
}
async function register(name, inviteCode) {
  const email = name === 'root' ? rootEmail : `dispatch-${name}-${randomBytes(4).toString('hex')}@example.com`
  const sent = await expect('/api/auth/send-code', { method: 'POST', user: '', body: { email, ...(inviteCode ? { inviteCode } : {}) } })
  const result = await request('/api/auth/register', { method: 'POST', user: '', body: { email, password: randomBytes(24).toString('hex'),
    code: sent.developmentCode, ...(inviteCode ? { inviteCode } : {}) } })
  assert.equal(result.status, 201)
  users[name] = { cookie: result.cookie }
  Object.assign(users[name], (await expect('/api/auth/me', { user: name })).user)
}
async function check(label, fn) { await fn(); count++; console.log(`PASS: dispatch ${label}`) }
let sequence = 0
const intake = (extra = {}) => ({ title: '修复手机登录页面报错', description: '登录后出现程序异常，需要开发修复。', mutationId: `dispatch_${++sequence}`, ...extra })
const post = (body, user = 'root') => ({ method: 'POST', body, user })
async function failSync() {
  const id = randomBytes(4).toString('hex')
  await new Promise(resolve => {
    const listener = message => { if (message.id === id) { server.off('message', listener); resolve() } }
    server.on('message', listener); server.send({ id, command: 'fail-sync-file', value: `${route.split('/').at(-1)}.json` })
  })
}
try {
  await start(); await register('root')
  const invite = await expect('/api/admin/invites', post({ maxUses: 4 }), 201)
  for (const name of ['alice', 'bob', 'viewer', 'outsider']) await register(name, invite.code)
  let project = await expect('/api/management/projects', post({ name: '自动需求分派隔离测试', mutationId: 'dispatch-project' }), 201)
  route = `/api/management/projects/${project.id}`
  project = await expect(`${route}/roles`, post({ name: '程序开发', description: '修复程序故障、登录报错、软件功能开发', memberIds: [users.alice.id, users.bob.id, users.viewer.id, users.outsider.id] }), 201)
  const dev = project.roles[0].id
  project = await expect(`${route}/roles`, post({ name: '视觉设计', description: '界面设计、颜色、图标和美术资源制作', memberIds: [users.root.id] }), 201)
  const design = project.roles[1].id
  project = await expect(route, { method: 'PATCH', body: { members: [{ userId: users.alice.id, permission: 'edit' },
    { userId: users.bob.id, permission: 'edit' }, { userId: users.viewer.id, permission: 'view' }] } })
  project = await expect(`${route}/table-setup`, post({ roles: [{ name: '程序开发', description: '修复程序故障、登录报错、软件功能开发' }],
    tableConfig: { configured: true, customFields: [{ id: 'points', name: '工作量', type: 'number', required: true },
      { id: 'technicalNotes', name: '技术处理记录', type: 'text', roleId: dev }] } }))
  for (const handler of ['alice', 'alice', 'bob']) await expect(`${route}/events`, post({ title: `已有${handler}工作`, roleId: dev,
    assigneeId: users[handler].id, values: { points: 1 }, status: 'doing' }), 201)
  wantedRole = dev
  await check('authentication, editor rights, origin, and server-owned assignment are enforced before inference', async () => {
    const before = calls
    for (const user of ['', 'viewer', 'outsider']) await expect(`${route}/intake`, post(intake(), user), user ? 403 : 401)
    await expect(`${route}/intake`, { ...post(intake()), headers: { Origin: 'https://other.example' } }, 403)
    await expect(`${route}/intake`, post(intake({ roleId: dev })), 400)
    await expect(`${route}/intake`, post(intake({ values: { points: 'invalid' } })), 400)
    await expect(`${route}/intake`, post(intake({ values: { technicalNotes: '处理人后续补充' } })), 400)
    await expect(`${route}/roles/${dev}`, { method: 'PATCH', body: { description: 'x'.repeat(501) } }, 400)
    await expect(`${route}/intake`, post({ title: 'missing operation' }), 400)
    assert.equal(calls, before)
    await expect(`${route}/events`, post({ title: 'normal events retain required field contract' }), 400)
  })
  await check('role is internal and handler is least-loaded eligible editor; complete requirement is stored', async () => {
    const body = intake({ description: '登录出错。' + '完整需求内容。'.repeat(1000) })
    const result = await expect(`${route}/intake`, post(body, 'alice'), 201), event = result.events.at(-1)
    assert.equal(event.id, `event_${body.mutationId}`); assert.equal(event.roleId, dev); assert.equal(event.assigneeId, users.bob.id)
    assert.equal(event.description, body.description); assert.equal(event.status, 'todo'); assert.equal(event.dispatch.status, 'assigned')
    assert.equal(event.dispatch.model, 'bge-small-zh-v1.5'); assert.ok(event.dispatch.assignedAt > 0)
    assert.ok(Array.from(latest.state).length <= 96); assert.ok(Object.values(latest.questions[0].options).every(value => Array.from(value).length <= 96))
    assert.ok(latest.questions[0].options[dev].includes('修复程序故障'))
    for (const user of Object.values(users)) assert.ok(!JSON.stringify(latest).includes(user.id))
    const before = calls, history = result.history.length
    const replay = await expect(`${route}/intake`, post({ ...body, expectedRevision: 1 }, 'alice'), 201)
    assert.equal(calls, before); assert.equal(replay.events.length, result.events.length); assert.equal(replay.history.length, history)
    await expect(`${route}/intake`, post({ ...body, title: 'changed replay' }, 'alice'), 409)
    assert.equal((await expect('/api/management/notifications', { user: 'bob' })).length, 0)
  })
  await check('fresh workloads decide assignee while inference stays outside the dataset lock', async () => {
    callback = async () => {
      await expect(`${route}/events`, post({ title: '模型计算期间新工作', roleId: dev, assigneeId: users.bob.id, values: { points: 2 } }), 201)
    }
    const result = await expect(`${route}/intake`, post(intake()), 201)
    assert.equal(result.events.at(-1).assigneeId, users.alice.id)
  })
  await check('ambiguous, unrelated, wrong, and oversized model outputs persist pending without guessing', async () => {
    for (const value of ['ambiguous', 'unrelated', 'weak', 'wrong-model', 'bad-values', 'large', 'cooling']) {
      mode = value
      const result = await expect(`${route}/intake`, post(intake()), 201), event = result.events.at(-1)
      assert.equal(event.dispatch.status, 'pending', value); assert.equal(event.roleId, ''); assert.equal(event.assigneeId, '')
      assert.equal(event.dispatch.assignedAt, undefined); assert.ok(event.dispatch.reason.length > 5)
    }
    mode = 'valid'
  })
  await check('role responsibilities changing mid-inference cannot commit stale assignment', async () => {
    callback = async () => { await expect(`${route}/roles/${dev}`, { method: 'PATCH', body: { description: '新的开发职责内容' } }) }
    const result = await expect(`${route}/intake`, post(intake()), 201), event = result.events.at(-1)
    assert.equal(event.dispatch.status, 'pending'); assert.equal(event.roleId, ''); assert.match(event.dispatch.reason, /配置已变更/)
  })
  await check('revoked requester cannot save after inference and project reads remain responsive', async () => {
    const before = (await expect(route)).events.length
    callback = async () => { await expect(route, { method: 'PATCH', body: { members: [{ userId: users.bob.id, permission: 'edit' }, { userId: users.viewer.id, permission: 'view' }] } }) }
    await expect(`${route}/intake`, post(intake(), 'alice'), 403)
    assert.equal((await expect(route)).events.length, before)
  })
  await check('cancelled client closes model request and saves no event; retry is safe', async () => {
    const before = (await expect(route)).events.length, body = intake(), controller = new AbortController()
    mode = 'cancel'; upstreamCancelled = false
    const observed = new Promise(resolve => { modelSeen = resolve })
    const pending = request(`${route}/intake`, { ...post(body), signal: controller.signal }).catch(error => error)
    await observed; controller.abort(); await pending
    for (let attempt = 0; attempt < 40 && !upstreamCancelled; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(upstreamCancelled, true); mode = 'valid'; modelSeen = undefined
    assert.equal((await expect(route)).events.length, before)
    const result = await expect(`${route}/intake`, post(body), 201); assert.equal(result.events.length, before + 1)
  })
  await check('model timeout saves pending within bounded time and aborts upstream', async () => {
    mode = 'timeout'; upstreamCancelled = false
    const started = Date.now(), result = await expect(`${route}/intake`, post(intake()), 201)
    assert.equal(result.events.at(-1).dispatch.status, 'pending'); assert.match(result.events.at(-1).dispatch.reason, /5秒/)
    assert.ok(Date.now() - started < 7000)
    mode = 'valid'
  })
  await check('failed durable write creates no receipt or event; restart and retry save one', async () => {
    const before = await expect(route), body = intake()
    await failSync(); await expect(`${route}/intake`, post(body), 500)
    assert.deepEqual(await expect(route), before)
    await stop(); await start()
    const result = await expect(`${route}/intake`, post(body), 201)
    assert.equal(result.events.length, before.events.length + 1)
    const replay = await expect(`${route}/intake`, post(body), 201)
    assert.equal(replay.events.length, result.events.length)
  })
  await check('missing setup saves pending and one eligible role assigns deterministically without model', async () => {
    const empty = await expect('/api/management/projects', post({ name: '未设置岗位' }), 201), emptyRoute = `/api/management/projects/${empty.id}`
    const before = calls
    const pending = await expect(`${emptyRoute}/intake`, post(intake()), 201)
    assert.equal(pending.events[0].dispatch.status, 'pending'); assert.match(pending.events[0].dispatch.reason, /尚未设置/)
    await expect(`${emptyRoute}/roles`, post({ name: '唯一角色', memberIds: [users.root.id] }), 201)
    const assigned = await expect(`${emptyRoute}/intake`, post(intake()), 201)
    assert.equal(assigned.events.at(-1).assigneeId, users.root.id); assert.equal(assigned.events.at(-1).dispatch.status, 'assigned')
    assert.equal(calls, before)
  })
  await check('more than sixteen eligible roles remain pending without partial comparison', async () => {
    const many = await expect('/api/management/projects', post({ name: '多岗位' }), 201), manyRoute = `/api/management/projects/${many.id}`
    await expect(`${manyRoute}/table-setup`, post({ roles: Array.from({ length: 17 }, (_, i) => ({ name: `岗位${i}`, description: `职责${i}`, memberIds: [users.root.id] })) }))
    const before = calls, result = await expect(`${manyRoute}/intake`, post(intake()), 201)
    assert.equal(result.events.at(-1).dispatch.status, 'pending'); assert.match(result.events.at(-1).dispatch.reason, /16/); assert.equal(calls, before)
  })
  await check('manual follow-up can fill business fields and update recorded assignment provenance', async () => {
    const project = await expect(route), event = project.events.find(event => event.dispatch?.status === 'pending')
    const result = await expect(`${route}/events/${event.id}`, { method: 'PATCH', body: { roleId: design, assigneeId: users.root.id, values: { points: 3 } } })
    const edited = result.events.find(item => item.id === event.id)
    assert.equal(edited.dispatch.status, 'assigned'); assert.match(edited.dispatch.reason, /编辑者调整/)
    const cleared = await expect(`${route}/events/${event.id}`, { method: 'PATCH', body: { assigneeId: '', assignee: '' } })
    const unassigned = cleared.events.find(item => item.id === event.id)
    assert.equal(unassigned.dispatch.status, 'pending'); assert.equal(unassigned.dispatch.assignedAt, undefined)
    assert.equal(unassigned.roleId, design, 'manual role selection remains available while the handler is being chosen')
  })
  await check('concurrent identical retries preserve successful assignment and one durable event', async () => {
    const body = intake(), before = await expect(route), callCount = calls
    callback = async () => { await new Promise(resolve => setTimeout(resolve, 100)) }
    const [first, second] = await Promise.all([expect(`${route}/intake`, post(body), 201), expect(`${route}/intake`, post(body), 201)])
    assert.equal(calls, callCount + 1)
    assert.equal(first.events.length, before.events.length + 1); assert.equal(second.events.length, first.events.length)
    assert.equal(first.events.at(-1).dispatch.status, 'assigned'); assert.deepEqual(second.events.at(-1), first.events.at(-1))
  })
  await check('a handler account deleted during inference cannot receive the saved task', async () => {
    callback = async () => { await expect(`/api/admin/users/${users.bob.id}`, { method: 'DELETE' }) }
    const result = await expect(`${route}/intake`, post(intake()), 201), event = result.events.at(-1)
    assert.equal(event.dispatch.status, 'pending'); assert.equal(event.assigneeId, ''); assert.equal(event.roleId, '')
    assert.match(event.dispatch.reason, /配置已变更/)
  })
  console.log(JSON.stringify({ status: 'PASS_MANAGEMENT_DISPATCH', cases: count, authenticatedHttp: true, durableStorage: true, emailSent: false, isolatedRuntime: true }))
} finally {
  await stop(); model.closeAllConnections(); model.close(); await fs.rm(runtime, { recursive: true, force: true })
}
