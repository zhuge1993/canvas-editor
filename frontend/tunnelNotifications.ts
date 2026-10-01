import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { replaceFileDurably } from './runtimeStorage.js'

export function quickTunnelOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/.test(normalized)) return undefined
  return normalized.replace(/\/$/, '')
}

export function activeQqRecipients(users: unknown): string[] {
  if (!Array.isArray(users)) throw new Error('Invalid registered user data')
  const recipients = new Set<string>()
  for (const value of users) {
    if (!value || typeof value !== 'object') continue
    const user = value as Record<string, unknown>
    if (typeof user.id !== 'string' || !user.id || typeof user.verifiedAt !== 'number' || !Number.isFinite(user.verifiedAt) || user.verifiedAt <= 0) continue
    if (user.disabled === true || user.active === false || user.isActive === false || user.deleted === true) continue
    if (typeof user.deletedAt === 'number' && user.deletedAt > 0) continue
    if (user.status !== undefined && user.status !== 'active' && user.status !== 'enabled') continue
    const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
    if (/^[a-z0-9][a-z0-9._+-]{0,63}@qq\.com$/.test(email)) recipients.add(email)
  }
  return [...recipients].sort()
}

/** Only a successful HTTPS response from the current public FlowBoard is ready. */
export async function verifyPublicFlowBoard(origin: string): Promise<boolean> {
  const canonical = quickTunnelOrigin(origin)
  if (!canonical) return false
  return new Promise((resolve) => {
    let finished = false
    const finish = (ok: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      request.destroy()
      resolve(ok)
    }
    // https.get does not follow redirects. TLS certificate validation stays enabled.
    const request = https.get(`${canonical}/api/health`, { agent: false, rejectUnauthorized: true }, (response) => {
      if (response.statusCode !== 200) { finish(false); return }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (part: string) => {
        body += part
        if (Buffer.byteLength(body, 'utf8') > 4096) finish(false)
      })
      response.on('error', () => finish(false))
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>
          finish(parsed.app === 'FlowBoard' && parsed.status === 'ok')
        } catch { finish(false) }
      })
    })
    const deadline = setTimeout(() => finish(false), 10000)
    request.on('error', () => finish(false))
  })
}

interface NotificationTask {
  key: string
  email: string
  status: 'pending' | 'sending' | 'sent'
  attempts: number
  nextAttemptAt: number
  lastError?: 'smtp_failed'
}

interface NotificationState {
  version: 1
  currentUrl: string | null
  status: string
  publicConnectivityVerified: boolean
  updatedAt: number
  sent: Record<string, number>
  tasks: NotificationTask[]
}

interface WorkerOptions {
  authDirectory: string
  currentUrl: () => unknown
  smtpConfigured: () => boolean
  send: (email: string, url: string, messageId: string) => Promise<void>
  verifyPublic?: (origin: string) => Promise<boolean>
  loadUsers?: () => Promise<unknown>
  now?: () => number
  report?: (status: { status: string; pending: number; sent: number }) => void
}

function notificationKey(url: string, email: string): string {
  return createHash('sha256').update(`${url}\n${email}`).digest('hex')
}

export function createTunnelNotificationWorker(options: WorkerOptions) {
  const stateFile = path.join(options.authDirectory, 'tunnel-notifications.json')
  const now = options.now ?? Date.now
  const verify = options.verifyPublic ?? verifyPublicFlowBoard
  const loadUsers = options.loadUsers ?? (async () => {
    try { return JSON.parse(await fsp.readFile(path.join(options.authDirectory, 'users.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  })
  let busy: Promise<void> | undefined
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let lastReport = ''
  let summary = { status: 'starting', pending: 0, sent: 0 }

  async function loadState(): Promise<NotificationState> {
    let parsed: NotificationState
    try { parsed = JSON.parse(await fsp.readFile(stateFile, 'utf8')) as NotificationState }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, currentUrl: null, status: 'no_current_url', publicConnectivityVerified: false, updatedAt: now(), sent: {}, tasks: [] }
    }
    // A corrupt checkpoint must not erase dedupe history and resend everything.
    if (parsed.version !== 1 || !parsed.sent || typeof parsed.sent !== 'object' || Array.isArray(parsed.sent) || !Array.isArray(parsed.tasks)) throw new Error('Invalid notification checkpoint')
    for (const [key, timestamp] of Object.entries(parsed.sent)) {
      if (!/^[a-f0-9]{64}$/.test(key) || typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) throw new Error('Invalid notification dedupe record')
    }
    if (parsed.currentUrl !== null && quickTunnelOrigin(parsed.currentUrl) !== parsed.currentUrl) throw new Error('Invalid notification URL checkpoint')
    for (const task of parsed.tasks) {
      if (!task || !parsed.currentUrl || typeof task.email !== 'string' || !/^[a-z0-9][a-z0-9._+-]{0,63}@qq\.com$/.test(task.email)
        || task.key !== notificationKey(parsed.currentUrl, task.email) || !['pending', 'sending', 'sent'].includes(task.status)
        || !Number.isInteger(task.attempts) || task.attempts < 0 || !Number.isFinite(task.nextAttemptAt) || task.nextAttemptAt < 0
        || (task.status === 'sent' && parsed.sent[task.key] === undefined)) throw new Error('Invalid notification task')
    }
    return parsed
  }

  async function persist(state: NotificationState): Promise<void> {
    state.updatedAt = now()
    await fsp.mkdir(options.authDirectory, { recursive: true })
    await replaceFileDurably(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    summary = { status: state.status, pending: state.tasks.filter(task => task.status !== 'sent').length, sent: state.tasks.filter(task => task.status === 'sent').length }
    const signature = JSON.stringify(summary)
    if (signature !== lastReport) { lastReport = signature; options.report?.({ ...summary }) }
  }

  async function refresh(state: NotificationState): Promise<void> {
    const url = quickTunnelOrigin(options.currentUrl()) ?? null
    const changed = state.currentUrl !== url
    state.currentUrl = url
    state.publicConnectivityVerified = false
    const previous = changed ? [] : state.tasks
    const recipients = url ? activeQqRecipients(await loadUsers()) : []
    state.tasks = recipients.map(email => {
      const key = notificationKey(url!, email)
      const old = previous.find(task => task.key === key)
      if (state.sent[key] !== undefined) return { key, email, status: 'sent', attempts: old?.attempts ?? 0, nextAttemptAt: 0 }
      // Interrupted SMTP attempts retry with the same Message-ID.
      return { key, email, status: 'pending', attempts: old?.attempts ?? 0, nextAttemptAt: Math.min(old?.nextAttemptAt ?? 0, now() + 30 * 60 * 1000) }
    })
    state.status = url ? 'pending' : 'no_current_url'
  }

  async function run(): Promise<void> {
    if (stopped) return
    const state = await loadState()
    await refresh(state)
    if (!state.currentUrl) { await persist(state); return }
    if (!options.smtpConfigured()) { state.status = 'not_configured'; await persist(state); return }
    if (!state.tasks.length) { state.status = 'no_recipients'; await persist(state); return }
    if (state.tasks.every(task => task.status === 'sent')) { state.status = 'up_to_date'; await persist(state); return }
    if (state.tasks.every(task => task.status === 'sent' || task.nextAttemptAt > now())) { state.status = 'retry_pending'; await persist(state); return }
    await persist(state)
    let healthy = false
    try { healthy = await verify(state.currentUrl) } catch { /* Offline DNS/TLS remains pending. */ }
    if (!healthy) { state.status = 'awaiting_public_health'; await persist(state); return }
    if (stopped) return
    state.publicConnectivityVerified = true
    for (const task of state.tasks) {
      if (stopped) return
      if (quickTunnelOrigin(options.currentUrl()) !== state.currentUrl) {
        await refresh(state)
        await persist(state)
        return
      }
      if (task.status === 'sent' || task.nextAttemptAt > now()) continue
      // Remove a recipient disabled/deleted while a slow SMTP send was in progress.
      if (!activeQqRecipients(await loadUsers()).includes(task.email)) continue
      // User loading and durable checkpoints can both outlive a tunnel restart.
      if (stopped) return
      if (quickTunnelOrigin(options.currentUrl()) !== state.currentUrl) {
        await refresh(state)
        await persist(state)
        return
      }
      task.status = 'sending'
      task.attempts += 1
      await persist(state)
      if (stopped) return
      if (quickTunnelOrigin(options.currentUrl()) !== state.currentUrl) {
        await refresh(state)
        await persist(state)
        return
      }
      try {
        await options.send(task.email, state.currentUrl, `<flowboard-tunnel-${task.key}@flowboard.local>`)
        state.sent[task.key] = now()
        task.status = 'sent'
        task.nextAttemptAt = 0
        delete task.lastError
      } catch {
        task.status = 'pending'
        task.lastError = 'smtp_failed'
        task.nextAttemptAt = now() + Math.min(30 * 60 * 1000, 30000 * 2 ** Math.min(task.attempts - 1, 6))
      }
      // Do not swallow checkpoint errors after SMTP accepted a message.
      await persist(state)
    }
    if (quickTunnelOrigin(options.currentUrl()) !== state.currentUrl) await refresh(state)
    else state.status = state.tasks.every(task => task.status === 'sent') ? 'up_to_date' : 'retry_pending'
    await persist(state)
  }

  function tick(): Promise<void> {
    if (busy) return busy
    busy = run().catch(() => {
      summary = { ...summary, status: 'storage_or_user_data_error' }
      options.report?.({ ...summary })
    }).finally(() => { busy = undefined })
    return busy
  }

  return {
    tick,
    status: () => ({ ...summary }),
    start() {
      if (timer) return
      stopped = false
      void tick()
      timer = setInterval(() => { void tick() }, 30000)
      timer.unref()
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined },
  }
}
