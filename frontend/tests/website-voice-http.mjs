import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Real HTTP/runtime/auth/storage with a deliberately fake inference bridge.
// This proves authorization/bounds/cancellation, not acoustic/model accuracy.
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-website-voice-'))
const tag = randomBytes(6).toString('hex')
const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\flowboard-website-voice-${tag}` : path.join(runtime, 'model.sock')
const fixture = path.join(runtime, 'fixture.cjs')
const cases = [], requests = [], connections = new Set()
let server, port, mode = 'normal', disconnected = false
const now = Date.now()
const paths = { auth: path.join(runtime, 'auth-data'), data: path.join(runtime, 'project-data'), logs: path.join(runtime, 'logs') }
const users = Object.fromEntries(['alice', 'bob', 'charlie', 'member', 'expired', 'admin', 'limit', 'cancel', 'bounds', 'errors', 'revoke'].map(name => [name,
  { id: `test_${name}`, email: `${name}@example.com`, passwordHash: 'unused fixture hash', createdAt: now, verifiedAt: now, ...(name === 'admin' ? { isAdmin: true } : {}) }]))
const sessions = Object.keys(users).map(name => ({ token: `fixture_${name}_${tag}`, userId: users[name].id, createdAt: now,
  expiresAt: name === 'expired' ? now - 1 : now + 3600000 }))
const cookie = name => `flowboard_session=fixture_${name}_${tag}`
const project = { id: 'voice_project_alice', ownerId: users.alice.id, name: 'Alice voice project', description: 'PROJECT_DESCRIPTION', color: '#123456', icon: 'folder',
  createdAt: now, updatedAt: now, revision: 0, schemaVersion: 1, receipts: [], categories: [{ id: 'bug', name: '功能问题', color: '#123456' }],
  roles: [{ id: 'dev', name: '技术', color: '#123456' }], members: [{ userId: users.member.id, permission: 'view' }, { userId: users.revoke.id, permission: 'edit' }], canvasIds: ['voice_canvas_alice'],
  events: [{ id: 'issue_1', title: 'ASR cursor input', description: 'FIX_THIS', priority: 'urgent', status: 'review', roleId: 'dev', categoryId: 'bug', assignee: '技术人员', recorder: 'Alice', attachments: [], createdAt: now, updatedAt: now },
    { id: 'issue_2', title: 'Saved issue', status: 'done', roleId: 'dev', categoryId: 'bug', assignee: '', recorder: '', attachments: [], createdAt: now - 86400000, updatedAt: now, completedAt: now }],
  history: [{ id: 'history_1', action: '验收', at: now, actorId: users.alice.id, actorName: 'Alice', eventId: 'issue_1', changes: [] }] }
const privateProject = { ...project, id: 'voice_project_bob', ownerId: users.bob.id, name: 'BOB_PRIVATE_PROJECT_SECRET', members: [], events: [] }
const canvas = { id: 'voice_canvas_alice', title: 'Alice canvas', ownerId: users.alice.id, createdAt: now, updatedAt: now,
  canvas: { shapes: { one: { id: 'one', type: 'text', text: 'ALICE_VISIBLE_CANVAS_TEXT', name: 'Text shape' } } } }
const privateCanvas = { ...canvas, id: 'voice_canvas_bob', ownerId: users.bob.id, title: 'BOB_PRIVATE_CANVAS_SECRET', canvas: { shapes: { secret: { text: 'BOB_PRIVATE_SHAPE_SECRET' } } } }
const shareToken = randomBytes(32).toString('base64url')
const shares = [{ token: shareToken, projectId: canvas.id, permission: 'view', createdAt: now, updatedAt: now }]
const write = (file, value) => fs.writeFile(file, JSON.stringify(value), 'utf8')
const projectFile = path.join(paths.data, 'management', 'projects', `${project.id}.json`)
await fs.mkdir(path.dirname(projectFile), { recursive: true }); await fs.mkdir(paths.auth, { recursive: true }); await fs.mkdir(paths.logs, { recursive: true })
await write(path.join(paths.auth, 'users.json'), Object.values(users)); await write(path.join(paths.auth, 'sessions.json'), sessions)
await write(path.join(paths.auth, 'shares.json'), shares); await write(projectFile, project)
await write(path.join(path.dirname(projectFile), `${privateProject.id}.json`), privateProject)
await write(path.join(paths.data, `${canvas.id}.json`), canvas); await write(path.join(paths.data, `${privateCanvas.id}.json`), privateCanvas)
const wav = Buffer.alloc(3644)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
const bridge = net.createServer(socket => {
  connections.add(socket); let pending = ''
  socket.on('error', () => {})
  socket.once('close', () => { connections.delete(socket); if (mode === 'hang') disconnected = true })
  socket.on('data', async chunk => {
    pending += chunk.toString('utf8')
    if (!pending.includes('\n')) return
    const request = JSON.parse(pending.trim()); pending = ''; requests.push(request)
    const respond = value => socket.end(JSON.stringify({ v: 1, id: request.id, ok: true, ...value }) + '\n')
    if (mode === 'hang') return
    if (mode === 'bad-id') { socket.end(JSON.stringify({ id: 'wrong', ok: true, text: 'INVALID' }) + '\n'); return }
    if (mode === 'busy') { socket.end(JSON.stringify({ id: request.id, ok: false, error_code: 'busy' }) + '\n'); return }
    if (['thermal', 'thermal_unavailable', 'audio_limit'].includes(mode)) { socket.end(JSON.stringify({ id: request.id, ok: false, error_code: mode }) + '\n'); return }
    if (mode === 'bad-wav') { respond({ audio_wav_base64: Buffer.from('NOT AUDIO').toString('base64') }); return }
    if (mode === 'revoke-member') { project.members = project.members.filter(member => member.userId !== users.revoke.id); await write(projectFile, project) }
    if (mode === 'revoke-share') { await write(path.join(paths.auth, 'shares.json'), []) }
    if (request.op === 'status') respond({ ready: true, active: mode === 'cooling' ? 'chat' : null, active_state: mode === 'cooling' ? 'cooling' : null,
      cooling: mode === 'cooling', thermal_waiting: mode === 'cooling', thermal_c: mode === 'cooling' ? 61 : 35, voice_asr_active: false,
      capabilities: { transcribe: true, chat: true, speech: true }, native_worker_pid: 98765 })
    else if (request.op === 'transcribe') respond({ text: '测试语音文字' })
    else if (request.op === 'tts') respond({ audio_wav_base64: wav.toString('base64'), sample_rate: 16000 })
    else respond({ text: mode === 'long-chat' ? '建议先验证页面布局和语音输入。'.repeat(12) : '本地模型测试回答' })
  })
})

async function request(route, { user = 'alice', method = 'POST', value, raw, headers = {}, signal } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: signal ?? AbortSignal.timeout(10000),
    headers: { ...(user ? { Cookie: cookie(user) } : {}), 'Content-Type': raw === undefined ? 'application/json' : 'application/octet-stream', ...headers },
    body: method === 'GET' ? undefined : raw ?? JSON.stringify(value ?? {}) })
  const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8')
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, text, bytes, headers: response.headers }
}
async function expect(route, options, status) {
  const response = await request(route, options)
  assert.equal(response.status, status, `${route}: ${response.text}`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response
}
async function caseTest(name, work) { await work(); cases.push(name); console.log(`PASS: website voice ${name}`) }
const ask = (text, kind = 'project', id = project.id) => ({ text, context: kind === 'workspace' ? { kind } : { kind, id } })
const waitUntil = async predicate => { for (let i = 0; i < 80; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error('Fixture condition timeout') }
try {
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(socketPath, resolve) })
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime,
    FLOWBOARD_VOICE_SOCKET: socketPath, FLOWBOARD_GUEST_MODE: '0', FLOWBOARD_TUNNEL_NOTIFY: 'false' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''; server.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8000) })
  port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr || 'Fixture startup timeout')), 10000)
    server.once('message', message => { clearTimeout(timer); resolve(message.port) }); server.once('error', reject) })
  await caseTest('anonymous/expired/forged sessions denied before inference', async () => {
    for (const user of [null, 'expired', 'not_registered']) await expect('/api/voice/ask', { user, value: ask('项目状态') }, 401)
    await expect('/api/voice/status', { user: null, method: 'GET' }, 401)
    assert.equal(requests.length, 0)
  })
  await caseTest('owner/member statistics are exact and private projects never included', async () => {
    const own = await expect('/api/voice/ask', { value: ask('今日技术角色等待验收问题') }, 200)
    assert.ok(own.data.answer.includes('共1条') && own.data.answer.includes('等待验收1条'))
    assert.equal(own.data.dataAnswer, true); assert.equal(own.data.readOnly, true); assert.equal(own.data.sources[0].id, project.id)
    assert.ok(own.data.spokenAnswer.length <= 120)
    const completed = await expect('/api/voice/ask', { value: ask('今日完成情况') }, 200)
    assert.ok(completed.data.answer.includes('今日完成记录共1条') && completed.data.answer.includes('Saved issue'))
    const progress = await expect('/api/voice/ask', { value: ask('技术角色处理进度') }, 200)
    assert.ok(progress.data.answer.includes('完成率50%'))
    const history = await expect('/api/voice/ask', { value: ask('今日技术工作记录') }, 200)
    assert.ok(history.data.answer.includes('Alice验收'))
    const member = await expect('/api/voice/ask', { user: 'member', value: ask('项目状态') }, 200)
    assert.ok(member.text.includes('ASR cursor input'))
    const all = await expect('/api/voice/ask', { value: ask('网站统计', 'workspace') }, 200)
    assert.ok(all.data.answer.includes('1个项目') && all.data.answer.includes('1张画布'))
    assert.equal(all.text.includes('BOB_PRIVATE'), false)
    assert.equal(requests.length, 0, 'accurate data answers do not spend model slots or invent figures')
  })
  await caseTest('ordinary user and admin cannot query unowned unshared resources', async () => {
    for (const user of ['alice', 'admin']) {
      const denied = await expect('/api/voice/ask', { user, value: ask('项目状态', 'project', privateProject.id) }, 404)
      assert.equal(denied.text.includes('BOB_PRIVATE'), false)
      await expect('/api/voice/ask', { user, value: ask('画布文字', 'canvas', privateCanvas.id) }, 404)
    }
    await expect('/api/voice/ask', { user: 'charlie', value: ask('项目状态') }, 404)
    await expect('/api/voice/ask', { user: 'member', value: ask('画布文字', 'canvas', canvas.id) }, 404)
  })
  await caseTest('canvas share grants selected canvas only and is rechecked after inference', async () => {
    const shared = await expect('/api/voice/ask', { user: 'charlie', value: ask('画布文字', 'canvas', canvas.id), headers: { 'x-flowboard-share-token': shareToken } }, 200)
    assert.ok(shared.text.includes('ALICE_VISIBLE_CANVAS_TEXT')); assert.equal(shared.text.includes('BOB_PRIVATE'), false)
    await expect('/api/voice/ask', { user: 'charlie', value: ask('画布文字', 'canvas', privateCanvas.id), headers: { 'x-flowboard-share-token': shareToken } }, 404)
    mode = 'revoke-share'
    await expect('/api/voice/ask', { user: 'charlie', value: ask('你好', 'canvas', canvas.id), headers: { 'x-flowboard-share-token': shareToken } }, 404)
    mode = 'normal'
  })
  await caseTest('model context is server-resolved, bounded, and revoked membership discards its answer', async () => {
    const result = await expect('/api/voice/ask', { user: 'bob', value: ask('分析这个项目的优先级', 'project', privateProject.id) }, 200)
    assert.ok(result.data.answer.includes('分析建议：本地模型测试回答'))
    assert.equal(result.data.dataAnswer, false); assert.ok(result.data.dataSummary.includes('BOB_PRIVATE_PROJECT_SECRET'))
    const record = requests.at(-1); assert.equal(record.op, 'chat'); assert.ok(record.context.includes('BOB_PRIVATE_PROJ'))
    assert.equal(record.context.includes('Alice voice project'), false); assert.ok(Buffer.byteLength(record.context) <= 224)
    mode = 'revoke-member'; const rejected = await expect('/api/voice/ask', { user: 'revoke', value: ask('你好') }, 404)
    assert.equal(rejected.text.includes('本地模型测试回答'), false); mode = 'normal'
    project.members.push({ userId: users.revoke.id, permission: 'view' }); await write(projectFile, project)
    mode = 'revoke-member'; const revokedWorkspace = await expect('/api/voice/ask', { user: 'revoke', value: ask('你好', 'workspace') }, 404)
    assert.equal(revokedWorkspace.text.includes('本地模型测试回答'), false); mode = 'normal'
    await expect('/api/voice/ask', { user: 'bob', value: { text: '你好', context: { kind: 'project', id: '../../auth-data/users' } } }, 400)
  })
  await caseTest('generic questions omit unrelated private data and selected analysis uses compact permitted facts', async () => {
    const greeting = await expect('/api/voice/ask', { value: ask('你好，请用一句话介绍自己。', 'workspace') }, 200)
    assert.equal(greeting.data.answer, '本地模型测试回答'); assert.equal(requests.at(-1).context, '')
    assert.deepEqual(greeting.data.sources, [], 'no data sources falsely attributed to a generic reply')
    await expect('/api/voice/ask', { value: ask('Linux是什么？') }, 200)
    assert.equal(requests.at(-1).context, '')
    const before = requests.length
    const advice = await expect('/api/voice/ask', { value: ask('分析项目问题，建议优先处理哪一条') }, 200)
    assert.equal(requests.length, before + 1); assert.equal(advice.data.dataAnswer, false)
    assert.ok(advice.data.dataSummary.includes('等待验收1条') && advice.data.answer.includes('分析建议：本地模型测试回答'))
    assert.equal(advice.data.spokenAnswer, '本地模型测试回答')
    const model = requests.at(-1); assert.ok(model.context.includes('ASR cursor input') && model.context.includes('紧急优先'))
    assert.equal(model.context.includes('BOB_PRIVATE'), false); assert.ok(Buffer.byteLength(model.context) <= 224)
    assert.equal(model.context.includes('取消0条'), false)
    const factsBefore = requests.length
    await expect('/api/voice/ask', { value: ask('项目问题一共有几条，等待验收多少条') }, 200)
    assert.equal(requests.length, factsBefore, 'factual statistics remain exact derived responses')
  })
  await caseTest('edit advice/history remain read-only queries and built-in spoken replies stay short', async () => {
    const before = await fs.readFile(projectFile)
    const advice = await expect('/api/voice/ask', { value: ask('怎么修改布局？', 'canvas', canvas.id) }, 200)
    assert.equal(advice.data.dataAnswer, false); assert.ok(advice.data.answer.includes('分析建议：本地模型测试回答'))
    for (const text of ['谁修改了这个项目？', '查看项目修改记录']) {
      const history = await expect('/api/voice/ask', { value: ask(text) }, 200)
      assert.ok(history.data.answer.includes('Alice验收')); assert.equal(history.data.answer.includes('请使用页面'), false)
    }
    const stats = await expect('/api/voice/ask', { user: 'member', value: ask('技术角色处理进度') }, 200)
    assert.ok(stats.data.answer.length > stats.data.spokenAnswer.length && stats.data.spokenAnswer.length <= 64)
    mode = 'long-chat'
    const long = await expect('/api/voice/ask', { user: 'member', value: ask('请分析项目处理优先级') }, 200)
    assert.ok(long.data.answer.includes('分析建议：') && long.data.spokenAnswer.length <= 64)
    mode = 'normal'
    const blocked = await expect('/api/voice/ask', { value: ask('请帮我删除整个项目') }, 200)
    assert.ok(blocked.data.answer.includes('只读')); assert.deepEqual(await fs.readFile(projectFile), before)
  })
  await caseTest('PCM upload and WAV response are bounded, input is not server microphone audio', async () => {
    const status = await expect('/api/voice/status', { user: 'bounds', method: 'GET' }, 200)
    assert.equal(status.data.available, true); assert.equal(status.text.includes('98765'), false)
    const recording = Buffer.alloc(3200)
    const stt = await expect('/api/voice/transcribe', { user: 'bounds', raw: recording }, 200)
    assert.equal(stt.data.text, '测试语音文字'); assert.equal(stt.data.durationMs, 100)
    const record = requests.at(-1); assert.equal(record.op, 'transcribe'); assert.equal(record.sample_rate, undefined)
    assert.deepEqual(Buffer.from(record.pcm16_base64, 'base64'), recording)
    await expect('/api/voice/transcribe', { user: 'bounds', raw: Buffer.alloc(3201) }, 400)
    await expect('/api/voice/transcribe', { user: 'bounds', raw: Buffer.alloc(640002) }, 413)
    await expect('/api/voice/transcribe', { user: 'bounds', value: { path: '/dev/snd/pcmC0D0c' } }, 415)
    const speech = await expect('/api/voice/speech', { user: 'bounds', value: { text: '你好' } }, 200)
    assert.equal(speech.headers.get('content-type'), 'audio/wav'); assert.deepEqual(speech.bytes, wav)
    await expect('/api/voice/speech', { user: 'bounds', value: { text: '声'.repeat(121) } }, 400)
  })
  await caseTest('malformed/busy bridge failures are safe and cross-site requests denied', async () => {
    mode = 'busy'; await expect('/api/voice/ask', { user: 'errors', value: ask('你好', 'workspace') }, 429)
    mode = 'bad-id'; await expect('/api/voice/ask', { user: 'errors', value: ask('你好', 'workspace') }, 502)
    mode = 'bad-wav'; await expect('/api/voice/speech', { user: 'errors', value: { text: '你好' } }, 502)
    mode = 'normal'
    await expect('/api/voice/ask', { user: 'errors', value: ask('项目状态'), headers: { Origin: 'https://attacker.example.com' } }, 403)
    await expect('/api/voice/ask', { user: 'errors', raw: Buffer.from('{bad'), headers: { 'Content-Type': 'application/json' } }, 400)
    await expect('/api/voice/ask', { user: 'errors', method: 'GET' }, 405)
  })
  await caseTest('thermal pause is cooling rather than a missing model and explicit long audio gives actionable error', async () => {
    mode = 'cooling'
    const status = await expect('/api/voice/status', { user: 'errors', method: 'GET' }, 200)
    assert.equal(status.data.available, true); assert.equal(status.data.busy, true); assert.equal(status.data.cooling, true)
    assert.ok(status.data.message.includes('正在冷却'))
    mode = 'thermal'
    const hot = await expect('/api/voice/ask', { user: 'errors', value: ask('你好', 'workspace') }, 503)
    assert.ok(hot.data.error.includes('手机温度较高') && hot.data.error.includes('冷却'))
    mode = 'thermal_unavailable'
    const sensor = await expect('/api/voice/ask', { user: 'errors', value: ask('你好', 'workspace') }, 503)
    assert.ok(sensor.data.error.includes('温度检测暂不可用') && sensor.data.error.includes('暂停处理'))
    mode = 'audio_limit'
    const length = await expect('/api/voice/speech', { user: 'errors', value: { text: '测试较长的语音' } }, 400)
    assert.ok(length.data.error.includes('缩短文本'))
    mode = 'normal'
  })
  await caseTest('one request per user and browser cancellation reaches private inference socket', async () => {
    mode = 'hang'; disconnected = false
    const controller = new AbortController(); const before = requests.length
    const pending = request('/api/voice/ask', { user: 'cancel', value: ask('你好', 'workspace'), signal: controller.signal }).catch(error => error)
    await waitUntil(() => requests.length > before)
    await expect('/api/voice/ask', { user: 'cancel', value: ask('你好', 'workspace') }, 429)
    controller.abort(); assert.ok(await pending instanceof Error); await waitUntil(() => disconnected)
    mode = 'normal'
    await expect('/api/voice/ask', { user: 'cancel', value: ask('项目状态') }, 404)
  })
  await caseTest('read-only intent never changes documents and fixed rate limit has no unbounded queue', async () => {
    const before = await fs.readFile(projectFile)
    const blocked = await expect('/api/voice/ask', { value: ask('删除这个项目') }, 200)
    assert.ok(blocked.data.answer.includes('只读')); assert.deepEqual(await fs.readFile(projectFile), before)
    for (let i = 0; i < 20; i++) await expect('/api/voice/ask', { user: 'limit', value: ask('网站状态', 'workspace') }, 200)
    await expect('/api/voice/ask', { user: 'limit', value: ask('网站状态', 'workspace') }, 429)
  })
  await caseTest('unavailable model is an honest status and no audio/chat content is persisted', async () => {
    for (const socket of connections) socket.destroy()
    await new Promise(resolve => bridge.close(resolve))
    const status = await expect('/api/voice/status', { user: 'bounds', method: 'GET' }, 200)
    assert.equal(status.data.available, false)
    await expect('/api/voice/speech', { user: 'bounds', value: { text: '你好' } }, 503)
    const files = await fs.readdir(paths.logs)
    for (const file of files) {
      const text = await fs.readFile(path.join(paths.logs, file), 'utf8')
      assert.equal(text.includes('本地模型测试回答'), false); assert.equal(text.includes('测试语音文字'), false)
    }
    assert.equal((await fs.readdir(runtime)).some(file => /record|audio|chat/.test(file)), false)
  })
  console.log(JSON.stringify({ result: 'PASS_HTTP_BOUNDARIES_WITH_FAKE_INFERENCE', cases: cases.length, inferenceCalls: requests.length, humanAcousticsTested: false, phoneInferenceTested: false }))
} finally {
  for (const socket of connections) socket.destroy()
  if (bridge.listening) await new Promise(resolve => bridge.close(resolve))
  if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGKILL'); await done }
  await fs.rm(runtime, { recursive: true, force: true })
}
