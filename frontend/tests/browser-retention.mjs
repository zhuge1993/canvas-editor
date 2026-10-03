import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-browser-retention-'))
class MemoryStorage {
  values = new Map()
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}
const previous = { indexedDB: globalThis.indexedDB, localStorage: globalThis.localStorage, fetch: globalThis.fetch, window: globalThis.window }
try {
  const canvasFile = path.join(temporary, 'canvas.cjs'), managementFile = path.join(temporary, 'management.cjs'), storageFile = path.join(temporary, 'storage.cjs')
  await Promise.all([
    build({ entryPoints: [path.join(frontend, 'src/utils/canvasDraft.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: canvasFile }),
    build({ entryPoints: [path.join(frontend, 'src/utils/managementDraft.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: managementFile }),
    build({ entryPoints: [path.join(frontend, 'src/utils/storage.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: storageFile,
      define: { 'import.meta.env.VITE_STORAGE_MODE': '"offline"' } }),
  ])
  const draft = await import(pathToFileURL(canvasFile)), management = await import(pathToFileURL(managementFile))
  const storage = new MemoryStorage(), original = JSON.stringify({ version: 3, shapes: {}, groups: {}, order: [] }), newer = JSON.stringify({ version: 3, shapes: { first: { id: 'first' } }, groups: {}, order: ['first'] })
  draft.writeCanvasDraft(storage, 'doc_one', original, 1000)
  assert.deepEqual(draft.parseCanvasDraft(storage.getItem(draft.canvasDraftKey('doc_one'))), { content: original, updatedAt: 1000 })
  draft.writeCanvasDraft(storage, 'doc_one', newer, 2000)
  assert.equal(draft.clearSavedCanvasDraft(storage, 'doc_one', original), false)
  assert.deepEqual(draft.parseCanvasDraft(storage.getItem(draft.canvasDraftKey('doc_one'))), { content: newer, updatedAt: 2000 })
  assert.equal(draft.clearSavedCanvasDraft(storage, 'doc_one', newer), true)
  assert.equal(storage.getItem(draft.canvasDraftKey('doc_one')), null)
  storage.setItem(draft.canvasDraftKey('legacy'), original)
  assert.deepEqual(draft.parseCanvasDraft(original), { content: original })
  assert.equal(draft.clearSavedCanvasDraft(storage, 'legacy', original), true)
  storage.setItem(draft.canvasDraftKey('corrupt'), '{recovery-needed')
  assert.equal(draft.clearSavedCanvasDraft(storage, 'corrupt', original), false)
  assert.equal(storage.getItem(draft.canvasDraftKey('corrupt')), '{recovery-needed')
  for (let index = 0; index < 1000; index++) { draft.writeCanvasDraft(storage, 'doc_one', original, index); assert.equal(draft.clearSavedCanvasDraft(storage, 'doc_one', original), true) }
  assert.equal(storage.length, 1)
  console.log('PASS: 1000 confirmed saves leave no draft growth; in-flight newer, legacy raw and corrupt recovery data are handled without discarding unconfirmed edits')

  storage.setItem('flowboard.table-setup-draft.v1:alice:mproj_removed', 'unsaved setup')
  storage.setItem('flowboard.project-guide.v1:bob:mproj_removed', 'guide progress')
  storage.setItem('flowboard.table-setup-draft.v1:alice:mproj_retained', 'unsaved other setup')
  storage.setItem('flowboard.project-create-draft.v1:alice', 'unsubmitted project')
  storage.setItem('unrelated:alice:mproj_removed', 'unrelated application data')
  management.clearManagementProjectDrafts(storage, 'mproj_removed')
  assert.equal(storage.getItem('flowboard.table-setup-draft.v1:alice:mproj_removed'), null)
  assert.equal(storage.getItem('flowboard.project-guide.v1:bob:mproj_removed'), null)
  assert.equal(storage.getItem('flowboard.table-setup-draft.v1:alice:mproj_retained'), 'unsaved other setup')
  assert.equal(storage.getItem('flowboard.project-create-draft.v1:alice'), 'unsubmitted project')
  assert.equal(storage.getItem('unrelated:alice:mproj_removed'), 'unrelated application data')
  console.log('PASS: permanent project deletion removes only its setup/guide keys, retaining other projects and unsubmitted creation drafts')

  let opened = 0, closed = 0, live = 0, peak = 0, nextFailure = ''
  const documents = new Map()
  globalThis.localStorage = storage
  globalThis.window = { location: { pathname: '/', href: 'http://isolated.test/' } }
  globalThis.fetch = async () => new Response('', { status: 200 })
  globalThis.indexedDB = { open() {
    const request = {}
    queueMicrotask(() => {
      let isClosed = false
      const db = { objectStoreNames: { contains: () => true }, close() { if (!isClosed) { isClosed = true; closed++; live-- } }, transaction() {
        if (nextFailure === 'throw') { nextFailure = ''; throw new Error('Synthetic transaction construction error') }
        const transaction = { objectStore() { return { index() { return { getAll: () => result(() => [...documents.values()]) } }, get: id => result(() => documents.get(id)),
          put: value => mutate(() => documents.set(value.id, value)), delete: id => mutate(() => documents.delete(id)) } } }
        function result(read) {
          const query = {}
          queueMicrotask(() => { if (nextFailure === 'read') { nextFailure = ''; query.error = new Error('Synthetic read failure'); query.onerror?.() }
            else { query.result = read(); query.onsuccess?.() } })
          return query
        }
        function mutate(change) {
          queueMicrotask(() => { const failure = nextFailure; nextFailure = ''
            if (failure === 'abort') { transaction.error = new Error('Synthetic abort'); transaction.onabort?.() }
            else if (failure === 'write') { transaction.error = new Error('Synthetic write failure'); transaction.onerror?.() }
            else { change(); transaction.oncomplete?.() } })
        }
        return transaction
      } }
      opened++; live++; peak = Math.max(peak, live); request.result = db; request.onsuccess?.()
    })
    return request
  } }
  const api = await import(pathToFileURL(storageFile))
  for (let index = 0; index < 100; index++) {
    await api.saveDocument({ id: 'doc_db', title: 'Isolated offline document', content: original, createdAt: 1, updatedAt: index })
    assert.equal((await api.getDocument('doc_db')).content, original)
    assert.equal((await api.getAllDocuments()).length, 1)
    await api.deleteDocument('doc_db')
    assert.equal(live, 0)
  }
  for (const failure of ['throw', 'read']) { nextFailure = failure; await assert.rejects(api.getDocument('doc_db')); assert.equal(live, 0) }
  for (const failure of ['write', 'abort']) { nextFailure = failure; await assert.rejects(api.saveDocument({ id: 'failed', title: 'Must not commit', createdAt: 1, updatedAt: 1 })); assert.equal(live, 0) }
  assert.equal(documents.has('failed'), false)
  draft.writeCanvasDraft(storage, 'doc_deleted', newer)
  await api.deleteDocument('doc_deleted')
  assert.equal(storage.getItem(draft.canvasDraftKey('doc_deleted')), null)
  assert.equal(opened, closed); assert.equal(live, 0); assert.equal(peak, 1)
  console.log(`PASS: ${opened} offline IndexedDB connections close after reads, writes, deletes, synchronous errors, write errors and transaction aborts; peak live 1, final live 0`)
  console.log('ALL_BROWSER_RETENTION_CHECKS_PASS 3')
} finally {
  for (const key of Object.keys(previous)) { if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key] }
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('flowboard-browser-retention-'))
  await fs.rm(temporary, { recursive: true, force: true })
}
