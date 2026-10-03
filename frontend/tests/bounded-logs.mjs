import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-bounded-logs-'))
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const fixture = option('--fixture') ? path.resolve(option('--fixture')) : path.join(directory, 'fixture.cjs')
if (!option('--fixture')) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/bounded-logs-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}
const { createBoundedLogWriter, readLogTail, createStaticFileCache } = createRequire(import.meta.url)(fixture)

try {
  const file = path.join(directory, 'operations.log')
  const writer = createBoundedLogWriter(file, { maxFileBytes: 1024, maxQueuedBytes: 4096, maxChunkBytes: 256, flushMaxChunks: 1 })
  for (let index = 0; index < 300; index += 1) {
    assert.equal(writer.write(`${String(index).padStart(4, '0')} ${'x'.repeat(90)}\n`), true)
    await writer.flush()
  }
  await writer.close()
  const retained = await fs.readdir(directory)
  assert.ok(retained.includes('operations.log.1'))
  assert.equal(retained.filter(name => name.startsWith('operations.log')).length, 2)
  for (const name of ['operations.log', 'operations.log.1']) assert.ok((await fs.stat(path.join(directory, name))).size <= 1024)
  assert.equal((await readLogTail(file, 2)).length, 2)
  assert.ok((await readLogTail(file, 2))[1].startsWith('0299 '))
  assert.equal(writer.write('after close\n'), false)
  console.log('PASS diagnostic files stay within two fixed generations, tail returns latest lines')

  const flood = createBoundedLogWriter(path.join(directory, 'flood.log'), { maxFileBytes: 1024, maxQueuedBytes: 4096, maxChunkBytes: 256, flushMaxChunks: 1 })
  for (let index = 0; index < 100_000; index += 1) {
    flood.write(`${'x'.repeat(200)}\n`)
    assert.ok(flood.stats.queuedBytes <= 4096)
  }
  assert.ok(flood.stats.droppedBytes > 0)
  assert.equal(flood.write(Buffer.alloc(16 * 1024 * 1024)), false)
  await flood.close()
  assert.equal(flood.stats.queuedBytes, 0)
  assert.equal(flood.stats.failures, 0)
  for (const name of ['flood.log', 'flood.log.1']) assert.ok((await fs.stat(path.join(directory, name))).size <= 1024)
  console.log('PASS 100000-line burst has a bounded byte queue and drops oversized diagnostics')

  const legacy = path.join(directory, 'legacy.log')
  await fs.writeFile(legacy, `${'old line\n'.repeat(1000)}last legacy line\n`)
  await fs.writeFile(`${legacy}.1`, 'backup line\n'.repeat(1000))
  const repaired = createBoundedLogWriter(legacy, { maxFileBytes: 1024 })
  assert.equal(repaired.write('new line\n'), true)
  await repaired.close()
  for (const name of [legacy, `${legacy}.1`]) assert.ok((await fs.stat(name)).size <= 1024)
  assert.equal((await readLogTail(legacy, 1))[0], 'new line')
  const quiet = path.join(directory, 'quiet.log')
  await fs.writeFile(quiet, 'quiet legacy line\n'.repeat(1000))
  await fs.writeFile(`${quiet}.1`, 'quiet backup line\n'.repeat(1000))
  const quietWriter = createBoundedLogWriter(quiet, { maxFileBytes: 1024 })
  await quietWriter.flush()
  for (const name of [quiet, `${quiet}.1`]) assert.ok((await fs.stat(name)).size <= 1024)
  assert.equal(quietWriter.stats.queuedBytes, 0)
  assert.equal(quietWriter.stats.failures, 0)
  await quietWriter.close()
  const huge = path.join(directory, 'huge.log')
  await fs.writeFile(huge, `${'z'.repeat(2 * 1024 * 1024)}\nlast bounded line\n`)
  assert.deepEqual(await readLogTail(huge, 500, { maxBytes: 1024 }), ['last bounded line'])
  assert.deepEqual(await readLogTail(path.join(directory, 'missing'), 10), [])
  console.log('PASS legacy oversized files compact on empty flush or write, and tail skips partial giant lines')

  const invalidTarget = path.join(directory, 'directory-target.log')
  await fs.mkdir(invalidTarget)
  let reported = 0
  const failing = createBoundedLogWriter(invalidTarget, { flushMaxChunks: 1, onError: () => { reported += 1; throw new Error('logger failure') } })
  for (let index = 0; index < 5; index += 1) { failing.write('unwritable\n'); await failing.flush() }
  assert.equal(failing.stats.failures, 5)
  await failing.close()
  assert.equal(failing.stats.failures, 6)
  assert.equal(failing.stats.queuedBytes, 0)
  assert.equal(reported, 1)
  assert.equal((await fs.readdir(directory)).filter(name => name.startsWith('directory-target.log')).length, 1)
  console.log('PASS failed writes do not retain retry queues or recursively report failures')

  const cache = createStaticFileCache({ maxBytes: 100, maxEntries: 3, maxFileBytes: 60 })
  const entry = bytes => ({ content: Buffer.alloc(bytes), mime: 'image/png', ext: '.png' })
  cache.set('first', entry(40)); cache.set('second', entry(40))
  assert.ok(cache.get('first'))
  cache.set('third', entry(40))
  assert.equal(cache.get('second'), undefined)
  assert.ok(cache.get('first'))
  assert.equal(cache.set('oversized', entry(61)), false)
  for (let index = 0; index < 10_000; index += 1) {
    cache.set(String(index), entry(15))
    assert.ok(cache.stats.bytes <= 100)
    assert.ok(cache.stats.entries <= 3)
  }
  assert.equal(cache.get('first'), undefined)
  console.log('PASS static asset LRU enforces byte and entry budgets under 10000 unique requests')
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
