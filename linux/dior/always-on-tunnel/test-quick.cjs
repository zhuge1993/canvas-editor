'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { extractQuickUrl, lineCollector, cloudArgs, startQuick } = require('./dior-quick-tunnel.cjs')

async function waitFor(predicate) {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fake child')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function main() {
  const origin = 'https://quiet-river-test.trycloudflare.com'
  assert.equal(extractQuickUrl(`INF | ${origin} |`), origin)
  assert.equal(extractQuickUrl(`url=${origin}/`), origin)
  for (const bad of [
    'http://quiet-river-test.trycloudflare.com', 'https://quiet-river-test.trycloudflare.com.evil.net',
    'https://user@quiet-river-test.trycloudflare.com', 'https://quiet-river-test.trycloudflare.com:443',
    'https://quiet-river-test.trycloudflare.com/path', 'https://quiet-river-test.trycloudflare.com?x=1',
    'https://quiet-river-test.trycloudflare.com#x', 'https://nested.quiet-river-test.trycloudflare.com',
    'https://-bad.trycloudflare.com', 'https://bad-.trycloudflare.com', 'https://bad_label.trycloudflare.com',
    `https://${'a'.repeat(64)}.trycloudflare.com`, `malformed${origin}`,
  ]) assert.equal(extractQuickUrl(bad), null, bad)
  const lines = []
  const collector = lineCollector(line => lines.push(line))
  collector.push('prefix ' + 'x'.repeat(9000) + '\n| https://quiet-')
  collector.push('river-test.trycloudflare.com |\r\n')
  collector.end()
  assert.deepEqual(lines, [`| ${origin} |`])
  const args = cloudArgs()
  assert.equal(args[args.indexOf('--url') + 1], 'http://127.0.0.1:3000')
  assert.equal(args[args.indexOf('--protocol') + 1], 'http2')
  assert.equal(args[args.indexOf('--config') + 1], '/dev/null')
  assert.ok(args.includes('--no-autoupdate'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dior-quick-wrapper-'))
  let active
  try {
    const state = path.join(root, 'state')
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, 'public-url'), 'https://stale.trycloudflare.com\n')
    const childFile = path.join(root, 'fake-child.cjs')
    fs.writeFileSync(childFile, `
process.stdout.write('https://bad.trycloudflare.com.evil.net\\n');
process.stderr.write('| https://quiet-river-test.trycloud');
setTimeout(() => process.stderr.write('flare.com |\\n'), 30);
setTimeout(() => process.exit(23), 500);
`, 'utf8')
    let captured
    const start = () => startQuick({ stateDir: state, quiet: true, signals: false,
      spawnImpl(binary, childArgs, options) {
        captured = { binary, childArgs, env: options.env }
        return spawn(process.execPath, [childFile], options)
      } })
    active = start()
    assert.equal(fs.readFileSync(path.join(state, 'public-url'), 'utf8'), '')
    await waitFor(() => fs.readFileSync(path.join(state, 'public-url'), 'utf8').trim() === origin)
    const issued = JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8'))
    assert.equal(issued.state, 'url-issued')
    assert.equal(issued.publicConnectivityVerified, false)
    assert.equal(issued.hostnamePermanent, false)
    assert.equal(captured.env.HOME, state)
    assert.equal(captured.binary, '/usr/local/bin/cloudflared')
    assert.equal(await active.done, 23)
    assert.equal(fs.readFileSync(path.join(state, 'public-url'), 'utf8'), '')
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8')).state, 'exited')
    // A normal service stop clears URL immediately and forwards termination.
    fs.writeFileSync(childFile, `process.stdout.write('| ${origin} |\\n'); setInterval(() => {}, 1000);`, 'utf8')
    active = start()
    await waitFor(() => fs.readFileSync(path.join(state, 'public-url'), 'utf8').trim() === origin)
    active.stop()
    assert.equal(fs.readFileSync(path.join(state, 'public-url'), 'utf8'), '')
    assert.equal(await active.done, 0)
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8')).state, 'stopped')
    assert.equal(fs.readdirSync(state).some(name => name.endsWith('.tmp')), false)
    console.log('PASS: strict Quick URL extraction; bounded split-stream parsing; HTTP2/local origin arguments; atomic URL replacement; stale/exit/stop cleanup; no false public connectivity claim')
  } finally {
    if (active && active.child && active.child.exitCode === null) active.child.kill('SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
