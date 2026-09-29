/**
 * FlowBoard 独立服务器
 * 可在本机或云服务器运行，静态资源由 exe 内置，数据保存在 exe 同目录。
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { exec, execSync, spawn } from 'node:child_process'
import { collectOrphanAssets, detectLanIPv4Addresses, ensureRuntimeDirs, handleRuntimeRequest, migrateInlineAssets, preferredPublicHost, sendSmtpMail } from './runtimeCore.js'

interface RuntimeOptions {
  host: string
  port: number
  debug: boolean
  openBrowser: boolean
  autoPort: boolean
  startedAt: number
}

/** 版本标识：构建时由构建脚本注入（见 scripts/build-exe.mjs），本地开发回退到 dev */
export const FLOWBOARD_VERSION: string =
  (process.env.FLOWBOARD_VERSION as string | undefined) ?? 'dev-build'

/** 相对路径展示：避免终端编码差异导致中文路径乱码 */
function displayPath(fullPath: string): string {
  const relative = path.relative(runtimeDir, fullPath)
  if (!relative || relative.startsWith('..')) return fullPath
  return relative.split(path.sep).join('/')
}

/** 邮件服务是否已配置；QQ 发件账号默认固定为根管理员邮箱，只需授权码。 */
function isSmtpConfigured(): boolean {
  return Boolean(process.env.FLOWBOARD_SMTP_PASS)
}


// ── Runtime paths and environment ─────────────────────────
const packagedProcess = process as NodeJS.Process & { pkg?: unknown }
const isPackagedMode = packagedProcess.pkg !== undefined
const configuredRuntimeDir = process.env.FLOWBOARD_RUNTIME_DIR?.trim()
const runtimeDir = configuredRuntimeDir
  ? path.resolve(configuredRuntimeDir)
  : isPackagedMode
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, '..')

const dataDirectory = path.join(runtimeDir, 'project-data')
const logDirectory = path.join(runtimeDir, 'logs')
const authDirectory = path.join(runtimeDir, 'auth-data')

const staticDir = (() => {
  const bundledDist = path.join(__dirname, 'dist')
  if (fs.existsSync(bundledDist)) return bundledDist
  return path.resolve(__dirname, '..', 'dist')
})()
const staticFileCache = new Map<string, { content: Buffer; mime: string; ext: string }>()

function loadEnvironmentFile(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const cmdMatch = line.match(/^\s*set\s+"(FLOWBOARD_[^=]+)=(.*)"\s*$/i)
      const envMatch = line.match(/^\s*(FLOWBOARD_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/i)
      const key = cmdMatch?.[1] ?? envMatch?.[1]
      const rawValue = cmdMatch?.[2] ?? envMatch?.[2]
      if (!key || rawValue === undefined || process.env[key] !== undefined) continue
      const value = rawValue.replace(/^(["'])(.*)\1$/, '$2')
      process.env[key] = value
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[FlowBoard] Failed to load environment file:', error)
    }
  }
}

loadEnvironmentFile(path.join(runtimeDir, 'flowboard.env.cmd'))
loadEnvironmentFile(path.join(runtimeDir, 'flowboard.env'))

const DEFAULT_SMTP_EMAIL = (process.env.FLOWBOARD_DEFAULT_ADMIN_EMAIL ?? '804559340@qq.com').trim().toLowerCase()
const SMTP_ENV_KEYS = ['FLOWBOARD_SMTP_HOST', 'FLOWBOARD_SMTP_PORT', 'FLOWBOARD_SMTP_SECURE', 'FLOWBOARD_SMTP_USER', 'FLOWBOARD_SMTP_PASS', 'FLOWBOARD_SMTP_FROM']

function smtpEnvironmentFile(): string {
  return path.join(runtimeDir, process.platform === 'win32' ? 'flowboard.env.cmd' : 'flowboard.env')
}

function writeSmtpEnvironmentFile(): void {
  const file = smtpEnvironmentFile()
  let lines: string[] = []
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { /* first configuration */ }
  const smtpKeys = new Set(SMTP_ENV_KEYS)
  lines = lines.filter(line => {
    const cmdMatch = line.match(/^\s*set\s+"(FLOWBOARD_[^=]+)=/i)
    const envMatch = line.match(/^\s*(FLOWBOARD_[A-Z0-9_]+)\s*=/i)
    const key = cmdMatch?.[1] ?? envMatch?.[1]
    return !key || !smtpKeys.has(key)
  }).filter(line => line.trim() !== '')

  if (process.platform === 'win32') {
    if (!lines.some(line => /^\s*@echo\s+off\s*$/i.test(line))) lines.unshift('@echo off')
    for (const key of SMTP_ENV_KEYS) {
      const value = process.env[key]
      if (value) lines.push(`set "${key}=${value}"`)
    }
    fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8')
  } else {
    for (const key of SMTP_ENV_KEYS) {
      const value = process.env[key]
      if (value) lines.push(`${key}='${value.replace(/'/g, `'"'"'`)}'`)
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
  }
}

function configureDefaultQqSmtp(authorizationCode: string): void {
  const code = authorizationCode.trim()
  if (!/^[A-Za-z0-9]{8,64}$/.test(code)) throw new Error('QQ 邮箱授权码格式不正确，应为 8-64 位字母或数字')
  process.env.FLOWBOARD_SMTP_HOST = 'smtp.qq.com'
  process.env.FLOWBOARD_SMTP_PORT = '465'
  process.env.FLOWBOARD_SMTP_SECURE = 'true'
  process.env.FLOWBOARD_SMTP_USER = DEFAULT_SMTP_EMAIL
  process.env.FLOWBOARD_SMTP_PASS = code
  process.env.FLOWBOARD_SMTP_FROM = DEFAULT_SMTP_EMAIL
  writeSmtpEnvironmentFile()
}

function clearSmtpConfiguration(): void {
  for (const key of SMTP_ENV_KEYS) delete process.env[key]
  writeSmtpEnvironmentFile()
}

function hasQuickSmtpCommand(): boolean {
  const command = (process.argv[2] ?? '').toLowerCase()
  const service = (process.argv[3] ?? '').toLowerCase()
  return command === 'set' && (service === 'stp' || service === 'smtp')
}

function runQuickSmtpCommand(): void {
  const authorizationCode = process.argv[4] ?? ''
  if (!authorizationCode) {
    console.error('用法: node server-bundle.cjs set stp <QQ邮箱授权码>')
    process.exitCode = 1
    return
  }
  configureDefaultQqSmtp(authorizationCode)
  console.log(`SMTP 已配置：smtp.qq.com:465 / ${DEFAULT_SMTP_EMAIL}`)
  console.log(`配置已保存到：${displayPath(smtpEnvironmentFile())}`)
}

// ── MIME 类型 ─────────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

async function ensureDirs() {
  await ensureRuntimeDirs({ dataDirectory, logDirectory, authDirectory })
}

function argumentValue(name: string): string | undefined {
  const inlinePrefix = `${name}=`
  const inline = process.argv.find(argument => argument.startsWith(inlinePrefix))
  if (inline) return inline.slice(inlinePrefix.length)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasArgument(name: string): boolean {
  return process.argv.includes(name)
}

function envEnabled(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value)
}

/** 检测 Windows 防火墙是否已放行指定 TCP 端口（失败返回 null 表示未知） */
function checkFirewallRule(port: number): boolean | null {
  if (process.platform !== 'win32') return null
  try {
    const output = execSync(`netsh advfirewall firewall show rule name="FlowBoard TCP ${port}"`, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return /已启用|Enabled\s*:\s*是|Enabled\s*:\s*Yes/i.test(output)
  } catch {
    return false
  }
}

function printVersionAndExit(): void {
  console.log(`FlowBoard ${FLOWBOARD_VERSION}`)
  console.log(`Node ${process.version} / ${process.platform} ${process.arch}`)
  console.log(`Mode: ${isPackagedMode ? 'packaged (single exe)' : 'development'}`)
  console.log(`Data: ${displayPath(dataDirectory)}`)
  console.log(`Logs: ${displayPath(logDirectory)}`)
  process.exit(0)
}

function parseRuntimeOptions(): RuntimeOptions {
  const host = (argumentValue('--host') ?? process.env.FLOWBOARD_HOST ?? '0.0.0.0').trim()
  if (!host) throw new Error('Host cannot be empty')

  const portText = argumentValue('--port') ?? process.env.FLOWBOARD_PORT ?? '3000'
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${portText}`)

  return {
    host,
    port,
    debug: hasArgument('--debug') || envEnabled(process.env.FLOWBOARD_DEBUG),
    openBrowser: hasArgument('--open') || (!hasArgument('--no-open') && !envEnabled(process.env.FLOWBOARD_NO_OPEN)),
    autoPort: hasArgument('--auto-port') || envEnabled(process.env.FLOWBOARD_AUTO_PORT),
    startedAt: Date.now(),
  }
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

// ── 扫码访问页 /qr ─────────────────────────────────────────
// 生成指向本机可访问地址的二维码页面（手机扫码即打开编辑器）。
// 使用 scripts/qrlib/ 下 MIT 协议的 qrcode-generator，页面内联渲染。
const qrLibCache: { qrcode?: string; qrcodeUtf8?: string } = {}

function loadQrLibs(): { qrcode: string; qrcodeUtf8: string } {
  if (qrLibCache.qrcode && qrLibCache.qrcodeUtf8) return qrLibCache as { qrcode: string; qrcodeUtf8: string }
  // pkg 打包时 assets 从 /snapshot 读取; 开发模式从项目目录读取
  const candidates = [
    path.join(__dirname, 'scripts', 'qrlib'),
    path.resolve(__dirname, '..', 'scripts', 'qrlib'),
    path.resolve(process.cwd(), 'scripts', 'qrlib'),
  ]
  let qrcode = ''
  let qrcodeUtf8 = ''
  for (const dir of candidates) {
    const main = path.join(dir, 'qrcode.js')
    const utf8 = path.join(dir, 'qrcode_UTF8.js')
    if (fs.existsSync(main)) {
      qrcode = fs.readFileSync(main, 'utf8')
      qrcodeUtf8 = fs.existsSync(utf8) ? fs.readFileSync(utf8, 'utf8') : ''
      break
    }
  }
  if (!qrcode) throw new Error('QR library not found (scripts/qrlib/qrcode.js)')
  qrLibCache.qrcode = qrcode
  qrLibCache.qrcodeUtf8 = qrcodeUtf8
  return { qrcode, qrcodeUtf8 }
}

function qrTargetUrl(options: RuntimeOptions): string {
  const lanAddresses = detectLanIPv4Addresses()
  const publicHost = preferredPublicHost()
  const host = publicHost !== 'localhost'
    ? publicHost
    : lanAddresses.length > 0 ? lanAddresses[0] : '127.0.0.1'
  return `http://${host}:${options.port}/`
}

async function serveQRPage(req: http.IncomingMessage, res: http.ServerResponse, options: RuntimeOptions): Promise<void> {
  try {
    const libs = loadQrLibs()
    const target = qrTargetUrl(options)
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowBoard 扫码访问</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f4f6f8; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .card { background: #fff; border-radius: 16px; padding: 40px 48px; text-align: center;
          box-shadow: 0 8px 30px rgba(0,0,0,.08); max-width: 420px; width: calc(100% - 48px); }
  h1 { font-size: 20px; margin: 0 0 8px; color: #1f2937; }
  p.sub { color: #6b7280; font-size: 14px; margin: 0 0 24px; }
  #qr { display: inline-block; padding: 12px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; }
  .url { margin-top: 24px; font-size: 15px; color: #111827; word-break: break-all;
         background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; }
  .hint { margin-top: 16px; font-size: 13px; color: #9ca3af; }
  .tip { margin-top: 8px; font-size: 12px; color: #d97706; }
</style>
</head>
<body>
  <div class="card">
    <h1>FlowBoard 扫码访问</h1>
    <p class="sub">使用手机相机 / 微信扫码，直接打开编辑器</p>
    <div id="qr"></div>
    <div class="url" id="url"></div>
    <p class="hint">请确保手机与本机处于同一局域网</p>
    <p class="tip">提示：若无法访问，请以管理员运行 allow-firewall.cmd 放行端口 ${options.port}</p>
  </div>
<script>
${libs.qrcode}
${libs.qrcodeUtf8}
(function () {
  var url = ${JSON.stringify(target)};
  document.getElementById('url').textContent = url;
  var qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  var cell = 5, margin = 4;
  var size = (qr.getModuleCount() + margin * 2) * cell;
  var canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#111827';
  for (var r = 0; r < qr.getModuleCount(); r++) {
    for (var c = 0; c < qr.getModuleCount(); c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      }
    }
  }
  document.getElementById('qr').appendChild(canvas);
})();
</script>
</body>
</html>`
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(html)
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, options: RuntimeOptions): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (req.method === 'GET' && pathname === '/qr') {
    await serveQRPage(req, res, options)
    return true
  }
  if (req.method === 'GET' && pathname === '/api/debug') {
    if (!options.debug) {
      sendJson(res, 404, { error: 'Debug interface disabled', enableWith: '--debug' })
      return true
    }
    sendJson(res, 200, {
      status: 'ok',
      app: 'FlowBoard',
      version: FLOWBOARD_VERSION,
      mode: isPackagedMode ? 'packaged' : 'development',
      listening: { host: options.host, port: options.port },
      request: { host: req.headers.host, remoteAddress: req.socket.remoteAddress },
      runtime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()) },
      paths: { executable: process.execPath, dataDirectory, logDirectory, authDirectory },
      startedAt: new Date(options.startedAt).toISOString(),
      timestamp: new Date().toISOString(),
    })
    return true
  }
  return handleRuntimeRequest(req, res, { paths: { dataDirectory, logDirectory, authDirectory } })
}

// ── 静态文件服务 ──────────────────────────────────────────
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const root = path.resolve(staticDir)
  let filePath = path.resolve(root, relativePath)

  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    res.statusCode = 404
    res.end('Not Found')
    return
  }

  if (!path.extname(filePath)) filePath = path.join(root, 'index.html')

  // 内存缓存：非 HTML 文件只读一次。
  const ext = path.extname(filePath).toLowerCase()
  const isHtml = ext === '.html' || ext === ''
  const cacheKey = filePath
  if (!isHtml && staticFileCache.has(cacheKey)) {
    const cached = staticFileCache.get(cacheKey)!
    res.statusCode = 200
    res.setHeader('Content-Type', cached.mime)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.end(cached.content)
    return
  }

  try {
    const stat = await fsp.stat(filePath)
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html')
    const fileExt = path.extname(filePath).toLowerCase()
    const content = await fsp.readFile(filePath)
    const mime = mimeForPath(filePath)
    if (!isHtml && fileExt !== '.html') {
      staticFileCache.set(filePath, { content, mime, ext: fileExt })
    }
    res.statusCode = 200
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', fileExt === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable')
    res.end(content)
  } catch {
    if (path.extname(relativePath)) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    // SPA fallback
    const htmlKey = path.join(root, 'index.html')
    if (staticFileCache.has(htmlKey)) {
      const cached = staticFileCache.get(htmlKey)!
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.end(cached.content)
      return
    }
    try {
      const html = await fsp.readFile(htmlKey)
      staticFileCache.set(htmlKey, { content: html, mime: 'text/html; charset=utf-8', ext: '.html' })
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.end(html)
    } catch {
      res.statusCode = 404
      res.end('Not Found')
    }
  }
}

// ── 打开浏览器 ────────────────────────────────────────────
function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`
  exec(cmd, () => {})
}

/** 将 Windows 控制台切到 UTF-8 (65001)，避免中文/框线乱码；失败静默忽略 */
function ensureConsoleUtf8(): void {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return
  try {
    execSync('chcp 65001 >nul', { stdio: 'ignore', windowsHide: true })
  } catch {
    // 控制台代码页不可切换时保持默认，仅影响显示不影响功能
  }
}

// ── 主入口 ────────────────────────────────────────────────
async function main() {
  ensureConsoleUtf8()
  if (hasArgument('--version') || hasArgument('-v')) printVersionAndExit()
  const options = parseRuntimeOptions()
  await ensureDirs()

  const server = http.createServer(async (req, res) => {
    try {
      if (!await handleApi(req, res, options)) await serveStatic(req, res)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  startListening(server, options)
}

/** 发送测试邮件（供交互式控制台 smtp test 使用） */
async function sendTestMail(to: string): Promise<void> {
  await sendSmtpMail(to, 'FlowBoard SMTP 测试邮件，配置正确 ✓')
}

// ── 交互式控制台（在启动的黑框里直接输入命令）────────────
const CONSOLE_HELP = `
可用命令（直接输入并回车）：

  help / ?                    显示本帮助
  status                      显示运行状态、访问地址、SMTP 状态
  url                         显示所有访问地址（本机 + 局域网）
  qr                          在控制台打印扫码访问页地址

  users                       列出所有已注册用户
  admin <邮箱>                 把用户设为管理员
      例：admin me@qq.com
  unadmin <邮箱>               取消管理员
  docs [邮箱]                  列出文档（不填=全部用户）
      例：docs            列出所有文档
      例：docs me@qq.com  只列该用户的文档
  copy <docId> <邮箱>          复制文档到指定用户
      例：copy doc_123_abc me@qq.com
  deldoc <docId>              删除文档（进回收站可在网页恢复）
  deluser <邮箱>               删除用户及其全部文档

  set stp <授权码>             快速配置 QQ SMTP（默认账号 804559340@qq.com）
  smtp                        显示当前 SMTP 配置状态
  smtp set <主机> <端口> <账号> <授权码> [发件人]
      高级配置邮件服务（立即生效并写入当前平台环境文件）
      例：smtp set smtp.qq.com 465 me@qq.com abcdefghijklmnop
      例：smtp set smtp.163.com 465 me@163.com mypass me@163.com
      说明：QQ 邮箱授权码 = QQ邮箱→设置→账户→开启SMTP→生成授权码
  smtp test <收件邮箱>          发送测试邮件
      例：smtp test me@qq.com
  smtp clear                  清除 SMTP 配置

  firewall                    放行 Windows 防火墙当前端口（需管理员）
  logs [行数]                  显示最近日志（默认 20 行）
      例：logs 50
  open                        用默认浏览器打开编辑器
  clear / cls                 清屏
  version                     显示版本信息
  exit / quit                 停止服务并退出
`

function startInteractiveConsole(options: RuntimeOptions): void {
  // 显式禁用时不启用；否则 TTY 与管道输入都支持（管道便于脚本化与自动化测试）
  if (hasArgument('--no-console') || envEnabled(process.env.FLOWBOARD_NO_CONSOLE)) return
  if (!process.stdin.readable) return
  const readline = require('node:readline') as typeof import('node:readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'FlowBoard> ',
    terminal: process.stdin.isTTY === true,
  })
  rl.prompt()

  const userFile = path.join(authDirectory, 'users.json')

  const readJsonSafe = <T>(file: string, fallback: T): T => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return fallback }
  }
  const writeJsonSafe = (file: string, value: unknown): void => {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  }
  rl.on('line', (raw) => {
    const input = raw.trim()
    if (!input) { rl.prompt(); return }
    const parts = input.split(/\s+/)
    const cmd = (parts[0] ?? '').toLowerCase()
    const args = parts.slice(1)

    try {
      switch (cmd) {
        case 'set': {
          const service = (args[0] ?? '').toLowerCase()
          if (service !== 'stp' && service !== 'smtp') {
            console.log('用法：set stp <QQ邮箱授权码>')
            break
          }
          const authorizationCode = args[1] ?? ''
          if (!authorizationCode) { console.log('用法：set stp <QQ邮箱授权码>'); break }
          configureDefaultQqSmtp(authorizationCode)
          console.log(`✓ SMTP 已配置：smtp.qq.com:465 / ${DEFAULT_SMTP_EMAIL}`)
          console.log(`  已保存到 ${displayPath(smtpEnvironmentFile())}`)
          break
        }

        case 'help': case '?': case 'h':
          console.log(CONSOLE_HELP)
          break

        case 'status': {
          const lan = detectLanIPv4Addresses()
          console.log(`版本      : ${FLOWBOARD_VERSION}`)
          console.log(`监听      : ${options.host}:${options.port}`)
          console.log(`本机访问  : http://127.0.0.1:${options.port}/`)
          if (lan.length > 0) for (const ip of lan) console.log(`局域网    : http://${ip}:${options.port}/`)
          console.log(`邮件服务  : ${isSmtpConfigured() ? '已配置 (' + (process.env.FLOWBOARD_SMTP_USER ?? '') + ')' : '未配置'}`)
          console.log(`防火墙    : ${checkFirewallRule(options.port) === true ? '已放行' : '未放行/未知（输入 firewall 放行）'}`)
          console.log(`数据目录  : ${displayPath(dataDirectory)}`)
          console.log(`运行时长  : ${Math.floor(process.uptime())} 秒`)
          break
        }

        case 'url': {
          const lan = detectLanIPv4Addresses()
          console.log(`本机   : http://127.0.0.1:${options.port}/`)
          for (const ip of lan) console.log(`局域网 : http://${ip}:${options.port}/`)
          console.log('（分享链接会自动使用局域网地址）')
          break
        }

        case 'qr':
          console.log(`扫码访问页：http://127.0.0.1:${options.port}/qr`)
          console.log('用浏览器打开该地址，手机扫二维码即可访问。')
          break

        case 'users': {
          const users = readJsonSafe<Array<{ id: string; email: string; isAdmin?: boolean }>>(userFile, [])
          if (users.length === 0) { console.log('暂无用户（在网页注册后再试）'); break }
          console.log('用户列表：')
          for (const u of users) console.log(`  ${u.email}${u.isAdmin ? '  [管理员]' : ''}  (${u.id})`)
          break
        }

        case 'admin': case 'unadmin': {
          const email = (args[0] ?? '').toLowerCase()
          if (!email) { console.log(`用法：${cmd} <邮箱>    例：${cmd} me@qq.com`); break }
          const users = readJsonSafe<Array<{ id: string; email: string; isAdmin?: boolean }>>(userFile, [])
          const user = users.find(u => u.email.toLowerCase() === email)
          if (!user) { console.log(`用户不存在：${email}（输入 users 查看已注册用户）`); break }
          if (cmd === 'unadmin' && email === DEFAULT_SMTP_EMAIL) {
            console.log(`不能取消默认根管理员：${DEFAULT_SMTP_EMAIL}`)
            break
          }
          user.isAdmin = cmd === 'admin'
          writeJsonSafe(userFile, users)
          console.log(`${cmd === 'admin' ? '已设为管理员' : '已取消管理员'}：${user.email}`)
          if (cmd === 'admin') console.log('该用户登录网页后，首页会出现「管理」按钮（可查看/复制所有人的画册、备份数据）')
          break
        }

        case 'docs': {
          const emailFilter = args[0]?.toLowerCase()
          const users = readJsonSafe<Array<{ id: string; email: string }>>(userFile, [])
          const emailById = new Map(users.map(u => [u.id, u.email]))
          const ownerId = emailFilter ? users.find(u => u.email.toLowerCase() === emailFilter)?.id : undefined
          if (emailFilter && !ownerId) { console.log(`用户不存在：${emailFilter}`); break }
          let files: string[] = []
          try { files = fs.readdirSync(dataDirectory).filter(f => f.endsWith('.json')) } catch { /* empty */ }
          let count = 0
          for (const file of files) {
            const doc = readJsonSafe<{ id?: string; title?: string; ownerId?: string; updatedAt?: number; deletedAt?: number }>(path.join(dataDirectory, file), {})
            if (!doc.id) continue
            if (ownerId && doc.ownerId !== ownerId) continue
            const owner = doc.ownerId ? (emailById.get(doc.ownerId) ?? doc.ownerId) : '(无主)'
            const time = doc.updatedAt ? new Date(doc.updatedAt).toLocaleString('zh-CN') : ''
            console.log(`  ${doc.id}  ${doc.title ?? '(无标题)'}  [${owner}]  ${time}${doc.deletedAt ? '  (回收站)' : ''}`)
            count++
          }
          console.log(`共 ${count} 个文档`)
          break
        }

        case 'copy': {
          const [docId, email] = args
          if (!docId || !email) { console.log('用法：copy <docId> <邮箱>    例：copy doc_123_abc me@qq.com'); break }
          const users = readJsonSafe<Array<{ id: string; email: string }>>(userFile, [])
          const target = users.find(u => u.email.toLowerCase() === email.toLowerCase())
          if (!target) { console.log(`目标用户不存在：${email}`); break }
          const safeId = docId.replace(/[^a-zA-Z0-9_-]/g, '')
          const doc = readJsonSafe<Record<string, unknown>>(path.join(dataDirectory, `${safeId}.json`), {})
          if (!doc.id) { console.log(`文档不存在：${docId}`); break }
          const now = Date.now()
          const copy = { ...doc, id: `doc_${now}_${Math.random().toString(36).slice(2, 8)}`, title: `${String(doc.title ?? '文档')}（副本）`, ownerId: target.id, createdAt: now, updatedAt: now }
          writeJsonSafe(path.join(dataDirectory, `${copy.id}.json`), copy)
          console.log(`已复制到 ${target.email}，新文档 ID：${copy.id}`)
          break
        }

        case 'deldoc': {
          const docId = args[0]
          if (!docId) { console.log('用法：deldoc <docId>    例：deldoc doc_123_abc'); break }
          const safeId = docId.replace(/[^a-zA-Z0-9_-]/g, '')
          const file = path.join(dataDirectory, `${safeId}.json`)
          const doc = readJsonSafe<Record<string, unknown>>(file, {})
          if (!doc.id) { console.log(`文档不存在：${docId}`); break }
          writeJsonSafe(file, { ...doc, deletedAt: Date.now() })
          console.log(`已移入回收站：${docId}（可在网页首页→回收站恢复）`)
          break
        }

        case 'deluser': {
          const email = (args[0] ?? '').toLowerCase()
          if (!email) { console.log('用法：deluser <邮箱>    例：deluser old@qq.com'); break }
          const users = readJsonSafe<Array<{ id: string; email: string }>>(userFile, [])
          const user = users.find(u => u.email.toLowerCase() === email)
          if (!user) { console.log(`用户不存在：${email}`); break }
          let deleted = 0
          try {
            for (const file of fs.readdirSync(dataDirectory).filter(f => f.endsWith('.json'))) {
              const doc = readJsonSafe<{ ownerId?: string }>(path.join(dataDirectory, file), {})
              if (doc.ownerId === user.id) { fs.unlinkSync(path.join(dataDirectory, file)); deleted++ }
            }
          } catch { /* empty */ }
          writeJsonSafe(userFile, users.filter(u => u.id !== user.id))
          console.log(`已删除用户 ${email} 及其 ${deleted} 个文档`)
          break
        }

        case 'smtp': {
          const sub = (args[0] ?? '').toLowerCase()
          if (!sub) {
            console.log('SMTP 配置状态：')
            console.log(`  主机    : ${process.env.FLOWBOARD_SMTP_HOST ?? '(未配置)'}`)
            console.log(`  端口    : ${process.env.FLOWBOARD_SMTP_PORT ?? '(未配置)'}`)
            console.log(`  账号    : ${process.env.FLOWBOARD_SMTP_USER ?? '(未配置)'}`)
            console.log(`  授权码  : ${process.env.FLOWBOARD_SMTP_PASS ? '已设置' : '(未配置)'}`)
            console.log(`  发件人  : ${process.env.FLOWBOARD_SMTP_FROM ?? '(未配置)'}`)
            console.log('')
            console.log('配置命令：smtp set <主机> <端口> <账号> <授权码> [发件人]')
            console.log('  例：smtp set smtp.qq.com 465 me@qq.com abcdefghijklmnop')
            console.log('测试发送：smtp test <收件邮箱>')
            break
          }
          if (sub === 'set') {
            const [, host, port, user, pass, from] = args
            if (!host || !port || !user || !pass) {
              console.log('用法：smtp set <主机> <端口> <账号> <授权码> [发件人]')
              console.log('  例：smtp set smtp.qq.com 465 me@qq.com abcdefghijklmnop')
              console.log('  QQ 邮箱授权码：QQ邮箱 → 设置 → 账户 → 开启SMTP服务 → 生成授权码')
              break
            }
            process.env.FLOWBOARD_SMTP_HOST = host
            process.env.FLOWBOARD_SMTP_PORT = port
            process.env.FLOWBOARD_SMTP_SECURE = Number(port) === 465 ? 'true' : 'false'
            process.env.FLOWBOARD_SMTP_USER = user
            process.env.FLOWBOARD_SMTP_PASS = pass
            process.env.FLOWBOARD_SMTP_FROM = from || user
            writeSmtpEnvironmentFile()
            console.log(`SMTP 配置已保存并立即生效（${displayPath(smtpEnvironmentFile())}）`)
            console.log(`可执行 smtp test ${user} 发送测试邮件验证`)
            break
          }
          if (sub === 'test') {
            const to = args[1] ?? process.env.FLOWBOARD_SMTP_USER
            if (!to) { console.log('用法：smtp test <收件邮箱>    例：smtp test me@qq.com'); break }
            if (!isSmtpConfigured()) { console.log('SMTP 未配置，先执行：smtp set <主机> <端口> <账号> <授权码>'); break }
            console.log(`正在发送测试邮件到 ${to} ...`)
            void sendTestMail(to).then(() => console.log('✓ 测试邮件已发送，请查收')).catch((error) => console.log(`✗ 发送失败：${error instanceof Error ? error.message : error}`)).finally(() => rl.prompt())
            return
          }
          if (sub === 'clear') {
            clearSmtpConfiguration()
            console.log('SMTP 配置已清除')
            break
          }
          console.log(`未知子命令：${sub}（可用：set / test / clear，或直接输入 smtp 查看状态）`)
          break
        }

        case 'firewall': {
          console.log(`正在放行 TCP ${options.port} ...`)
          try {
            execSync(`netsh advfirewall firewall delete rule name="FlowBoard TCP ${options.port}"`, { stdio: 'ignore', windowsHide: true })
          } catch { /* 规则不存在 */ }
          try {
            execSync(`netsh advfirewall firewall add rule name="FlowBoard TCP ${options.port}" dir=in action=allow protocol=TCP localport=${options.port} profile=any`, { stdio: 'ignore', windowsHide: true })
            console.log(`✓ 已放行端口 ${options.port}，局域网设备现在可以访问`)
          } catch {
            console.log('✗ 放行失败：需要管理员权限。请以管理员身份重新启动本程序，或运行 allow-firewall.cmd')
          }
          break
        }

        case 'logs': {
          const count = Math.min(200, Math.max(1, Number(args[0]) || 20))
          const logFile = path.join(logDirectory, 'operations.log')
          try {
            const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-count)
            for (const line of lines) {
              try {
                const entry = JSON.parse(line) as { timestamp?: string; event?: string; message?: string }
                console.log(`  ${entry.timestamp?.slice(11, 19) ?? ''}  ${entry.event ?? ''}  ${entry.message ?? ''}`)
              } catch { console.log(`  ${line}`) }
            }
          } catch { console.log('暂无日志') }
          break
        }

        case 'open':
          openBrowser(`http://127.0.0.1:${options.port}/`)
          console.log('已在浏览器打开')
          break

        case 'clear': case 'cls':
          console.clear()
          break

        case 'version':
          console.log(`FlowBoard ${FLOWBOARD_VERSION} / Node ${process.version} / ${process.platform} ${process.arch}`)
          break

        case 'exit': case 'quit': case 'stop':
          console.log('正在停止 FlowBoard ...')
          rl.close()
          process.exit(0)
          return

        default:
          console.log(`未知命令：${cmd}    输入 help 查看全部命令`)
      }
    } catch (error) {
      console.log(`命令执行出错：${error instanceof Error ? error.message : error}`)
    }
    rl.prompt()
  })

  rl.on('close', () => {
    process.exit(0)
  })
}

function startListening(server: http.Server, options: RuntimeOptions): void {
  process.env.FLOWBOARD_RUNTIME_PORT = String(options.port)
  const onListening = () => {
    const localUrl = `http://127.0.0.1:${options.port}`
    const lanAddresses = detectLanIPv4Addresses()
    const publicHost = preferredPublicHost()
    const publicUrl = publicHost !== 'localhost'
      ? `http://${publicHost}:${options.port}`
      : lanAddresses.length > 0
        ? `http://${lanAddresses[0]}:${options.port}`
        : localUrl
    const mode = isPackagedMode ? 'packaged' : 'development'
    const firewallAllowed = checkFirewallRule(options.port)
    const line = (label: string, value: string) => `  ${label.padEnd(12)} ${value}`
    console.log('')
    console.log('╔══════════════════════════════════════════════════════════╗')
    console.log(`║  FlowBoard ${mode} v${FLOWBOARD_VERSION.padEnd(33)}║`)
    console.log('╠══════════════════════════════════════════════════════════╣')
    console.log(line('本机访问', `${localUrl}/`))
    console.log(line('局域网访问', `${publicUrl}/`))
    if (lanAddresses.length > 1) {
      for (const address of lanAddresses.slice(1)) {
        console.log(line('备用地址', `http://${address}:${options.port}/`))
      }
    }
    console.log(line('健康检查', `${localUrl}/api/health`))
    console.log(line('扫码访问', `${localUrl}/qr`))
    console.log(line('调试接口', options.debug ? `${localUrl}/api/debug` : 'disabled (--debug)'))
    console.log(line('数据目录', displayPath(dataDirectory)))
    console.log(line('日志目录', displayPath(logDirectory)))
    console.log(line('邮件服务', isSmtpConfigured() ? '已配置' : '未配置（输入 smtp 命令配置）'))
    console.log('╠══════════════════════════════════════════════════════════╣')
    if (firewallAllowed === false) {
      console.log('  ⚠ Windows 防火墙未放行此端口，局域网设备可能无法访问！')
      console.log('    输入 firewall 命令自动放行（需管理员权限）。')
    } else if (firewallAllowed === null) {
      console.log('  局域网无法访问时：输入 firewall 命令放行防火墙端口。')
    }
    console.log('  云服务器需在安全组放行 TCP ' + options.port)
    console.log('╠══════════════════════════════════════════════════════════╣')
    console.log('  在此窗口直接输入命令并回车（输入 help 查看全部命令）')
    console.log('╚══════════════════════════════════════════════════════════╝')
    console.log('')


    if (options.openBrowser) openBrowser(`${localUrl}/`)
    // 启动交互式控制台（可在黑框里直接敲命令）
    startInteractiveConsole(options)
  }

  server.once('error', error => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      // 端口已被占用: 先探测是不是已在运行的 FlowBoard, 是则直接打开浏览器并正常退出(单实例友好, 避免双击"闪退")
      const busyUrl = `http://127.0.0.1:${options.port}`
      let settled = false
      const failAsBusy = () => {
        if (settled) return
        settled = true
        if (options.autoPort) {
          // 自动尝试下一个端口（最多 +9）
          const nextPort = options.port + 1
          if (nextPort <= options.port + 9 && nextPort <= 65535) {
            console.log(`[FlowBoard] 端口 ${options.port} 被占用, 自动改用端口 ${nextPort} (--auto-port)`)
            options.port = nextPort
            startListening(server, options)
            return
          }
        }
        console.error(`FlowBoard 启动失败: 端口 ${options.port} 已被占用，请用 --port 指定其他端口。`)
        process.exit(1)
      }
      const probeRequest = http.get(`${busyUrl}/api/health`, (probeResponse) => {
        probeResponse.resume()
        if (settled) return
        settled = true
        console.log(`[FlowBoard] 端口 ${options.port} 上已有 FlowBoard 在运行, 本次不重复启动。`)
        if (options.openBrowser) openBrowser(`${busyUrl}/`)
        process.exit(0)
      })
      probeRequest.setTimeout(2500, () => probeRequest.destroy())
      probeRequest.on('error', failAsBusy)
      probeRequest.on('close', () => { if (!settled) failAsBusy() })
      return
    }
    else if (code === 'EACCES') console.error('FlowBoard 启动失败: 没有权限监听该端口。')
    else console.error('FlowBoard 网络启动失败:', error)
    process.exit(1)
  })

  server.listen(options.port, options.host, onListening)
}

// ── 守护进程模式 (--daemon) ───────────────────────────────
// 以自身为子进程启动服务；子进程异常退出时自动重启（最多 10 次），
// 实现"崩溃自动恢复"，适合长时间运行的服务器/局域网共享场景。
const DAEMON_MAX_RESTARTS = 10
const DAEMON_RESTART_DELAY_MS = 1200

function shouldRunDaemon(): boolean {
  return hasArgument('--daemon') && !hasArgument('--no-daemon') && !envEnabled(process.env.FLOWBOARD_NO_DAEMON)
}

function runAsDaemon(): void {
  // 收集除 --daemon 外的原始参数（保留 --host/--port/--debug/--open/--auto-port 等）
  const childArgs = process.argv.slice(1).filter(arg => arg !== '--daemon' && arg !== '--no-daemon')
  const exePath = process.execPath
  const logFile = path.join(runtimeDir, 'logs', 'daemon.log')
  const outStream = fs.createWriteStream(logFile, { flags: 'a' })
  let restarts = 0

  console.log(`[daemon] watchdog started, spawning: ${exePath} ${childArgs.join(' ')}`)
  console.log(`[daemon] logs: ${displayPath(logFile)}`)

  const spawnChild = () => {
    const child = spawn(exePath, childArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', chunk => { process.stdout.write(chunk); outStream.write(chunk) })
    child.stderr.on('data', chunk => { process.stderr.write(chunk); outStream.write(chunk) })
    child.on('error', error => {
      console.error('[daemon] failed to spawn child:', error.message)
      process.exit(1)
    })
    child.on('exit', (code, signal) => {
      const abnormal = code !== 0 && code !== null
      const stamp = new Date().toISOString()
      outStream.write(`[${stamp}] child exited code=${code} signal=${signal}\n`)
      if (!abnormal) {
        console.log('[daemon] child exited normally, watchdog stopping.')
        process.exit(0)
      }
      restarts += 1
      if (restarts > DAEMON_MAX_RESTARTS) {
        console.error(`[daemon] child crashed ${restarts} times, giving up.`)
        outStream.write(`[${stamp}] giving up after ${restarts} crashes\n`)
        process.exit(1)
      }
      console.log(`[daemon] child crashed (code=${code}), restart ${restarts}/${DAEMON_MAX_RESTARTS} in ${DAEMON_RESTART_DELAY_MS}ms...`)
      setTimeout(spawnChild, DAEMON_RESTART_DELAY_MS)
    })
  }
  spawnChild()
}

if (hasQuickSmtpCommand()) {
  runQuickSmtpCommand()
} else if (hasAdminCommand()) {
  // 命令行管理模式：直接操作本地数据，输出后退出
  void runAdminCommand().then(() => process.exit(0)).catch(error => {
    console.error('管理命令执行失败:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
} else if (shouldRunDaemon()) {
  // 只跑 watchdog，不再启动服务本体
  runAsDaemon()
} else {
  // 正常启动
  void main()
}

// ── 命令行管理 (admin) ─────────────────────────────────────
// 用法: FlowBoard.exe admin <command> [args]
//   help                     显示全部命令
//   users                    列出所有用户
//   set-admin <email>        将指定用户设为管理员
//   remove-admin <email>     取消管理员
//   docs [email]             列出文档（不填邮箱=全部）
//   copy-doc <docId> <email> 复制文档到指定用户的画册
//   delete-doc <docId>       删除文档
//   delete-user <email>      删除用户及其文档
//   smtp                     查看 SMTP 配置状态（敏感信息打码）
//   version                  版本信息
function hasAdminCommand(): boolean {
  return process.argv[2] === 'admin' || process.argv[2] === 'manage'
}

interface AdminUserRecord {
  id: string
  email: string
  passwordHash?: string
  createdAt?: number
  isAdmin?: boolean
}

async function readJsonFileSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJsonFileSafe(file: string, value: unknown): Promise<void> {
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

async function runAdminCommand(): Promise<void> {
  ensureConsoleUtf8()
  const command = process.argv[3] ?? 'help'
  const arg1 = process.argv[4]
  const arg2 = process.argv[5]

  const userFile = path.join(authDirectory, 'users.json')
  const shareFile = path.join(authDirectory, 'shares.json')

  switch (command) {
    case 'help':
    case '--help':
    case '-h': {
      console.log('FlowBoard 管理命令')
      console.log('用法: FlowBoard.exe admin <command> [args]')
      console.log('')
      console.log('  help                     显示全部命令')
      console.log('  users                    列出所有用户')
      console.log('  set-admin <email>        将指定用户设为管理员（管理员可查看/复制所有人的画册）')
      console.log('  remove-admin <email>     取消管理员')
      console.log('  docs [email]             列出文档（不填邮箱=全部用户的文档）')
      console.log('  copy-doc <docId> <email> 复制文档到指定用户的画册')
      console.log('  delete-doc <docId>       删除文档')
      console.log('  delete-user <email>      删除用户及其全部文档')
      console.log('  smtp                     查看 SMTP 配置状态（密码打码）')
      console.log('  migrate-assets           把文档里内嵌的 base64 图片抽取为外置资源（大幅瘦身）')
      console.log('  gc-assets                回收没有被任何文档引用的孤儿图片')
      console.log('  version                  版本信息')
      console.log('')
      console.log(`数据目录: ${displayPath(dataDirectory)}`)
      return
    }

    case 'version':
      printVersionAndExit()
      return

    case 'users': {
      const users = await readJsonFileSafe<AdminUserRecord[]>(userFile, [])
      if (users.length === 0) {
        console.log('暂无用户')
        return
      }
      console.log('用户列表:')
      for (const user of users) {
        console.log(`  ${user.email}${user.isAdmin ? '  [管理员]' : ''}  (id: ${user.id})`)
      }
      return
    }

    case 'set-admin':
    case 'remove-admin': {
      if (!arg1) {
        console.error('用法: FlowBoard.exe admin set-admin <email>')
        process.exit(1)
        return
      }
      const users = await readJsonFileSafe<AdminUserRecord[]>(userFile, [])
      const email = arg1.toLowerCase()
      const user = users.find(item => item.email.toLowerCase() === email)
      if (!user) {
        console.error(`用户不存在: ${email}（先执行 admin users 查看已注册用户）`)
        process.exit(1)
        return
      }
      if (command === 'remove-admin' && email === DEFAULT_SMTP_EMAIL) {
        console.error(`不能取消默认根管理员: ${DEFAULT_SMTP_EMAIL}`)
        process.exit(1)
        return
      }
      const isAdmin = command === 'set-admin'
      user.isAdmin = isAdmin
      await writeJsonFileSafe(userFile, users)
      console.log(`${isAdmin ? '已设为管理员' : '已取消管理员'}: ${user.email}`)
      console.log('管理员可执行: admin docs / admin copy-doc <docId> <email> 查看和复制他人画册')
      return
    }

    case 'docs': {
      const users = await readJsonFileSafe<AdminUserRecord[]>(userFile, [])
      const emailFilter = arg1?.toLowerCase()
      const ownerByEmail = new Map<string, string>()
      for (const user of users) ownerByEmail.set(user.email.toLowerCase(), user.id)
      const ownerIdFilter = emailFilter ? ownerByEmail.get(emailFilter) : undefined
      if (emailFilter && !ownerIdFilter) {
        console.error(`用户不存在: ${emailFilter}`)
        process.exit(1)
        return
      }
      const files = await fsp.readdir(dataDirectory).catch(() => [] as string[])
      const jsonFiles = files.filter(file => file.endsWith('.json'))
      let count = 0
      for (const file of jsonFiles) {
        const project = await readJsonFileSafe<StoredDocumentLike>(path.join(dataDirectory, file), null)
        if (!project || typeof project.id !== 'string') continue
        if (ownerIdFilter && project.ownerId !== ownerIdFilter) continue
        const ownerEmail = [...ownerByEmail.entries()].find(([, id]) => id === project.ownerId)?.[0] ?? project.ownerId ?? '(未知)'
        const title = typeof project.title === 'string' ? project.title : '(无标题)'
        const updated = typeof project.updatedAt === 'number' ? new Date(project.updatedAt).toLocaleString('zh-CN') : ''
        console.log(`  ${project.id}  标题: ${title}  所有者: ${ownerEmail}  更新: ${updated}`)
        count++
      }
      console.log(`共 ${count} 个文档${emailFilter ? `（用户: ${emailFilter}）` : ''}`)
      return
    }

    case 'copy-doc': {
      if (!arg1 || !arg2) {
        console.error('用法: FlowBoard.exe admin copy-doc <docId> <email>')
        process.exit(1)
        return
      }
      const users = await readJsonFileSafe<AdminUserRecord[]>(userFile, [])
      const targetEmail = arg2.toLowerCase()
      const target = users.find(item => item.email.toLowerCase() === targetEmail)
      if (!target) {
        console.error(`目标用户不存在: ${targetEmail}`)
        process.exit(1)
        return
      }
      const sourcePath = projectPathSafe(arg1)
      const project = await readJsonFileSafe<StoredDocumentLike>(sourcePath, null)
      if (!project || typeof project.id !== 'string') {
        console.error(`文档不存在: ${arg1}`)
        process.exit(1)
        return
      }
      const now = Date.now()
      const copy: StoredDocumentLike = {
        ...project,
        id: `doc_${now}_${Math.random().toString(36).slice(2, 8)}`,
        title: `${typeof project.title === 'string' ? project.title : '复制文档'}（副本）`,
        ownerId: target.id,
        createdAt: now,
        updatedAt: now,
      }
      await writeJsonFileSafe(path.join(dataDirectory, `${copy.id}.json`), copy)
      console.log(`已复制文档 "${typeof project.title === 'string' ? project.title : ''}" 到 ${target.email}`)
      console.log(`新文档 ID: ${copy.id}`)
      return
    }

    case 'delete-doc': {
      if (!arg1) {
        console.error('用法: FlowBoard.exe admin delete-doc <docId>')
        process.exit(1)
        return
      }
      const targetPath = projectPathSafe(arg1)
      try {
        await fsp.unlink(targetPath)
      } catch {
        console.error(`文档不存在: ${arg1}`)
        process.exit(1)
        return
      }
      // 同步删除相关分享链接
      const shares = await readJsonFileSafe<Array<{ token: string; projectId: string }>>(shareFile, [])
      const remaining = shares.filter(share => share.projectId !== arg1)
      if (remaining.length !== shares.length) await writeJsonFileSafe(shareFile, remaining)
      console.log(`已删除文档: ${arg1}`)
      return
    }

    case 'delete-user': {
      if (!arg1) {
        console.error('用法: FlowBoard.exe admin delete-user <email>')
        process.exit(1)
        return
      }
      const users = await readJsonFileSafe<AdminUserRecord[]>(userFile, [])
      const email = arg1.toLowerCase()
      const user = users.find(item => item.email.toLowerCase() === email)
      if (!user) {
        console.error(`用户不存在: ${email}`)
        process.exit(1)
        return
      }
      // 删除该用户全部文档
      const files = await fsp.readdir(dataDirectory).catch(() => [] as string[])
      let deleted = 0
      for (const file of files.filter(f => f.endsWith('.json'))) {
        const project = await readJsonFileSafe<StoredDocumentLike>(path.join(dataDirectory, file), null)
        if (project?.ownerId === user.id) {
          await fsp.unlink(path.join(dataDirectory, file)).catch(() => undefined)
          deleted++
        }
      }
      await writeJsonFileSafe(userFile, users.filter(item => item.id !== user.id))
      // 清理会话
      const sessionFile = path.join(authDirectory, 'sessions.json')
      const sessions = await readJsonFileSafe<Array<{ token: string; userId: string }>>(sessionFile, [])
      await writeJsonFileSafe(sessionFile, sessions.filter(item => item.userId !== user.id))
      console.log(`已删除用户 ${email} 及其 ${deleted} 个文档`)
      return
    }

    case 'migrate-assets': {
      console.log('正在把文档内嵌的 base64 图片迁移为外置资源...')
      const result = await migrateInlineAssets({ dataDirectory, logDirectory, authDirectory })
      console.log(`扫描文档/快照 ${result.scanned} 个，抽取图片 ${result.converted} 张（新写入 ${result.written}，命中去重 ${result.deduped}）`)
      console.log(`文档总体积 ${(result.bytesBefore / 1048576).toFixed(2)} MB → ${(result.bytesAfter / 1048576).toFixed(2)} MB`)
      console.log(`图片存放目录: ${displayPath(path.join(dataDirectory, 'assets'))}`)
      return
    }

    case 'gc-assets': {
      const result = await collectOrphanAssets({ dataDirectory, logDirectory, authDirectory })
      console.log(`被引用图片 ${result.referenced} 张，保留 ${result.kept} 张，回收孤儿 ${result.removed} 张（释放 ${(result.bytesFreed / 1048576).toFixed(2)} MB）`)
      return
    }

    case 'smtp': {
      console.log('SMTP 配置状态:')
      console.log(`  主机: ${process.env.FLOWBOARD_SMTP_HOST ?? '(未配置)'}`)
      console.log(`  端口: ${process.env.FLOWBOARD_SMTP_PORT ?? '(未配置)'}`)
      console.log(`  账号: ${process.env.FLOWBOARD_SMTP_USER ?? '(未配置)'}`)
      console.log(`  授权码: ${process.env.FLOWBOARD_SMTP_PASS ? '已设置(打码)' : '(未配置)'}`)
      console.log(`  发件人: ${process.env.FLOWBOARD_SMTP_FROM ?? '(未配置)'}`)
      console.log('')
      console.log('提示: 也可在 Web 界面「首页 → 设置」中配置 SMTP（登录后即可，无需管理员）。')
      return
    }

    default:
      console.error(`未知命令: ${command}`)
      console.error('执行 FlowBoard.exe admin help 查看所有命令')
      process.exit(1)
  }
}

interface StoredDocumentLike {
  id: string
  title?: unknown
  ownerId?: string
  createdAt?: number
  updatedAt?: number
  [key: string]: unknown
}

function projectPathSafe(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(dataDirectory, `${safe}.json`)
}
