import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-lifetime-'))
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const fixture = option('--fixture') ? path.resolve(option('--fixture')) : path.join(runtime, 'fixture.cjs')
const healthcheck = option('--healthcheck') ? path.resolve(option('--healthcheck')) : path.join(frontend, 'healthcheck.cjs')
if (!option('--fixture')) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}

let server
let port
let cookie = ''
const password = randomBytes(20).toString('hex')
const email = 'lifetime-test@example.com'
const publicUrlFile = path.join(runtime, 'current-public-url')
async function start() {
  server = spawn(process.execPath, [fixture], {
    env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: email, FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_PUBLIC_HOST: 'draw.example.com', FLOWBOARD_PUBLIC_PROTOCOL: 'https', FLOWBOARD_PUBLIC_URL_FILE: publicUrlFile },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let errors = ''
  server.stderr.on('data', part => { errors += part.toString() })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${errors}`)), 10000)
    server.once('error', reject)
    server.once('exit', code => reject(new Error(`Fixture exited ${code}: ${errors}`)))
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
  const done = new Promise(resolve => {
    const listener = message => {
      if (message.id === id) { server.off('message', listener); resolve() }
    }
    server.on('message', listener)
  })
  server.send({ id, command, value })
  await done
}
async function request(route, { method = 'GET', body, authenticated = false, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
async function expectStatus(route, options, status) {
  const response = await request(route, options)
  assert.equal(response.status, status, JSON.stringify(response.data))
  return response
}
async function health() {
  const child = spawn(process.execPath, [healthcheck], { env: { ...process.env, FLOWBOARD_PORT: String(port) }, stdio: 'ignore' })
  return (await once(child, 'exit'))[0]
}

try {
  await fs.writeFile(publicUrlFile, 'https://first-blue-lamp.trycloudflare.com\n')
  await start()
  const sent = await expectStatus('/api/auth/send-code', { method: 'POST', body: { email } }, 200)
  const registered = await expectStatus('/api/auth/register', { method: 'POST', body: { email, password, code: sent.data.developmentCode } }, 201)
  cookie = registered.cookie
  assert.ok(cookie)
  const project = { id: 'lifetime_project', title: 'Before restart', canvas: { shapes: {}, marker: 'initial' } }
  await expectStatus(`/api/projects/${project.id}`, { method: 'PUT', authenticated: true, body: project }, 200)
  const createShare = permission => expectStatus(`/api/projects/${project.id}/shares`, { method: 'POST', authenticated: true, body: { permission }, headers: { 'X-Forwarded-Host': 'changing-host.example.net', 'X-Forwarded-Proto': 'http' } }, 201)
  const viewing = (await createShare('view')).data
  const editing = (await createShare('edit')).data
  for (const share of [viewing, editing]) {
    assert.equal(share.url, `https://draw.example.com/share/${share.token}`)
    assert.equal(share.expiresAt, undefined)
  }
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XsAAAAASUVORK5CYII=', 'base64')
  const asset = await expectStatus('/api/assets', { method: 'POST', body: { dataUrl: `data:image/png;base64,${image.toString('base64')}` }, headers: { 'X-FlowBoard-Share-Token': editing.token } }, 200)
  assert.equal(typeof asset.data.url, 'string')
  const saved = { ...project, title: 'Saved through edit link', canvas: { shapes: {}, marker: 'persisted', image: asset.data.url } }
  await expectStatus(`/api/share/${editing.token}`, { method: 'PUT', body: saved }, 200)
  await expectStatus(`/api/share/${viewing.token}`, { method: 'PUT', body: saved }, 403)

  // Stop immediately after acknowledged writes; reuse the same data directories.
  await stop()
  await start()
  assert.equal((await expectStatus('/api/auth/me', { authenticated: true }, 200)).data.user.email, email)
  const healthDetails = (await expectStatus('/api/health', { authenticated: true }, 200)).data
  assert.equal(healthDetails.urls[0], 'https://draw.example.com')
  assert.ok(healthDetails.urls.every(value => !value.includes('draw.example.com:3000')))
  const read = (await expectStatus(`/api/share/${viewing.token}`, {}, 200)).data
  assert.equal(read.title, saved.title)
  assert.equal(JSON.parse(read.content).marker, 'persisted')
  const shares = (await expectStatus(`/api/projects/${project.id}/shares`, { authenticated: true }, 200)).data
  assert.deepEqual(shares.map(value => value.url).sort(), [viewing.url, editing.url].sort())
  const loadedImage = await fetch(`http://127.0.0.1:${port}${asset.data.url}`)
  assert.equal(loadedImage.status, 200)
  assert.deepEqual(Buffer.from(await loadedImage.arrayBuffer()), image)
  console.log('PASS: abrupt process restart preserves user, session, view/edit links, project and image')

  await command('fail-next-sync')
  await expectStatus(`/api/share/${editing.token}`, { method: 'PUT', body: { ...saved, title: 'Must not be acknowledged' } }, 500)
  assert.equal((await expectStatus(`/api/share/${editing.token}`, {}, 200)).data.title, saved.title)
  await command('fail-next-sync')
  await expectStatus(`/api/projects/${project.id}/shares`, { method: 'POST', authenticated: true, body: { permission: 'edit' } }, 500)
  assert.equal((await expectStatus(`/api/projects/${project.id}/shares`, { authenticated: true }, 200)).data.length, 2)
  const names = [...await fs.readdir(path.join(runtime, 'project-data')), ...await fs.readdir(path.join(runtime, 'auth-data'))]
  assert.ok(names.every(name => !name.endsWith('.tmp')))
  console.log('PASS: fsync failure returns HTTP 500, preserves previous project/share records and removes staging files')

  await command('public-mode', 'dynamic')
  const listShares = () => expectStatus(`/api/projects/${project.id}/shares`, { authenticated: true, headers: { 'X-Forwarded-Host': 'changing-host.example.net', 'X-Forwarded-Proto': 'http' } }, 200)
  const firstOrigin = 'https://first-blue-lamp.trycloudflare.com'
  let currentShares = (await listShares()).data
  assert.deepEqual(currentShares.map(value => value.token).sort(), [viewing.token, editing.token].sort())
  assert.ok(currentShares.every(value => value.url === `${firstOrigin}/share/${value.token}`))
  const newView = (await createShare('view')).data
  const newEdit = (await createShare('edit')).data
  assert.equal(newView.url, `${firstOrigin}/share/${newView.token}`)
  assert.equal(newEdit.url, `${firstOrigin}/share/${newEdit.token}`)
  const shareFile = path.join(runtime, 'auth-data', 'shares.json')
  const recordsBeforeUrlChange = await fs.readFile(shareFile)
  const tokenSet = [viewing.token, editing.token, newView.token, newEdit.token].sort()
  const secondOrigin = 'https://second-green-lamp.trycloudflare.com'
  await fs.writeFile(publicUrlFile, `${secondOrigin}/\n`)
  currentShares = (await listShares()).data
  assert.deepEqual(currentShares.map(value => value.token).sort(), tokenSet)
  assert.ok(currentShares.every(value => value.url === `${secondOrigin}/share/${value.token}`))
  assert.equal((await expectStatus('/api/health', { authenticated: true }, 200)).data.urls[0], secondOrigin)
  assert.equal((await expectStatus(`/api/share/${newView.token}`, {}, 200)).data.permission, 'view')
  await expectStatus(`/api/share/${newView.token}`, { method: 'PUT', body: saved }, 403)
  await expectStatus(`/api/share/${newEdit.token}`, { method: 'PUT', body: saved }, 200)

  // These values must not become an origin, even when read from the configured file.
  const invalidUrls = [
    'http://first-blue-lamp.trycloudflare.com',
    'https://first-blue-lamp.trycloudflare.com.evil.example',
    'https://one.two.trycloudflare.com',
    'https://trycloudflare.com',
    'https://first-blue-lamp.trycloudflare.com:443',
    'https://user:password@first-blue-lamp.trycloudflare.com',
    'https://first-blue-lamp.trycloudflare.com/path',
    'https://first-blue-lamp.trycloudflare.com?query=value',
    'https://first-blue-lamp.trycloudflare.com#fragment',
    `${firstOrigin}\n${secondOrigin}`,
    'x'.repeat(1025),
    '',
  ]
  for (const value of invalidUrls) {
    await fs.writeFile(publicUrlFile, value)
    assert.ok((await listShares()).data.every(share => share.url === `https://changing-host.example.net/share/${share.token}`))
    assert.ok((await expectStatus('/api/health', { authenticated: true }, 200)).data.urls.every(url => !url.includes('trycloudflare.com')))
  }
  await fs.unlink(publicUrlFile)
  assert.ok((await listShares()).data.every(share => share.url === `https://changing-host.example.net/share/${share.token}`))
  await fs.mkdir(publicUrlFile)
  assert.ok((await listShares()).data.every(share => share.url === `https://changing-host.example.net/share/${share.token}`))
  await fs.rmdir(publicUrlFile)
  await fs.writeFile(publicUrlFile, `${secondOrigin}\n`)
  await command('public-mode', 'http')
  assert.ok((await listShares()).data.every(share => share.url === `http://changing-host.example.net/share/${share.token}`))
  await command('public-mode', 'fixed')
  assert.ok((await listShares()).data.every(share => share.url === `https://draw.example.com/share/${share.token}`))
  assert.deepEqual(await fs.readFile(shareFile), recordsBeforeUrlChange)
  console.log('PASS: live Quick Tunnel URL changes update view/edit/login entry origins, preserve tokens/records and reject invalid URL files')

  assert.equal(await health(), 0)
  await command('health-mode', 'invalid')
  assert.equal(await health(), 1)
  await command('health-mode', 'hang')
  const before = Date.now()
  assert.equal(await health(), 1)
  assert.ok(Date.now() - before < 21000)
  console.log('PASS: health checker accepts FlowBoard, rejects another app and bounds a hung HTTP request')
} finally {
  await stop()
  await fs.rm(runtime, { recursive: true, force: true })
}
