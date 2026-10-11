import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'

let active = 0, count = 0, until = 0
const error = (res: ServerResponse, status: number, message: string, type = 'invalid_request_error', code: string | null = null) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { message, type, param: null, code } }))
}
const hash = (text: string) => createHash('sha256').update(text).digest()

export async function readLocalAPIKey(): Promise<string> {
  const file = process.env.FLOWBOARD_API_KEY_FILE?.trim()
  if (!file) throw new Error('API key not configured')
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 || stat.size < 32) throw new Error('invalid key file')
  const secret = (await fs.readFile(file, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new Error('invalid key')
  return secret
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = 0, done = false
    const chunks: Buffer[] = []
    const finish = (failure?: Error) => {
      if (done) return
      done = true; clearTimeout(timer)
      req.off('data', data); req.off('end', end); req.off('error', fail); signal.removeEventListener('abort', fail)
      if (failure) { req.resume(); reject(failure) } else resolve(Buffer.concat(chunks, bytes))
    }
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16384) finish(new Error('too_large')); else chunks.push(chunk) }
    const end = () => finish()
    const fail = () => finish(new Error('upload_aborted'))
    const timer = setTimeout(() => finish(new Error('upload_timeout')), 10000)
    timer.unref(); req.on('data', data); req.once('end', end); req.once('error', fail); signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) fail()
  })
}

export async function handleOpenAICompatible(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://flowboard.local').pathname
  if (pathname !== '/v1' && !pathname.startsWith('/v1/')) return false
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
  const abort = new AbortController()
  const close = () => { if (!res.writableEnded) abort.abort() }
  const requestAbort = () => abort.abort()
  req.once('aborted', requestAbort); res.once('close', close)
  let acquired = false
  try {
    const file = process.env.FLOWBOARD_API_KEY_FILE?.trim()
    if (!file) { error(res, 503, 'API key has not been configured', 'server_error', 'api_not_configured'); return true }
    let secret: string
    try {
      secret = await readLocalAPIKey()
    } catch { error(res, 503, 'API key configuration unavailable', 'server_error', 'api_not_configured'); return true }
    const supplied = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
    if (!timingSafeEqual(hash(supplied), hash(secret))) { error(res, 401, 'Invalid API key', 'authentication_error', 'invalid_api_key'); req.resume(); return true }
    if (!['/v1/models', '/v1/chat/completions'].includes(pathname)) { error(res, 404, 'Endpoint not found'); return true }
    if (req.method !== (pathname === '/v1/models' ? 'GET' : 'POST')) { error(res, 405, 'Method not supported'); return true }
    const now = Date.now()
    if (now >= until) { until = now + 60000; count = 0 }
    if (active >= 2 || ++count > 60) { error(res, 429, 'API busy; retry shortly', 'rate_limit_error', 'rate_limit_exceeded'); req.resume(); return true }
    active++; acquired = true
    let body: Buffer | undefined
    if (req.method === 'POST') {
      if ((req.headers['content-type'] ?? '').split(';')[0]?.trim() !== 'application/json' || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) { error(res, 415, 'Uncompressed JSON required'); req.resume(); return true }
      const length = req.headers['content-length']
      if (length && (!/^\d+$/.test(length) || Number(length) > 16384)) { error(res, 413, 'Request exceeds 16384 bytes'); req.resume(); return true }
      body = await readBody(req, abort.signal)
      if (!body.length) { error(res, 400, 'Empty JSON body'); return true }
      try { JSON.parse(body.toString('utf8')) } catch { error(res, 400, 'Invalid JSON'); return true }
    }
    const base = new URL(process.env.FLOWBOARD_DECISION_URL?.trim() || 'http://127.0.0.1:8149')
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) { error(res, 503, 'Local model address required', 'server_error'); return true }
    const upstream = await fetch(new URL(pathname, base), { method: req.method, redirect: 'error', headers: { 'Content-Type': 'application/json' }, ...(body ? { body } : {}), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
    // The classifier sends a bounded JSON result (or a few SSE events) after
    // inference. Buffer that response to validate its size before publishing.
    if (!upstream.body) throw new Error('empty upstream')
    const chunks: Uint8Array[] = [], reader = upstream.body.getReader()
    let bytes = 0
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break
        bytes += item.value.length
        if (bytes > 65536) { await reader.cancel(); throw new Error('upstream too large') }
        chunks.push(item.value)
      }
    } finally { reader.releaseLock() }
    if (!res.destroyed) {
      res.statusCode = upstream.status
      res.setHeader('Content-Type', upstream.headers.get('content-type') === 'text/event-stream' ? 'text/event-stream' : 'application/json; charset=utf-8')
      res.end(Buffer.concat(chunks, bytes))
    }
  } catch (failure) {
    if (!res.destroyed && !res.writableEnded) {
      const message = failure instanceof Error ? failure.message : ''
      error(res, message === 'too_large' ? 413 : message.startsWith('upload_') ? 408 : 503, message === 'too_large' ? 'Request exceeds 16384 bytes' : 'Local model temporarily unavailable', 'server_error')
    }
  } finally {
    if (acquired) active--
    req.off('aborted', requestAbort); res.off('close', close)
  }
  return true
}
