import http from 'node:http'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { ensureRuntimeDirs, handleRuntimeRequest } from '../runtimeCore.js'

const root = process.env.FLOWBOARD_RUNTIME_DIR!
const paths = {
  dataDirectory: path.join(root, 'project-data'),
  authDirectory: path.join(root, 'auth-data'),
  logDirectory: path.join(root, 'logs'),
}
let failNextSync = false
let failSyncFile: string | undefined
let healthMode = 'normal'
const originalOpen = fsp.open.bind(fsp)
fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
  const handle = await originalOpen(...args)
  const temporary = String(args[0])
  const targeted = failSyncFile !== undefined && path.basename(temporary).startsWith(`${failSyncFile}.`) && temporary.endsWith('.tmp')
  if (temporary.endsWith('.tmp') && (failNextSync || targeted)) {
    if (failNextSync) failNextSync = false
    if (targeted) failSyncFile = undefined
    handle.sync = async () => { throw Object.assign(new Error('Injected storage sync failure'), { code: 'EIO' }) }
  }
  return handle
}) as typeof fsp.open

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/health' && healthMode !== 'normal') {
    if (healthMode === 'hang') return
    res.setHeader('Content-Type', 'application/json')
    res.end('{"app":"OtherApp","status":"ok"}')
    return
  }
  if (!await handleRuntimeRequest(req, res, { paths })) {
    res.statusCode = 404
    res.end()
  }
})
ensureRuntimeDirs(paths).then(() => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address && typeof address !== 'string') process.send?.({ port: address.port })
  })
}).catch((error) => { console.error(error.message); process.exit(1) })
process.on('message', (message: { id: string; command: string; value?: string }) => {
  if (message.command === 'fail-next-sync') failNextSync = true
  if (message.command === 'fail-sync-file') {
    if (typeof message.value !== 'string' || !/^[A-Za-z0-9_-]+\.json$/.test(message.value)) throw new Error('Fixture sync target must be a JSON basename')
    failSyncFile = message.value
  }
  if (message.command === 'health-mode') healthMode = message.value!
  if (message.command === 'public-mode') {
    if (message.value === 'fixed') process.env.FLOWBOARD_PUBLIC_HOST = 'draw.example.com'
    else delete process.env.FLOWBOARD_PUBLIC_HOST
    process.env.FLOWBOARD_PUBLIC_PROTOCOL = message.value === 'http' ? 'http' : 'https'
  }
  process.send?.({ id: message.id })
})
