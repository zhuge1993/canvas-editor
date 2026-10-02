import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1] }
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-delete-example-'))
const fixture = option('--fixture') ? path.resolve(option('--fixture')) : path.join(runtime, 'fixture.cjs')
if (!option('--fixture')) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}
const users = {}, streams = [], checks = [], password = 'Isolated-delete-example-42'
let server, port
async function start() {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime,
    FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'delete-root@example.test', FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_GUEST_MODE: '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  server.stderr.on('data', data => { errors = (errors + data.toString()).slice(-8000) })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${errors}`)), 15000)
    server.once('message', data => { clearTimeout(timer); resolve(data.port) })
    server.once('error', error => { clearTimeout(timer); reject(error) })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${errors}`)) })
  })
}
async function stop() {
  for (const stream of streams) stream.abort.abort()
  if (!server || server.exitCode !== null) return
  const done = once(server, 'exit'); server.kill('SIGKILL'); await done
}
async function request(route, user = 'alice', method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
    headers: { 'Content-Type': 'application/json', ...(users[user]?.cookie ? { Cookie: users[user].cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const bytes = Buffer.from(await response.arrayBuffer())
  let data; try { data = JSON.parse(bytes.toString('utf8')) } catch { data = bytes }
  if (response.headers.get('set-cookie') && users[user]) users[user].cookie = response.headers.get('set-cookie').split(';')[0]
  return { status: response.status, data }
}
async function expect(route, user = 'alice', method = 'GET', body, status = 200) {
  const response = await request(route, user, method, body)
  assert.equal(response.status, status, `${method} ${route.replace(/[A-Za-z0-9_-]{43}/g, '[token]')}: ${JSON.stringify(response.data).slice(0, 1000)}`)
  return response.data
}
async function register(name, inviteCode) {
  const email = `${name === 'root' ? 'delete-root' : name + '-delete-example'}@example.test`
  users[name] = { email, cookie: '' }
  const code = await expect('/api/auth/send-code', name, 'POST', { email, inviteCode })
  const result = await expect('/api/auth/register', name, 'POST', { email, password, inviteCode, code: code.developmentCode }, 201)
  users[name].id = result.user.id
}
async function login(name) { await expect('/api/auth/login', name, 'POST', { email: users[name].email, password }) }
async function failSync(file) {
  const id = `sync_${Date.now()}`
  await new Promise(resolve => { const listener = data => { if (data.id === id) { server.off('message', listener); resolve() } }; server.on('message', listener); server.send({ id, command: file ? 'fail-sync-file' : 'fail-next-sync', ...(file ? { value: file } : {}) }) })
}
async function openLive(route) {
  const abort = new AbortController(), response = await fetch(`http://127.0.0.1:${port}${route}/live?clientId=delete-test`,
    { headers: { Cookie: users.alice.cookie }, signal: abort.signal })
  assert.equal(response.status, 200)
  const stream = { abort, ended: false }; streams.push(stream)
  void (async () => { try { for await (const _chunk of response.body) { /* drain */ } } catch { /* closed on cleanup */ } finally { stream.ended = true } })()
  return stream
}
async function until(predicate, message) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline && !predicate()) await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(predicate(), message)
}
async function exists(file) { return fs.access(file).then(() => true, () => false) }
function pass(name) { checks.push(name); console.log(`PASS: ${name}`) }

try {
  await start(); await register('root')
  const siteInvite = await expect('/api/admin/invites', 'root', 'POST', { maxUses: 2 }, 201)
  await register('alice', siteInvite.code); await register('bob', siteInvite.code)
  await failSync(); await expect('/api/management/projects/example', 'alice', 'POST', { mutationId: 'example_once' }, 500)
  assert.equal((await expect('/api/management/projects')).filter(project => project.isExample).length, 0)
  const started = Date.now()
  const concurrentSamples = await Promise.all([1, 2].map(() => expect('/api/management/projects/example', 'alice', 'POST', { mutationId: 'example_once' }, 201)))
  let sample = concurrentSamples[0]
  assert.equal(concurrentSamples[1].id, sample.id)
  const sampleRoute = `/api/management/projects/${sample.id}`
  assert.equal(sample.ownerId, users.alice.id); assert.equal(sample.isExample, true); assert.equal(sample.guideVersion, 1)
  assert.ok(sample.createdAt >= started && sample.createdAt <= Date.now())
  assert.equal(sample.tableConfig.configured, true); assert.equal(sample.roles.length, 3); assert.equal(sample.categories.length, 3)
  assert.deepEqual(sample.tableConfig.customFields.map(field => field.type).sort(), ['checkbox', 'date', 'number', 'select', 'text'])
  const statuses = ['todo', 'doing', 'review', 'rejected', 'ready', 'released', 'done', 'blocked', 'on_hold', 'cancelled']
  assert.deepEqual(sample.events.map(event => event.status).sort(), [...statuses].sort())
  assert.equal(sample.canvasIds.length, 0); assert.equal(sample.members.length, 0)
  assert.ok(sample.events.every(event => event.attachments.length === 0 && (event.recipientIds?.length ?? 0) === 0))
  assert.ok(sample.history.every(entry => entry.action === 'example.seed' && entry.at >= started && entry.actorId === users.alice.id))
  assert.equal((await expect('/api/management/notifications', 'bob')).length, 0)
  const sampleStats = await expect(`${sampleRoute}/stats`)
  assert.equal(sampleStats.total, 10); assert.equal(sampleStats.activeTotal, 9); assert.equal(sampleStats.cancelled, 1)
  assert.ok(sampleStats.byStatus.every(stage => stage.count === 1))
  const shanghaiDay = value => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
    const part = name => parts.find(value => value.type === name).value
    return `${part('year')}-${part('month')}-${part('day')}`
  }
  assert.equal(sampleStats.today, shanghaiDay(Date.now()))
  assert.equal(sampleStats.newToday, sample.events.filter(event => shanghaiDay(event.createdAt) === sampleStats.today).length)
  assert.equal(sampleStats.completedToday, sample.events.filter(event => event.completedAt !== undefined && shanghaiDay(event.completedAt) === sampleStats.today).length)
  sample = await expect(sampleRoute, 'alice', 'PATCH', { name: 'Edited stored example', revision: sample.revision })
  const eventId = sample.events[0].id
  sample = await expect(`${sampleRoute}/events/${eventId}`, 'alice', 'PATCH', { title: 'Edited persistent sample event', revision: sample.revision })
  const repeatSample = await expect('/api/management/projects/example', 'alice', 'POST', {}, 201)
  assert.equal(repeatSample.id, sample.id); assert.equal(repeatSample.name, 'Edited stored example')
  assert.equal(repeatSample.events.find(event => event.id === eventId).title, 'Edited persistent sample event')
  assert.equal((await expect('/api/management/projects')).filter(project => project.isExample).length, 1)
  const bobSample = await expect('/api/management/projects/example', 'bob', 'POST', {}, 201)
  assert.equal(bobSample.ownerId, users.bob.id); assert.notEqual(bobSample.id, sample.id)
  assert.ok(bobSample.events.every(event => !sample.events.some(other => other.id === event.id)))
  await expect(sampleRoute, 'bob', 'GET', undefined, 403)
  pass('stored editable owner-only example; all ten stages and five field types; server-date statistics; idempotent refresh and isolated second owner')

  const survivor = await expect('/api/management/projects', 'alice', 'POST', { name: 'Keep this project' }, 201)
  const survivorRoute = `/api/management/projects/${survivor.id}`
  const survivorAsset = await expect(`${survivorRoute}/assets`, 'alice', 'POST', { name: 'keep.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('preserved unrelated attachment').toString('base64') }, 201)
  const survivorWithEvent = await expect(`${survivorRoute}/events`, 'alice', 'POST', { title: 'Keep this notification', attachments: [{ id: survivorAsset.id }] }, 201)
  await expect(`${survivorRoute}/events/${survivorWithEvent.events[0].id}/notify`, 'alice', 'POST', { recipientIds: [users.bob.id], mutationId: 'survivor_notice' })
  const survivorInvite = await expect(`${survivorRoute}/invites`, 'alice', 'POST', { permission: 'view', roleIds: [], maxUses: 3 }, 201)
  let doomed = await expect('/api/management/projects', 'alice', 'POST', { name: 'Direct deletion disposable project' }, 201)
  const route = `/api/management/projects/${doomed.id}`
  await expect('/api/projects/kept_canvas', 'alice', 'PUT', { id: 'kept_canvas', title: 'Independent linked canvas', canvas: { version: 3, shapes: {}, groups: {}, order: [] } })
  const canvasShare = await expect('/api/ai-shares', 'alice', 'POST', { kind: 'canvas', resourceId: 'kept_canvas' }, 201)
  doomed = await expect(route, 'alice', 'PATCH', { canvasIds: ['kept_canvas'], members: [{ userId: users.bob.id, permission: 'edit' }], revision: doomed.revision })
  const asset = await expect(`${route}/assets`, 'alice', 'POST', { name: 'private.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('isolated project attachment').toString('base64') }, 201)
  doomed = await expect(`${route}/events`, 'alice', 'POST', { title: 'Delete selected issue', attachments: [{ id: asset.id }], revision: doomed.revision }, 201)
  const issue = doomed.events[0]
  await expect(`${route}/events/${issue.id}/notify`, 'alice', 'POST', { recipientIds: [users.bob.id], mutationId: 'doomed_notice', revision: doomed.revision })
  const invite = await expect(`${route}/invites`, 'alice', 'POST', { permission: 'view', roleIds: [], maxUses: 3 }, 201)
  const share = await expect('/api/ai-shares', 'alice', 'POST', { kind: 'management', resourceId: doomed.id, scope: { eventIds: [issue.id], includeAttachments: true } }, 201)
  await expect(route, 'bob', 'DELETE', {}, 403)
  await expect(route, 'root', 'DELETE', {}, 403)
  await expect(asset.url)
  await failSync(); await expect(route, 'alice', 'DELETE', { mutationId: 'hard_delete_once', revision: doomed.revision }, 500)
  assert.equal((await expect(route)).revision, doomed.revision)
  await expect(`/ai/${share.token}/data.json`, 'anonymous')
  await expect(`/api/management/invites/${invite.token}`, 'bob')
  assert.equal((await expect('/api/management/notifications', 'bob')).filter(note => note.projectId === doomed.id).length, 1)
  pass('direct deletion remains creator-only; injected precommit sync failure preserves project, share, invite, attachment and notification')

  const survivorStream = await openLive(survivorRoute)
  const stream = await openLive(route)
  await expect(route, 'alice', 'DELETE', { mutationId: 'hard_delete_once', revision: doomed.revision })
  await until(() => stream.ended, 'deleted project live stream must close')
  assert.equal(survivorStream.ended, false, 'independent project live connection remains open')
  await expect(route, 'alice', 'DELETE', { mutationId: 'hard_delete_once', revision: doomed.revision })
  await expect(route, 'alice', 'GET', undefined, 404)
  await expect(asset.url, 'alice', 'GET', undefined, 404)
  await expect(`/ai/${share.token}/data.json`, 'anonymous', 'GET', undefined, 404)
  await expect(`/api/management/invites/${invite.token}`, 'bob', 'GET', undefined, 404)
  assert.equal(await exists(path.join(runtime, 'project-data', 'management', 'projects', doomed.id + '.json')), false)
  assert.equal(await exists(path.join(runtime, 'project-data', 'management-assets', doomed.id)), false)
  const notes = await expect('/api/management/notifications', 'bob')
  assert.equal(notes.filter(note => note.projectId === doomed.id).length, 0)
  assert.equal(notes.filter(note => note.projectId === survivor.id).length, 1)
  const notificationStore = JSON.parse(await fs.readFile(path.join(runtime, 'auth-data', 'management-notifications.json'), 'utf8'))
  assert.ok(notificationStore.receipts.every(receipt => receipt.projectId !== doomed.id))
  assert.equal((await expect('/api/ai-shares')).some(capability => capability.resourceId === doomed.id), false)
  assert.equal((await expect('/api/projects/kept_canvas')).title, 'Independent linked canvas')
  await expect(`/ai/${canvasShare.token}/data.json`, 'anonymous')
  assert.equal((await expect(survivorRoute)).id, survivor.id)
  assert.equal((await expect(survivorAsset.url)).toString('utf8'), 'preserved unrelated attachment')
  await expect(`/api/management/invites/${survivorInvite.token}`, 'bob')
  assert.equal((await expect(`/api/management/projects/${bobSample.id}`, 'bob')).id, bobSample.id)
  assert.equal((await expect('/api/auth/me', 'bob')).user.id, users.bob.id)
  pass('physical project/assets removal; related invitations, capabilities, inbox/receipts and live connection cleaned; independent canvas/capability, projects and users preserved')

  let interrupted = await expect('/api/management/projects', 'alice', 'POST', { name: 'Interrupted authorized deletion' }, 201)
  const interruptedRoute = `/api/management/projects/${interrupted.id}`
  const interruptedAsset = await expect(`${interruptedRoute}/assets`, 'alice', 'POST', { name: 'interrupted.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('disposable interrupted attachment').toString('base64') }, 201)
  interrupted = await expect(`${interruptedRoute}/events`, 'alice', 'POST', { title: 'Interrupted issue', attachments: [{ id: interruptedAsset.id }] }, 201)
  await expect(`${interruptedRoute}/events/${interrupted.events[0].id}/notify`, 'alice', 'POST', { recipientIds: [users.bob.id], mutationId: 'interrupted_notice' })
  const interruptedInvite = await expect(`${interruptedRoute}/invites`, 'alice', 'POST', { permission: 'view', roleIds: [] }, 201)
  const interruptedShare = await expect('/api/ai-shares', 'alice', 'POST', { kind: 'management', resourceId: interrupted.id }, 201)
  await failSync('ai-shares.json')
  await expect(interruptedRoute, 'alice', 'DELETE', { revision: interrupted.revision }, 500)
  // Inspect the isolated runtime directly: another management HTTP request
  // would recover the journal before the abrupt-restart branch is exercised.
  const pendingDirectory = path.join(runtime, 'project-data', 'management', '.deletions')
  const journalNames = (await fs.readdir(pendingDirectory)).filter(name => name.startsWith(interrupted.id + '.'))
  assert.equal(journalNames.length, 1)
  const journalDirectory = path.join(pendingDirectory, journalNames[0])
  const journal = JSON.parse(await fs.readFile(path.join(journalDirectory, 'journal.json'), 'utf8'))
  assert.equal(journal.projectId, interrupted.id); assert.equal(journal.ownerId, users.alice.id)
  assert.equal(await exists(path.join(journalDirectory, 'project.json')), true)
  assert.equal(await exists(path.join(journalDirectory, 'assets')), true)
  assert.equal(await exists(path.join(runtime, 'project-data', 'management', 'projects', interrupted.id + '.json')), false)
  assert.equal(await exists(path.join(runtime, 'project-data', 'management-assets', interrupted.id)), false)
  assert.ok(JSON.parse(await fs.readFile(path.join(runtime, 'auth-data', 'ai-shares.json'), 'utf8')).some(share => share.id === interruptedShare.id))
  await stop(); await start(); await login('alice'); await login('bob'); await login('root')
  await expect(interruptedRoute, 'alice', 'GET', undefined, 404)
  assert.equal(await exists(journalDirectory), false, 'first management request completes durable deletion and removes the private journal')
  await expect(interruptedAsset.url, 'alice', 'GET', undefined, 404)
  await expect(`/ai/${interruptedShare.token}/data.json`, 'anonymous', 'GET', undefined, 404)
  await expect(`/api/management/invites/${interruptedInvite.token}`, 'bob', 'GET', undefined, 404)
  assert.equal((await expect('/api/management/notifications', 'bob')).some(note => note.projectId === interrupted.id), false)
  assert.equal((await expect(survivorAsset.url)).toString('utf8'), 'preserved unrelated attachment')
  await expect(`/ai/${canvasShare.token}/data.json`, 'anonymous')
  pass('post-detach capability fsync failure retains a private authorized journal; SIGKILL/restart first management request finishes cleanup without resurrecting the project')

  // A kill before atomic intent rename leaves no committed authorization.
  // Recovery may discard producer-shaped preparations, never the live project.
  const preparations = [[], ['journal.json.123.abcdef123456.tmp'], ['journal.json.123.abcdef123456.tmp', 'journal.json.456.123456abcdef.tmp']]
  const preparationDirectories = []
  for (const [index, files] of preparations.entries()) {
    const directory = path.join(pendingDirectory, `${survivor.id}.${String(9 - index).repeat(24)}`)
    await fs.mkdir(directory, { mode: 0o700 })
    for (const file of files) await fs.writeFile(path.join(directory, file), '{"uncommitted":', { mode: 0o600 })
    preparationDirectories.push(directory)
  }
  await stop(); await start(); await login('alice'); await login('bob'); await login('root')
  assert.equal((await expect(survivorRoute)).id, survivor.id)
  for (const directory of preparationDirectories) assert.equal(await exists(directory), false)
  assert.equal(await exists(path.join(runtime, 'project-data', 'management', 'projects', survivor.id + '.json')), true)
  assert.equal((await expect(survivorAsset.url)).toString('utf8'), 'preserved unrelated attachment')
  await expect(`/api/management/invites/${survivorInvite.token}`, 'bob')
  pass('pre-intent SIGKILL-shaped empty/tmp-only preparations recover without deleting or hiding the original project, attachment or invitation')

  const invalidPreparations = [{ name: 'project.json', kind: 'file' }, { name: 'journal.json.badpid.abcdef123456.tmp', kind: 'file' }, { name: 'assets', kind: 'directory' }]
  if (process.platform !== 'win32') invalidPreparations.push({ name: 'journal.json.123.abcdef123456.tmp', kind: 'symlink' })
  const sentinel = path.join(runtime, 'preparation-sentinel.txt')
  await fs.writeFile(sentinel, 'do not alter', { mode: 0o600 })
  for (const [index, invalid] of invalidPreparations.entries()) {
    const directory = path.join(pendingDirectory, `${survivor.id}.${String(6 - index).repeat(24)}`)
    const leftover = path.join(directory, invalid.name)
    await fs.mkdir(directory, { mode: 0o700 })
    if (invalid.kind === 'directory') await fs.mkdir(leftover)
    else if (invalid.kind === 'symlink') await fs.symlink(sentinel, leftover)
    else await fs.writeFile(leftover, 'must not erase unknown residue', { mode: 0o600 })
    await expect(survivorRoute, 'alice', 'GET', undefined, 500)
    assert.equal(await exists(leftover), true, 'unknown or detached bytes must not be discarded without a committed journal')
    if (invalid.kind === 'symlink') assert.equal((await fs.lstat(leftover)).isSymbolicLink(), true)
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'do not alter')
    assert.equal(path.dirname(directory), pendingDirectory); assert.ok(path.basename(directory).startsWith(survivor.id + '.'))
    await fs.rm(directory, { recursive: true, force: true }) // Isolated malformed fixture only.
    assert.equal((await expect(survivorRoute)).id, survivor.id)
  }
  pass(`unknown preparation names, detached-project files and asset directories remain untouched and fail closed${process.platform === 'win32' ? '; symlink fixture is POSIX-only' : ', including symlink targets'}`)

  const backup = JSON.parse(gunzipSync(await expect('/api/admin/backup', 'root')))
  for (const corrupt of [project => { project.isExample = 'true' }, project => { project.guideVersion = -1 }]) {
    const invalid = structuredClone(backup); corrupt(invalid.management.projects[sample.id + '.json'])
    await expect('/api/admin/restore', 'root', 'POST', invalid, 400)
    assert.equal((await expect(sampleRoute)).name, 'Edited stored example')
  }
  await stop(); await start(); await login('alice'); await login('bob'); await login('root')
  await expect(route, 'alice', 'GET', undefined, 404)
  assert.equal((await expect('/api/management/projects/example', 'alice', 'POST', {}, 201)).id, sample.id)
  assert.equal((await expect(`${survivorRoute}/events`)).length, 1)
  await expect(sampleRoute, 'alice', 'DELETE', {})
  const rebuilt = await expect('/api/management/projects/example', 'alice', 'POST', {}, 201)
  assert.notEqual(rebuilt.id, sample.id); assert.equal(rebuilt.ownerId, users.alice.id)
  assert.equal((await expect('/api/management/projects')).filter(project => project.isExample).length, 1)
  pass('deletion and editable example survive abrupt restart; malformed example/guide backup rejected before writes; deleting an example permits one fresh stored copy')
  console.log(JSON.stringify({ status: 'PASS_MANAGEMENT_DELETE_EXAMPLE', checks, count: checks.length, actualHttp: true, isolatedRuntime: true, emailSent: false }))
} finally {
  await stop()
  assert.equal(path.dirname(runtime), path.resolve(os.tmpdir())); assert.ok(path.basename(runtime).startsWith('flowboard-delete-example-'))
  await fs.rm(runtime, { recursive: true, force: true })
}
