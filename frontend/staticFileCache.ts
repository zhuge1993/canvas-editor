interface StaticFile {
  content: Buffer
  mime: string
  ext: string
}

/** The shipped UI stays cached without retaining every requested asset for the process lifetime. */
export function createStaticFileCache({ maxBytes = 16 * 1024 * 1024, maxEntries = 64, maxFileBytes = 2 * 1024 * 1024 } = {}) {
  const entries = new Map<string, StaticFile>()
  let bytes = 0
  const remove = (key: string) => {
    const entry = entries.get(key)
    if (entry) bytes -= entry.content.length
    entries.delete(key)
  }
  return {
    get(key: string): StaticFile | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return entry
    },
    set(key: string, entry: StaticFile): boolean {
      remove(key)
      if (entry.content.length > Math.min(maxFileBytes, maxBytes) || maxEntries < 1) return false
      while (entries.size >= maxEntries || bytes + entry.content.length > maxBytes) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        remove(oldest)
      }
      entries.set(key, entry)
      bytes += entry.content.length
      return true
    },
    get stats() { return { bytes, entries: entries.size } },
  }
}
