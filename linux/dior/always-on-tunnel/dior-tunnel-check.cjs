#!/usr/bin/env node
'use strict'
// Check this appliance's deliberately small templates, then use the native parser.
// Credential content is not printed or parsed here; the tunnel client consumes it.
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawnSync } = require('node:child_process')

function fail(message) { throw new Error(message) }
function read(file) {
  const data = fs.readFileSync(file, 'utf8')
  if (data.includes('\0') || data.startsWith('\uFEFF')) fail('Configuration must be UTF-8 without BOM or NUL')
  return data
}
function hostname(host) {
  if (net.isIP(host)) fail('A fixed DNS hostname is required')
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) fail('A fixed DNS hostname is required')
  if (host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail('Invalid DNS hostname')
  if (/(?:^|\.)(?:invalid|example|test|localhost)$/.test(host) || /^(?:example\.(?:com|net|org))$/.test(host)) fail('An example hostname is not a deployed public entry')
  return host
}
function privateFile(file, staticOnly) {
  if (staticOnly) return
  const info = fs.lstatSync(file)
  const group = spawnSync('/usr/bin/id', ['-g', 'flowboard-tunnel'], { encoding: 'utf8', timeout: 5000 })
  if (group.error || group.status !== 0 || !/^\d+\s*$/.test(group.stdout)) fail('Install the flowboard-tunnel service user first')
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.uid !== 0 || (info.mode & 0o777) !== 0o640 || info.gid !== Number(group.stdout.trim())) fail('Credential must be a nonempty root:flowboard-tunnel file with mode 0640')
}
function native(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) fail('Native tunnel configuration validation failed; inspect it locally without copying secrets into logs')
}
function field(config, regex, label) {
  const matches = [...config.matchAll(regex)]
  if (matches.length !== 1) fail(`Exactly one ${label} is required`)
  return matches[0][1]
}
function check(options = {}) {
  const root = options.root || '/etc/dior-tunnel'
  const staticOnly = options.staticOnly || false
  const provider = read(path.join(root, 'provider')).trim()
  if (provider === 'quick') {
    if (!staticOnly) native('/usr/local/bin/cloudflared', ['--version'])
    return { provider, publicUrlFile: '/var/lib/dior-tunnel/public-url', staticOnly,
      publicConnectivityVerified: false, hostnamePermanent: false }
  }
  if (provider !== 'cloudflare' && provider !== 'frp') fail('Tunnel is unconfigured; select quick, cloudflare, or frp')
  const publicUrl = read(path.join(root, 'public-url')).trim()
  const url = new URL(publicUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') fail('Public entry must be one HTTPS hostname with no port, path, or credentials')
  const host = hostname(url.hostname)
  if (provider === 'cloudflare') {
    const config = read(path.join(root, 'cloudflare.yml'))
    if (/REPLACE_WITH|trycloudflare\.com|\burl\s*:/.test(config)) fail('Configure a named fixed tunnel; quick tunnels are not an always-on entry')
    const id = field(config, /^tunnel:\s*([0-9a-f-]+)\s*$/gm, 'tunnel UUID')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) fail('Invalid named tunnel UUID')
    if (field(config, /^\s*- hostname:\s*([a-z0-9.-]+)\s*$/gm, 'public hostname') !== host) fail('Tunnel hostname must match public-url')
    if (field(config, /^credentials-file:\s*(\S+)\s*$/gm, 'credential path') !== '/etc/dior-tunnel/cloudflare-credentials.json') fail('Use the fixed private credential file')
    const services = [...config.matchAll(/^\s*(?:- )?service:\s*(\S+)\s*$/gm)].map(match => match[1])
    if (services.length !== 2 || services[0] !== 'http://127.0.0.1:3000' || services[1] !== 'http_status:404') fail('Only local FlowBoard and the final 404 ingress rule may be exposed')
    privateFile(path.join(root, 'cloudflare-credentials.json'), staticOnly)
    if (!staticOnly) native('/usr/local/bin/cloudflared', ['tunnel', '--config', path.join(root, 'cloudflare.yml'), 'ingress', 'validate'])
  } else if (provider === 'frp') {
    const config = read(path.join(root, 'frpc.toml'))
    if (/REPLACE_WITH|^\s*(?:auth\.token|webServer\.|includes|visitors)\s*=/m.test(config)) fail('Fill in the VPS hostname and use a private token file')
    const server = hostname(field(config, /^serverAddr\s*=\s*"([a-z0-9.-]+)"\s*$/gm, 'VPS hostname'))
    if (field(config, /^transport\.tls\.serverName\s*=\s*"([a-z0-9.-]+)"\s*$/gm, 'TLS server name') !== server) fail('VPS certificate identity must match its hostname')
    const expected = [
      /^loginFailExit\s*=\s*false\s*$/m,
      /^transport\.protocol\s*=\s*"tcp"\s*$/m,
      /^transport\.tls\.enable\s*=\s*true\s*$/m,
      /^transport\.tls\.trustedCaFile\s*=\s*"\/etc\/dior-tunnel\/frp-ca\.crt"\s*$/m,
      /^auth\.tokenSource\.type\s*=\s*"file"\s*$/m,
      /^auth\.tokenSource\.file\.path\s*=\s*"\/etc\/dior-tunnel\/frp-token"\s*$/m,
      /^localIP\s*=\s*"127\.0\.0\.1"\s*$/m,
      /^localPort\s*=\s*3000\s*$/m,
      /^remotePort\s*=\s*63000\s*$/m,
    ]
    if (expected.some(regex => !regex.test(config)) || (config.match(/^\[\[proxies\]\]\s*$/gm) || []).length !== 1) fail('Use the reconnecting TLS template with one FlowBoard proxy')
    privateFile(path.join(root, 'frp-token'), staticOnly)
    if (!staticOnly && !fs.statSync(path.join(root, 'frp-ca.crt')).isFile()) fail('A trusted VPS CA certificate is required')
    if (!staticOnly) native('/usr/local/bin/frpc', ['verify', '-c', path.join(root, 'frpc.toml')])
  } else {
    fail('Tunnel is unconfigured; select cloudflare or frp after the owner supplies an entry')
  }
  return { provider, publicUrl: url.origin, staticOnly, publicConnectivityVerified: false }
}
module.exports = { check }
if (require.main === module) {
  try {
    if (process.argv.length !== 2) fail('Runtime checker accepts no override paths or flags')
    console.log(JSON.stringify(check()))
  } catch (error) {
    console.error(`Dior tunnel configuration: ${error.message}`)
    process.exitCode = 1
  }
}
