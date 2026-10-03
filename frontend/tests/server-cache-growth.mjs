import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-server-cache-'))
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const bundle = path.join(directory, 'server.cjs')
if (option('--server')) await fs.copyFile(path.resolve(option('--server')), bundle)
else {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'server.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: bundle })
}
const dist = path.join(directory, 'dist')
const runtime = path.join(directory, 'runtime')
await fs.mkdir(dist)
await fs.mkdir(runtime)
const html = '<!doctype html><title>Bounded cache fixture</title>'
await fs.writeFile(path.join(dist, 'index.html'), html)
const asset = Buffer.alloc(192 * 1024, 42)
for (let index = 0; index < 100; index += 1) await fs.writeFile(path.join(dist, `asset-${index}.bin`), asset)
const large = Buffer.alloc(8 * 1024 * 1024, 91)
await fs.writeFile(path.join(dist, 'large.bin'), large)
let child
let port
const heldRequests = []
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const value = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return value
}
async function start(daemon = false) {
  port = await freePort()
  child = spawn(process.execPath, [bundle, '--host', '127.0.0.1', '--port', String(port), '--no-open', '--no-console', ...(daemon ? ['--daemon'] : [])], {
    env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_TUNNEL_NOTIFY: 'false', FLOWBOARD_NO_DAEMON: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errors = ''
  child.stdout.resume()
  child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4096) })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
      if (response.status === 200 && (await response.json()).app === 'FlowBoard') return
    } catch { /* Wait for the actual listener. */ }
    await pause(50)
  }
  throw new Error(`Server startup timed out: ${errors}`)
}
async function stop() {
  for (const request of heldRequests) request.destroy()
  heldRequests.length = 0
  if (!child || child.exitCode !== null) return
  const exiting = once(child, 'exit')
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000)
  const [code, signal] = await exiting
  clearTimeout(timeout)
  if (process.platform !== 'win32') assert.equal(code, 0, `Expected graceful exit, signal=${signal}`)
  child = undefined
}

function holdRequest() {
  const request = http.request({ host: '127.0.0.1', port, path: '/api/auth/login', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '4096' }, agent: false })
  request.on('error', () => undefined)
  request.on('response', response => response.resume())
  request.write('{')
  heldRequests.push(request)
  return request
}

async function waitStatus(route, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1000) })
    await response.arrayBuffer()
    if (response.status === status) return response
    await pause(20)
  }
  throw new Error(`Expected ${route} to reach HTTP ${status}`)
}

try {
  await start()
  for (let index = 0; index < 100; index += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/asset-${index}.bin`)
    assert.equal(response.status, 200)
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(asset))
  }
  const firstAgain = await fetch(`http://127.0.0.1:${port}/asset-0.bin`)
  assert.equal(hash(Buffer.from(await firstAgain.arrayBuffer())), hash(asset))
  const response = await fetch(`http://127.0.0.1:${port}/large.bin`)
  assert.equal(response.status, 200)
  assert.equal(Number(response.headers.get('content-length')), large.length)
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(large))
  const head = await fetch(`http://127.0.0.1:${port}/large.bin`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/projects/example`)).text(), html)
  assert.equal((await fetch(`http://127.0.0.1:${port}/../missing.bin`)).status, 404)
  for (let index = 0; index < 32; index += 1) holdRequest()
  const overloaded = await waitStatus('/api/debug', 503)
  assert.equal(overloaded.headers.get('retry-after'), '2')
  assert.equal(overloaded.headers.get('connection'), 'close')
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200)
  assert.notEqual((await fetch(`http://127.0.0.1:${port}/api/management/projects/mproj_fixture/live`)).status, 503)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/management/projects/mproj_fixture/live`, { method: 'POST' })).status, 503)
  const first = heldRequests[0]
  const completed = new Promise(resolve => first.once('response', response => { response.once('end', resolve); response.resume() }))
  first.end('"email":"absent-growth@example.com","password":"TestPassword123"}'.padEnd(4095, ' '))
  await completed
  await waitStatus('/api/debug', 404)
  holdRequest()
  await waitStatus('/api/debug', 503)
  heldRequests[1].destroy()
  await waitStatus('/api/debug', 404)
  for (const request of heldRequests) request.destroy()
  heldRequests.length = 0
  console.log('PASS ordinary API admission caps 32 unfinished uploads, returns 503/Retry-After, exempts health and GET SSE, releases on finish and close')
  await stop()
  console.log('PASS real HTTP server serves 100 cache entries, reloaded eviction, 8 MiB stream, HEAD, SPA fallback and shutdown')

  if (process.platform !== 'win32') {
    const log = path.join(runtime, 'logs', 'daemon.log')
    await fs.writeFile(log, 'legacy diagnostic\n'.repeat(400_000))
    await start(true)
    // The watchdog awaits its initialization flush before spawning the child.
    // A successful health response is the synchronization point, not a sleep.
    assert.ok((await fs.stat(log)).size <= 5 * 1024 * 1024)
    await stop()
    const stopped = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }).then(() => false, () => true)
    assert.equal(stopped, true)
    console.log('PASS real Linux watchdog compacts old daemon log and SIGTERM stops both parent and server child')
  }
} finally {
  await stop()
  await fs.rm(directory, { recursive: true, force: true })
}
