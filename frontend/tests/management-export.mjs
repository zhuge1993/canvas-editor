import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = await build({ entryPoints: [path.join(frontend, 'managementExport.ts')], bundle: true,
  platform: 'node', target: 'node20', format: 'esm', write: false })
const { buildManagementExport, renderManagementMarkdown, renderCanvasPreview, collectCanvasAssetRefs } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const baseUrl = 'https://draw.example.com/ai/test_token_abcdefghijkl'
const legacy = '/api/assets/' + 'a'.repeat(32) + '.png'
const otherLegacy = '/api/assets/' + 'b'.repeat(32) + '.png'
const privateUrl = '/api/management/projects/workspace/assets/private-original-id'
const mapped = baseUrl + '/assets/public-opaque-id'
const canvasMapped = baseUrl + '/assets/public-canvas-id'
const privateAttachment = { id: 'private-original-id', name: 'Example.png', mime: 'image/png', bytes: 23, url: privateUrl, createdAt: 1 }
const publicAttachment = { ...privateAttachment, id: 'public-opaque-id', url: mapped }
const event = { id: 'selected', title: 'Chosen event', description: 'ordinary text', roleId: 'role', categoryId: 'cat',
  source: 'owner', recorder: 'author', assignee: 'person', priority: 'high', status: 'todo', createdAt: 1, updatedAt: 2,
  attachments: [privateAttachment] }
const canvas = { version: 3, order: ['group'], groups: { group: { id: 'group', childIds: ['text', 'picture'], visible: true } },
  workspace: { x: -10, y: 4, w: 1200, h: 800 }, backgroundColor: '#ffffff', custom: { untouched: [1, 'label'] },
  thumbnail: 'data:image/png;base64,QUJDRA==', shapes: {
    text: { id: 'text', type: 'text', x: 12.5, y: -3, w: 101, h: 42, fill: '#abcdef', text: 'Full text <safe> 😄',
      fontSize: 23, fontFamily: 'OriginalFont', fontWeight: 'bold', textColor: '#123456', rotation: 17, visible: true },
    picture: { id: 'picture', type: 'image', x: 90, y: 80, w: 100, h: 60, src: legacy, visible: true },
  } }
const project = { id: 'workspace', ownerId: 'private-owner', name: 'Workspace', description: 'description', color: '#123456', icon: 'task',
  roles: [{ id: 'role', name: 'Role', color: '#123456' }], categories: [{ id: 'cat', name: 'Category', color: '#123456' }],
  canvasIds: ['canvas', 'unselected-canvas'], events: [event, { ...event, id: 'hidden', title: 'UNSELECTED_SECRET', attachments: [] }],
  history: [
    { id: 'h1', eventId: 'selected', action: 'attachments', at: 1, actorId: 'author', changes: [{ field: 'attachments', before: [], after: [privateAttachment] }] },
    { id: 'h2', eventId: 'hidden', action: 'updated', at: 1, actorId: 'author', changes: [{ field: 'title', before: 'HIDDEN', after: 'HIDDEN_SECRET' }] },
    { id: 'h3', action: 'project.update', at: 1, actorId: 'author', changes: [{ field: 'description', before: '', after: legacy }] },
  ], createdAt: 1, updatedAt: 2, revision: 3 }
function input(scope = {}) {
  return { kind: 'management', resourceId: 'workspace', project, scope, canvases: [
    { id: 'canvas', title: 'Selected canvas', canvas }, { id: 'unselected-canvas', title: 'SECRET_CANVAS', canvas: { src: otherLegacy } },
  ], assets: [publicAttachment, { ...publicAttachment, id: 'public-canvas-id', url: canvasMapped },
    { ...publicAttachment, id: 'hidden', url: baseUrl + '/assets/hidden' }],
  assetUrls: { [privateUrl]: mapped, [legacy]: canvasMapped, [otherLegacy]: baseUrl + '/assets/hidden' },
  baseUrl, now: 10, offset: 0, limit: 1, historyOffset: 0, historyLimit: 1 }
}

const chosen = buildManagementExport(input({ eventIds: ['selected'], canvasIds: ['canvas'] }))
assert.equal(chosen.events[0].attachments[0].id, 'public-opaque-id', 'private IDs correlate through URLs, not opaque ID equality')
assert.equal(chosen.events[0].attachments[0].url, mapped)
assert.deepEqual(chosen.assets.map(asset => asset.id).sort(), ['public-canvas-id', 'public-opaque-id'])
assert.equal(chosen.history[0].changes[0].after[0].id, 'public-opaque-id')
assert.equal(chosen.historyPagination.total, 2)
assert.ok(chosen.historyPagination.nextUrl.includes('historyOffset=1'))
assert.equal(JSON.stringify(chosen).includes('UNSELECTED_SECRET'), false)
assert.equal(JSON.stringify(chosen).includes('SECRET_CANVAS'), false)
assert.equal(JSON.stringify(chosen).includes('private-owner'), false)
assert.equal(JSON.stringify(chosen).includes(privateUrl), false)

const canvasInput = { ...input({ canvasIds: ['canvas'] }), kind: 'canvas', resourceId: 'canvas', project: undefined }
const native = buildManagementExport(canvasInput)
assert.deepEqual(JSON.parse(JSON.stringify(native.canvas.shapes.text)), canvas.shapes.text)
assert.deepEqual(JSON.parse(JSON.stringify(native.canvas.groups)), canvas.groups)
assert.deepEqual(JSON.parse(JSON.stringify(native.canvas.workspace)), canvas.workspace)
assert.equal(native.canvas.shapes.picture.src, canvasMapped)
assert.equal(native.canvas.thumbnail, '')
assert.deepEqual(collectCanvasAssetRefs(canvas), [legacy])

const disabled = buildManagementExport({ ...canvasInput, scope: { includeAttachments: false } })
assert.equal(disabled.canvas.shapes.picture.src, '')
assert.equal(disabled.canvas.thumbnail, '')
assert.equal(JSON.stringify(disabled).includes(legacy), false)
assert.equal(JSON.stringify(disabled).includes('data:image/'), false)
assert.deepEqual(disabled.assets, [])
assert.deepEqual(JSON.parse(JSON.stringify(disabled.canvas.shapes.text)), canvas.shapes.text)
const disabledHistory = buildManagementExport(input({ eventIds: ['selected'], canvasIds: [], includeAttachments: false }))
assert.deepEqual(disabledHistory.events[0].attachments, [])
assert.deepEqual(disabledHistory.history[0].changes[0].after, [])
assert.equal(JSON.stringify(disabledHistory).includes(privateUrl), false)
const noEvents = buildManagementExport(input({ eventIds: [], canvasIds: [], includeHistory: false, includeStats: false, includeAttachments: false }))
assert.deepEqual(noEvents.events, [])
assert.deepEqual(noEvents.canvases, [])
assert.equal(noEvents.history, undefined)
assert.equal(noEvents.stats, undefined)

const malicious = structuredClone(canvas)
malicious.shapes.text.text = '</text><script>alert(1)</script>'
malicious.shapes.text.fill = 'url(https://evil.example/paint)'
malicious.shapes.text.fontFamily = '" onload="alert(1)'
malicious.shapes.picture.src = 'https://evil.example/picture.png'
const svg = renderCanvasPreview(malicious, {})
assert.equal(svg.includes('<script'), false)
assert.equal(svg.includes('<foreignObject'), false)
assert.equal(svg.includes('https://evil.example'), false)
assert.equal(svg.includes('href="javascript:'), false)
assert.equal(svg.includes('" onload="'), false)
assert.ok(svg.includes('&lt;script&gt;'))
const localImageSvg = renderCanvasPreview(canvas, { [legacy]: 'https://evil.example/ai/test_token_abcdefghijkl/assets/public-canvas-id' })
assert.equal(localImageSvg.includes('https://evil.example'), false, 'SVG references stay same origin even for absolute mapping')
assert.ok(localImageSvg.includes('href="/ai/test_token_abcdefghijkl/assets/public-canvas-id"'))
const markdown = renderManagementMarkdown({ ...chosen, name: '<script>fake</script>' })
assert.equal(markdown.includes('<script>'), false)
assert.ok(markdown.includes('Structured JSON'))
assert.ok(markdown.includes('Continue history'))
assert.equal(JSON.stringify(canvas).includes('public-canvas-id'), false, 'projection cannot mutate original canvas')
console.log('PASS: scoped AI projection; opaque asset URL correlation; disabled attachments/history redaction; exact native node fields; explicit pagination; no-script/no-external SVG and Markdown')
