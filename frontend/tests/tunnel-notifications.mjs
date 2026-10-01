import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-notifications-'))
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const modulePath = option('--module') ? path.resolve(option('--module')) : path.join(root, 'notifications.cjs')
const smtpModulePath = option('--smtp-module') ? path.resolve(option('--smtp-module')) : path.join(root, 'smtp.cjs')
if (!option('--module') || !option('--smtp-module')) {
  const { build } = await import('esbuild')
  if (!option('--module')) await build({ entryPoints: [path.join(frontend, 'tunnelNotifications.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: modulePath })
  if (!option('--smtp-module')) await build({ entryPoints: [path.join(frontend, 'runtimeCore.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: smtpModulePath })
}
const require = createRequire(import.meta.url)
const { activeQqRecipients, createTunnelNotificationWorker, verifyPublicFlowBoard } = require(modulePath)
const originA = 'https://first-blue-lamp.trycloudflare.com'
const originB = 'https://second-green-lamp.trycloudflare.com'
const originC = 'https://third-orange-lamp.trycloudflare.com'
const active = email => ({ id: `usr_${email}`, email, verifiedAt: 1 })

try {
  assert.deepEqual(activeQqRecipients([
    active('100@qq.com'), active('100@QQ.COM'), active('200@qq.com'), active('other@example.com'),
    { ...active('300@qq.com'), disabled: true }, { ...active('400@qq.com'), active: false },
    { ...active('500@qq.com'), deletedAt: 1 }, { ...active('600@qq.com'), status: 'disabled' },
    { ...active('700@qq.com'), verifiedAt: 0 }, { email: '800@qq.com', verifiedAt: 1 },
    active('bad\naddress@qq.com'),
  ]), ['100@qq.com', '200@qq.com'])
  let origin = originA
  let configured = false
  let publicReady = false
  let clock = 100000
  let users = [active('100@qq.com'), active('200@qq.com'), { ...active('300@qq.com'), disabled: true }, active('other@example.com')]
  let failOnce = true
  let changeDuringSend = false
  const delivered = []
  const attempts = []
  const healthChecks = []
  const settings = {
    authDirectory: path.join(root, 'auth-data'), currentUrl: () => origin, smtpConfigured: () => configured,
    loadUsers: async () => users, now: () => clock,
    verifyPublic: async url => { healthChecks.push(url); return publicReady },
    send: async (email, url, messageId) => {
      attempts.push({ email, url, messageId })
      if (email === '200@qq.com' && failOnce) { failOnce = false; throw new Error('Simulated offline SMTP') }
      delivered.push({ email, url, messageId })
      if (changeDuringSend && url === originB && email === '100@qq.com') origin = originC
    },
  }
  let worker = createTunnelNotificationWorker(settings)
  const checkpoint = () => fs.readFile(path.join(settings.authDirectory, 'tunnel-notifications.json'), 'utf8').then(JSON.parse)
  await worker.tick()
  assert.equal(worker.status().status, 'not_configured')
  assert.equal((await checkpoint()).tasks.length, 2)
  assert.equal(attempts.length, 0)
  assert.equal(healthChecks.length, 0)
  configured = true
  await worker.tick()
  assert.equal(worker.status().status, 'awaiting_public_health')
  assert.equal(attempts.length, 0)
  publicReady = true
  await worker.tick()
  assert.equal(worker.status().status, 'retry_pending')
  assert.equal(delivered.length, 1)
  assert.equal((await checkpoint()).publicConnectivityVerified, true)
  assert.deepEqual(delivered.map(value => value.email), ['100@qq.com'])
  const failedMessageId = attempts.find(value => value.email === '200@qq.com').messageId
  worker = createTunnelNotificationWorker(settings)
  await worker.tick()
  assert.equal(attempts.length, 2)
  clock += 30000
  await worker.tick()
  assert.equal(worker.status().status, 'up_to_date')
  assert.equal(delivered.length, 2)
  assert.equal(attempts.at(-1).messageId, failedMessageId)
  worker = createTunnelNotificationWorker(settings)
  await worker.tick()
  await worker.tick()
  assert.equal(attempts.length, 3)
  assert.equal(new Set(delivered.map(value => `${value.url}:${value.email}`)).size, delivered.length)
  console.log('PASS: active QQ filtering, not-configured/offline pending, bounded retry and persisted restart dedupe')

  origin = originB
  changeDuringSend = true
  await worker.tick()
  assert.equal((await checkpoint()).currentUrl, originC)
  assert.ok(delivered.every(value => !(value.url === originB && value.email === '200@qq.com')))
  assert.ok((await checkpoint()).tasks.every(task => task.status === 'pending'))
  changeDuringSend = false
  await worker.tick()
  assert.equal((await checkpoint()).currentUrl, originC)
  assert.equal(worker.status().status, 'up_to_date')
  assert.equal(delivered.filter(value => value.url === originC).length, 2)
  const beforeInvalid = attempts.length
  const checksBeforeInvalid = healthChecks.length
  origin = 'https://untrusted.example.com'
  await worker.tick()
  assert.equal(worker.status().status, 'no_current_url')
  assert.equal((await checkpoint()).tasks.length, 0)
  assert.equal(attempts.length, beforeInvalid)
  assert.equal(healthChecks.length, checksBeforeInvalid)
  origin = originA
  await worker.tick()
  assert.equal(attempts.length, beforeInvalid)
  users = [...users, active('900@qq.com')]
  await worker.tick()
  assert.equal(delivered.at(-1).email, '900@qq.com')
  assert.equal(delivered.filter(value => value.url === originA && value.email === '900@qq.com').length, 1)
  console.log('PASS: changed URL drops old unsent work, invalid origins never send, returning URLs dedupe and new registrations receive once')

  let releaseHealth
  let healthStarted
  const waitingForHealth = new Promise(resolve => { healthStarted = resolve })
  const pausedHealth = new Promise(resolve => { releaseHealth = resolve })
  const stoppedWorker = createTunnelNotificationWorker({
    ...settings, authDirectory: path.join(root, 'stopped-auth'),
    verifyPublic: async () => { healthStarted(); return pausedHealth },
  })
  const attemptsBeforeStop = attempts.length
  const blockedTick = stoppedWorker.tick()
  await waitingForHealth
  stoppedWorker.stop()
  releaseHealth(true)
  await blockedTick
  await stoppedWorker.tick()
  assert.equal(attempts.length, attemptsBeforeStop)
  const concurrentWorker = createTunnelNotificationWorker({ ...settings, authDirectory: path.join(root, 'concurrent-auth') })
  const firstTick = concurrentWorker.tick()
  const secondTick = concurrentWorker.tick()
  assert.equal(firstTick, secondTick)
  await firstTick
  assert.equal(attempts.length - attemptsBeforeStop, 3)
  const offlineWorker = createTunnelNotificationWorker({
    ...settings, authDirectory: path.join(root, 'offline-auth'),
    verifyPublic: async () => { throw new Error('Simulated DNS failure') },
  })
  const attemptsBeforeOffline = attempts.length
  await offlineWorker.tick()
  assert.equal(offlineWorker.status().status, 'awaiting_public_health')
  assert.equal(attempts.length, attemptsBeforeOffline)
  console.log('PASS: stopped worker sends nothing after delayed health, concurrent ticks serialize and DNS failure stays pending')

  // Exercise both awaits immediately before SMTP, rather than only switching
  // the URL inside send() when the old message is already in flight.
  for (const phase of ['load-users', 'checkpoint']) {
    for (const action of ['change-url', 'stop']) {
      let raceOrigin = originA
      let usersLoads = 0
      let paused = false
      let pauseReached
      let releasePause
      const reached = new Promise(resolve => { pauseReached = resolve })
      const release = new Promise(resolve => { releasePause = resolve })
      const raceDelivered = []
      const raceHealth = []
      const raceDirectory = path.join(root, `race-${phase}-${action}`)
      const raceFile = path.join(raceDirectory, 'tunnel-notifications.json')
      const pause = async () => { paused = true; pauseReached(); await release }
      const originalRename = fs.rename
      const raceSettings = {
        authDirectory: raceDirectory, currentUrl: () => raceOrigin, smtpConfigured: () => true,
        loadUsers: async () => {
          usersLoads++
          if (phase === 'load-users' && usersLoads === 2) await pause()
          return [active('100@qq.com')]
        },
        verifyPublic: async url => { raceHealth.push(url); return true },
        send: async (email, url) => { raceDelivered.push({ email, url }) },
      }
      const raceWorker = createTunnelNotificationWorker(raceSettings)
      if (phase === 'checkpoint') {
        fs.rename = async (source, destination) => {
          await originalRename(source, destination)
          if (destination === raceFile && !paused) {
            const persisted = JSON.parse(await fs.readFile(raceFile, 'utf8'))
            if (persisted.tasks.some(task => task.status === 'sending')) await pause()
          }
        }
      }
      try {
        const pendingTick = raceWorker.tick()
        await reached
        if (action === 'change-url') raceOrigin = originB
        else raceWorker.stop()
        releasePause()
        await pendingTick
        assert.deepEqual(raceDelivered, [])
        if (action === 'change-url') {
          const persisted = JSON.parse(await fs.readFile(raceFile, 'utf8'))
          assert.equal(persisted.currentUrl, originB)
          assert.ok(persisted.tasks.every(task => task.status === 'pending'))
          assert.equal(persisted.publicConnectivityVerified, false)
          await raceWorker.tick()
          assert.deepEqual(raceDelivered, [{ email: '100@qq.com', url: originB }])
          assert.deepEqual(raceHealth, [originA, originB])
        } else {
          await raceWorker.tick()
          assert.deepEqual(raceDelivered, [])
        }
      } finally {
        fs.rename = originalRename
        releasePause()
        raceWorker.stop()
      }
    }
  }
  console.log('PASS: URL changes and stop during user loading or durable sending checkpoint prevent stale SMTP sends')

  const originalGet = https.get
  let transportCalls = 0
  let responseStatus = 200
  let responseBody = '{"app":"FlowBoard","status":"ok"}'
  https.get = (url, options, callback) => {
    transportCalls++
    assert.equal(url, `${originA}/api/health`)
    assert.equal(options.rejectUnauthorized, true)
    const request = new EventEmitter()
    request.destroy = () => request
    queueMicrotask(() => {
      const response = new EventEmitter()
      response.statusCode = responseStatus
      response.headers = { location: originB }
      response.setEncoding = () => response
      callback(response)
      response.emit('data', responseBody)
      response.emit('end')
    })
    return request
  }
  try {
    assert.equal(await verifyPublicFlowBoard('https://bad.example.com'), false)
    assert.equal(transportCalls, 0)
    assert.equal(await verifyPublicFlowBoard(originA), true)
    responseStatus = 302
    assert.equal(await verifyPublicFlowBoard(originA), false)
    responseStatus = 200
    responseBody = '{"app":"AnotherApp","status":"ok"}'
    assert.equal(await verifyPublicFlowBoard(originA), false)
    responseBody = 'x'.repeat(4097)
    assert.equal(await verifyPublicFlowBoard(originA), false)
  } finally { https.get = originalGet }
  console.log('PASS: external health transport keeps TLS validation, does not follow redirects and rejects wrong/oversized responses')

  // Local fake SMTP exercises the real shared sender. No external mail server is contacted.
  let passwordResponse = 'reject'
  let acceptedMessages = 0
  let capturedMessage = ''
  const fakeSmtp = net.createServer(socket => {
    socket.setEncoding('utf8')
    socket.write('220 local-test ESMTP\r\n')
    let buffer = ''
    let stage = 'command'
    socket.on('error', () => undefined)
    socket.on('data', part => {
      buffer += part
      while (buffer.includes('\r\n')) {
        const separator = buffer.indexOf('\r\n')
        const line = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        if (stage === 'data') {
          if (line === '.') { acceptedMessages++; socket.end('250 queued\r\n'); stage = 'done' }
          else capturedMessage += `${line}\n`
        } else if (stage === 'username') { socket.write('334 Password:\r\n'); stage = 'password' }
        else if (stage === 'password') {
          const responses = {
            reject: `535 rejected ${line}\r\n`,
            malformed: `invalid AUTH response ${line}\r\n`,
            numeric: `000 invalid AUTH response ${line}\r\n`,
            multiline: `235-echo ${line}\r\ninvalid continuation ${line}\r\n`,
            mismatched: `235-echo ${line}\r\n535 echoed ${line}\r\n`,
            accepted: '235 authenticated\r\n',
          }
          socket.write(responses[passwordResponse])
          stage = 'command'
        }
        else if (line.startsWith('EHLO')) socket.write('250 local-test\r\n')
        else if (line === 'AUTH LOGIN') { socket.write('334 Username:\r\n'); stage = 'username' }
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 ok\r\n')
        else if (line === 'DATA') { socket.write('354 go\r\n'); stage = 'data' }
        else if (line === 'QUIT') socket.end('221 bye\r\n')
      }
    })
  })
  await new Promise(resolve => fakeSmtp.listen(0, '127.0.0.1', resolve))
  const fakePassword = randomBytes(24).toString('hex')
  const previousEnv = { ...process.env }
  try {
    Object.assign(process.env, { FLOWBOARD_SMTP_HOST: '127.0.0.1', FLOWBOARD_SMTP_PORT: String(fakeSmtp.address().port), FLOWBOARD_SMTP_SECURE: 'false', FLOWBOARD_SMTP_USER: 'sender@qq.com', FLOWBOARD_SMTP_FROM: 'sender@qq.com', FLOWBOARD_SMTP_PASS: fakePassword })
    const { sendTunnelNotificationMail, sendSmtpMail } = require(smtpModulePath)
    const messageId = `<flowboard-tunnel-${'a'.repeat(64)}@flowboard.local>`
    await assert.rejects(sendTunnelNotificationMail('100@qq.com', originA, messageId), error => {
      assert.equal(error.message, 'SMTP AUTH password failed: 535')
      assert.ok(!error.message.includes(fakePassword) && !error.message.includes(Buffer.from(fakePassword).toString('base64')))
      return true
    })
    for (const response of ['malformed', 'numeric', 'multiline', 'mismatched']) {
      passwordResponse = response
      for (const send of [
        () => sendTunnelNotificationMail('100@qq.com', originA, messageId),
        () => sendSmtpMail('100@qq.com', '123456'),
      ]) {
        await assert.rejects(send(), error => {
          assert.equal(error.message, 'Invalid SMTP response')
          assert.ok(!error.message.includes(fakePassword) && !error.message.includes(Buffer.from(fakePassword).toString('base64')))
          return true
        })
      }
    }
    passwordResponse = 'accepted'
    await sendTunnelNotificationMail('100@qq.com', originA, messageId)
    assert.equal(acceptedMessages, 1)
    assert.ok(capturedMessage.includes(`Message-ID: ${messageId}`) && capturedMessage.includes(originA))
    await assert.rejects(sendTunnelNotificationMail('other@example.com', originA, messageId))
    assert.equal(acceptedMessages, 1)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
    await new Promise(resolve => fakeSmtp.close(resolve))
  }
  console.log('PASS: real shared SMTP sender redacts rejected/malformed AUTH responses, accepts DATA without relying on QUIT and blocks non-QQ tunnel mail')

  await fs.writeFile(path.join(settings.authDirectory, 'tunnel-notifications.json'), '{broken')
  const countBeforeCorruption = attempts.length
  worker = createTunnelNotificationWorker(settings)
  await worker.tick()
  assert.equal(worker.status().status, 'storage_or_user_data_error')
  assert.equal(attempts.length, countBeforeCorruption)
  console.log('PASS: corrupt checkpoint fails closed instead of erasing dedupe history and resending')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
