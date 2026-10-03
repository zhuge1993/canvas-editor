import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-growth-'))
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const modules = {}
for (const [name, source] of [['runtime', 'runtimeCore.ts'], ['limits', 'runtimeGrowth.ts'], ['notifications', 'tunnelNotifications.ts']]) {
  modules[name] = option(`--${name}-module`) ? path.resolve(option(`--${name}-module`)) : path.join(root, `${name}.cjs`)
  if (!option(`--${name}-module`)) {
    const { build } = await import('esbuild')
    await build({ entryPoints: [path.join(frontend, source)], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: modules[name] })
  }
}
const previousEnv = { ...process.env }
Object.assign(process.env, { FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'growth-root@example.com', FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_TUNNEL_NOTIFY: 'false', FLOWBOARD_SMTP_TOTAL_TIMEOUT_MS: '5000' })
const require = createRequire(import.meta.url)
const runtime = require(modules.runtime)
const { BoundedCache, BoundedTtlMap, BoundedWorkQueue } = require(modules.limits)
const { createTunnelNotificationWorker } = require(modules.notifications)
const servers = new Set()
const sockets = new Set()
const results = []
const pass = name => { results.push(name); console.log(`PASS: ${name}`) }
const digest = value => createHash('sha256').update(value).digest('hex')
const pathsFor = name => ({ dataDirectory: path.join(root, name, 'project-data'), authDirectory: path.join(root, name, 'auth-data'), logDirectory: path.join(root, name, 'logs') })
const putJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value)}\n`)
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse)
const origin = 'https://growth-blue-lamp.trycloudflare.com'
const key = (url, email) => digest(`${url}\n${email}`)

async function listen(server) {
  servers.add(server)
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

try {
  const attempts = new BoundedTtlMap(2048, 300000)
  for (let index = 0; index < 2048; index++) assert.equal(attempts.set(`share-${index}`, { failures: 5 }, 1000), true)
  for (let index = 2048; index < 20000; index++) assert.equal(attempts.set(`share-${index}`, { failures: 1 }, 1001), false)
  assert.equal(attempts.size, 2048)
  assert.deepEqual(attempts.get('share-0', 1001), { failures: 5 })
  assert.equal(attempts.prune(301000), 2048)
  assert.equal(attempts.size, 0)
  assert.equal(attempts.set('new', { failures: 1 }, 301000), true)
  const cache = new BoundedCache(16)
  for (let index = 0; index < 20000; index++) cache.set(`directory-${index}`, index)
  assert.equal(cache.size, 16)
  assert.equal(cache.get('directory-0'), undefined)
  assert.equal(cache.get('directory-19999'), 19999)
  pass('20,000 temporary-key/cache operations stay bounded; live password locks survive capacity pressure and expired keys disappear')

  const queue = new BoundedWorkQueue(32)
  let releaseFirst
  const blocked = new Promise(resolve => { releaseFirst = resolve })
  let started = 0
  const work = Array.from({ length: 32 }, (_, index) => queue.run(async () => { started++; if (index === 0) await blocked; return index }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(queue.size, 32)
  assert.equal(started, 1)
  await assert.rejects(queue.run(async () => 'overflow'), /capacity reached/)
  assert.equal(queue.size, 32)
  releaseFirst()
  assert.deepEqual(await Promise.all(work), Array.from({ length: 32 }, (_, index) => index))
  assert.equal(queue.size, 0)
  await assert.rejects(queue.run(async () => { throw new Error('Synthetic worker failure') }), /Synthetic worker failure/)
  assert.equal(queue.size, 0)
  assert.equal(await queue.run(async () => 'recovered'), 'recovered')
  pass('serial password work caps running plus waiting tasks at 32, rejects overflow and releases capacity after success or failure')

  const authPaths = pathsFor('authentication')
  await runtime.ensureRuntimeDirs(authPaths)
  const now = Date.now()
  const permanent = { users: [{ id: 'safe-user', email: 'safe@example.com', passwordHash: 'kept-verbatim' }], project: { id: 'safe-project', canvas: { title: 'durable data' } } }
  await putJson(path.join(authPaths.authDirectory, 'users.json'), permanent.users)
  await putJson(path.join(authPaths.dataDirectory, 'safe-project.json'), permanent.project)
  const savedUsers = digest(await fs.readFile(path.join(authPaths.authDirectory, 'users.json')))
  const savedProject = digest(await fs.readFile(path.join(authPaths.dataDirectory, 'safe-project.json')))
  await putJson(path.join(authPaths.authDirectory, 'sessions.json'), [{ token: 'active', userId: 'safe-user', expiresAt: now + 86400000 }, { token: 'expired', expiresAt: now - 1 }])
  await putJson(path.join(authPaths.authDirectory, 'verification.json'), [{ email: 'active@example.com', expiresAt: now + 86400000, attempts: 0 }, { email: 'expired@example.com', expiresAt: now - 1, attempts: 0 }, { email: 'exhausted@example.com', expiresAt: now + 1000, attempts: 5 }])
  await putJson(path.join(authPaths.authDirectory, 'login-attempts.json'), [{ email: 'active@example.com', lastFailAt: now - 1000, count: 5 }, { email: 'expired@example.com', lastFailAt: now - 300001, count: 5 }])
  assert.deepEqual(await runtime.pruneRuntimeTransientState(authPaths, now), { sessions: 1, verification: 2, loginAttempts: 1, sharePasswordAttempts: 0 })
  assert.equal((await readJson(path.join(authPaths.authDirectory, 'sessions.json')))[0].token, 'active')
  assert.equal((await readJson(path.join(authPaths.authDirectory, 'verification.json')))[0].email, 'active@example.com')
  assert.equal((await readJson(path.join(authPaths.authDirectory, 'login-attempts.json')))[0].count, 5)
  const originalRename = fs.rename
  let maintenanceWrites = 0
  fs.rename = async (...args) => { if (String(args[1]).startsWith(authPaths.authDirectory)) maintenanceWrites++; return originalRename(...args) }
  try {
    for (let index = 1; index <= 59; index++) await runtime.pruneRuntimeTransientState(authPaths, now + index * 60000)
    assert.equal(maintenanceWrites, 0)
    assert.equal((await runtime.pruneRuntimeTransientState(authPaths, now + 3600000)).loginAttempts, 1)
    assert.equal(maintenanceWrites, 1)
  } finally { fs.rename = originalRename }
  assert.equal(digest(await fs.readFile(path.join(authPaths.authDirectory, 'users.json'))), savedUsers)
  assert.equal(digest(await fs.readFile(path.join(authPaths.dataDirectory, 'safe-project.json'))), savedProject)
  pass('hourly authentication pruning preserves live sessions, codes and locks and leaves account/project bytes unchanged; 59 idle checks do not rewrite auth')

  const capacityPaths = pathsFor('verification-capacity')
  await runtime.ensureRuntimeDirs(capacityPaths)
  const codes = Array.from({ length: 1024 }, (_, index) => ({ email: `capacity-${index}@example.com`, codeHash: `hash-${index}`, createdAt: now - 61000, sentAt: now - 61000, expiresAt: now + 86400000, attempts: 0 }))
  const verificationFile = path.join(capacityPaths.authDirectory, 'verification.json')
  await putJson(verificationFile, codes)
  const capacityBytes = digest(await fs.readFile(verificationFile))
  const apiPort = await listen(http.createServer(async (request, response) => {
    if (!await runtime.handleRuntimeRequest(request, response, { paths: capacityPaths })) { response.statusCode = 404; response.end() }
  }))
  const requestCode = () => fetch(`http://127.0.0.1:${apiPort}/api/auth/send-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'growth-root@example.com' }), signal: AbortSignal.timeout(10000) })
  assert.equal((await requestCode()).status, 429)
  assert.equal(digest(await fs.readFile(verificationFile)), capacityBytes)
  codes[0] = { ...codes[0], email: 'growth-root@example.com' }
  await putJson(verificationFile, codes)
  const consoleLog = console.log
  console.log = () => undefined
  let accepted
  try { accepted = await requestCode(); await accepted.text() } finally { console.log = consoleLog }
  assert.equal(accepted.status, 200)
  const afterResend = await readJson(verificationFile)
  assert.equal(afterResend.length, 1024)
  for (let index = 1; index < codes.length; index++) assert.equal(afterResend.find(value => value.email === codes[index].email)?.codeHash, codes[index].codeHash)
  pass('real HTTP verification capacity rejects a new reservation without evicting valid codes and permits an existing email to renew')

  const notificationDirectory = path.join(root, 'notification-auth')
  await fs.mkdir(notificationDirectory)
  let clock = 200 * 86400000
  const currentEmail = '100@qq.com'
  const currentKey = key(origin, currentEmail)
  const sent = {}
  for (let index = 0; index < 6500; index++) sent[digest(`historical-${index}`)] = clock - index * 1000
  for (let index = 0; index < 1000; index++) sent[digest(`expired-${index}`)] = 1
  sent[currentKey] = 1
  const notificationFile = path.join(notificationDirectory, 'tunnel-notifications.json')
  await putJson(notificationFile, { version: 1, currentUrl: origin, status: 'up_to_date', publicConnectivityVerified: true, updatedAt: clock, sent, tasks: [{ key: currentKey, email: currentEmail, status: 'sent', attempts: 1, nextAttemptAt: 0 }] })
  let deliveries = 0
  const worker = createTunnelNotificationWorker({ authDirectory: notificationDirectory, currentUrl: () => origin, smtpConfigured: () => true, now: () => clock, loadUsers: async () => [{ id: 'registered', email: currentEmail, verifiedAt: 1 }], verifyPublic: async () => true, send: async () => { deliveries++ } })
  let checkpointWrites = 0
  fs.rename = async (...args) => { if (args[1] === notificationFile) checkpointWrites++; return originalRename(...args) }
  try {
    await worker.tick()
    const compacted = await readJson(notificationFile)
    assert.equal(Object.keys(compacted.sent).length, 4097)
    assert.equal(compacted.sent[currentKey], 1)
    assert.equal(compacted.publicConnectivityVerified, true)
    const unchanged = digest(await fs.readFile(notificationFile))
    assert.equal(checkpointWrites, 1)
    for (let index = 0; index < 100; index++) { clock += 30000; await worker.tick() }
    assert.equal(checkpointWrites, 1)
    assert.equal(digest(await fs.readFile(notificationFile)), unchanged)
    assert.equal(deliveries, 0)
  } finally { fs.rename = originalRename; worker.stop() }
  pass('7,501 notification dedupe records compact to 4,096 recent history plus all current recipients; 100 idle ticks perform no checkpoint writes or duplicate mail')

  const retryDirectory = path.join(root, 'retry-auth')
  await fs.mkdir(retryDirectory)
  const retryFile = path.join(retryDirectory, 'tunnel-notifications.json')
  await putJson(retryFile, { version: 1, currentUrl: origin, status: 'retry_pending', publicConnectivityVerified: true, updatedAt: clock, sent: {}, tasks: [{ key: currentKey, email: currentEmail, status: 'pending', attempts: 1000000000, nextAttemptAt: 0, lastError: 'smtp_failed' }] })
  const retryWorker = createTunnelNotificationWorker({ authDirectory: retryDirectory, currentUrl: () => origin, smtpConfigured: () => true, now: () => clock, loadUsers: async () => [{ id: 'registered', email: currentEmail, verifiedAt: 1 }], verifyPublic: async () => true, send: async () => { throw new Error('Synthetic SMTP failure') } })
  for (let index = 0; index < 20; index++) { await retryWorker.tick(); clock += 1800000 }
  const retry = await readJson(retryFile)
  assert.equal(retry.tasks.length, 1)
  assert.equal(retry.tasks[0].status, 'pending')
  assert.equal(retry.tasks[0].attempts, 7)
  assert.equal(retry.tasks[0].lastError, 'smtp_failed')
  retryWorker.stop()
  pass('failed SMTP work remains durable while retry counters and backoff remain bounded over repeated outages')

  for (const behavior of ['oversized', 'multiline', 'slow-drip']) {
    const fake = net.createServer(socket => {
      if (behavior === 'oversized') socket.write(`220 ${'x'.repeat(32769)}`)
      else if (behavior === 'multiline') socket.write(Array.from({ length: 101 }, () => '220-more').join('\r\n') + '\r\n')
      else {
        socket.write('220 waiting')
        const timer = setInterval(() => { socket.write('x') }, 250)
        socket.once('close', () => clearInterval(timer))
      }
    })
    const port = await listen(fake)
    Object.assign(process.env, { FLOWBOARD_SMTP_HOST: '127.0.0.1', FLOWBOARD_SMTP_PORT: String(port), FLOWBOARD_SMTP_SECURE: 'false', FLOWBOARD_SMTP_USER: 'synthetic@qq.com', FLOWBOARD_SMTP_FROM: 'synthetic@qq.com', FLOWBOARD_SMTP_PASS: 'synthetic-test-only' })
    const startedAt = Date.now()
    await assert.rejects(runtime.sendSmtpMail('100@qq.com', 'synthetic-code'), error => {
      assert.equal(error.message, behavior === 'slow-drip' ? 'SMTP total timeout' : 'SMTP response exceeds limit')
      assert.ok(!error.message.includes('synthetic-test-only'))
      return true
    })
    if (behavior === 'slow-drip') assert.ok(Date.now() - startedAt >= 4800 && Date.now() - startedAt < 9000)
    await new Promise(resolve => fake.close(resolve))
    servers.delete(fake)
  }
  pass('actual TCP SMTP rejects oversized/multiline responses, closes sockets, and ends an active slow stream at its absolute deadline')

  await runtime.appendRuntimeLog(authPaths, { level: 'error', event: 'growth-log', message: '界'.repeat(5000), details: { oversized: 'x'.repeat(120000) } })
  await runtime.flushRuntimeLogs()
  for (const name of ['operations.log', 'errors.log']) {
    const bytes = await fs.readFile(path.join(authPaths.logDirectory, name))
    assert.ok(bytes.length <= 16384)
    const log = JSON.parse(bytes.toString().trim())
    assert.equal(log.message.length, 2048)
    assert.deepEqual(log.details, { truncated: true })
  }
  await runtime.closeRuntimeLogs()
  pass('runtime log integration caps serialized entries before buffering and flushes both fixed diagnostic files')

  if (option('--report')) await fs.writeFile(path.resolve(option('--report')), `${JSON.stringify({ status: 'PASS', groups: results.length, tests: results }, null, 2)}\n`)
} finally {
  await runtime.closeRuntimeLogs()
  for (const socket of sockets) socket.destroy()
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))))
  for (const envKey of Object.keys(process.env)) if (!(envKey in previousEnv)) delete process.env[envKey]
  Object.assign(process.env, previousEnv)
  await fs.rm(root, { recursive: true, force: true })
}
