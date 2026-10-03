import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Independent HTTP acceptance. Every account, token, asset and project belongs
// to this disposable console-auth fixture; no production phone/data is used.
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-management-access-'))
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const fixture = option('--fixture') ? path.resolve(option('--fixture')) : path.join(runtime, 'fixture.cjs')
const tag = randomBytes(5).toString('hex')
const adminEmail = `management-admin-${tag}@example.com`
let server, port
const users = {}
const cases = []

if (!option('--fixture')) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')],
    bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}

async function start() {
  server = spawn(process.execPath, [fixture], {
    env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: adminEmail,
      FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_GUEST_MODE: '0', FLOWBOARD_TUNNEL_NOTIFY: 'false',
      FLOWBOARD_PUBLIC_HOST: 'draw.example.com', FLOWBOARD_PUBLIC_PROTOCOL: 'https' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let errors = ''
  server.stderr.on('data', part => { errors = (errors + part.toString()).slice(-8000) })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Management fixture startup timeout: ${errors}`)), 10000)
    server.once('error', error => { clearTimeout(timer); reject(error) })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Management fixture exited ${code}: ${errors}`)) })
    server.once('message', message => { clearTimeout(timer); resolve(message.port) })
  })
}

async function stop() {
  if (!server || server.exitCode !== null) return
  const done = once(server, 'exit')
  server.kill('SIGKILL')
  await done
}

async function command(command, value) {
  const id = randomBytes(6).toString('hex')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.off('message', listener); reject(new Error('Fixture command timeout')) }, 10000)
    const listener = message => {
      if (message.id === id) { clearTimeout(timer); server.off('message', listener); resolve() }
    }
    server.on('message', listener)
    server.send({ id, command, value })
  })
}

async function request(route, { method = 'GET', body, user, headers = {} } = {}) {
  assert.ok(route.startsWith('/') && !route.startsWith('//'), 'fixture requests stay on loopback')
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Cookie: users[user].cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  const text = bytes.toString('utf8')
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, text, bytes, headers: response.headers,
    cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

async function expectStatus(route, options, status) {
  const response = await request(route, options)
  assert.equal(response.status, status, `${options?.method || 'GET'} ${route}: ${JSON.stringify(response.data)}`)
  return response
}

async function register(name, email, inviteCode) {
  const password = randomBytes(20).toString('hex')
  const sent = await expectStatus('/api/auth/send-code', { method: 'POST', body: { email, inviteCode } }, 200)
  const registered = await expectStatus('/api/auth/register', {
    method: 'POST', body: { email, password, inviteCode, code: sent.data.developmentCode },
  }, 201)
  assert.ok(registered.cookie)
  users[name] = { email, password, cookie: registered.cookie }
  return (await expectStatus('/api/auth/me', { user: name }, 200)).data.user
}

async function caseTest(label, action) {
  await action()
  cases.push(label)
  console.log(`PASS: management access ${label}`)
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XsAAAAASUVORK5CYII=', 'base64')
const routeOf = url => new URL(url).pathname + new URL(url).search
const nativeCanvas = {
  version: 3, order: ['nested'], groups: { nested: { id: 'nested', childIds: ['label'], visible: true, collapsed: false } },
  workspace: { x: -21, y: 7, w: 1200, h: 800 }, backgroundColor: '#fafafa', gridSize: 20,
  shapes: { label: { id: 'label', type: 'text', name: 'Original', x: 12.75, y: -8, w: 223, h: 51,
    rotation: 19, fill: '#abcdef', stroke: '#123456', strokeWidth: 2, opacity: 0.75,
    text: 'Exact native text <safe> 😄', fontSize: 27, fontFamily: 'ExampleFont', fontWeight: 'bold',
    textColor: '#654321', textAlign: 'left', visible: true, locked: false } },
}
function readonlyHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'none'"))
}

try {
  await start()
  await register('admin', adminEmail)
  const invitation = (await expectStatus('/api/admin/invites', {
    method: 'POST', user: 'admin', body: { maxUses: 2 },
  }, 201)).data.code
  const alice = await register('alice', `management-alice-${tag}@example.com`, invitation)
  const bob = await register('bob', `management-bob-${tag}@example.com`, invitation)
  assert.equal(alice.isAdmin, false)
  assert.equal(bob.isAdmin, false)
  await caseTest('authenticated ordinary owner fixtures', async () => {
    await expectStatus('/api/management/projects', {}, 401)
    assert.deepEqual((await expectStatus('/api/management/projects', { user: 'alice' }, 200)).data, [])
    assert.deepEqual((await expectStatus('/api/management/projects', { user: 'bob' }, 200)).data, [])
  })
  const canvasA = `access_canvas_a_${tag}`, canvasA2 = `access_canvas_a2_${tag}`, canvasB = `access_canvas_b_${tag}`
  for (const [id, owner] of [[canvasA, 'alice'], [canvasA2, 'alice'], [canvasB, 'bob']]) {
    await expectStatus(`/api/projects/${id}`, { method: 'PUT', user: owner,
      body: { id, title: owner === 'bob' ? 'BOB_PRIVATE_CANVAS_SECRET' : id, canvas: nativeCanvas } }, 200)
  }
  let aliceProject = (await expectStatus('/api/management/projects', { method: 'POST', user: 'alice',
    body: { name: 'Ordinary Alice workspace', canvasIds: [canvasA, canvasA2] } }, 201)).data
  const bobProject = (await expectStatus('/api/management/projects', { method: 'POST', user: 'bob',
    body: { name: 'BOB_PRIVATE_MANAGEMENT_SECRET', canvasIds: [canvasB] } }, 201)).data
  const projectPath = `/api/management/projects/${aliceProject.id}`
  await caseTest('ordinary owner isolation and forged associations', async () => {
    assert.deepEqual((await expectStatus('/api/management/projects', { user: 'alice' }, 200)).data.map(row => row.id), [aliceProject.id])
    assert.deepEqual((await expectStatus('/api/management/projects', { user: 'bob' }, 200)).data.map(row => row.id), [bobProject.id])
    for (const suffix of ['', '/events', '/history', '/stats']) {
      const denied = await expectStatus(projectPath + suffix, { user: 'bob' }, 403)
      assert.equal(denied.text.includes('Ordinary Alice workspace'), false)
    }
    await expectStatus(projectPath, { method: 'PATCH', user: 'bob', body: { name: 'FORGED' } }, 403)
    await expectStatus(projectPath, { method: 'PATCH', user: 'alice', body: { canvasIds: [canvasB] } }, 403)
    await expectStatus('/api/ai-shares', { method: 'POST', user: 'bob', body: { kind: 'management', resourceId: aliceProject.id } }, 403)
    await expectStatus('/api/ai-shares', { method: 'POST', user: 'bob', body: { kind: 'canvas', resourceId: canvasA } }, 403)
    await expectStatus('/api/ai-shares', { method: 'POST', user: 'alice', body: {
      kind: 'management', resourceId: aliceProject.id, scope: { canvasIds: [canvasB] },
    } }, 403)
  })
  const attachment = (await expectStatus(projectPath + '/assets', { method: 'POST', user: 'alice',
    body: { name: 'private-pixel.png', dataUrl: `data:image/png;base64,${png.toString('base64')}` } }, 201)).data
  aliceProject = (await expectStatus(projectPath + '/events', { method: 'POST', user: 'alice', body: {
    title: 'SELECTED_EVENT', description: 'Chosen event text', status: 'todo', attachments: [{ id: attachment.id }],
  } }, 201)).data
  const selectedEvent = aliceProject.events.find(event => event.title === 'SELECTED_EVENT')
  aliceProject = (await expectStatus(projectPath + '/events', { method: 'POST', user: 'alice',
    body: { title: 'UNSELECTED_EVENT_SECRET', status: 'doing' } }, 201)).data
  const hiddenEvent = aliceProject.events.find(event => event.title === 'UNSELECTED_EVENT_SECRET')
  const share = (await expectStatus('/api/ai-shares', { method: 'POST', user: 'alice', body: {
    kind: 'management', resourceId: aliceProject.id,
    scope: { eventIds: [selectedEvent.id], canvasIds: [canvasA], includeHistory: true, includeStats: true, includeAttachments: true, includePreview: true },
  } }, 201)).data
  const aiPath = routeOf(share.url)
  let publicAssetPath
  await caseTest('capability scope, opaque assets and read-only exports', async () => {
    const json = await expectStatus(aiPath + '/data.json', {}, 200)
    readonlyHeaders(json)
    assert.ok(json.headers.get('content-type')?.includes('application/json'))
    assert.deepEqual(json.data.events.map(event => event.id), [selectedEvent.id])
    assert.deepEqual(json.data.canvases.map(canvas => canvas.id), [canvasA])
    assert.equal(json.data.stats.total, 1)
    assert.equal(json.text.includes('UNSELECTED_EVENT_SECRET'), false)
    assert.equal(json.text.includes('BOB_PRIVATE_'), false)
    assert.equal(json.text.includes(attachment.url), false)
    assert.equal(json.data.events[0].attachments.length, 1)
    assert.notEqual(json.data.events[0].attachments[0].id, attachment.id)
    publicAssetPath = routeOf(json.data.events[0].attachments[0].url)
    await expectStatus(attachment.url, {}, 401)
    await expectStatus(attachment.url, { user: 'bob' }, 403)
    assert.deepEqual((await expectStatus(attachment.url, { user: 'alice' }, 200)).bytes, png)
    assert.deepEqual((await expectStatus(publicAssetPath, {}, 200)).bytes, png)
    await expectStatus(aiPath + '/assets/' + '0'.repeat(32), {}, 404)
    await expectStatus(aiPath + `/canvases/${canvasA2}.json`, {}, 404)
    await expectStatus(aiPath + `/canvases/${canvasB}.json`, {}, 404)
    assert.deepEqual((await expectStatus(aiPath + `/canvases/${canvasA}.json`, {}, 200)).data, nativeCanvas)
    const md = await expectStatus(aiPath, {}, 200)
    readonlyHeaders(md)
    assert.ok(md.headers.get('content-type')?.startsWith('text/markdown'))
    assert.equal(md.text.includes('<script'), false)
    const svg = await expectStatus(aiPath + `/canvases/${canvasA}/preview.svg`, {}, 200)
    readonlyHeaders(svg)
    assert.ok(svg.headers.get('content-type')?.startsWith('image/svg+xml'))
    assert.ok(svg.text.includes('ExampleFont') && svg.text.includes('&lt;safe&gt;'))
    assert.equal(svg.text.includes('<script'), false)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expectStatus(aiPath, { method, body: { name: 'ILLEGAL_WRITE' } }, 405)
      await expectStatus(aiPath + '/data.json', { method, body: {} }, 405)
    }
    const head = await expectStatus(aiPath, { method: 'HEAD' }, 200)
    assert.equal(head.bytes.length, 0)
    const forged = share.token.slice(0, -1) + (share.token.endsWith('A') ? 'B' : 'A')
    await expectStatus(`/ai/${forged}/data.json`, {}, 404)
    await expectStatus('/api/management/projects', { headers: { 'X-FlowBoard-Share-Token': share.token } }, 401)
    assert.deepEqual((await expectStatus(`/api/ai-shares?kind=management&resourceId=${aliceProject.id}`, { user: 'bob' }, 200)).data, [])
    await expectStatus(`/api/ai-shares/${share.id}`, { method: 'DELETE', user: 'bob' }, 404)
  })
  await caseTest('explicit empty/disabled scope and foreign event rejection', async () => {
    await expectStatus('/api/ai-shares', { method: 'POST', user: 'alice', body: {
      kind: 'management', resourceId: aliceProject.id, scope: { eventIds: ['not_an_event'] },
    } }, 400)
    const empty = (await expectStatus('/api/ai-shares', { method: 'POST', user: 'alice', body: {
      kind: 'management', resourceId: aliceProject.id,
      scope: { eventIds: [], canvasIds: [], includeHistory: false, includeStats: false, includeAttachments: false, includePreview: false },
    } }, 201)).data
    const data = (await expectStatus(routeOf(empty.jsonUrl), {}, 200)).data
    assert.deepEqual(data.events, [])
    assert.deepEqual(data.canvases, [])
    assert.deepEqual(data.assets, [])
    assert.equal(data.history, undefined)
    assert.equal(data.stats, undefined)
    await expectStatus(routeOf(empty.url) + `/canvases/${canvasA}.json`, {}, 404)
    await expectStatus(routeOf(empty.url) + '/assets/' + publicAssetPath.split('/').at(-1), {}, 404)
  })
  await caseTest('ordinary owner idempotency and concurrent optimistic patches', async () => {
    const before = (await expectStatus(projectPath, { user: 'alice' }, 200)).data
    const body = { title: 'IDEMPOTENT_OWNER_EVENT', mutationId: `access_mutation_${tag}`, revision: before.revision }
    const results = await Promise.all([request(projectPath + '/events', { method: 'POST', user: 'alice', body }),
      request(projectPath + '/events', { method: 'POST', user: 'alice', body })])
    assert.deepEqual(results.map(result => result.status), [201, 201])
    const after = (await expectStatus(projectPath, { user: 'alice' }, 200)).data
    assert.equal(after.events.filter(event => event.title === body.title).length, 1)
    assert.equal(after.history.length, before.history.length + 1)
    assert.equal(after.revision, before.revision + 1)
    await expectStatus(projectPath + '/events', { method: 'POST', user: 'alice', body: { ...body, title: 'CHANGED_PAYLOAD' } }, 409)
    const competing = await Promise.all([
      request(projectPath + '/events/' + selectedEvent.id, { method: 'PATCH', user: 'alice', body: { title: 'CONCURRENT_A', revision: after.revision } }),
      request(projectPath + '/events/' + hiddenEvent.id, { method: 'PATCH', user: 'alice', body: { title: 'CONCURRENT_B', revision: after.revision } }),
    ])
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409])
    const both = await Promise.all([
      request(projectPath + '/events/' + selectedEvent.id, { method: 'PATCH', user: 'alice', body: { assignee: 'Parallel A' } }),
      request(projectPath + '/events/' + hiddenEvent.id, { method: 'PATCH', user: 'alice', body: { assignee: 'Parallel B' } }),
    ])
    assert.ok(both.every(result => result.status === 200))
    const saved = (await expectStatus(projectPath, { user: 'alice' }, 200)).data
    assert.equal(saved.events.find(event => event.id === selectedEvent.id).assignee, 'Parallel A')
    assert.equal(saved.events.find(event => event.id === hiddenEvent.id).assignee, 'Parallel B')
  })
  await caseTest('revocation survives abrupt restart', async () => {
    await expectStatus(`/api/ai-shares/${share.id}`, { method: 'DELETE', user: 'alice' }, 200)
    await expectStatus(aiPath + '/data.json', {}, 404)
    await expectStatus(publicAssetPath, {}, 404)
    await stop(); await start()
    await expectStatus(aiPath + '/data.json', { user: 'alice' }, 404)
    await expectStatus(publicAssetPath, {}, 404)
    assert.equal((await expectStatus('/api/auth/me', { user: 'alice' }, 200)).data.user.id, alice.id)
    const saved = (await expectStatus(projectPath, { user: 'alice' }, 200)).data
    assert.equal(saved.events.find(event => event.id === selectedEvent.id).assignee, 'Parallel A')
    assert.equal(saved.events.find(event => event.id === hiddenEvent.id).assignee, 'Parallel B')
  })
  await caseTest('deleted resources and deleted owners invalidate old capabilities', async () => {
    const canvasShare = (await expectStatus('/api/ai-shares', { method: 'POST', user: 'alice',
      body: { kind: 'canvas', resourceId: canvasA2 } }, 201)).data
    await expectStatus(routeOf(canvasShare.jsonUrl), {}, 200)
    await expectStatus(`/api/projects/${canvasA2}`, { method: 'DELETE', user: 'alice' }, 200)
    await expectStatus(routeOf(canvasShare.jsonUrl), {}, 404)
    const bobShare = (await expectStatus('/api/ai-shares', { method: 'POST', user: 'bob',
      body: { kind: 'management', resourceId: bobProject.id } }, 201)).data
    await expectStatus(routeOf(bobShare.jsonUrl), {}, 200)
    await expectStatus(`/api/admin/users/${bob.id}`, { method: 'DELETE', user: 'admin' }, 200)
    await expectStatus(routeOf(bobShare.jsonUrl), {}, 404)
    await expectStatus(`/api/management/projects/${bobProject.id}`, { user: 'bob' }, 401)
    const doomed = (await expectStatus('/api/management/projects', { method: 'POST', user: 'alice', body: { name: 'Disposable deletion scope' } }, 201)).data
    const doomedShare = (await expectStatus('/api/ai-shares', { method: 'POST', user: 'alice', body: { kind: 'management', resourceId: doomed.id } }, 201)).data
    await expectStatus(`/api/management/projects/${doomed.id}`, { method: 'DELETE', user: 'alice' }, 200)
    await expectStatus(routeOf(doomedShare.jsonUrl), {}, 404)
  })
  console.log(`Management access cases completed: ${cases.length}`)
} finally {
  await stop()
  const safeRoot = path.resolve(os.tmpdir())
  assert.ok(path.resolve(runtime).startsWith(safeRoot + path.sep), 'only remove this verified disposable fixture')
  await fs.rm(runtime, { recursive: true, force: true })
}
