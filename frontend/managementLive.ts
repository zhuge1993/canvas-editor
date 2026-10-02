import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ProjectLiveOptions {
  projectId: string; clientId: string; actorId: string; actorName: string
  getSnapshot: () => unknown | Promise<unknown>
  canRead: () => boolean | Promise<boolean>
}
export interface ProjectPresenceUser { userId: string; name: string; sessions: number; lastSeenAt: number }
const HEARTBEAT_MS = 15000
const TTL_MS = 45000
const CALLBACK_MS = 5000
const MAX_CONNECTIONS = 256
const MAX_PROJECT_CONNECTIONS = 64
const MAX_USER_CONNECTIONS = 8
const MAX_FRAME_BYTES = 2 * 1024 * 1024
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 65536
const rooms = new Map<string, Set<Connection>>()
let totalConnections = 0

interface Connection {
  options: ProjectLiveOptions; req: IncomingMessage; res: ServerResponse
  closed: boolean; initialized: boolean; busy: boolean; blockedSince?: number
  lastSeenAt: number; lastSentRevision: number; pendingRevision: number; presencePending: boolean
  controller: AbortController; timer?: ReturnType<typeof setInterval>
  close: (reason: string) => void; flush: () => Promise<void>
}

function presence(projectId: string): { users: ProjectPresenceUser[] } {
  const users = new Map<string, ProjectPresenceUser>()
  const now = Date.now()
  for (const client of rooms.get(projectId) ?? []) {
    if (client.closed || !client.initialized || now - client.lastSeenAt > TTL_MS) continue
    const previous = users.get(client.options.actorId)
    if (previous) { previous.sessions++; previous.lastSeenAt = Math.max(previous.lastSeenAt, client.lastSeenAt) }
    else users.set(client.options.actorId, { userId: client.options.actorId, name: client.options.actorName,
      sessions: 1, lastSeenAt: client.lastSeenAt })
  }
  return { users: [...users.values()].sort((a, b) => a.userId.localeCompare(b.userId)) }
}

function queuePresence(projectId: string): void {
  for (const client of rooms.get(projectId) ?? []) {
    client.presencePending = true
    void client.flush()
  }
}

function callback<T>(work: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value?: T, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value as T)
    }
    const abort = () => finish(undefined, new Error('Live connection closed'))
    const timer = setTimeout(() => finish(undefined, new Error('Live authorization timeout')), CALLBACK_MS)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => signal.aborted ? Promise.reject(new Error('Live connection closed')) : work())
      .then(value => finish(value), () => finish(undefined, new Error('Live callback failed')))
  })
}

function writeFrame(client: Connection, frame: string): boolean {
  if (client.closed || client.res.destroyed || client.res.writableEnded) return false
  if (client.blockedSince !== undefined) return false
  const size = Buffer.byteLength(frame)
  if (size > MAX_FRAME_BYTES || client.res.writableLength + size > MAX_BUFFER_BYTES) {
    client.close('slow-consumer'); return false
  }
  try {
    if (!client.res.write(frame)) client.blockedSince = Date.now()
    return true
  } catch { client.close('write-failed'); return false }
}

function event(client: Connection, name: string, value: unknown): boolean {
  try { return writeFrame(client, `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`) }
  catch { client.close('serialization-failed'); return false }
}

function errorResponse(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.destroyed || res.writableEnded) { res.destroy(); return }
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify({ error: message }))
}

/** Authenticated per-user SSE. Snapshot is obtained separately for each actor;
 * a mutation broadcast contains only revision metadata, never an owner's DTO. */
export async function attachProjectLive(req: IncomingMessage, res: ServerResponse, options: ProjectLiveOptions): Promise<void> {
  if (req.method !== 'GET') { errorResponse(res, 405, 'Live updates require GET'); return }
  if (![options.projectId, options.actorId, options.clientId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)) ||
      typeof options.actorName !== 'string' || options.actorName.length > 200) { errorResponse(res, 400, 'Invalid live connection identity'); return }
  const controller = new AbortController()
  const abortHandshake = () => controller.abort()
  req.once('aborted', abortHandshake)
  res.once('close', abortHandshake)
  let authorized = false
  try { authorized = await callback(options.canRead, controller.signal) === true } catch { /* fail closed */ }
  finally { req.off('aborted', abortHandshake); res.off('close', abortHandshake) }
  if (!authorized) { errorResponse(res, 403, 'Project live access denied'); return }
  if (req.destroyed || res.destroyed || res.writableEnded) return
  let room = rooms.get(options.projectId)
  for (const existing of room ?? []) {
    if (existing.options.actorId === options.actorId && existing.options.clientId === options.clientId) existing.close('client-replaced')
  }
  room = rooms.get(options.projectId)
  if (totalConnections >= MAX_CONNECTIONS || (room?.size ?? 0) >= MAX_PROJECT_CONNECTIONS ||
      [...room ?? []].filter(client => client.options.actorId === options.actorId).length >= MAX_USER_CONNECTIONS) {
    errorResponse(res, 429, 'Too many live connections'); return
  }
  const client: Connection = { options, req, res, closed: false, initialized: false, busy: true,
    lastSeenAt: Date.now(), lastSentRevision: 0, pendingRevision: 0, presencePending: false, controller,
    close: () => {}, flush: async () => {} }
  const cleanup = () => client.close('connection-closed')
  const onDrain = () => { client.blockedSince = undefined; void client.flush() }
  client.close = (_reason: string) => {
    if (client.closed) return
    client.closed = true
    controller.abort()
    clearInterval(client.timer)
    req.off('aborted', cleanup)
    res.off('close', cleanup); res.off('error', cleanup); res.off('drain', onDrain)
    const current = rooms.get(options.projectId)
    current?.delete(client)
    totalConnections--
    if (!current?.size) rooms.delete(options.projectId)
    if (!res.destroyed) {
      if (client.blockedSince !== undefined) res.destroy()
      else res.end()
    }
    queuePresence(options.projectId)
  }
  client.flush = async () => {
    if (client.closed || client.busy || !client.initialized) return
    client.busy = true
    try {
      if (Date.now() - client.lastSeenAt > TTL_MS ||
          (client.blockedSince !== undefined && Date.now() - client.blockedSince >= HEARTBEAT_MS)) { client.close('expired'); return }
      if (await callback(options.canRead, controller.signal) !== true) { client.close('access-revoked'); return }
      if (client.closed) return
      client.lastSeenAt = Date.now()
      if (client.blockedSince !== undefined) return
      if (client.pendingRevision > client.lastSentRevision) {
        const revision = client.pendingRevision
        if (event(client, 'revision', { revision })) client.lastSentRevision = revision
      }
      if (client.presencePending && client.blockedSince === undefined) {
        client.presencePending = false
        event(client, 'presence', presence(options.projectId))
      }
    } catch { client.close('authorization-failed') }
    finally {
      client.busy = false
      if (!client.closed && client.blockedSince === undefined &&
          (client.pendingRevision > client.lastSentRevision || client.presencePending)) void client.flush()
    }
  }
  if (!room) { room = new Set(); rooms.set(options.projectId, room) }
  room.add(client); totalConnections++
  req.once('aborted', cleanup)
  res.once('close', cleanup); res.once('error', cleanup); res.on('drain', onDrain)
  try {
    const project = await callback(options.getSnapshot, controller.signal)
    if (!project || typeof project !== 'object' || !('revision' in project) || !('id' in project) ||
        project.id !== options.projectId || !Number.isSafeInteger(project.revision) || (project.revision as number) < 1)
      throw new Error('Invalid project snapshot')
    if (await callback(options.canRead, controller.signal) !== true || client.closed) { client.close('access-revoked'); return }
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    client.initialized = true
    client.lastSentRevision = project.revision as number
    if (!event(client, 'snapshot', { project, revision: project.revision, refreshRequired: true, presence: presence(options.projectId) })) { client.close('snapshot-failed'); return }
    client.timer = setInterval(() => {
      if (Date.now() - client.lastSeenAt > TTL_MS) { client.close('expired'); return }
      // Comments contain no project/user data and keep the transport alive
      // while an async authorization check runs. Data still requires canRead.
      if (!client.closed && client.blockedSince === undefined) writeFrame(client, `: heartbeat ${Date.now()}\n\n`)
      void client.flush()
    }, HEARTBEAT_MS)
    client.timer.unref()
  } catch {
    if (!res.headersSent) errorResponse(res, 503, 'Project live snapshot unavailable')
    client.close('snapshot-unavailable')
  } finally {
    client.busy = false
    if (!client.closed) { queuePresence(options.projectId); void client.flush() }
  }
}

/** Coalesced metadata only. Call after the project mutation has fsynced. */
export function publishProjectChange(projectId: string, revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) return
  for (const client of rooms.get(projectId) ?? []) {
    client.pendingRevision = Math.max(client.pendingRevision, revision)
    void client.flush()
  }
}
