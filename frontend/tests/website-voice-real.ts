/** Opt-in phone qualification: ephemeral accounts/data + real HTTP + real Unix
 * inference. Compile this file alone with esbuild; run its CJS as flowboard UID
 * 101. It never reads or writes the production FlowBoard runtime directory. */
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ensureRuntimeDirs, handleRuntimeRequest } from '../runtimeCore.js'

async function main() {
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-voice-http-'))
if (process.platform !== 'linux' || process.getuid?.() !== 101) {
  await fs.rmdir(root); throw new Error('Real phone fixture must run as flowboard UID 101')
}
if (!root.startsWith('/tmp/flowboard-voice-http-')) { await fs.rmdir(root); throw new Error('Fixture directory must remain under /tmp') }
await fs.chmod(root, 0o700)
const paths = { dataDirectory: path.join(root, 'project-data'), authDirectory: path.join(root, 'auth-data'), logDirectory: path.join(root, 'logs') }
const users = ['owner', 'stranger'].map(name => ({ id: `qa_${name}`, email: `${name}@fixture.invalid`, passwordHash: 'unused fixture hash', createdAt: Date.now(), verifiedAt: Date.now() }))
const ownerToken = randomBytes(32).toString('base64url'), strangerToken = randomBytes(32).toString('base64url')
const cases: Array<{ name: string; pass: boolean; status?: number; elapsedSeconds?: number; text?: string; bytes?: number }> = []
const report: Record<string, unknown> = { result: 'PENDING', uid: process.getuid(), ephemeralFixture: true, productionDataUsed: false,
  realPhoneInference: true, humanAcousticsTested: false, cases }
const server = http.createServer((req, res) => { void handleRuntimeRequest(req, res, { paths }).then(handled => {
  if (!handled) { res.statusCode = 404; res.end() }
}).catch(() => { if (!res.destroyed && !res.writableEnded) { res.statusCode = 500; res.end() } }) })
let port = 0
const write = async (file: string, value: unknown) => { await fs.writeFile(file, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }) }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function request(route: string, value?: unknown, token?: string, recording?: Buffer): Promise<{ status: number; bytes: Buffer; data: Record<string, unknown> }> {
  const payload = recording ?? (value === undefined ? undefined : Buffer.from(JSON.stringify(value)))
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: value === undefined && recording === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Cookie: `flowboard_session=${token}` } : {}), ...(payload ? { 'Content-Length': payload.length,
        'Content-Type': recording ? 'application/octet-stream' : 'application/json' } : {}) } }, res => {
      const chunks: Buffer[] = []; let bytes = 0
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1100000) { res.destroy(); reject(new Error('Fixture response too large')) } else chunks.push(chunk) })
      res.once('error', reject)
      res.once('end', () => { const buffer = Buffer.concat(chunks); let data: Record<string, unknown> = {}
        try { data = JSON.parse(buffer.toString('utf8')) } catch { /* binary WAV */ }
        resolve({ status: res.statusCode ?? 0, bytes: buffer, data }) })
    })
    req.setTimeout(50000, () => req.destroy(new Error('Fixture request timeout')))
    req.once('error', reject); req.end(payload)
  })
}
async function check(name: string, work: () => Promise<{ status?: number; text?: string; bytes?: number }>) {
  const started = Date.now()
  try { cases.push({ name, pass: true, ...await work(), elapsedSeconds: (Date.now() - started) / 1000 }) }
  catch (error) { cases.push({ name, pass: false, text: error instanceof Error ? error.message.slice(0, 240) : 'Fixture failed', elapsedSeconds: (Date.now() - started) / 1000 }); throw error }
}
async function pcmInput(): Promise<Buffer | undefined> {
  const inputFile = process.env.FLOWBOARD_VOICE_TEST_PCM || process.env.FLOWBOARD_VOICE_TEST_WAV
  if (!inputFile) return undefined
  const stat = await fs.lstat(inputFile)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 700000, 'Generated test recording must be a bounded regular file')
  const input = await fs.readFile(inputFile)
  if (process.env.FLOWBOARD_VOICE_TEST_PCM) return input
  assert(input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WAVE', 'Test WAV header invalid')
  let format = false
  for (let offset = 12; offset + 8 <= input.length;) {
    const kind = input.toString('ascii', offset, offset + 4), size = input.readUInt32LE(offset + 4), start = offset + 8
    assert(start + size <= input.length, 'Test WAV chunk invalid')
    if (kind === 'fmt ') { assert(size >= 16 && input.readUInt16LE(start) === 1 && input.readUInt16LE(start + 2) === 1
      && input.readUInt32LE(start + 4) === 16000 && input.readUInt16LE(start + 14) === 16, 'Test WAV must be mono PCM16LE 16000 Hz'); format = true }
    if (kind === 'data') { assert(format, 'Test WAV format must precede data'); return input.subarray(start, start + size) }
    offset = start + size + size % 2
  }
  throw new Error('Test WAV has no PCM data')
}
try {
  await ensureRuntimeDirs(paths)
  await write(path.join(paths.authDirectory, 'users.json'), users)
  await write(path.join(paths.authDirectory, 'sessions.json'), [{ token: ownerToken, userId: users[0]!.id, createdAt: Date.now(), expiresAt: Date.now() + 3600000 },
    { token: strangerToken, userId: users[1]!.id, createdAt: Date.now(), expiresAt: Date.now() + 3600000 }])
  await fs.mkdir(path.join(paths.dataDirectory, 'management', 'projects'), { recursive: true })
  const projectId = 'qa_voice_project', canvasId = 'qa_voice_canvas'
  const now = Date.now()
  await write(path.join(paths.dataDirectory, 'management', 'projects', `${projectId}.json`), { id: projectId, ownerId: users[0]!.id,
    name: '语音验收临时项目', description: '', roles: [{ id: 'developer', name: '技术', color: '#123456' }], categories: [], canvasIds: [], members: [],
    events: [{ id: 'qa_issue', title: '网页语音输入', description: '验证语音文字插入光标位置', priority: 'high', status: 'review', roleId: 'developer', categoryId: '', createdAt: now, updatedAt: now, assignee: '技术', attachments: [] }],
    history: [], revision: 0, receipts: [], schemaVersion: 1, createdAt: now, updatedAt: now })
  await write(path.join(paths.dataDirectory, `${canvasId}.json`), { id: canvasId, ownerId: users[0]!.id, title: '语音测试画布', createdAt: now, updatedAt: now,
    canvas: { shapes: { one: { id: 'one', type: 'text', text: '语音输入按钮' } } } })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert(address && typeof address !== 'string', 'Fixture did not bind loopback'); port = address.port
  await check('unauthenticated request denied', async () => { const r = await request('/api/voice/ask', { text: '项目状态' }); assert(r.status === 401, 'Anonymous request accepted'); return { status: r.status } })
  await check('real bridge model capabilities', async () => { const r = await request('/api/voice/status', undefined, ownerToken); assert(r.status === 200 && r.data.available === true, 'Real inference unavailable')
    report.capabilities = r.data.capabilities; return { status: r.status } })
  await check('exact scoped project counts', async () => { const r = await request('/api/voice/ask', { text: '今日技术等待验收问题', context: { kind: 'project', id: projectId } }, ownerToken)
    assert(r.status === 200 && String(r.data.answer).includes('共1条') && String(r.data.answer).includes('等待验收1条') && r.data.dataAnswer === true, 'Project counts incorrect')
    assert(typeof r.data.spokenAnswer === 'string' && r.data.spokenAnswer.length <= 64, 'Built-in factual speech too long')
    report.factualSpokenCharacters = r.data.spokenAnswer.length
    return { status: r.status, text: String(r.data.answer) } })
  await check('other account isolated', async () => { const r = await request('/api/voice/ask', { text: '项目状态', context: { kind: 'project', id: projectId } }, strangerToken); assert(r.status === 404, 'Cross-user data leaked'); return { status: r.status } })
  await check('canvas text scoped and readable', async () => { const r = await request('/api/voice/ask', { text: '画布里面有什么文字', context: { kind: 'canvas', id: canvasId } }, ownerToken)
    assert(r.status === 200 && String(r.data.answer).includes('语音输入按钮'), 'Canvas text unreadable'); return { status: r.status, text: String(r.data.answer) } })
  const recording = await pcmInput()
  if (recording) await check('real uploaded PCM transcription', async () => { const r = await request('/api/voice/transcribe', undefined, ownerToken, recording)
    assert(r.status === 200 && typeof r.data.text === 'string' && r.data.text.trim(), `Real ASR failed (${r.status})`); return { status: r.status, text: String(r.data.text), bytes: recording.length } })
  else report.transcriptionSkipped = 'No generated PCM/WAV fixture provided'
  await check('real stateless local model generation', async () => { const r = await request('/api/voice/ask', { text: '你好，请用一句话介绍自己。', context: { kind: 'workspace' } }, ownerToken)
    assert(r.status === 200 && typeof r.data.answer === 'string' && r.data.answer.trim() && r.data.dataAnswer === false, `Real local model failed (${r.status})`)
    report.contextTruncated = r.data.contextTruncated; return { status: r.status, text: String(r.data.answer) } })
  await check('real scoped project model analysis', async () => { const r = await request('/api/voice/ask', { text: '分析项目优先级，建议先做什么？', context: { kind: 'project', id: projectId } }, ownerToken)
    assert(r.status === 200 && r.data.dataAnswer === false && typeof r.data.spokenAnswer === 'string' && r.data.spokenAnswer.trim()
      && String(r.data.dataSummary).includes('等待验收1条') && String(r.data.answer).includes('分析建议：'), `Real scoped model analysis failed (${r.status})`)
    assert(r.data.spokenAnswer.length <= 64, 'Built-in model speech too long'); report.modelSpokenCharacters = r.data.spokenAnswer.length
    return { status: r.status, text: String(r.data.answer) } })
  await check('real browser audio response', async () => { const r = await request('/api/voice/speech', { text: '网页语音服务已经连接。' }, ownerToken)
    assert(r.status === 200 && r.bytes.length > 44 && r.bytes.toString('ascii', 0, 4) === 'RIFF', `Real TTS failed (${r.status})`)
    return { status: r.status, bytes: r.bytes.length } })
  report.result = recording ? 'PASS_REAL_PHONE_HTTP_UNIX_MODELS' : 'PASS_PARTIAL_REAL_PHONE_HTTP_NO_STT_INPUT'
} catch (error) { report.result = 'FAIL'; report.error = error instanceof Error ? error.message.slice(0, 240) : 'Fixture failed'; process.exitCode = 1 }
finally {
  if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  await fs.rm(root, { recursive: true, force: true })
  report.ephemeralFixtureRemoved = true
  console.log(JSON.stringify(report))
}
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Fixture startup failed'); process.exitCode = 1 })
