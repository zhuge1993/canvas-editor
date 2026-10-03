/** Temporary guards reject new entries at capacity rather than evicting a live lock. */
export class BoundedTtlMap<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>()
  private readonly capacity: number
  private readonly ttlMs: number

  constructor(capacity: number, ttlMs: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Invalid temporary state limits')
    this.capacity = capacity
    this.ttlMs = ttlMs
  }

  get size(): number { return this.entries.size }

  prune(now = Date.now()): number {
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) { this.entries.delete(key); removed++ }
    }
    return removed
  }

  hasCapacity(key: string, now = Date.now()): boolean {
    this.prune(now)
    return this.entries.has(key) || this.entries.size < this.capacity
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) { this.entries.delete(key); return undefined }
    return entry.value
  }

  set(key: string, value: T, now = Date.now()): boolean {
    if (!this.hasCapacity(key, now)) return false
    this.entries.set(key, { value, expiresAt: now + this.ttlMs })
    return true
  }

  delete(key: string): boolean { return this.entries.delete(key) }
}

/** Recomputable values may evict their oldest entry; durable application data may not. */
export class BoundedCache<T> {
  private readonly entries = new Map<string, T>()
  private readonly capacity: number

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid cache capacity')
    this.capacity = capacity
  }

  get size(): number { return this.entries.size }
  get(key: string): T | undefined { return this.entries.get(key) }
  set(key: string, value: T): void {
    this.entries.delete(key)
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(key, value)
  }
  delete(key: string): boolean { return this.entries.delete(key) }
}

/** A serial worker also needs a bounded waiting room, not just one active operation. */
export class BoundedWorkQueue {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private readonly capacity: number
  private readonly overflow: () => Error

  constructor(capacity: number, overflow = () => new Error('Work queue capacity reached')) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid work queue capacity')
    this.capacity = capacity
    this.overflow = overflow
  }

  get size(): number { return this.pending }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= this.capacity) throw this.overflow()
    this.pending++
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const previous = this.tail
    this.tail = previous.catch(() => undefined).then(() => gate)
    await previous.catch(() => undefined)
    try { return await operation() }
    finally { this.pending--; release() }
  }
}
