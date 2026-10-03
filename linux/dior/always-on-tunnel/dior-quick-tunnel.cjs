#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const http = require('node:http')
const https = require('node:https')
const dns = require('node:dns')
const net = require('node:net')
const { performance } = require('node:perf_hooks')

const STATE_DIR = '/var/lib/dior-tunnel'
const CLIENT = '/usr/local/bin/cloudflared'
const MAX_LINE = 8192
const READY_URL = 'http://127.0.0.1:20241/ready'
const HEALTH_URL = 'http://127.0.0.1:3000/api/health'
const OFFICIAL_API_URL = 'https://api.trycloudflare.com/'

function requestStatus(url, options = {}) {
  return new Promise(resolve => {
    let request, response, deadline, resolver
    let finished = false
    const finish = result => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      options.signal?.removeEventListener('abort', onAbort)
      resolver?.cancel()
      response?.destroy()
      request?.destroy()
      resolve(result)
    }
    const onAbort = () => finish(null)
    if (options.signal?.aborted) return finish(null)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const transport = url.startsWith('https:') ? https : http
    deadline = setTimeout(() => finish(null), options.timeoutMs || 5000)
    try {
      const requestOptions = { agent: false, family: 4, rejectUnauthorized: true }
      if (!net.isIP(new URL(url).hostname)) {
        // getaddrinfo can outlive request.destroy(). A per-probe c-ares resolver
        // can cancel DNS as well as the socket when the deadline/stop fires.
        resolver = new dns.Resolver({ timeout: 1000, tries: 2 })
        requestOptions.lookup = (hostname, lookupOptions, callback) => resolver.resolve4(hostname, (error, addresses) => {
          if (error) return callback(error)
          if (!addresses?.length) return callback(Object.assign(new Error('No IPv4 address'), { code: 'ENODATA' }))
          if (lookupOptions.all) callback(null, addresses.map(address => ({ address, family: 4 })))
          else callback(null, addresses[0], 4)
        })
      }
      request = transport.get(url, requestOptions, value => {
        response = value
        if (finished) { response.destroy(); return }
        if (!options.readBody) return finish({ statusCode: response.statusCode, body: null })
        let text = ''
        let size = 0
        response.setEncoding('utf8')
        response.on('data', part => {
          size += Buffer.byteLength(part)
          if (size > 4096) return finish(null)
          text += part
        })
        response.once('error', () => finish(null))
        response.once('aborted', () => finish(null))
        response.once('end', () => finish({ statusCode: response.statusCode, body: text }))
      })
      request.once('error', () => finish(null))
      if (finished) request.destroy()
    } catch { finish(null) }
  })
}

function healthyFlowBoard(response) {
  if (response?.statusCode !== 200 || typeof response.body !== 'string') return false
  try {
    const body = JSON.parse(response.body)
    return body.app === 'FlowBoard' && body.status === 'ok'
  } catch { return false }
}

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
  const setTimer = options.setTimeoutImpl || setTimeout
  const clearTimer = options.clearTimeoutImpl || clearTimeout
  const now = options.nowImpl || (() => performance.now())
  const checkStatus = options.checkStatusImpl || requestStatus
  const watchdogStarted = now()
  const warmupMs = options.watchdogWarmupMs ?? 60000
  const intervalMs = options.watchdogIntervalMs ?? 30000
  const timeoutMs = options.watchdogTimeoutMs ?? 5000
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 })
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Quick Tunnel state directory must be a real directory')
  fs.chmodSync(directory, 0o755)
  const startedAt = new Date().toISOString()
  let publicUrl = null
  let child
  let stopping = false
  let killer
  let watchdogTimer, watchdogAbort, watchdogTask
  let readyFailures = 0
  let recovering = false
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
    if (!publicUrl && !stopping && !recovering && !complete && url) {
      publicUrl = url
      atomicWrite(directory, 'public-url', url + '\n')
      writeStatus('url-issued')
      if (!options.quiet) console.log(`Dior Quick Tunnel current URL: ${url}`)
    }
  }
  const stdout = lineCollector(onLine)
  const stderr = lineCollector(onLine)
  const cancelWatchdog = () => {
    clearTimer(watchdogTimer)
    watchdogTimer = undefined
    watchdogAbort?.abort()
  }
  const armKiller = () => {
    clearTimer(killer)
    if (complete) return
    killer = setTimer(() => { if (!complete) child?.kill('SIGKILL') }, 15000)
    killer?.unref?.()
  }
  const stop = () => {
    if (stopping || complete) return
    stopping = true
    cancelWatchdog()
    clearUrl()
    writeStatus('stopping')
    child?.kill('SIGTERM')
    armKiller()
  }
  const onSignal = () => stop()
  let complete = false
  const onClose = (code, signal, error) => {
    if (complete) return
    complete = true
    cancelWatchdog()
    clearTimer(killer)
    stdout.end()
    stderr.end()
    clearUrl()
    writeStatus(stopping ? 'stopped' : 'exited', { exitCode: code, signal: signal || null,
      ...(recovering ? { reason: 'cloudflared-not-ready', readyFailureCount: readyFailures } : {}),
      ...(error ? { error: error.code || 'spawn-failed' } : {}) })
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGINT', onSignal)
    const resultCode = stopping ? 0 : recovering ? 1 : (typeof code === 'number' && code !== 0 ? code : 1)
    // Aborting a current request settles it before done, leaving no network
    // handles or watchdog work running after the service has closed.
    Promise.resolve(watchdogTask).then(() => finish(resultCode), () => finish(resultCode))
  }
  const active = () => !stopping && !complete && !recovering
  const scheduleWatchdog = delay => {
    if (!active()) return
    clearTimer(watchdogTimer)
    watchdogTimer = setTimer(() => {
      watchdogTimer = undefined
      void checkReadiness()
    }, delay)
    watchdogTimer?.unref?.()
  }
  const probe = (url, readBody, signal) => new Promise(resolve => {
    let settled = false
    const finishProbe = result => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => finishProbe(null)
    if (signal.aborted) return finishProbe(null)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => signal.aborted ? null : checkStatus(url, { readBody, timeoutMs, signal }))
      .then(finishProbe, () => finishProbe(null))
  })
  const checkReadiness = () => {
    if (!active()) return Promise.resolve()
    if (watchdogTask) return watchdogTask
    if (now() - watchdogStarted < warmupMs) {
      scheduleWatchdog(warmupMs - (now() - watchdogStarted))
      return Promise.resolve()
    }
    clearTimer(watchdogTimer)
    watchdogTimer = undefined
    watchdogAbort = new AbortController()
    const signal = watchdogAbort.signal
    watchdogTask = (async () => {
      const ready = await probe(READY_URL, false, signal)
      if (!active() || signal.aborted) return
      if (ready?.statusCode === 200) { readyFailures = 0; return }
      readyFailures++
      if (readyFailures < 3) return
      const [origin, official] = await Promise.all([
        probe(HEALTH_URL, true, signal), probe(OFFICIAL_API_URL, false, signal),
      ])
      if (!active() || signal.aborted) return
      // A certificate-validated official API response (including GET 405)
      // proves connectivity. An outage or saved URL does not; redirects are
      // never followed to another hostname.
      if (!healthyFlowBoard(origin) || !official || official.statusCode < 200 || official.statusCode >= 500) return
      recovering = true
      clearUrl()
      writeStatus('recovering', { reason: 'cloudflared-not-ready', readyFailureCount: readyFailures })
      if (!options.quiet) console.error('Dior Quick Tunnel: readiness failed while network and FlowBoard are healthy; restarting client.')
      child?.kill('SIGTERM')
      armKiller()
    })().catch(() => {
      // HTTP failures cannot cause URL churn; errors contain no environment or
      // authentication data. The following tick can try again if still active.
      if (recovering && !complete) { child?.kill('SIGTERM'); armKiller() }
    }).finally(() => {
      watchdogAbort = undefined
      watchdogTask = undefined
      if (active()) scheduleWatchdog(intervalMs)
    })
    return watchdogTask
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
    scheduleWatchdog(warmupMs)
  } catch (error) { onClose(null, null, error) }
  return { child, done, stop, checkReadiness }
}

module.exports = { extractQuickUrl, lineCollector, cloudArgs, startQuick, requestStatus, healthyFlowBoard }
if (require.main === module) {
  if (process.argv.length !== 2 || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    console.error('Run the Quick Tunnel wrapper without arguments as the flowboard-tunnel service user.')
    process.exitCode = 78
  } else {
    try { startQuick().done.then(code => { process.exitCode = code }) }
    catch (error) { console.error(`Dior Quick Tunnel: ${error.message}`); process.exitCode = 1 }
  }
}
