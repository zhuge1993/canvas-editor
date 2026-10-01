#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const STATE_DIR = '/var/lib/dior-tunnel'
const CLIENT = '/usr/local/bin/cloudflared'
const MAX_LINE = 8192

function extractQuickUrl(line) {
  if (line.length > MAX_LINE) return null
  const candidates = line.matchAll(/(?:^|[\s|<>"'=])(https:\/\/[^\s|<>"'`]+)/g)
  for (const match of candidates) {
    const candidate = match[1]
    // One DNS label only, no credentials, port, path, query, or fragment.
    if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/.test(candidate)) continue
    const url = new URL(candidate)
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash) return url.origin
  }
  return null
}

function lineCollector(onLine) {
  let pending = ''
  let discarding = false
  return {
    push(chunk) {
      for (const part of String(chunk).split(/(?<=\n)/)) {
        const end = part.endsWith('\n')
        if (!discarding) {
          pending += part
          if (pending.length > MAX_LINE) { pending = ''; discarding = true }
        }
        if (end) {
          if (!discarding) onLine(pending.replace(/[\r\n]+$/, ''))
          pending = ''
          discarding = false
        }
      }
    },
    end() {
      if (!discarding && pending) onLine(pending)
      pending = ''
      discarding = false
    },
  }
}

function atomicWrite(directory, name, data) {
  const temporary = path.join(directory, `.${name}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`)
  let fd
  try {
    fd = fs.openSync(temporary, 'wx', 0o644)
    fs.writeFileSync(fd, data, 'utf8')
    fs.fchmodSync(fd, 0o644)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, path.join(directory, name))
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function cloudArgs() {
  // /dev/null and a dedicated HOME prevent loading a saved account/configuration.
  return ['tunnel', '--config', '/dev/null', '--origincert', '/dev/null',
    '--url', 'http://127.0.0.1:3000', '--protocol', 'http2', '--edge-ip-version', '4',
    '--no-autoupdate', '--metrics', '127.0.0.1:20241', '--loglevel', 'info', '--grace-period', '10s']
}

function startQuick(options = {}) {
  const directory = options.stateDir || STATE_DIR
  const spawnClient = options.spawnImpl || spawn
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 })
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Quick Tunnel state directory must be a real directory')
  fs.chmodSync(directory, 0o755)
  const startedAt = new Date().toISOString()
  let publicUrl = null
  let child
  let stopping = false
  let killer
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const writeStatus = (state, extra = {}) => atomicWrite(directory, 'status.json', JSON.stringify({
    provider: 'quick', state, publicUrl, startedAt, updatedAt: new Date().toISOString(),
    wrapperPid: process.pid, clientPid: child?.pid || null,
    publicConnectivityVerified: false, hostnamePermanent: false, ...extra,
  }) + '\n')
  const clearUrl = () => { publicUrl = null; atomicWrite(directory, 'public-url', '') }
  clearUrl()
  writeStatus('starting')
  // Pass only public process settings; never pass FlowBoard or account variables.
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    TZ: process.env.TZ || 'UTC', LANG: 'C.UTF-8', HOME: directory,
    GOGC: '50', GOMEMLIMIT: '96MiB', GOMAXPROCS: '2' }
  const onLine = line => {
    const url = extractQuickUrl(line)
    if (!publicUrl && !stopping && url) {
      publicUrl = url
      atomicWrite(directory, 'public-url', url + '\n')
      writeStatus('url-issued')
      if (!options.quiet) console.log(`Dior Quick Tunnel current URL: ${url}`)
    }
  }
  const stdout = lineCollector(onLine)
  const stderr = lineCollector(onLine)
  const stop = () => {
    if (stopping) return
    stopping = true
    clearUrl()
    writeStatus('stopping')
    child?.kill('SIGTERM')
    killer = setTimeout(() => child?.kill('SIGKILL'), 15000)
    killer.unref()
  }
  const onSignal = () => stop()
  let complete = false
  const onClose = (code, signal, error) => {
    if (complete) return
    complete = true
    clearTimeout(killer)
    stdout.end()
    stderr.end()
    clearUrl()
    writeStatus(stopping ? 'stopped' : 'exited', { exitCode: code, signal: signal || null,
      ...(error ? { error: error.code || 'spawn-failed' } : {}) })
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGINT', onSignal)
    finish(stopping ? 0 : (typeof code === 'number' && code !== 0 ? code : 1))
  }
  try {
    child = spawnClient(CLIENT, cloudArgs(), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    writeStatus('starting')
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', error => onClose(null, null, error))
    child.once('close', (code, signal) => onClose(code, signal))
    if (options.signals !== false) {
      process.on('SIGTERM', onSignal)
      process.on('SIGINT', onSignal)
    }
  } catch (error) { onClose(null, null, error) }
  return { child, done, stop }
}

module.exports = { extractQuickUrl, lineCollector, cloudArgs, startQuick }
if (require.main === module) {
  if (process.argv.length !== 2 || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    console.error('Run the Quick Tunnel wrapper without arguments as the flowboard-tunnel service user.')
    process.exitCode = 78
  } else {
    try { startQuick().done.then(code => { process.exitCode = code }) }
    catch (error) { console.error(`Dior Quick Tunnel: ${error.message}`); process.exitCode = 1 }
  }
}
