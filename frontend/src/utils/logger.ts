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

function serializeDetails(details: unknown): unknown {
  if (details instanceof Error) {
    return { name: details.name, message: details.message, stack: details.stack }
  }
  try {
    return JSON.parse(JSON.stringify(details)) as unknown
  } catch {
    return String(details)
  }
}

export function writeLog(level: LogLevel, event: string, message: string, details?: unknown) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    message,
    documentId: currentDocumentId(),
    details: serializeDetails(details),
  }

  void fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    keepalive: true,
  }).catch(() => undefined)
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
