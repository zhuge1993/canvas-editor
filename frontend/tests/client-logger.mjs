import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-client-logger-'))
try {
  const { build } = await import('esbuild')
  const bundled = await build({ entryPoints: [path.join(frontend, 'src/utils/logger.ts')], bundle: true, platform: 'browser', target: 'es2022', format: 'cjs', write: false })
  let now = 1_000_000
  const requests = []
  const timers = new Set()
  const listeners = new Map()
  const module = { exports: {} }
  class Clock extends Date { static now() { return now } }
  const sandbox = {
    module, exports: module.exports, Date: Clock, TextEncoder, AbortController,
    window: { location: { pathname: '/editor/example', href: 'https://example.test/editor/example' },
      addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener: event => listeners.delete(event) },
    setTimeout: (handler, milliseconds) => { const timer = { handler, milliseconds }; timers.add(timer); return timer },
    clearTimeout: timer => timers.delete(timer),
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve: () => resolve({ body: { cancel: () => Promise.resolve() } }) })
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  }
  vm.runInNewContext(bundled.outputFiles[0].text, sandbox)
  const logger = module.exports
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const cycle = { text: '界'.repeat(1_000_000) }; cycle.cycle = cycle
  for (let index = 0; index < 10_000; index += 1) logger.writeLog('info', 'burst', 'message', cycle)
  await tick()
  assert.equal(requests.length, 2)
  assert.equal(timers.size, 2)
  for (const request of requests) {
    assert.ok(Buffer.byteLength(request.options.body) <= 16 * 1024)
    assert.equal(JSON.parse(request.options.body).documentId, 'example')
    assert.equal(request.options.keepalive, true)
  }
  for (const timer of [...timers]) timer.handler()
  await tick()
  assert.equal(timers.size, 0)
  logger.writeLog('info', 'after-timeout', 'released'); await tick()
  assert.equal(requests.length, 3)
  requests[2].resolve(); await tick()
  console.log('PASS offline burst allows only two timed requests and bounds huge cyclic details')

  logger.writeLog('error', 'repeat-error', 'same failure'); await tick()
  const firstErrorIndex = requests.length - 1
  requests[firstErrorIndex].resolve(); await tick()
  for (let index = 0; index < 1000; index += 1) logger.writeLog('error', 'repeat-error', 'same failure')
  await tick()
  assert.equal(requests.length, firstErrorIndex + 1)
  now += 31_000
  logger.writeLog('error', 'repeat-error', 'same failure'); await tick()
  assert.equal(requests.length, firstErrorIndex + 2)
  requests.at(-1).resolve(); await tick()
  console.log('PASS repeated error is coalesced and can be recorded again after its fixed interval')

  const baseline = requests.length
  for (let index = 0; index < 100; index += 1) {
    logger.writeLog('info', `event-${index}`, 'message'); await tick()
    requests.at(-1)?.resolve(); await tick()
  }
  assert.ok(requests.length - baseline <= 20)
  now += 60_000
  logger.writeLog('info', 'after-refill', 'message'); await tick()
  assert.ok(requests.length > baseline)
  requests.at(-1).resolve(); await tick()
  const remove = logger.installGlobalErrorLogging(); await tick()
  assert.equal(listeners.size, 2)
  requests.at(-1).resolve(); await tick()
  remove()
  assert.equal(listeners.size, 0)
  console.log('PASS sustained rate has a fixed burst budget and global listener cleanup remains correct')
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
