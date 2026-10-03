import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1] }
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-workspace-'))
const fixture = option('--fixture') ? path.resolve(option('--fixture')) : path.join(runtime, 'fixture.cjs')
if (!option('--fixture')) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}
const rootEmail = 'workspace-owner@example.com'
const otherEmail = 'workspace-other@example.com'
const password = randomBytes(24).toString('hex')
const base = '/api/management/projects'
const checks = []
let server, port, rootCookie, otherCookie
async function start() {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: rootEmail, FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_PUBLIC_HOST: 'workspace.example.com', FLOWBOARD_PUBLIC_PROTOCOL: 'https' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  server.stderr.on('data', value => { errors += value })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${errors}`)), 15000)
    server.once('message', value => { clearTimeout(timer); resolve(value.port) })
    server.once('error', reject)
    server.once('exit', code => reject(new Error(`Fixture exited ${code}: ${errors}`)))
  })
}
async function stop() { if (!server || server.exitCode !== null) return; const done = once(server, 'exit'); server.kill('SIGKILL'); await done }
async function request(route, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const bytes = Buffer.from(await response.arrayBuffer())
  const text = bytes.toString('utf8')
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, text, bytes, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
async function expect(route, options, status = 200) { const r = await request(route, options); assert.equal(r.status, status, `${route}: ${r.text.slice(0, 1200)}`); return r }
function pass(name) { checks.push(name); console.log(`PASS: ${name}`) }
async function register(email, inviteCode) {
  const sent = await expect('/api/auth/send-code', { method: 'POST', body: { email, ...(inviteCode ? { inviteCode } : {}) } })
  return expect('/api/auth/register', { method: 'POST', body: { email, password, code: sent.data.developmentCode, ...(inviteCode ? { inviteCode } : {}) } }, 201)
}
const own = (body, method = 'POST') => ({ method, cookie: rootCookie, body })
const read = () => ({ cookie: rootCookie })
const shape = { id: 'ui_button', type: 'button', name: 'Create project button', x: 42, y: 24, w: 160, h: 48, rotation: 0, fill: '#2563eb', stroke: '#1d4ed8', strokeWidth: 2, opacity: 1, text: '创建项目 <UI>', fontSize: 16, fontWeight: 'bold', textAlign: 'center', textColor: '#ffffff', cornerRadius: 8, lineStyle: 'solid', shadowBlur: 0, shadowColor: '#000000', visible: true, locked: false }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XsAAAAASUVORK5CYII=', 'base64')
try {
  await start()
  const registered = await register(rootEmail); rootCookie = registered.cookie
  const invite = (await expect('/api/admin/invites', own({ maxUses: 2 }), 201)).data
  const other = await register(otherEmail, invite.code); otherCookie = other.cookie
  await expect(base, {}, 401)
  let project = (await expect(base, own({ name: '工作台需求与维护', description: '真实 API 验收数据', mutationId: 'workspace-create-project' }), 201)).data
  assert.ok(project.id && Number.isInteger(project.revision))
  const route = `${base}/${project.id}`
  for (const options of [{ cookie: otherCookie }, { cookie: otherCookie, method: 'PATCH', body: { name: 'Should not change' } }]) {
    assert.ok([403, 404].includes((await request(route, options)).status))
  }
  assert.deepEqual((await expect(base, { cookie: otherCookie })).data, [])
  pass('one account creates a management project; anonymous and other-account access is denied')

  project = (await expect(`${route}/roles`, own({ name: '技术维护', color: '#7c3aed' }), 201)).data
  const roleId = project.roles.at(-1).id
  project = (await expect(`${route}/categories`, own({ name: '功能开发', color: '#059669' }), 201)).data
  const categoryId = project.categories.at(-1).id
  project = (await expect(`${route}/roles/${roleId}`, own({ name: '内核与网站', color: '#6366f1' }, 'PATCH'))).data
  assert.equal(project.roles.find(value => value.id === roleId).name, '内核与网站')
  const createBody = { title: '制作项目表格', description: '完成角色分类、记录与筛选', roleId, categoryId, source: '需求讨论', assignee: '开发', priority: 'high', status: 'todo', mutationId: 'workspace-create-event' }
  project = (await expect(`${route}/events`, own(createBody), 201)).data
  let event = project.events.at(-1)
  const eventId = event.id
  assert.ok(event.createdAt && event.updatedAt && event.recorder)
  assert.equal(event.completedAt, undefined)
  const count = project.events.length
  const repeated = await request(`${route}/events`, own(createBody))
  assert.ok([200, 201].includes(repeated.status), repeated.text)
  assert.equal(repeated.data.events.length, count)
  project = repeated.data
  pass('editable roles/categories and event fields persist; retried mutation does not duplicate the event')

  const versionBefore = project.revision
  project = (await expect(`${route}/events/${eventId}`, own({ status: 'done', expectedRevision: versionBefore, mutationId: 'workspace-complete-event' }, 'PATCH'))).data
  event = project.events.find(value => value.id === eventId)
  assert.ok(event.completedAt >= event.createdAt)
  let stats = (await expect(`${route}/stats`, read())).data
  assert.equal(stats.total, 1); assert.equal(stats.done, 1); assert.equal(stats.completionPercent, 100)
  assert.equal(stats.newToday, 1); assert.equal(stats.completedToday, 1); assert.equal(stats.timeZone, 'Asia/Shanghai')
  assert.equal(stats.byCategory.find(value => value.id === categoryId).count, 1)
  const completed = event.completedAt
  project = (await expect(`${route}/events/${eventId}`, own({ status: 'doing', expectedRevision: project.revision }, 'PATCH'))).data
  assert.equal(project.events.find(value => value.id === eventId).completedAt, undefined)
  stats = (await expect(`${route}/stats`, read())).data
  assert.equal(stats.done, 0); assert.equal(stats.doing, 1); assert.equal(stats.completedToday, 0)
  assert.ok(project.history.some(value => value.eventId === eventId && JSON.stringify(value.changes).includes(String(completed))))
  await expect(`${route}/events/${eventId}`, own({ title: 'Stale overwrite', expectedRevision: versionBefore }, 'PATCH'), 409)
  pass('complete/uncomplete automatically timestamps and audits; totals and stale revision conflict are accurate')

  project = (await expect(`${route}/events`, own({ title: '保密的其它需求', description: 'DO_NOT_SHARE_SECRET_EVENT', roleId, categoryId, status: 'todo', priority: 'urgent' }), 201)).data
  const secretEvent = project.events.at(-1)
  const filtered = (await expect(`${route}/stats?status=doing`, read())).data
  assert.equal(filtered.total, 1); assert.equal(filtered.doing, 1); assert.equal(filtered.todo, 0)
  assert.equal((await expect(`${route}/events?priority=urgent`, read())).data[0].id, secretEvent.id)
  pass('table filters and chart statistics use the same selected records')

  const legacyImage = (await expect('/api/assets', own({ dataUrl: `data:image/png;base64,${png.toString('base64')}` }))).data
  const imageShape = { ...shape, id: 'ui_image', type: 'image', name: '参考截图', src: legacyImage.url, x: 240 }
  await expect('/api/projects/workspace_canvas', own({ id: 'workspace_canvas', title: '服务器 UI 画布', canvas: { version: 3, shapes: { [shape.id]: shape, [imageShape.id]: imageShape }, order: [shape.id, imageShape.id], groups: {}, workspace: { x: 0, y: 0, w: 1200, h: 800 } } }, 'PUT'))
  await expect('/api/projects/other_canvas', { method: 'PUT', cookie: otherCookie, body: { id: 'other_canvas', title: 'Other user canvas', canvas: { shapes: {}, secret: 'OTHER_OWNER' } } })
  assert.ok([403, 404].includes((await request(route, own({ canvasIds: ['other_canvas'] }, 'PATCH'))).status))
  project = (await expect(route, own({ canvasIds: ['workspace_canvas'] }, 'PATCH'))).data
  pass('same account associates its canvas; even an admin cannot associate another owner canvas')

  const attachment = (await expect(`${route}/assets`, own({ name: 'issue.png', dataUrl: `data:image/png;base64,${png.toString('base64')}` }), 201)).data
  await expect(attachment.url, {}, 401)
  assert.ok([403, 404].includes((await request(attachment.url, { cookie: otherCookie })).status))
  assert.deepEqual((await expect(attachment.url, read())).bytes, png)
  project = (await expect(`${route}/events/${eventId}`, own({ attachments: [attachment] }, 'PATCH'))).data
  const share = (await expect('/api/ai-shares', own({ kind: 'management', resourceId: project.id, scope: { canvasIds: ['workspace_canvas'], eventIds: [eventId], includeHistory: true, includeStats: true, includeAttachments: true, includePreview: true } }), 201)).data
  const aiPath = new URL(share.url).pathname
  assert.ok(share.token.length >= 32)
  const markdown = await expect(aiPath, {})
  assert.match(markdown.headers.get('content-type'), /text\/(markdown|plain)/)
  assert.match(markdown.text, /工作台需求与维护/)
  assert.match(markdown.text, /制作项目表格/)
  assert.ok(!markdown.text.includes('DO_NOT_SHARE_SECRET_EVENT'))
  assert.match(markdown.headers.get('cache-control'), /no-store/)
  const exported = (await expect(`${aiPath}/data.json?offset=0&limit=1`, {})).data
  assert.equal(exported.events.length, 1)
  assert.equal(exported.events[0].id, eventId)
  assert.equal(exported.stats.total, 1)
  assert.ok(!JSON.stringify(exported).includes('DO_NOT_SHARE_SECRET_EVENT'))
  assert.deepEqual(exported.canvases.map(value => value.id), ['workspace_canvas'])
  const canvasRead = await expect(`${aiPath}/canvases/workspace_canvas.json`, {})
  assert.ok(canvasRead.text.includes('创建项目 <UI>') && canvasRead.text.includes('2563eb'))
  assert.ok(canvasRead.data.shapes.ui_image.src.includes(`/ai/${share.token}/assets/`))
  assert.ok(!canvasRead.text.includes(legacyImage.url))
  const svg = await expect(`${aiPath}/canvases/workspace_canvas/preview.svg`, {})
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/)
  assert.match(svg.text, /&lt;UI&gt;/)
  const assetPath = new URL(exported.assets[0].url, 'https://workspace.example.com').pathname
  assert.deepEqual((await expect(assetPath, {})).bytes, png)
  assert.ok([404, 403].includes((await request(`${aiPath}/canvases/other_canvas.json`)).status))
  await expect(aiPath, { method: 'POST', body: { name: 'Unauthorized write' } }, 405)
  pass('AI reads scoped Markdown, JSON, native canvas nodes, safe SVG and selected private image without cookies')

  const restricted = (await expect('/api/ai-shares', own({ kind: 'management', resourceId: project.id, scope: { canvasIds: ['workspace_canvas'], eventIds: [eventId], includeHistory: true, includeStats: true, includeAttachments: false, includePreview: false } }), 201)).data
  const restrictedPath = new URL(restricted.url).pathname
  const restrictedData = await expect(`${restrictedPath}/data.json`, {})
  assert.deepEqual(restrictedData.data.assets, [])
  assert.deepEqual(restrictedData.data.events[0].attachments, [])
  assert.ok(!restrictedData.text.includes(attachment.url))
  const restrictedCanvas = await expect(`${restrictedPath}/canvases/workspace_canvas.json`, {})
  assert.ok(!restrictedCanvas.text.includes(legacyImage.url))
  assert.equal(restrictedCanvas.data.shapes.ui_image.src, '')
  await expect(`${restrictedPath}/canvases/workspace_canvas/preview.svg`, {}, 404)
  pass('disabling images removes native and historical asset URLs and denies preview access')

  await stop(); await start()
  assert.equal((await expect(route, read())).data.name, project.name)
  await expect(`${aiPath}/data.json`, {})
  assert.deepEqual((await expect(attachment.url, read())).bytes, png)
  await expect(`/api/ai-shares/${share.id}`, own(undefined, 'DELETE'))
  for (const revoked of [aiPath, `${aiPath}/data.json`, `${aiPath}/canvases/workspace_canvas.json`, `${aiPath}/canvases/workspace_canvas/preview.svg`, assetPath]) {
    assert.ok([404, 410].includes((await request(revoked)).status), revoked)
  }
  pass('abrupt server restart preserves project, session, private image and token; revocation blocks every token endpoint')
  const report = { status: 'PASS_WORKSPACE_INTEGRATION', checks, count: checks.length, actualHttp: true, isolatedRuntime: true, productionUsersModified: false }
  if (option('--report')) await fs.writeFile(path.resolve(option('--report')), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await stop() }
