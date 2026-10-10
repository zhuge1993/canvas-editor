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
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-decision-'))
const fixture = path.join(runtime, 'fixture.cjs')
await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
let mode = 'valid', calls = 0, payload, revoke, cancelled = false
const model = http.createServer(async (req, res) => {
  const reply = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
  if (req.url === '/health') return reply({ status: 'ready', model: mode === 'wrong-model' ? 'Qwen' : 'AgentJev-0.6B', output_token_decoding: false })
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); calls++
  if (mode === 'cancel') { res.on('close', () => { cancelled = true }); return }
  if (mode === 'revoke') await revoke()
  const answers = payload.questions.map(q => {
    const keys = q.type === 'choice' ? Object.keys(q.options) : q.type === 'boolean' ? ['true', 'false'] : q.levels.map((_, i) => String(i))
    const probs = keys.map((_, i) => i === 0 ? 0.8 : 0.2 / (keys.length - 1))
    return { id: mode === 'bad-id' ? 'wrong' : q.id, type: q.type, value: 'untrusted', distribution: Object.fromEntries(keys.map((k, i) => [k, mode === 'bad-probability' ? 0.9 : probs[i]])) }
  })
  reply({ model: 'AgentJev-0.6B', api_version: 'agentjev.decision.v1', results: [{ id: 'decision', answers }], usage: { generated_tokens: mode === 'generation' ? 1 : 0, truncated_inputs: mode === 'truncation' ? 1 : 0 } })
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
let server, port, cookie, otherCookie, count = 0
const password = randomBytes(24).toString('hex')
const q = { id: 'kind', type: 'choice', question: '这是什么问题？', options: { bug: '程序问题', request: '功能需求' } }
const input = { state: '保存后图形消失', questions: [q], context: { kind: 'workspace' } }
async function request(route, value, auth = cookie, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: auth } : {}), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000) })
  const text = await response.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
async function check(name, fn) { await fn(); count++; console.log(`PASS: ${name}`) }
async function register(email, inviteCode) {
  const code = await request('/api/auth/send-code', { email, ...(inviteCode ? { inviteCode } : {}) }, null)
  const result = await request('/api/auth/register', { email, password, code: code.data.developmentCode, ...(inviteCode ? { inviteCode } : {}) }, null)
  assert.equal(result.status, 201); return result.cookie
}
try {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'decision-owner@example.com', FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_GUEST_MODE: '0', FLOWBOARD_TUNNEL_NOTIFY: 'false', FLOWBOARD_DECISION_URL: `http://127.0.0.1:${model.address().port}` }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; server.stderr.on('data', value => { errors += value })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${errors}`)), 15000)
    server.once('message', value => { clearTimeout(timer); resolve(value.port) })
    server.once('error', reject); server.once('exit', code => reject(new Error(`exited ${code}: ${errors}`)))
  })
  cookie = await register('decision-owner@example.com')
  const invite = await request('/api/admin/invites', { maxUses: 2 })
  otherCookie = await register('decision-other@example.com', invite.data.code)
  const created = await request('/api/management/projects', { name: '私有决策测试项目', description: '仅所有者可见', mutationId: 'decision-project' })
  assert.equal(created.status, 201)
  const projectId = created.data.id
  await check('anonymous access is denied before any model call', async () => {
    const before = calls; assert.equal((await request('/api/decision/evaluate', input, null)).status, 401); assert.equal(calls, before)
    assert.equal((await request('/api/decision/status', undefined, null)).status, 401)
  })
  await check('only the selected decision model reports ready', async () => {
    assert.equal((await request('/api/decision/status')).data.available, true)
    mode = 'wrong-model'; assert.equal((await request('/api/decision/status')).data.available, false); mode = 'valid'
  })
  await check('real runtime forwards authorized state; result is derived from probabilities', async () => {
    const result = await request('/api/decision/evaluate', { ...input, context: { kind: 'project', id: projectId } })
    assert.equal(result.status, 200); assert.equal(result.data.answers[0].value, 'bug'); assert.equal(result.data.answers[0].top_probability, 0.8)
    assert.equal(result.data.generatedTokens, 0); assert.equal(result.data.readOnly, true)
    assert.ok(JSON.stringify(payload.state).includes('私有决策测试项目'))
    assert.equal(result.data.sources[0].id, projectId)
  })
  await check('other account and invalid resource paths cannot reach inference', async () => {
    const before = calls
    assert.equal((await request('/api/decision/evaluate', { ...input, context: { kind: 'project', id: projectId } }, otherCookie)).status, 404)
    assert.equal((await request('/api/decision/evaluate', { ...input, context: { kind: 'project', id: '../../auth-data/users' } })).status, 400)
    assert.equal(calls, before)
  })
  await check('choice, boolean and ordinal score use the same typed probability contract', async () => {
    const result = await request('/api/decision/evaluate', { ...input, questions: [q, { id: 'truth', type: 'boolean', question: '是否属于故障？' }, { id: 'urgency', type: 'score', question: '有多紧急？', levels: ['低', '高'] }] })
    assert.equal(result.status, 200); assert.equal(result.data.answers[1].probability, 0.8); assert.equal(result.data.answers[1].value, true); assert.equal(result.data.answers[2].score, 0.2)
  })
  await check('invalid probabilities, ids, generation or truncated answers are rejected', async () => {
    for (const value of ['bad-probability', 'bad-id', 'generation', 'truncation']) { mode = value; assert.equal((await request('/api/decision/evaluate', input)).status, 502) }
    mode = 'valid'
  })
  await check('duplicate descriptions and malformed questions are rejected before inference', async () => {
    const before = calls
    assert.equal((await request('/api/decision/evaluate', { ...input, questions: [{ ...q, options: { a: '重复', b: '重复' } }] })).status, 400)
    assert.equal((await request('/api/decision/evaluate', { ...input, questions: [q, q] })).status, 400)
    assert.equal(calls, before)
  })
  await check('cross-origin submissions are denied', async () => {
    const before = calls; assert.equal((await request('/api/decision/evaluate', input, cookie, { Origin: 'https://attacker.example' })).status, 403); assert.equal(calls, before)
  })
  await check('revoked resource access is rechecked after inference', async () => {
    const file = path.join(runtime, 'project-data', 'management', 'projects', `${projectId}.json`)
    const saved = await fs.readFile(file)
    revoke = async () => { const stored = JSON.parse(saved); stored.deletedAt = Date.now(); await fs.writeFile(file, JSON.stringify(stored)) }
    mode = 'revoke'; assert.equal((await request('/api/decision/evaluate', { ...input, context: { kind: 'project', id: projectId } })).status, 404)
    await fs.writeFile(file, saved); mode = 'valid'
  })
  await check('cancelling the browser closes its upstream request', async () => {
    mode = 'cancel'; const controller = new AbortController(), before = calls
    const pending = fetch(`http://127.0.0.1:${port}/api/decision/evaluate`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal }).catch(error => error)
    const deadline = Date.now() + 5000
    while (calls === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(calls > before); controller.abort(); await pending
    while (!cancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(cancelled); mode = 'valid'
  })
  await check('retired voice endpoints are absent for GET and POST', async () => {
    assert.equal((await request('/api/voice/ask', { text: 'hello' })).status, 404)
    assert.equal((await request('/api/voice/status', undefined, null)).status, 404)
    assert.equal((await request('/api/voice/ask', undefined, null)).status, 404)
  })
  console.log(JSON.stringify({ status: 'PASS', cases: count, inference: 'protocol fixture; actual model tested separately' }))
} finally {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
  await fs.rm(runtime, { recursive: true, force: true })
}
