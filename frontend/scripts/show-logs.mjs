import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const logDirectory = process.env.FLOWBOARD_RUNTIME_DIR?.trim()
  ? path.join(path.resolve(process.env.FLOWBOARD_RUNTIME_DIR.trim()), 'logs')
  : path.resolve(scriptDirectory, '../../logs')

async function tail(file, count) {
  let handle
  try {
    const target = path.join(logDirectory, file)
    const stat = await lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink()) return []
    handle = await open(target, 'r')
    const maxBytes = 256 * 1024
    const start = Math.max(0, stat.size - maxBytes)
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline < 0 ? '' : text.slice(newline + 1)
    }
    return text.trim().split(/\r?\n/).filter(Boolean).slice(-count)
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

const [operations, errors] = await Promise.all([
  tail('operations.log', 12),
  tail('errors.log', 12),
])

console.log('[FlowBoard] Latest operation log:')
console.log(operations.length > 0 ? operations.join('\n') : '(none)')
console.log('[FlowBoard] Latest error log:')
console.log(errors.length > 0 ? errors.join('\n') : '(none)')
