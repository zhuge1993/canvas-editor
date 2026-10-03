import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-voice-client-'))
try {
  const captureFile = path.join(temporary, 'capture.cjs'), clientFile = path.join(temporary, 'client.cjs')
  await Promise.all([
    build({ entryPoints: [path.join(root, 'src/utils/voiceCapture.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: captureFile }),
    build({ entryPoints: [path.join(root, 'src/services/voice.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: clientFile }),
  ])
  const { Pcm16Encoder, VOICE_MAX_SAMPLES } = await import(pathToFileURL(captureFile))
  for (const rate of [16000, 44100, 48000, 96000]) {
    const samples = Float32Array.from({ length: rate }, (_, index) => Math.sin(index / rate * Math.PI * 440 * 2) * .5)
    const whole = new Pcm16Encoder(rate), split = new Pcm16Encoder(rate)
    whole.append(samples)
    for (let index = 0; index < samples.length; index += 127) split.append(samples.subarray(index, index + 127))
    assert.equal(whole.seconds, 1)
    assert.deepEqual(new Uint8Array(whole.finish()), new Uint8Array(split.finish()))
  }
  const bounded = new Pcm16Encoder(16000)
  for (let index = 0; index < 30; index++) bounded.append(new Float32Array(16000).fill(.5))
  assert.equal(bounded.full, true); assert.equal(bounded.seconds, 20)
  assert.equal(bounded.finish().byteLength, VOICE_MAX_SAMPLES * 2)
  assert.equal(bounded.seconds, 0)
  const endian = new Pcm16Encoder(16000); endian.append(new Float32Array([1, -1, 0, NaN]))
  assert.deepEqual([...new Uint8Array(endian.finish())], [255, 127, 0, 128, 0, 0, 0, 0])
  for (const rate of [0, 8000, NaN, 200000]) assert.throws(() => new Pcm16Encoder(rate))
  console.log('PASS: 4 device sample rates preserve callback-boundary continuity, LE signed PCM, finite samples and hard 20-second/640000-byte bound')
  const api = await import(pathToFileURL(clientFile)), calls = []
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ text: '识别结果' }), { headers: { 'Content-Type': 'application/json' } }) }
    assert.equal((await api.transcribeVoice(new ArrayBuffer(16000), new AbortController().signal)).text, '识别结果')
    assert.equal(calls.length, 1); assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream')
    for (const size of [0, 1, 640002]) await assert.rejects(api.transcribeVoice(new ArrayBuffer(size), new AbortController().signal))
    assert.equal(calls.length, 1)
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'phone_voice_preempted' }), { status: 429 })
    await assert.rejects(api.askVoice('项目进度', { kind: 'workspace' }, new AbortController().signal), /语音对话优先/)
    const canceled = new AbortController(); canceled.abort()
    await assert.rejects(api.askVoice('项目进度', { kind: 'workspace' }, canceled.signal), error => error.name === 'AbortError')
    globalThis.fetch = async () => new Response(new Uint8Array(5), { headers: { 'Content-Type': 'application/json' } })
    await assert.rejects(api.speakVoice('你好', new AbortController().signal), /格式异常/)
  } finally { globalThis.fetch = originalFetch }
  console.log('PASS: signed-cookie PCM request, invalid-body rejection, explicit preemption/cancellation and invalid TTS rejection; no automatic request retries')
  console.log('ALL_VOICE_CLIENT_CHECKS_PASS 2')
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('flowboard-voice-client-'))
  await fs.rm(temporary, { recursive: true, force: true })
}
