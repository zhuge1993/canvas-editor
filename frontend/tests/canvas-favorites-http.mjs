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
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-canvas-favorites-'))
const fixture = path.join(runtime, 'fixture.cjs'), users = {}, accountPassword = 'Isolated-favorites-account-password-42'
await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
let server, port
async function start() {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime,
    FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'favorites-root@example.test', FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_TUNNEL_NOTIFY: 'false', FLOWBOARD_GUEST_MODE: '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; server.stderr.on('data', data => { errors = (errors + data.toString()).slice(-8000) })
  port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(errors)), 10000); server.once('message', message => { clearTimeout(timer); resolve(message.port) }); server.once('exit', code => reject(new Error(`exit ${code}: ${errors}`))) })
}
async function stop() { if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGKILL'); await done } }
async function request(route, method = 'GET', body, actor = 'viewer', status = 200, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json',
    ...(users[actor]?.cookie ? { Cookie: users[actor].cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const bytes = Buffer.from(await response.arrayBuffer()); let data
  try { data = JSON.parse(bytes.toString()) } catch { data = bytes }
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(data)}`)
  if (response.headers.get('set-cookie') && users[actor]) users[actor].cookie = response.headers.get('set-cookie').split(';')[0]
  if (route.startsWith('/api/canvas/favorites')) assert.equal(response.headers.get('cache-control'), 'no-store')
  return data
}
async function register(actor, inviteCode) {
  users[actor] = { email: `favorites-${actor}@example.test`, cookie: '' }
  const sent = await request('/api/auth/send-code', 'POST', { email: users[actor].email, ...(inviteCode ? { inviteCode } : {}) }, actor)
  return request('/api/auth/register', 'POST', { email: users[actor].email, password: accountPassword, code: sent.developmentCode, ...(inviteCode ? { inviteCode } : {}) }, actor, 201)
}
async function login(actor) { await request('/api/auth/login', 'POST', { email: users[actor].email, password: accountPassword }, actor) }
async function ipc(command, value) {
  const id = `fixture_${Date.now()}`
  const done = new Promise(resolve => { const receive = message => { if (message.id === id) { server.off('message', receive); resolve() } }; server.on('message', receive) })
  server.send({ id, command, value }); await done
}
function invalidSummary(value) {
  assert.equal(value.status, 'unavailable')
  assert.deepEqual(Object.keys(value).sort(), ['addedAt', 'id', 'shareId', 'status'], 'invalid references expose no stale source metadata')
}

try {
  await start()
  const root = await register('root'), invite = await request('/api/admin/invites', 'POST', { maxUses: 4 }, 'root', 201)
  const author = await register('author', invite.code)
  await register('viewer', invite.code); await register('outsider', invite.code)
  const source = { id: 'source_reference', title: 'Original canvas', content: JSON.stringify({ shapes: { note: { id: 'note', text: 'first revision' } } }), thumbnail: 'original-thumbnail', createdAt: 1, updatedAt: 1 }
  await request(`/api/projects/${source.id}`, 'PUT', source, 'author')
  const share = await request(`/api/projects/${source.id}/shares`, 'POST', { permission: 'view' }, 'author', 201)
  await request('/api/canvas/favorites', 'POST', { shareId: share.token }, 'anonymous', 401)
  await request('/api/canvas/favorites', 'POST', { shareId: share.token }, 'viewer', 403, { Origin: 'https://attacker.example' })
  await request('/api/canvas/favorites', 'POST', { shareId: share.token }, 'viewer', 403, { 'Sec-Fetch-Site': 'cross-site' })
  await request('/api/canvas/favorites', 'POST', { shareId: share.token, password: 'must-not-be-stored' }, 'viewer', 400)
  const favorite = await request('/api/canvas/favorites', 'POST', { shareId: share.token }, 'viewer', 201)
  assert.equal(favorite.status, 'active'); assert.equal(favorite.permission, 'view'); assert.equal(favorite.title, source.title)
  assert.equal(favorite.authorName, 'favorites-author'); assert.match(favorite.id, /^fav_[a-f0-9]{24}$/)
  const contentPath = `/api/canvas/favorites/${favorite.id}/content`
  assert.equal((await request(contentPath)).content, source.content)
  await request(contentPath, 'GET', undefined, 'outsider', 404)
  await request(`/api/canvas/favorites/${favorite.id}`, 'DELETE', undefined, 'outsider', 404)
  await request(contentPath, 'PUT', { title: 'must never overwrite' }, 'viewer', 405)
  await request(`/api/projects/${source.id}`, 'PUT', { ...source, title: 'must never overwrite' }, 'viewer', 403)
  assert.deepEqual(await request('/api/projects'), [], 'collection creates no owned canvas copy')
  assert.deepEqual(await request('/api/canvas/favorites', 'GET', undefined, 'outsider'), [])
  const retries = await Promise.all(Array.from({ length: 5 }, () => request('/api/canvas/favorites', 'POST', { shareId: share.token })))
  assert.ok(retries.every(value => value.id === favorite.id)); assert.equal((await request('/api/canvas/favorites')).length, 1)
  const changed = { ...source, title: 'Author updated the original', content: JSON.stringify({ shapes: { note: { id: 'note', text: 'latest revision' } } }), thumbnail: 'latest-thumbnail' }
  await request(`/api/projects/${source.id}`, 'PUT', changed, 'author')
  const latest = await request(contentPath)
  assert.equal(latest.content, changed.content); assert.equal(latest.title, changed.title); assert.equal(latest.permission, 'view')
  assert.equal((await request('/api/canvas/favorites'))[0].thumbnail, changed.thumbnail)

  const editShare = await request(`/api/projects/${source.id}/shares`, 'POST', { permission: 'edit' }, 'author', 201)
  const editorVersion = await request(`/api/share/${editShare.token}`, 'GET', undefined, 'anonymous')
  const authorUpdate = { ...changed, title: 'Author wins a stale editor race', content: JSON.stringify({ shapes: { note: { id: 'note', text: 'author latest content during editor session' } } }) }
  await request(`/api/projects/${source.id}`, 'PUT', authorUpdate, 'author')
  await request(`/api/share/${editShare.token}`, 'PUT', { ...editorVersion, title: 'Stale editor overwrite', expectedUpdatedAt: editorVersion.updatedAt }, 'anonymous', 409)
  const authorPreserved = await request(`/api/projects/${source.id}`, 'GET', undefined, 'author')
  assert.equal(authorPreserved.content, authorUpdate.content); assert.equal(authorPreserved.title, authorUpdate.title)
  await request(`/api/share/${editShare.token}`, 'PUT', { ...authorPreserved, expectedUpdatedAt: 'invalid' }, 'anonymous', 400)
  const editorRetry = { ...authorPreserved, title: 'Editor merged with latest', content: changed.content, expectedUpdatedAt: authorPreserved.updatedAt }
  const editorSaved = await request(`/api/share/${editShare.token}`, 'PUT', editorRetry, 'anonymous')
  assert.equal(editorSaved.permission, 'edit'); assert.equal(typeof editorSaved.updatedAt, 'number')
  assert.ok(editorSaved.updatedAt > authorPreserved.updatedAt, 'every write advances the CAS version even within one clock millisecond')
  assert.equal((await request(`/api/share/${editShare.token}`, 'GET', undefined, 'anonymous')).updatedAt, editorSaved.updatedAt)
  assert.equal((await request(contentPath)).content, changed.content)
  await request(`/api/share/${editShare.token}`, 'PUT', { ...editorRetry, expectedUpdatedAt: undefined }, 'anonymous')
  await request(`/api/projects/${source.id}/shares/${editShare.token}`, 'PATCH', { permission: 'view' }, 'author')
  await request(`/api/share/${editShare.token}`, 'PUT', editorRetry, 'anonymous', 403)

  const sharePassword = 'Protected-reference-password-17', nextPassword = 'Changed-reference-password-28'
  const protectedShare = await request(`/api/projects/${source.id}/shares`, 'POST', { permission: 'edit', password: sharePassword }, 'author', 201)
  await request('/api/canvas/favorites', 'POST', { shareId: protectedShare.token }, 'viewer', 401)
  await request('/api/canvas/favorites', 'POST', { shareId: protectedShare.token }, 'viewer', 401, { 'X-Share-Password': 'wrong-password' })
  const protectedFavorite = await request('/api/canvas/favorites', 'POST', { shareId: protectedShare.token }, 'viewer', 201, { 'X-Share-Password': sharePassword })
  const protectedPath = `/api/canvas/favorites/${protectedFavorite.id}/content`
  assert.equal((await request(protectedPath)).permission, 'view', 'editable share does not grant writes through a favorite')
  const storeFile = path.join(runtime, 'auth-data', 'canvas-favorites.json')
  const stored = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  assert.equal(stored.favorites.length, 2)
  assert.equal(JSON.stringify(stored).includes(sharePassword), false)
  assert.ok(stored.favorites.every(item => Object.keys(item).sort().join(',') === 'createdAt,grantFingerprint,id,shareToken,userId'))
  assert.equal((await fs.readdir(path.join(runtime, 'project-data'))).filter(file => file.endsWith('.json')).length, 1)
  await request(`/api/projects/${source.id}/shares/${protectedShare.token}`, 'PATCH', { permission: 'view', password: nextPassword }, 'author')
  invalidSummary((await request('/api/canvas/favorites')).find(item => item.id === protectedFavorite.id))
  await request(protectedPath, 'GET', undefined, 'viewer', 410)
  await request('/api/canvas/favorites', 'POST', { shareId: protectedShare.token }, 'viewer', 401, { 'X-Share-Password': sharePassword })
  assert.equal((await request('/api/canvas/favorites', 'POST', { shareId: protectedShare.token }, 'viewer', 200, { 'X-Share-Password': nextPassword })).id, protectedFavorite.id)
  assert.equal((await request(protectedPath)).content, changed.content)

  const syncShare = await request(`/api/projects/${source.id}/shares`, 'POST', { permission: 'view' }, 'author', 201)
  const beforeFailure = await fs.readFile(storeFile)
  await ipc('fail-sync-file', 'canvas-favorites.json')
  await request('/api/canvas/favorites', 'POST', { shareId: syncShare.token }, 'viewer', 500)
  assert.deepEqual(await fs.readFile(storeFile), beforeFailure, 'failed durable write is never reported as a saved reference')
  const synced = await request('/api/canvas/favorites', 'POST', { shareId: syncShare.token }, 'viewer', 201)
  await request(`/api/canvas/favorites/${synced.id}`, 'DELETE')
  assert.equal((await request(`/api/projects/${source.id}`, 'GET', undefined, 'author')).content, changed.content)
  await request(`/api/canvas/favorites/${synced.id}/content`, 'GET', undefined, 'viewer', 404)

  const archive = JSON.parse(gunzipSync(await request('/api/admin/backup', 'GET', undefined, 'root')))
  assert.equal(archive.auth['canvas-favorites.json'].favorites.length, 2)
  assert.equal(JSON.stringify(archive.auth['canvas-favorites.json']).includes(nextPassword), false)
  for (const corrupt of [
    value => { value.favorites[0].userId = '../escape' },
    value => { value.favorites[0].shareToken = 'short' },
    value => { value.favorites[0].grantFingerprint = 'bad' },
    value => { value.favorites[0].createdAt = -1 },
    value => { value.favorites[0].password = nextPassword },
    value => { value.favorites.push({ ...value.favorites[0] }) },
  ]) {
    const invalid = structuredClone(archive); invalid.data['should_not_write.json'] = { id: 'should_not_write', title: 'must not write', createdAt: 1, updatedAt: 1 }
    corrupt(invalid.auth['canvas-favorites.json'])
    await request('/api/admin/restore', 'POST', invalid, 'root', 400)
    await assert.rejects(fs.access(path.join(runtime, 'project-data', 'should_not_write.json')))
    assert.equal((await request(contentPath)).content, changed.content)
  }
  await request(`/api/projects/${source.id}/shares/${share.token}`, 'DELETE', undefined, 'author')
  invalidSummary((await request('/api/canvas/favorites')).find(item => item.id === favorite.id))
  await request(contentPath, 'GET', undefined, 'viewer', 410)
  await request('/api/admin/restore', 'POST', archive, 'root')
  await request('/api/canvas/favorites', 'GET', undefined, 'viewer', 401)
  await login('viewer'); await login('author')
  assert.equal((await request(contentPath)).content, changed.content)
  assert.equal((await request(protectedPath)).content, changed.content)
  const legacy = structuredClone(archive); delete legacy.auth['canvas-favorites.json']
  await request('/api/admin/restore', 'POST', legacy, 'root')
  await login('viewer'); await login('author')
  assert.equal((await request('/api/canvas/favorites')).length, 2, 'old backups without this optional file preserve current references')
  await stop(); await start(); assert.equal((await request(contentPath)).content, changed.content, 'references survive abrupt restart')
  await request(`/api/projects/${source.id}/shares/${share.token}`, 'PATCH', { permission: 'view', expiresInHours: 0.000001 }, 'author')
  invalidSummary((await request('/api/canvas/favorites')).find(item => item.id === favorite.id))
  await request(contentPath, 'GET', undefined, 'viewer', 410)
  await request(`/api/admin/users/${author.user.id}`, 'DELETE', undefined, 'root')
  invalidSummary((await request('/api/canvas/favorites')).find(item => item.id === protectedFavorite.id))
  await request(protectedPath, 'GET', undefined, 'viewer', 410)
  await request(`/api/canvas/favorites/${protectedFavorite.id}`, 'DELETE')
  assert.equal((await request('/api/canvas/favorites')).length, 1)
  assert.notEqual(root.user.id, author.user.id)
  console.log('PASS canvas favorites: authenticated reference-only collection, live original updates, password proof and invalidation, private account boundaries, read-only access, durable retry/sync failure, strict backup roundtrip/legacy/pre-write rejection, expiry/author deletion and abrupt restart')
} finally {
  await stop()
  assert.ok(path.dirname(runtime) === path.resolve(os.tmpdir()) && path.basename(runtime).startsWith('flowboard-canvas-favorites-'))
  await fs.rm(runtime, { recursive: true, force: true })
}
