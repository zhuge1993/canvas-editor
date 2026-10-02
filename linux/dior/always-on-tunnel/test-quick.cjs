'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const http = require('node:http')
const https = require('node:https')
const dns = require('node:dns')
const { extractQuickUrl, lineCollector, cloudArgs, startQuick, requestStatus, healthyFlowBoard } = require('./dior-quick-tunnel.cjs')

const READY = 'http://127.0.0.1:20241/ready'
const HEALTH = 'http://127.0.0.1:3000/api/health'
const OFFICIAL = 'https://api.trycloudflare.com/'
const ORIGIN = 'https://quiet-river-test.trycloudflare.com'

function fakeWatchdog(root, options = {}) {
  let time = 0
  let ready = options.ready || [503]
  let readyIndex = 0
  const timers = new Set()
  const requests = []
  const signals = []
  const child = new EventEmitter()
  child.pid = 1234
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = signal => {
    signals.push(signal)
    queueMicrotask(() => child.emit('close', 0, signal))
    return true
  }
  const state = fs.mkdtempSync(path.join(root, 'watchdog-'))
  const active = startQuick({ stateDir: state, quiet: true, signals: false,
    spawnImpl: () => child,
    nowImpl: () => time,
    setTimeoutImpl(fn, delay) { const timer = { fn, delay, unref() {} }; timers.add(timer); return timer },
    clearTimeoutImpl(timer) { timers.delete(timer) },
    checkStatusImpl: options.checkStatus || (async (url, details) => {
      requests.push({ url, details })
      if (url === READY) return { statusCode: ready[Math.min(readyIndex++, ready.length-1)] }
      if (url === HEALTH) return options.origin === undefined
        ? { statusCode: 200, body: JSON.stringify({ app: 'FlowBoard', status: 'ok' }) } : options.origin
      if (url === OFFICIAL) return options.official === undefined ? { statusCode: 405 } : options.official
      throw new Error('unexpected endpoint')
    }),
  })
  child.stdout.write(`| ${ORIGIN} |\n`)
  return { active, child, state, timers, requests, signals,
    async check(at) { time = at; await active.checkReadiness() },
    url() { return fs.readFileSync(path.join(state, 'public-url'), 'utf8').trim() },
    async stop() { active.stop(); assert.equal(await active.done, 0); assert.equal(timers.size, 0) },
  }
}

async function watchdogTests(root) {
  let fixture = fakeWatchdog(root, { ready: [200] })
  assert.equal([...fixture.timers][0].delay, 60000)
  await fixture.check(59000)
  assert.equal(fixture.requests.length, 0, 'warmup suppresses probes and recovery')
  await fixture.check(60000)
  await fixture.check(90000)
  await fixture.check(120000)
  assert.equal(fixture.requests.length, 3)
  assert.ok(fixture.requests.every(item => item.url === READY), 'healthy ready never probes the WAN or origin')
  assert.equal([...fixture.timers][0].delay, 30000)
  assert.equal(fixture.signals.length, 0)
  assert.equal(fixture.url(), ORIGIN)
  await fixture.stop()

  fixture = fakeWatchdog(root, { ready: [503, 503, 200, 503, 503, 503] })
  for (const at of [60000, 90000, 120000, 150000, 180000]) await fixture.check(at)
  assert.equal(fixture.signals.length, 0, 'healthy readiness resets the consecutive failure count')
  assert.equal(fixture.url(), ORIGIN)
  await fixture.check(210000)
  assert.deepEqual(fixture.signals, ['SIGTERM'])
  assert.equal(fixture.url(), '')
  assert.equal(await fixture.active.done, 1, 'watchdog exit lets OpenRC respawn the wrapper')
  assert.equal(fixture.timers.size, 0)
  const exited = JSON.parse(fs.readFileSync(path.join(fixture.state, 'status.json'), 'utf8'))
  assert.equal(exited.reason, 'cloudflared-not-ready')
  assert.equal(exited.readyFailureCount, 3)
  assert.equal(exited.publicConnectivityVerified, false)

  for (const options of [
    { official: null },
    { official: { statusCode: 503 } },
    { origin: { statusCode: 200, body: JSON.stringify({ app: 'Another app', status: 'ok' }) } },
    { origin: { statusCode: 200, body: '{invalid' } },
    { origin: null },
  ]) {
    fixture = fakeWatchdog(root, options)
    for (const at of [60000, 90000, 120000, 150000, 180000]) await fixture.check(at)
    assert.equal(fixture.signals.length, 0, 'offline/provider outage/unhealthy origin must not churn URL')
    assert.equal(fixture.url(), ORIGIN)
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.state, 'status.json'), 'utf8')).state, 'url-issued')
    await fixture.stop()
  }

  let pendingSignal, finishReady
  fixture = fakeWatchdog(root, { checkStatus(url, details) {
    assert.equal(url, READY)
    pendingSignal = details.signal
    return new Promise(resolve => {
      finishReady = resolve
      details.signal.addEventListener('abort', () => resolve(null), { once: true })
    })
  } })
  const checking = fixture.check(60000)
  await Promise.resolve(); await Promise.resolve()
  const sameCheck = fixture.active.checkReadiness()
  assert.equal(sameCheck, fixture.active.checkReadiness(), 'checks cannot overlap')
  fixture.active.stop()
  assert.equal(pendingSignal.aborted, true)
  assert.equal(await fixture.active.done, 0, 'normal stop remains success during an active request')
  await checking; await sameCheck
  assert.equal(fixture.timers.size, 0)
  finishReady({ statusCode: 503 })
  await Promise.resolve()
  assert.equal(fixture.signals.length, 1, 'late results do not cause a second termination')

  fixture = fakeWatchdog(root, { checkStatus(url, details) {
    return new Promise(resolve => details.signal.addEventListener('abort', () => resolve(null), { once: true }))
  } })
  const closeCheck = fixture.check(60000)
  await Promise.resolve(); await Promise.resolve()
  fixture.child.emit('close', 23, null)
  assert.equal(await fixture.active.done, 23)
  await closeCheck
  assert.equal(fixture.timers.size, 0)
  assert.equal(fixture.url(), '')
}

async function httpProbeTests() {
  assert.equal(healthyFlowBoard({ statusCode: 200, body: '{"app":"FlowBoard","status":"ok"}' }), true)
  assert.equal(healthyFlowBoard({ statusCode: 200, body: '{"app":"Other","status":"ok"}' }), false)
  const server = http.createServer((request, response) => {
    if (request.url === '/hang') return
    if (request.url === '/huge') { response.end('X'.repeat(5000)); return }
    response.writeHead(request.url === '/not-ready' ? 503 : 200)
    response.end('{"app":"FlowBoard","status":"ok"}')
  })
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await requestStatus(`${base}/not-ready`)).statusCode, 503)
    assert.equal(healthyFlowBoard(await requestStatus(base, { readBody: true })), true)
    assert.equal(await requestStatus(`${base}/huge`, { readBody: true }), null)
    const before = Date.now()
    assert.equal(await requestStatus(`${base}/hang`, { readBody: true, timeoutMs: 30 }), null)
    assert.ok(Date.now()-before < 1000, 'hung HTTP request is bounded')
    const cancel = new AbortController()
    const pending = requestStatus(`${base}/hang`, { readBody: true, signal: cancel.signal })
    cancel.abort()
    assert.equal(await pending, null)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
  const originalGet = https.get
  let captured
  try {
    https.get = (url, options, callback) => {
      captured = { url, options }
      const request = new EventEmitter(); request.destroy = () => {}
      queueMicrotask(() => callback({ statusCode: 405, destroy() {} }))
      return request
    }
    assert.equal((await requestStatus(OFFICIAL)).statusCode, 405)
    assert.equal(captured.url, OFFICIAL)
    assert.equal(captured.options.rejectUnauthorized, true)
    assert.equal(captured.options.family, 4)
    assert.equal(captured.options.agent, false)
  } finally { https.get = originalGet }
  const OriginalResolver = dns.Resolver
  let resolverInstance
  try {
    dns.Resolver = class {
      constructor(options) { this.options = options; this.cancelled = 0; resolverInstance = this }
      resolve4(hostname, callback) { this.hostname = hostname; this.callback = callback }
      cancel() {
        this.cancelled++
        if (this.callback) {
          const callback = this.callback; this.callback = null
          callback(Object.assign(new Error('cancelled fixture DNS'), { code: 'ECANCELLED' }))
        }
      }
    }
    https.get = (url, options, callback) => {
      const request = new EventEmitter(); request.destroy = () => {}
      options.lookup(new URL(url).hostname, { all: false }, error => {
        if (error) request.emit('error', error)
        else callback({ statusCode: 405, destroy() {} })
      })
      return request
    }
    assert.equal(await requestStatus(OFFICIAL, { timeoutMs: 30 }), null)
    assert.equal(resolverInstance.hostname, 'api.trycloudflare.com')
    assert.equal(resolverInstance.cancelled, 1, 'deadline cancels pending DNS as well as HTTP')
    const cancel = new AbortController()
    const pending = requestStatus(OFFICIAL, { signal: cancel.signal })
    cancel.abort()
    assert.equal(await pending, null)
    assert.equal(resolverInstance.cancelled, 1, 'stop cancels pending DNS immediately')
  } finally { https.get = originalGet; dns.Resolver = OriginalResolver }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fake child')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function main() {
  const origin = 'https://quiet-river-test.trycloudflare.com'
  assert.equal(extractQuickUrl(`INF | ${origin} |`), origin)
  assert.equal(extractQuickUrl(`url=${origin}/`), origin)
  for (const bad of [
    'http://quiet-river-test.trycloudflare.com', 'https://quiet-river-test.trycloudflare.com.evil.net',
    'https://user@quiet-river-test.trycloudflare.com', 'https://quiet-river-test.trycloudflare.com:443',
    'https://quiet-river-test.trycloudflare.com/path', 'https://quiet-river-test.trycloudflare.com?x=1',
    'https://quiet-river-test.trycloudflare.com#x', 'https://nested.quiet-river-test.trycloudflare.com',
    'https://-bad.trycloudflare.com', 'https://bad-.trycloudflare.com', 'https://bad_label.trycloudflare.com',
    `https://${'a'.repeat(64)}.trycloudflare.com`, `malformed${origin}`,
  ]) assert.equal(extractQuickUrl(bad), null, bad)
  const lines = []
  const collector = lineCollector(line => lines.push(line))
  collector.push('prefix ' + 'x'.repeat(9000) + '\n| https://quiet-')
  collector.push('river-test.trycloudflare.com |\r\n')
  collector.end()
  assert.deepEqual(lines, [`| ${origin} |`])
  const args = cloudArgs()
  assert.equal(args[args.indexOf('--url') + 1], 'http://127.0.0.1:3000')
  assert.equal(args[args.indexOf('--protocol') + 1], 'http2')
  assert.equal(args[args.indexOf('--config') + 1], '/dev/null')
  assert.ok(args.includes('--no-autoupdate'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dior-quick-wrapper-'))
  let active
  try {
    const state = path.join(root, 'state')
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, 'public-url'), 'https://stale.trycloudflare.com\n')
    const childFile = path.join(root, 'fake-child.cjs')
    fs.writeFileSync(childFile, `
process.stdout.write('https://bad.trycloudflare.com.evil.net\\n');
process.stderr.write('| https://quiet-river-test.trycloud');
setTimeout(() => process.stderr.write('flare.com |\\n'), 30);
setTimeout(() => process.exit(23), 500);
`, 'utf8')
    let captured
    const start = () => startQuick({ stateDir: state, quiet: true, signals: false,
      spawnImpl(binary, childArgs, options) {
        captured = { binary, childArgs, env: options.env }
        return spawn(process.execPath, [childFile], options)
      } })
    active = start()
    assert.equal(fs.readFileSync(path.join(state, 'public-url'), 'utf8'), '')
    await waitFor(() => fs.readFileSync(path.join(state, 'public-url'), 'utf8').trim() === origin)
    const issued = JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8'))
    assert.equal(issued.state, 'url-issued')
    assert.equal(issued.publicConnectivityVerified, false)
    assert.equal(issued.hostnamePermanent, false)
    assert.equal(captured.env.HOME, state)
    assert.equal(captured.binary, '/usr/local/bin/cloudflared')
    assert.equal(await active.done, 23)
    assert.equal(fs.readFileSync(path.join(state, 'public-url'), 'utf8'), '')
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8')).state, 'exited')
    // A normal service stop clears URL immediately and forwards termination.
    fs.writeFileSync(childFile, `process.stdout.write('| ${origin} |\\n'); setInterval(() => {}, 1000);`, 'utf8')
    active = start()
    await waitFor(() => fs.readFileSync(path.join(state, 'public-url'), 'utf8').trim() === origin)
    active.stop()
    assert.equal(fs.readFileSync(path.join(state, 'public-url'), 'utf8'), '')
    assert.equal(await active.done, 0)
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8')).state, 'stopped')
    assert.equal(fs.readdirSync(state).some(name => name.endsWith('.tmp')), false)
    await watchdogTests(root)
    await httpProbeTests()
    console.log('PASS: strict Quick URL/stream contracts; atomic cleanup; readiness warmup and healthy reset; 3-failure online recovery; offline/provider/origin churn protection; cancellation/close cleanup; bounded HTTP; certificate-validated official API GET405; supervisor recovery exit1/normal stop exit0')
  } finally {
    if (active && active.child && active.child.exitCode === null) active.child.kill('SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
