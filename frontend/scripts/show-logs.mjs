import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const logDirectory = path.resolve(scriptDirectory, '../../logs')

async function tail(file, count) {
  try {
    const text = await readFile(path.join(logDirectory, file), 'utf8')
    return text.trim().split(/\r?\n/).filter(Boolean).slice(-count)
  } catch {
    return []
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
