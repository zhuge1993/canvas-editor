import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Real HTTP transport with fresh, mutable authorization callbacks. Complete
// account/membership integration is additionally covered by collaboration tests.
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = await build({ entryPoints: [path.join(frontend, 'managementLive.ts')], bundle: true, platform: 'node',
  target: 'node20', format: 'esm', write: false })
const { attachProjectLive, publishProjectChange } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'))
const authorized = new Set(['alice', 'bob'])
let ownerExists = true, revision = 1
const server = http.createServer((req, res) => {
  const user = req.headers['x-test-user']
  const clientId = new URL(req.url, 'http://localhost').searchParams.get('clientId')
  void attachProjectLive(req, res, { projectId: 'project', clientId, actorId: user || 'anonymous', actorName: user || 'anonymous',
    canRead: async () => ownerExists && authorized.has(user),
    getSnapshot: async () => ({ id: 'project', revision, access: user === 'alice' ? 'owner' : 'edit', marker: user }),
  })
})
const sockets = new Set()
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const clients = []
async function connect(user, clientId) {
  const controller = new AbortController()
  const response = await fetch(`${base}/?clientId=${clientId}`, { headers: { 'X-Test-User': user }, signal: controller.signal })
  assert.equal(response.status, 200)
  assert.ok(response.headers.get('content-type').includes('text/event-stream'))
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const client = { controller, reader, frames: [], done: false, failed: undefined }
  clients.push(client)
  void (async () => {
    let pending = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        let boundary
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
          if (frame.startsWith(':')) client.frames.push({ event: 'heartbeat' })
          else {
            const event = frame.match(/^event: (.+)$/m)?.[1]
            const data = frame.match(/^data: (.+)$/m)?.[1]
            if (data) client.frames.push({ event, data: JSON.parse(data) })
          }
        }
      }
    } catch (error) { if (!controller.signal.aborted) client.failed = error }
    finally { client.done = true }
  })()
  return client
}
async function wait(condition, label, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('SSE timeout: ' + label)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
try {
  const denied = await fetch(`${base}/?clientId=guest`, { headers: { 'X-Test-User': 'unregistered' } })
  assert.equal(denied.status, 403)
  const alice = await connect('alice', 'alice_tab1')
  const bob = await connect('bob', 'bob_tab1')
  await wait(() => alice.frames.some(frame => frame.event === 'snapshot') && bob.frames.some(frame => frame.event === 'snapshot'), 'initial snapshot')
  assert.equal(alice.frames.find(frame => frame.event === 'snapshot').data.project.access, 'owner')
  assert.equal(bob.frames.find(frame => frame.event === 'snapshot').data.project.access, 'edit')
  assert.equal(bob.frames.find(frame => frame.event === 'snapshot').data.project.marker, 'bob')
  assert.equal(alice.frames.find(frame => frame.event === 'snapshot').data.refreshRequired, true)
  assert.equal(bob.frames.find(frame => frame.event === 'snapshot').data.refreshRequired, true)
  await wait(() => alice.frames.some(frame => frame.event === 'presence' && frame.data.users.length === 2), 'two online users')
  const bobSecond = await connect('bob', 'bob_tab2')
  await wait(() => alice.frames.some(frame => frame.event === 'presence' && frame.data.users.some(user => user.userId === 'bob' && user.sessions === 2)), 'two tabs one user')
  revision = 2; publishProjectChange('project', revision)
  await wait(() => alice.frames.some(frame => frame.event === 'revision' && frame.data.revision === 2) &&
    bob.frames.some(frame => frame.event === 'revision' && frame.data.revision === 2), 'committed revision')
  assert.deepEqual(Object.keys(bob.frames.find(frame => frame.event === 'revision').data), ['revision'])
  const replacement = await connect('bob', 'bob_tab2')
  await wait(() => bobSecond.done, 'duplicate client close')
  authorized.delete('bob'); revision = 3; publishProjectChange('project', revision)
  await wait(() => bob.done && replacement.done, 'permission revoked cleanup')
  assert.equal(bob.frames.some(frame => frame.event === 'revision' && frame.data.revision === 3), false)
  await wait(() => alice.frames.some(frame => frame.event === 'presence' && frame.data.users.length === 1 && frame.data.users[0].userId === 'alice'), 'revoked users leave presence')
  ownerExists = false; publishProjectChange('project', 4)
  await wait(() => alice.done, 'deleted owner cleanup')
  const stale = await fetch(`${base}/?clientId=stale`, { headers: { 'X-Test-User': 'alice' } })
  assert.equal(stale.status, 403)
  assert.ok(clients.every(client => !client.failed))
  console.log('PASS: real SSE HTTP; per-actor projection; two users/multiple tabs; metadata-only committed revisions; duplicate replacement; fresh revoke/owner deletion and presence cleanup')
} finally {
  for (const client of clients) client.controller.abort()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
}
