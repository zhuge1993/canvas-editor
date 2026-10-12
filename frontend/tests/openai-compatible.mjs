import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-openai-'))
const fixture = path.join(runtime, 'fixture.cjs'), keyFile = path.join(runtime, 'api-key')
const key = randomBytes(32).toString('hex')
await fs.writeFile(keyFile, key)
await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
let calls = 0, forwarded, port, server
const model = http.createServer(async (req, res) => {
  calls++
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  forwarded = { route: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'bge-small-zh-v1.5', object: 'model', owned_by: 'local', created: 0 }] })); return }
  const body = JSON.parse(forwarded.body)
  if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n'); return }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] }))
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
async function request(route, body, token = key, contentType = 'application/json') {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': contentType }, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(10000) })
  return { status: r.status, body: await r.text(), contentType: r.headers.get('content-type') }
}
try {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_TUNNEL_NOTIFY: 'false', FLOWBOARD_API_KEY_FILE: keyFile, FLOWBOARD_DECISION_URL: `http://127.0.0.1:${model.address().port}` }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  port = await Promise.race([once(server, 'message').then(([value]) => value.port), new Promise((_, reject) => setTimeout(() => reject(new Error('fixture timeout')), 10000).unref())])
  assert.equal((await request('/v1/models', undefined, null)).status, 401)
  assert.equal((await request('/v1/models', undefined, 'x'.repeat(40))).status, 401); assert.equal(calls, 0)
  assert.equal((await request('/v1/models')).status, 200); assert.equal(forwarded.headers.authorization, undefined)
  const input = JSON.stringify({ model: 'bge-small-zh-v1.5', messages: [{ role: 'user', content: '登录页面打不开' }] })
  const r = await request('/v1/chat/completions', input)
  assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).object, 'chat.completion'); assert.equal(forwarded.body, input)
  assert.equal(forwarded.headers.cookie, undefined)
  const sse = await request('/v1/chat/completions', JSON.stringify({ ...JSON.parse(input), stream: true }))
  assert.equal(sse.status, 200); assert.equal(sse.contentType, 'text/event-stream'); assert.ok(sse.body.includes('[DONE]'))
  const before = calls
  assert.equal((await request('/v1/chat/completions', 'x'.repeat(16385))).status, 413)
  assert.equal((await request('/v1/chat/completions', '{')).status, 400)
  assert.equal((await request('/v1/chat/completions', input, key, 'text/plain')).status, 415)
  assert.equal((await request('/v1/embeddings', '{}')).status, 404)
  assert.equal(calls, before)
  await fs.writeFile(keyFile, 'invalid')
  assert.equal((await request('/v1/models')).status, 503); assert.equal(calls, before)
  console.log('PASS OpenAI gateway: Bearer isolation, exact forwarding, JSON/SSE, body bounds and disabled configuration')
} finally {
  if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
  await fs.rm(runtime, { recursive: true, force: true })
}
