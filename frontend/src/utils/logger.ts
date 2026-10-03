export type LogLevel = 'info' | 'warn' | 'error'

interface LogEntry {
  timestamp: string
  level: LogLevel
  event: string
  message: string
  documentId?: string
  details?: unknown
}

function currentDocumentId() {
  const match = window.location.pathname.match(/^\/editor\/([^/]+)/)
  return match?.[1]
}

const MAX_IN_FLIGHT = 2
const REQUEST_TIMEOUT_MS = 5000
const MAX_BODY_BYTES = 16 * 1024
const ERROR_REPEAT_MS = 30_000
const recentErrors = new Map<string, number>()
const encoder = new TextEncoder()
let inFlight = 0
let tokens = 20
let lastRefill = Date.now()

function serializeDetails(details: unknown): unknown {
  const seen = new WeakSet<object>()
  let nodes = 128
  let characters = 2048
  const text = (value: string) => {
    const trimmed = value.slice(0, Math.min(512, characters))
    characters -= trimmed.length
    return trimmed.length < value.length ? `${trimmed}…` : trimmed
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 4) return '[truncated]'
    if (value === undefined || value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (typeof value === 'string') return text(value)
    if (typeof value !== 'object') return text(String(value))
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (value instanceof Error) return visit({ name: value.name, message: value.message, stack: value.stack }, depth + 1)
    if (Array.isArray(value)) return value.slice(0, 32).map(item => visit(item, depth + 1))
    const result: Record<string, unknown> = {}
    let count = 0
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (++count > 32 || nodes <= 0) break
      try { result[key.slice(0, 80)] = visit((value as Record<string, unknown>)[key], depth + 1) } catch { result[key.slice(0, 80)] = '[unavailable]' }
    }
    return result
  }
  try { return visit(details, 0) } catch { return '[unavailable]' }
}

export function writeLog(level: LogLevel, event: string, message: string, details?: unknown) {
  // Diagnostics must stay bounded when offline or when one error repeats every frame.
  const now = Date.now()
  tokens = Math.min(20, tokens + Math.max(0, now - lastRefill) / 2000)
  lastRefill = now
  if (inFlight >= MAX_IN_FLIGHT || tokens < 1) return
  const boundedEvent = event.slice(0, 160)
  const boundedMessage = message.slice(0, 2048)
  const documentId = currentDocumentId()?.slice(0, 160)
  if (level === 'error') {
    const key = `${boundedEvent}\n${boundedMessage}\n${documentId ?? ''}`
    const last = recentErrors.get(key)
    if (last !== undefined && now - last < ERROR_REPEAT_MS) return
    for (const [entry, timestamp] of recentErrors) if (now - timestamp >= ERROR_REPEAT_MS) recentErrors.delete(entry)
    if (recentErrors.size >= 64) recentErrors.delete(recentErrors.keys().next().value!)
    recentErrors.set(key, now)
  }
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event: boundedEvent,
    message: boundedMessage,
    documentId,
    details: serializeDetails(details),
  }

  let body = JSON.stringify(entry)
  if (encoder.encode(body).byteLength > MAX_BODY_BYTES) body = JSON.stringify({ ...entry, details: '[details exceeded diagnostic size limit]' })
  tokens -= 1
  inFlight += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  // No retry queue: diagnostic failures are dropped rather than retained forever.
  void Promise.resolve().then(() => fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: controller.signal,
    keepalive: true,
  })).then(response => response.body?.cancel()).catch(() => undefined).finally(() => {
    clearTimeout(timer)
    inFlight -= 1
  })
}

export function logOperation(event: string, message: string, details?: unknown) {
  writeLog('info', event, message, details)
}

export function logWarning(event: string, message: string, details?: unknown) {
  writeLog('warn', event, message, details)
}

export function logError(event: string, error: unknown, details?: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  writeLog('error', event, message, { error: serializeDetails(error), context: serializeDetails(details) })
}

export function installGlobalErrorLogging() {
  const handleError = (event: ErrorEvent) => {
    logError('window.error', event.error ?? event.message, {
      file: event.filename,
      line: event.lineno,
      column: event.colno,
    })
  }
  const handleRejection = (event: PromiseRejectionEvent) => {
    logError('window.unhandled_rejection', event.reason)
  }
  window.addEventListener('error', handleError)
  window.addEventListener('unhandledrejection', handleRejection)
  logOperation('application.started', 'FlowBoard application started', { url: window.location.href })
  return () => {
    window.removeEventListener('error', handleError)
    window.removeEventListener('unhandledrejection', handleRejection)
  }
}
