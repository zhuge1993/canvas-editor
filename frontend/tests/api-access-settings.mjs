import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'api-access-settings-'))
const fixture = path.join(runtime, 'fixture.cjs'), keyFile = path.join(runtime, 'key'), tunnel = path.join(runtime, 'public-url')
const key = randomBytes(32).toString('hex'), password = randomBytes(24).toString('hex')
await fs.writeFile(keyFile, key); await fs.writeFile(tunnel, 'https://first-fixture.trycloudflare.com')
await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
let server, port, ownerCookie
async function request(route, data, cookie = ownerCookie, extra = {}, method) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) })
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0], cache: res.headers.get('cache-control') }
}
async function register(email, inviteCode) {
  const sent = await request('/api/auth/send-code', { email, ...(inviteCode ? { inviteCode } : {}) }, null)
  const registered = await request('/api/auth/register', { email, password, code: sent.data.developmentCode, ...(inviteCode ? { inviteCode } : {}) }, null)
  assert.equal(registered.status, 201); return registered.cookie
}
try {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'api-owner@example.com', FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_TUNNEL_NOTIFY: 'false', FLOWBOARD_API_KEY_FILE: keyFile, FLOWBOARD_PUBLIC_HOST: '', FLOWBOARD_PUBLIC_PROTOCOL: 'https', FLOWBOARD_PUBLIC_URL_FILE: tunnel }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  port = await Promise.race([once(server, 'message').then(([value]) => value.port), new Promise((_, reject) => setTimeout(() => reject(new Error('fixture timeout')), 15000).unref())])
  for (const [route, body] of [['/api/settings/decision-api', undefined], ['/api/settings/decision-api/reveal', {}]]) assert.equal((await request(route, body, null)).status, 401)
  ownerCookie = await register('api-owner@example.com')
  const invite = await request('/api/admin/invites', { maxUses: 2 })
  const other = await register('api-other@example.com', invite.data.code)
  assert.equal((await request('/api/settings/decision-api', undefined, other)).status, 403)
  assert.equal((await request('/api/settings/decision-api/reveal', {}, other)).status, 403)
  const user = (await request('/api/auth/me', undefined, other)).data.user
  assert.equal((await request(`/api/admin/users/${user.id}`, { isAdmin: true }, ownerCookie, {}, 'PATCH')).status, 200)
  assert.equal((await request('/api/settings/decision-api/reveal', {}, other)).status, 403)
  const info = await request('/api/settings/decision-api')
  assert.equal(info.status, 200); assert.equal(info.cache, 'no-store'); assert.equal(info.data.configured, true)
  assert.equal(info.data.api_key, undefined); assert.ok(!JSON.stringify(info.data).includes(key))
  assert.equal(info.data.base_url, 'https://first-fixture.trycloudflare.com/v1'); assert.equal(info.data.model, 'bge-small-zh-v1.5')
  assert.equal((await request('/api/settings/decision-api/reveal')).status, 405)
  assert.equal((await request('/api/settings/decision-api/reveal', {}, ownerCookie, { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await request('/api/settings/decision-api/reveal', {}, ownerCookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  const revealed = await request('/api/settings/decision-api/reveal', {})
  assert.equal(revealed.status, 200); assert.equal(revealed.cache, 'no-store'); assert.equal(revealed.data.api_key, key)
  await fs.writeFile(tunnel, 'https://second-fixture.trycloudflare.com')
  assert.equal((await request('/api/settings/decision-api/reveal', {})).data.base_url, 'https://second-fixture.trycloudflare.com/v1')
  const rotated = randomBytes(32).toString('hex'); await fs.writeFile(keyFile, rotated)
  assert.equal((await request('/api/settings/decision-api/reveal', {})).data.api_key, rotated)
  await fs.writeFile(keyFile, 'invalid')
  assert.equal((await request('/api/settings/decision-api')).data.configured, false)
  assert.equal((await request('/api/settings/decision-api/reveal', {})).status, 503)
  await request('/api/auth/logout', {})
  assert.equal((await request('/api/settings/decision-api/reveal', {})).status, 401)
  console.log('PASS API settings: root-only reveal, masked metadata, fresh URL/key, no-store, cross-site rejection, missing config and revoked session')
} finally {
  if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done }
  await fs.rm(runtime, { recursive: true, force: true })
}
