import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1] }
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-management-growth-'))
const fixture = option('--fixture') ? path.resolve(option('--fixture')) : path.join(runtime, 'fixture.cjs')
if (!option('--fixture')) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}
const password = 'Synthetic-management-growth-42', checks = []
let server, port, cookie = ''
const paths = { data: path.join(runtime, 'project-data'), auth: path.join(runtime, 'auth-data') }
async function start() {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime,
    FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'growth-test@example.test', FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_TUNNEL_NOTIFY: 'false' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  server.stderr.on('data', data => { errors = (errors + data).slice(-4000) })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errors || 'Fixture timed out')), 15000)
    server.once('message', data => { clearTimeout(timer); resolve(data.port) })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${errors}`)) })
    server.once('error', error => { clearTimeout(timer); reject(error) })
  })
}
async function stop() { if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGKILL'); await done } }
async function request(route, method = 'GET', body, status = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const bytes = Buffer.from(await response.arrayBuffer())
  let value; try { value = JSON.parse(bytes.toString('utf8')) } catch { value = bytes }
  assert.equal(response.status, status, `${method} ${route.replace(/[A-Za-z0-9_-]{43}/g, '[token]')}: ${JSON.stringify(value).slice(0, 300)}`)
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
  return value
}
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const write = async (file, value) => fs.writeFile(file, JSON.stringify(value), 'utf8')
const exists = async file => fs.access(file).then(() => true, () => false)
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')
function pass(name) { checks.push(name); console.log(`PASS: ${name}`) }
const base = '/api/management/projects'
const projectFile = id => path.join(paths.data, 'management', 'projects', `${id}.json`)
const assetDirectory = id => path.join(paths.data, 'management-assets', id)
async function ageAsset(projectId, assetId, days = 8) {
  const directory = assetDirectory(projectId), metadataPath = path.join(directory, `${assetId}.json`), metadata = await read(metadataPath)
  metadata.createdAt = Date.now() - days * 86400000
  await write(metadataPath, metadata)
  const date = new Date(metadata.createdAt)
  await fs.utimes(metadataPath, date, date); await fs.utimes(path.join(directory, metadata.file), date, date)
  return metadata
}
async function seedAsset(project, index, bytes = 4, days = 8) {
  const id = `asset_${index.toString(16).padStart(24, '0')}`, directory = assetDirectory(project.id)
  await fs.mkdir(directory, { recursive: true })
  const metadata = { id, projectId: project.id, ownerId: project.ownerId, file: `${id}.txt`, name: `temporary-${index}.txt`, mime: 'text/plain', bytes,
    createdAt: Date.now() - days * 86400000, url: `${base}/${project.id}/assets/${id}` }
  const binary = path.join(directory, metadata.file)
  await fs.writeFile(binary, 'test', 'utf8'); await fs.truncate(binary, bytes)
  await write(path.join(directory, `${id}.json`), metadata)
  const date = new Date(metadata.createdAt)
  await fs.utimes(binary, date, date); await fs.utimes(path.join(directory, `${id}.json`), date, date)
  return metadata
}
try {
  await start()
  const sent = await request('/api/auth/send-code', 'POST', { email: 'growth-test@example.test' })
  const account = await request('/api/auth/register', 'POST', { email: 'growth-test@example.test', password, code: sent.developmentCode }, 201)
  let project = await request(base, 'POST', { name: 'Isolated reachability proof' }, 201), route = `${base}/${project.id}`
  const survivor = await request(base, 'POST', { name: 'Untouched unrelated business project' }, 201)
  const survivorHash = await hash(projectFile(survivor.id))
  const assets = []
  for (let index = 0; index < 5; index++) assets.push(await request(`${route}/assets`, 'POST', { name: `${index}.txt`, dataUrl: `data:text/plain;base64,${Buffer.from(`asset-${index}`).toString('base64')}` }, 201))
  project = await request(`${route}/events`, 'POST', { title: 'Durable current record', attachments: [assets[0].id] }, 201)
  project = await request(`${route}/events`, 'POST', { title: 'Durable notification snapshot', attachments: [assets[2].id] }, 201)
  await request(`${route}/events/${project.events[1].id}/notify`, 'POST', { mutationId: 'snapshot_once', recipientIds: [account.user.id] })
  await stop()
  const privateProject = await read(projectFile(project.id))
  privateProject.events[1].attachments = []
  privateProject.history = privateProject.history.filter(entry => entry.eventId !== privateProject.events[1].id)
  privateProject.history.push({ id: 'hist_only_attachment', eventId: privateProject.events[0].id, action: 'events.PATCH', at: Date.now(), actorId: account.user.id,
    changes: [{ field: 'attachments', before: [assets[1]], after: [] }] })
  await write(projectFile(project.id), privateProject)
  for (let index = 0; index < 4; index++) await ageAsset(project.id, assets[index].id)
  const orphan = await seedAsset(project, 9999)
  await fs.unlink(path.join(assetDirectory(project.id), `${orphan.id}.json`))
  const unknownFile = path.join(assetDirectory(project.id), 'unrelated-user-export.txt')
  await fs.writeFile(unknownFile, 'never garbage collect unknown files', 'utf8')
  const notificationsFile = path.join(paths.auth, 'management-notifications.json'), notificationHash = await hash(notificationsFile)
  const projectHash = await hash(projectFile(project.id))
  await start(); await request(base)
  for (const asset of assets.slice(0, 3)) assert.equal(await exists(path.join(assetDirectory(project.id), `${asset.id}.json`)), true)
  assert.equal(await exists(path.join(assetDirectory(project.id), `${assets[3].id}.json`)), false)
  assert.equal(await exists(path.join(assetDirectory(project.id), `${assets[4].id}.json`)), true)
  assert.equal(await exists(path.join(assetDirectory(project.id), orphan.file)), false)
  assert.equal(await exists(unknownFile), true)
  assert.equal(await hash(projectFile(project.id)), projectHash); assert.equal(await hash(projectFile(survivor.id)), survivorHash)
  assert.equal(await hash(notificationsFile), notificationHash)
  await request(`/api/management/notifications`)
  pass('7-day orphan reachability preserves current records, complete attachment history, notification-only snapshots, recent uploads, unknown files and unrelated business data')
  await fs.unlink(unknownFile) // Remove only this test-created non-application proof file before the strict backup scenario.

  const firstInviteBody = { permission: 'view', maxUses: 1, mutationId: 'expire_never_reactivate' }
  const expiring = await request(`${route}/invites`, 'POST', firstInviteBody, 201)
  const active = await request(`${route}/invites`, 'POST', { permission: 'view', mutationId: 'keep_active' }, 201)
  await stop()
  const invitesPath = path.join(paths.auth, 'management-invites.json'), inviteStore = await read(invitesPath)
  const old = inviteStore.invites.find(invite => invite.id === expiring.id)
  old.createdAt = Date.now() - 8 * 86400000; old.expiresAt = Date.now() - 1
  await write(invitesPath, inviteStore)
  await start(); await request(base)
  const afterInvites = await read(invitesPath)
  assert.equal(afterInvites.invites.some(invite => invite.id === expiring.id), false)
  assert.equal(afterInvites.invites.some(invite => invite.id === active.id), true)
  assert.ok(afterInvites.receipts.some(receipt => receipt.inviteId === expiring.id))
  await request(`${route}/invites`, 'POST', firstInviteBody, 410)
  assert.equal((await read(invitesPath)).invites.length, 1)
  const backup = JSON.parse(gunzipSync(await request('/api/admin/backup')))
  assert.ok(backup.management.invites.receipts.some(receipt => receipt.inviteId === expiring.id))
  await request('/api/admin/restore', 'POST', backup)
  await request('/api/auth/login', 'POST', { email: 'growth-test@example.test', password })
  await request(`${route}/invites`, 'POST', firstInviteBody, 410)
  pass('expired invitations reclaimed; compact mutation digest prevents late replay from creating a fresh grant; inactive receipt survives private backup/restore')

  await stop()
  const capacityInvites = await read(invitesPath), template = capacityInvites.invites[0]
  for (let index = capacityInvites.invites.length; index < 100; index++) capacityInvites.invites.push({ ...template,
    id: `minvite_${index.toString(16).padStart(24, '0')}`, token: randomBytes(32).toString('base64url') })
  await write(invitesPath, capacityInvites)
  await start(); await request(base)
  const fullStoreHash = await hash(invitesPath)
  await request(`${route}/invites`, 'POST', { permission: 'view', mutationId: 'invite_capacity_new' }, 429)
  assert.equal(await hash(invitesPath), fullStoreHash)
  await request(`${route}/invites/${capacityInvites.invites[99].id}`, 'DELETE')
  await request(`${route}/invites`, 'POST', { permission: 'view', mutationId: 'invite_capacity_new' }, 201)
  await stop()
  const receiptCapacity = await read(invitesPath)
  for (let index = receiptCapacity.receipts.length; index < 4096; index++) receiptCapacity.receipts.push({ id: `retained_mutation_${index}`,
    digest: createHash('sha256').update(`test-${index}`).digest('hex'), ownerId: project.ownerId, projectId: project.id, inviteId: expiring.id })
  receiptCapacity.invites.pop()
  await write(invitesPath, receiptCapacity)
  await start(); await request(base)
  const receiptCapacityHash = await hash(invitesPath)
  await request(`${route}/invites`, 'POST', { permission: 'view', mutationId: 'receipt_capacity_new' }, 429)
  assert.equal(await hash(invitesPath), receiptCapacityHash)
  await request(`${route}/invites`, 'POST', firstInviteBody, 410)
  pass('100 project invitations and4096 compact receipts enforce pre-write ceilings while preserving existing grants and late-retry rejection')

  let capability
  for (let index = 0; index < 32; index++) capability = await request('/api/ai-shares', 'POST', { kind: 'management', resourceId: project.id, scope: {} }, 201)
  await request('/api/ai-shares', 'POST', { kind: 'management', resourceId: project.id, scope: {} }, 429)
  await request(`/ai/${capability.token}/data.json`)
  await request(`/api/ai-shares/${capability.id}`, 'DELETE')
  const replacement = await request('/api/ai-shares', 'POST', { kind: 'management', resourceId: project.id, scope: {} }, 201)
  assert.notEqual(replacement.token, capability.token)
  await request(`/ai/${capability.token}/data.json`, 'GET', undefined, 404)
  pass('per-resource capability ceiling rejects growth while preserving live AI URLs; explicit revocation frees capacity and old token stays invalid')

  const pendingProject = await request(base, 'POST', { name: 'Pending-upload-count budget' }, 201), pendingRoute = `${base}/${pendingProject.id}`, pendingAssets = []
  for (let index = 0; index < 32; index++) pendingAssets.push(await request(`${pendingRoute}/assets`, 'POST', { name: `${index}.txt`, dataUrl: 'data:text/plain;base64,dGVzdA==' }, 201))
  await request(`${pendingRoute}/assets`, 'POST', { name: 'blocked.txt', dataUrl: 'data:text/plain;base64,dGVzdA==' }, 429)
  await request(`${pendingRoute}/events`, 'POST', { title: 'Saved attachments free the pending budget', attachments: pendingAssets.slice(0, 2).map(asset => asset.id) }, 201)
  await request(`${pendingRoute}/assets`, 'POST', { name: 'allowed.txt', dataUrl: 'data:text/plain;base64,dGVzdA==' }, 201)
  pass('32 pending-upload ceiling prevents abandoned-file accumulation; saved attachments remain and release the temporary quota')

  const byteProject = await request(base, 'POST', { name: 'Pending-upload-byte budget' }, 201), byteRoute = `${base}/${byteProject.id}`
  await stop()
  for (let index = 0; index < 8; index++) await seedAsset(byteProject, 20000 + index, 8 * 1024 * 1024, 1)
  await start(); await request(base)
  await request(`${byteRoute}/assets`, 'POST', { name: 'over64MiB.txt', dataUrl: 'data:text/plain;base64,dGVzdA==' }, 429)
  pass('64MiB pending-byte ceiling applies before writes, preserving existing bytes without deleting unsaved young uploads')

  const batchProject = await request(base, 'POST', { name: 'Bounded idle cleanup batch' }, 201)
  await stop()
  for (let index = 0; index < 150; index++) await seedAsset(batchProject, 30000 + index)
  await start(); await request(base)
  const remaining = (await fs.readdir(assetDirectory(batchProject.id))).length
  assert.ok(remaining >= 172 && remaining < 300, `128-file pass budget observed: ${remaining}`)
  for (let index = 0; index < 20; index++) await request(base)
  assert.equal((await fs.readdir(assetDirectory(batchProject.id))).length, remaining)
  await stop(); await start(); await request(base)
  assert.ok((await fs.readdir(assetDirectory(batchProject.id))).length < remaining)
  pass('cleanup deletes at most128 files per pass, throttles repeated HTTP traffic, and makes progress after a restart')

  if (process.platform !== 'win32') {
    await stop()
    const target = path.join(runtime, 'outside-maintenance-proof.txt')
    await fs.writeFile(target, 'symlink target must remain untouched', 'utf8')
    const symlinkId = 'asset_' + 'f'.repeat(24)
    await fs.symlink(target, path.join(assetDirectory(project.id), `${symlinkId}.txt`))
    await write(path.join(assetDirectory(project.id), `${symlinkId}.json`), { id: symlinkId, projectId: project.id, ownerId: project.ownerId,
      file: `${symlinkId}.txt`, name: 'linked.txt', mime: 'text/plain', bytes: 32, createdAt: Date.now() - 8 * 86400000 })
    const linkedDirectory = path.join(paths.data, 'management-assets', 'mproj_symlink_proof')
    await fs.symlink(assetDirectory(project.id), linkedDirectory, 'dir')
    await start(); await request(base)
    assert.equal(await fs.readFile(target, 'utf8'), 'symlink target must remain untouched')
    assert.equal((await fs.lstat(path.join(assetDirectory(project.id), `${symlinkId}.txt`))).isSymbolicLink(), true)
    assert.equal((await fs.lstat(linkedDirectory)).isSymbolicLink(), true)
    pass('POSIX symlink files/directories are retained and external targets remain unchanged')
  } else console.log('SKIP: POSIX symlink assertions require the Linux phone runner')
  const report = { status: 'PASS', checks, platform: process.platform, fixture: path.basename(fixture), syntheticRuntime: true }
  if (option('--report')) await write(path.resolve(option('--report')), report)
  console.log(`ALL_MANAGEMENT_GROWTH_CHECKS_PASS ${checks.length}`)
} finally {
  await stop()
  assert.equal(path.dirname(runtime), path.resolve(os.tmpdir())); assert.ok(path.basename(runtime).startsWith('flowboard-management-growth-'))
  await fs.rm(runtime, { recursive: true, force: true })
}
