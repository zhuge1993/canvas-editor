import fsp from 'node:fs/promises'
import path from 'node:path'

export interface BoundedLogOptions {
  maxFileBytes?: number
  maxQueuedBytes?: number
  maxChunkBytes?: number
  flushIntervalMs?: number
  flushMaxChunks?: number
  onError?: (error: unknown) => void
}

function limit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value!))) : fallback
}

/** Diagnostic logs have a fixed disk budget; business records never pass through this writer. */
export function createBoundedLogWriter(file: string, options: BoundedLogOptions = {}) {
  const maxFileBytes = limit(options.maxFileBytes, 5 * 1024 * 1024, 1024, 64 * 1024 * 1024)
  const maxQueuedBytes = limit(options.maxQueuedBytes, 256 * 1024, 1024, 1024 * 1024)
  const maxChunkBytes = limit(options.maxChunkBytes, 16 * 1024, 256, Math.min(maxFileBytes, maxQueuedBytes))
  const flushIntervalMs = limit(options.flushIntervalMs, 1000, 1, 60_000)
  const flushMaxChunks = limit(options.flushMaxChunks, 50, 1, 1000)
  const pending: Buffer[] = []
  let queuedBytes = 0
  let flushing: Promise<void> | undefined
  let timer: NodeJS.Timeout | undefined
  let closed = false
  let initialized = false
  let droppedBytes = 0
  let failures = 0
  let lastErrorNotice = -Infinity
  const addDropped = (bytes: number) => { droppedBytes = Math.min(Number.MAX_SAFE_INTEGER, droppedBytes + bytes) }
  const noteError = (error: unknown) => {
    failures = Math.min(Number.MAX_SAFE_INTEGER, failures + 1)
    const now = Date.now()
    if (!options.onError || now - lastErrorNotice < 60_000) return
    lastErrorNotice = now
    try { options.onError(error) } catch { /* A failed logger must never recursively log itself. */ }
  }

  async function boundExisting(target: string): Promise<void> {
    const stat = await fsp.lstat(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) return
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Log target must be a regular file')
    if (stat.size <= maxFileBytes) return
    const handle = await fsp.open(target, 'r+')
    try {
      const tail = Buffer.alloc(maxFileBytes)
      const { bytesRead } = await handle.read(tail, 0, tail.length, stat.size - tail.length)
      const newline = tail.indexOf(10)
      const start = newline >= 0 ? newline + 1 : 0
      const retained = tail.subarray(start, bytesRead)
      // Logs are disposable diagnostics: a crash during compaction may lose old log lines,
      // but never leaves an additional temporary generation on disk.
      await handle.truncate(0)
      await handle.write(retained, 0, retained.length, 0)
    } finally {
      await handle.close()
    }
  }

  async function initialize(): Promise<void> {
    if (initialized) return
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await boundExisting(`${file}.1`)
    await boundExisting(file)
    initialized = true
  }

  async function appendBatch(batch: Buffer): Promise<void> {
    await boundExisting(file)
    const size = await fsp.stat(file).then(stat => stat.size, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    })
    if (size + batch.length > maxFileBytes) {
      const backup = `${file}.1`
      const backupStat = await fsp.lstat(backup).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (backupStat && (!backupStat.isFile() || backupStat.isSymbolicLink())) throw new Error('Log backup must be a regular file')
      await fsp.rm(backup, { force: true })
      if (size > 0) await fsp.rename(file, backup)
    }
    await fsp.appendFile(file, batch, { mode: 0o600 })
  }

  async function drain(): Promise<void> {
    try { await initialize() } catch (error) {
      addDropped(queuedBytes)
      pending.length = 0
      queuedBytes = 0
      noteError(error)
      return
    }
    while (pending.length > 0) {
      const chunks: Buffer[] = []
      let size = 0
      while (pending.length > 0 && size + pending[0]!.length <= maxFileBytes) {
        const chunk = pending.shift()!
        chunks.push(chunk)
        size += chunk.length
        queuedBytes -= chunk.length
      }
      try { await appendBatch(Buffer.concat(chunks, size)) } catch (error) {
        addDropped(size)
        noteError(error)
      }
    }
  }

  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (flushing) return flushing
    flushing = drain().finally(() => {
      flushing = undefined
      if (pending.length > 0) void flush()
    })
    return flushing
  }

  const write = (value: string | Buffer): boolean => {
    if (closed) return false
    const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value.length
    if (bytes === 0) return true
    if (bytes > maxChunkBytes || queuedBytes + bytes > maxQueuedBytes) {
      addDropped(bytes)
      return false
    }
    // Copy only after the size check; callers may reuse or mutate their input buffer.
    pending.push(Buffer.from(value))
    queuedBytes += bytes
    if (pending.length >= flushMaxChunks) void flush()
    else if (!timer) {
      timer = setTimeout(() => { timer = undefined; void flush() }, flushIntervalMs)
      timer.unref?.()
    }
    return true
  }

  return {
    write,
    flush,
    async close() {
      closed = true
      do { await flush() } while (pending.length > 0 || flushing)
    },
    get stats() { return { queuedBytes, queuedChunks: pending.length, droppedBytes, failures, closed } },
  }
}

/** Reads only a bounded tail, even when inspecting a legacy log that has not rotated yet. */
export async function readLogTail(file: string, count: number, { maxBytes = 256 * 1024 }: { maxBytes?: number } = {}): Promise<string[]> {
  const boundedCount = limit(count, 100, 1, 500)
  const boundedBytes = limit(maxBytes, 256 * 1024, 1024, 1024 * 1024)
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    const stat = await fsp.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return []
    handle = await fsp.open(file, 'r')
    const start = Math.max(0, stat.size - boundedBytes)
    const buffer = Buffer.alloc(Math.min(stat.size, boundedBytes))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-boundedCount)
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
