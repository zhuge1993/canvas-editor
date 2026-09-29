import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { promisify } from 'node:util'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'

const scryptAsync = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const SESSION_COOKIE = 'flowboard_session'
const SESSION_MAX_AGE = 7 * 24 * 60 * 60
const VERIFICATION_TTL = 10 * 60 * 1000
const VERIFICATION_RESEND_DELAY = 60 * 1000
const MAX_VERIFICATION_ATTEMPTS = 5
const PASSWORD_MIN_LENGTH = 8
const DEFAULT_ADMIN_EMAIL = (process.env.FLOWBOARD_DEFAULT_ADMIN_EMAIL ?? '804559340@qq.com').trim().toLowerCase()
const DEFAULT_MAX_USERS = Math.max(2, Number(process.env.FLOWBOARD_MAX_USERS ?? '20') || 20)

/**
 * 检测本机局域网 IPv4 地址（非回环、非内部保留的常规私有网段）。
 * 返回按优先级排序的地址列表：优先 192.168.x.x / 10.x.x.x / 172.16-31.x.x。
 */
export function detectLanIPv4Addresses(): string[] {
  const candidates: Array<{ address: string; priority: number }> = []
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const address = entry.address
      let priority = 3
      if (/^192\.168\./.test(address)) priority = 1
      else if (/^10\./.test(address)) priority = 2
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) priority = 2
      else if (/^(169\.254\.|127\.)/.test(address)) priority = 4
      candidates.push({ address, priority })
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.address.localeCompare(b.address))
  return [...new Set(candidates.map(item => item.address))]
}

/** 优先的对外地址：环境变量 FLOWBOARD_PUBLIC_HOST > 检测到的局域网 IP > localhost */
export function preferredPublicHost(): string {
  const configured = process.env.FLOWBOARD_PUBLIC_HOST?.trim()
  if (configured) return configured
  const lanAddresses = detectLanIPv4Addresses()
  return lanAddresses[0] ?? 'localhost'
}
class RequestBodyError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'RequestBodyError'
    this.status = status
  }
}


type Permission = 'owner' | 'view' | 'edit'
type SharePermission = Exclude<Permission, 'owner'>

export interface RuntimePaths {
  dataDirectory: string
  logDirectory: string
  authDirectory: string
}

export interface StoredDocument {
  id: string
  title: string
  content?: string
  canvas?: unknown
  thumbnail?: string
  createdAt: number
  updatedAt: number
  ownerId?: string
  /** 软删除时间戳：设置后进入回收站，可恢复/彻底删除 */
  deletedAt?: number
}

interface StoredUser {
  id: string
  email: string
  passwordHash: string
  createdAt: number
  verifiedAt: number
  lastLoginAt?: number
  isAdmin?: boolean
}

interface StoredSession {
  token: string
  userId: string
  createdAt: number
  expiresAt: number
}

interface VerificationCode {
  email: string
  codeHash: string
  createdAt: number
  sentAt: number
  expiresAt: number
  attempts: number
}

interface StoredInvite {
  code: string
  createdAt: number
  createdBy: string
  maxUses: number
  usedCount: number
  lastUsedAt?: number
  disabled?: boolean
}

interface StoredShare {
  token: string
  projectId: string
  permission: SharePermission
  createdAt: number
  updatedAt: number
  expiresAt?: number
  passwordHash?: string
}

interface ClientLog {
  timestamp?: string
  level?: string
  event?: string
  message?: string
  documentId?: string
  details?: unknown
}

interface PublicUser {
  id: string
  email: string
  createdAt: number
  isAdmin?: boolean
}

interface ProjectResponse {
  id: string
  title: string
  content: string
  thumbnail: string | undefined
  createdAt: number
  updatedAt: number
  permission: Permission
}

interface RuntimeContext {
  paths: RuntimePaths
}

const writeQueues = new Map<string, Promise<void>>()

function filePath(paths: RuntimePaths, name: string): string {
  const authFile = new Set(['users.json', 'sessions.json', 'verification.json', 'invites.json', 'shares.json', 'login-attempts.json']).has(name)
  return path.join(authFile ? paths.authDirectory : paths.dataDirectory, name)
}

// ── 图片资源外置 ──────────────────────────────────────────
// 文档里只保存 /api/assets/<sha256>.<ext> 引用，图片本体按内容寻址存盘：
// 天然去重（同图多处引用只存一份）+ 可设 immutable 强缓存（二次访问零传输）。
// 这样单文档从 MB 级降到几十 KB，保存/打开/列表接口都不再搬运图片数据。
function assetsDirectory(paths: RuntimePaths): string {
  return path.join(paths.dataDirectory, 'assets')
}

/** 严格的文件名白名单：杜绝路径穿越 */
const ASSET_FILE_PATTERN = /^[a-f0-9]{16,64}\.(png|jpg|jpeg|webp|gif)$/

const ASSET_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

const MAX_ASSET_BYTES = 8 * 1024 * 1024

/** 从 dataURL 中解析出图片本体；非图片 dataURL 返回 null */
function decodeImageDataUrl(dataUrl: string): { buffer: Buffer; extension: string } | null {
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/)
  if (!match) return null
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1]!
  const buffer = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64')
  return buffer.length > 0 ? { buffer, extension } : null
}

/** 内容寻址写入：返回可直接引用的 URL，同内容自动去重 */
async function storeAssetBuffer(paths: RuntimePaths, buffer: Buffer, extension: string): Promise<{ url: string; deduped: boolean }> {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 40)
  const name = `${hash}.${extension}`
  const directory = assetsDirectory(paths)
  await fsp.mkdir(directory, { recursive: true })
  const file = path.join(directory, name)
  try {
    await fsp.access(file)
    return { url: `/api/assets/${name}`, deduped: true }
  } catch {
    await fsp.writeFile(file, buffer)
    return { url: `/api/assets/${name}`, deduped: false }
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(temporary, file)
}

const writeDebounceTimers = new Map<string, NodeJS.Timeout>()
function queueJsonWrite(file: string, value: unknown): Promise<void> {
  // 防抖：同一文件 200ms 内多次写入合并为一次。
  clearTimeout(writeDebounceTimers.get(file))
  return new Promise((resolve) => {
    writeDebounceTimers.set(file, setTimeout(() => {
      writeDebounceTimers.delete(file)
      const previous = writeQueues.get(file) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(() => writeJson(file, value))
      writeQueues.set(file, next)
      void next.then(
        () => { if (writeQueues.get(file) === next) writeQueues.delete(file); resolve() },
        () => { if (writeQueues.get(file) === next) writeQueues.delete(file); resolve() },
      )
    }, 200))
  })
}

export async function ensureRuntimeDirs(paths: RuntimePaths): Promise<void> {
  await Promise.all([
    fsp.mkdir(paths.dataDirectory, { recursive: true }),
    fsp.mkdir(paths.logDirectory, { recursive: true }),
    fsp.mkdir(paths.authDirectory, { recursive: true }),
  ])
}

/** 响应体超过该阈值才启用 gzip：小响应压缩反而增加 CPU 开销 */
const GZIP_MIN_BYTES = 4096

/** pkg 打包的 Node 14 运行时上 res.req 不可靠，
 *  因此在 handleRuntimeRequest 入口就把结果标记到 res 上。 */
interface GzipAwareResponse extends ServerResponse {
  __acceptsGzip?: boolean
}

function acceptsGzip(res: ServerResponse): boolean {
  const flagged = (res as GzipAwareResponse).__acceptsGzip
  if (typeof flagged === 'boolean') return flagged
  const header = res.req?.headers['accept-encoding']
  return typeof header === 'string' && /\bgzip\b/.test(header)
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  for (const [key, headerValue] of Object.entries(headers ?? {})) res.setHeader(key, headerValue)
  const body = JSON.stringify(value)
  // 大响应体压缩传输：低带宽云服务器上收益明显（实测 JSON 可压 5-10x）
  if (body.length >= GZIP_MIN_BYTES && acceptsGzip(res)) {
    res.setHeader('Content-Encoding', 'gzip')
    res.setHeader('Vary', 'Accept-Encoding')
    res.end(gzipSync(body))
    return
  }
  res.end(body)
}

function sendError(res: ServerResponse, status: number, message: string, details?: Record<string, unknown>): void {
  sendJson(res, status, { error: message, ...details })
}

/** 读取请求体为原始 Buffer（用于备份恢复等二进制场景） */
function readBodyRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > 50 * 1024 * 1024) { cleanup(); reject(new RequestBodyError('请求体不能超过 50 MiB', 413)); return }
      chunks.push(buffer)
    }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // 注意：Node 14 的 IncomingMessage 不原生支持 asyncIterator（pkg target），
  // 因此使用传统 data/end 事件模式代替 for await...of。
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > 25 * 1024 * 1024) {
        cleanup()
        reject(new RequestBodyError('请求体不能超过 25 MiB', 413))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      cleanup()
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) { resolve({}); return }
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new RequestBodyError('请求体必须是 JSON 对象'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new RequestBodyError('请求体必须是有效 JSON'))
      }
    }
    const onError = (error: Error) => { cleanup(); reject(new RequestBodyError(error.message)) }
    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320
}

function validProjectId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

function projectPath(paths: RuntimePaths, id: string): string {
  if (!validProjectId(id)) throw new Error('Invalid project id')
  return path.join(paths.dataDirectory, `${id}.json`)
}

function authUser(user: StoredUser): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt, isAdmin: user.isAdmin === true }
}

async function loadUsers(paths: RuntimePaths): Promise<StoredUser[]> {
  const users = await readJson<StoredUser[]>(filePath(paths, 'users.json'), [])
  let changed = false
  for (const user of users) {
    if (user.email.toLowerCase() === DEFAULT_ADMIN_EMAIL && user.isAdmin !== true) {
      user.isAdmin = true
      changed = true
    }
  }
  if (changed) await queueJsonWrite(filePath(paths, 'users.json'), users)
  return users
}

async function saveUsers(paths: RuntimePaths, users: StoredUser[]): Promise<void> {
  await queueJsonWrite(filePath(paths, 'users.json'), users)
}

async function loadSessions(paths: RuntimePaths): Promise<StoredSession[]> {
  return readJson(filePath(paths, 'sessions.json'), [])
}

async function saveSessions(paths: RuntimePaths, sessions: StoredSession[]): Promise<void> {
  await queueJsonWrite(filePath(paths, 'sessions.json'), sessions)
}

async function loadVerificationCodes(paths: RuntimePaths): Promise<VerificationCode[]> {
  return readJson(filePath(paths, 'verification.json'), [])
}

async function saveVerificationCodes(paths: RuntimePaths, codes: VerificationCode[]): Promise<void> {
  await queueJsonWrite(filePath(paths, 'verification.json'), codes)
}

async function loadInvites(paths: RuntimePaths): Promise<StoredInvite[]> {
  return readJson(filePath(paths, 'invites.json'), [])
}

async function saveInvites(paths: RuntimePaths, invites: StoredInvite[]): Promise<void> {
  await queueJsonWrite(filePath(paths, 'invites.json'), invites)
}

async function loadShares(paths: RuntimePaths): Promise<StoredShare[]> {
  return readJson(filePath(paths, 'shares.json'), [])
}

async function saveShares(paths: RuntimePaths, shares: StoredShare[]): Promise<void> {
  await queueJsonWrite(filePath(paths, 'shares.json'), shares)
}

// ── 登录失败限流（防爆破） ────────────────────────────────
interface LoginAttempt {
  email: string
  count: number
  lastFailAt: number
}

const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCK_MS = 5 * 60 * 1000

async function loadLoginAttempts(paths: RuntimePaths): Promise<LoginAttempt[]> {
  return readJson(filePath(paths, 'login-attempts.json'), [])
}

async function saveLoginAttempts(paths: RuntimePaths, attempts: LoginAttempt[]): Promise<void> {
  await queueJsonWrite(filePath(paths, 'login-attempts.json'), attempts)
}

async function passwordDigest(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })
  return `scrypt$16384$8$1$${salt}$${hash.toString('hex')}`
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nText, rText, pText, salt, expectedHex] = encoded.split('$')
  if (algorithm !== 'scrypt' || !nText || !rText || !pText || !salt || !expectedHex) return false
  const expected = Buffer.from(expectedHex, 'hex')
  const actual = await scryptAsync(password, salt, expected.length, {
    N: Number(nText),
    r: Number(rText),
    p: Number(pText),
    maxmem: 32 * 1024 * 1024,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}`
}

function newVerificationCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function normalizeInviteCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : ''
}

function newInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(10)
  let result = ''
  for (const byte of bytes) result += alphabet[byte % alphabet.length]
  return result
}

function inviteIsUsable(invite: StoredInvite | undefined): invite is StoredInvite {
  return Boolean(invite && invite.disabled !== true && invite.usedCount < invite.maxUses)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key) cookies[key] = decodeURIComponent(value)
  }
  return cookies
}

function cookieOptions(maxAge: number): string {
  const secure = /^(1|true|yes|on)$/i.test(process.env.FLOWBOARD_COOKIE_SECURE ?? '') ? '; Secure' : ''
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(SESSION_MAX_AGE)}`)
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(0)}`)
}

async function currentUser(req: IncomingMessage, paths: RuntimePaths): Promise<StoredUser | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) return null
  const now = Date.now()
  const sessions = await loadSessions(paths)
  const validSessions = sessions.filter(session => session.expiresAt > now)
  if (validSessions.length !== sessions.length) void saveSessions(paths, validSessions).catch(() => undefined)
  const session = validSessions.find(item => item.token === token)
  if (!session) return null
  const users = await loadUsers(paths)
  return users.find(user => user.id === session.userId) ?? null
}

/** 游客模式：默认关闭（FLOWBOARD_GUEST_MODE=1 开启）。登录用于区分个人画册与分享权限。 */
function guestModeEnabled(): boolean {
  return process.env.FLOWBOARD_GUEST_MODE === '1'
}

const GUEST_USER: StoredUser = {
  id: 'guest',
  email: 'guest@local',
  passwordHash: '',
  createdAt: 0,
  verifiedAt: 0,
}

async function requireUser(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths): Promise<StoredUser | null> {
  const user = await currentUser(req, paths)
  if (!user && guestModeEnabled()) return GUEST_USER
  if (!user) sendError(res, 401, 'Login required')
  return user
}

function canManageProject(user: StoredUser, project: StoredDocument): boolean {
  return user.isAdmin === true || project.ownerId === user.id
}

async function createSession(userId: string, paths: RuntimePaths, res: ServerResponse): Promise<void> {
  const now = Date.now()
  const sessions = (await loadSessions(paths)).filter(session => session.expiresAt > now && session.userId !== userId)
  const token = randomBytes(32).toString('base64url')
  sessions.push({ token, userId, createdAt: now, expiresAt: now + SESSION_MAX_AGE * 1000 })
  await saveSessions(paths, sessions)
  setSessionCookie(res, token)
}

async function removeSession(req: IncomingMessage, paths: RuntimePaths): Promise<void> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) return
  const sessions = await loadSessions(paths)
  await saveSessions(paths, sessions.filter(session => session.token !== token))
}

/** 遗留文档归属认领：仅需执行一次（用标记文件跳过），否则每次列表请求都要全量读盘解析 */
const LEGACY_CLAIM_MARKER = '.legacy-claimed'

async function claimLegacyProjects(paths: RuntimePaths, userId: string): Promise<void> {
  const marker = path.join(paths.authDirectory, LEGACY_CLAIM_MARKER)
  try {
    await fsp.access(marker)
    return
  } catch {
    // 尚未认领过，继续
  }
  let files: string[]
  try {
    files = (await fsp.readdir(paths.dataDirectory)).filter(file => file.endsWith('.json'))
  } catch {
    return
  }
  await Promise.all(files.map(async file => {
    const fullPath = path.join(paths.dataDirectory, file)
    try {
      const project = JSON.parse(await fsp.readFile(fullPath, 'utf8')) as StoredDocument
      if (!project.ownerId && typeof project.id === 'string') await writeJson(fullPath, { ...project, ownerId: userId })
    } catch {
      // Leave malformed legacy files untouched.
    }
  }))
  await fsp.writeFile(marker, String(Date.now()), 'utf8').catch(() => undefined)
}

function projectCanvas(project: StoredDocument): unknown {
  if (project.canvas !== undefined) return project.canvas
  try {
    return JSON.parse(project.content ?? '{}')
  } catch {
    return { shapes: {} }
  }
}

function projectResponse(project: StoredDocument, permission: Permission): ProjectResponse {
  return {
    id: project.id,
    title: project.title,
    content: JSON.stringify(projectCanvas(project)),
    thumbnail: project.thumbnail,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    permission,
  }
}

/** 列表项：只含元数据，不含画布内容。
 *  首页只需要标题/缩略图/时间；若返回完整 content（含图片数据时可达 MB 级），
 *  每次打开首页都要读盘 + 重新序列化 + 传输整份文档。 */
interface ProjectSummary {
  id: string
  title: string
  thumbnail?: string
  createdAt: number
  updatedAt: number
  permission: Permission
}

function projectSummary(project: StoredDocument, permission: Permission): ProjectSummary {
  return {
    id: project.id,
    title: project.title,
    thumbnail: project.thumbnail,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    permission,
  }
}

async function readProject(paths: RuntimePaths, id: string): Promise<StoredDocument | null> {
  try {
    return JSON.parse(await fsp.readFile(projectPath(paths, id), 'utf8')) as StoredDocument
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeProject(paths: RuntimePaths, body: Record<string, unknown>, ownerId: string, existing?: StoredDocument): Promise<void> {
  const id = typeof body.id === 'string' ? body.id : ''
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
  if (!validProjectId(id) || !title) throw new Error('Invalid project data')
  const canvas = body.content ? JSON.parse(String(body.content)) : body.canvas ?? { shapes: {} }
  const now = Date.now()
  const project: StoredDocument = {
    id,
    title,
    canvas,
    thumbnail: typeof body.thumbnail === 'string' ? body.thumbnail : existing?.thumbnail,
    createdAt: existing?.createdAt ?? (typeof body.createdAt === 'number' ? body.createdAt : now),
    updatedAt: now,
    ownerId: existing?.ownerId ?? ownerId,
  }
  await writeJson(projectPath(paths, id), project)
}

function forwardedHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value?.split(',')[0]
  const normalized = first?.trim()
  if (!normalized || !/^[A-Za-z0-9.:[\]-]+$/.test(normalized)) return undefined
  return normalized
}

function shareUrl(req: IncomingMessage, token: string): string {
  // 穿透/反代优先使用显式公网域名或 X-Forwarded-*；直连时使用请求自身 Host（通常已包含 :3000）。
  const configuredHost = process.env.FLOWBOARD_PUBLIC_HOST?.trim()
  const forwardedHost = forwardedHeader(req.headers['x-forwarded-host'])
  const requestHost = forwardedHeader(req.headers.host)
  const fallbackHost = preferredPublicHost()
  const host = configuredHost || forwardedHost || requestHost || fallbackHost
  const forwardedProtocol = forwardedHeader(req.headers['x-forwarded-proto'])
  const protocol = process.env.FLOWBOARD_PUBLIC_PROTOCOL === 'https'
    ? 'https'
    : process.env.FLOWBOARD_PUBLIC_PROTOCOL === 'http'
      ? 'http'
      : forwardedProtocol === 'https' ? 'https' : 'http'
  const runtimePort = Number(process.env.FLOWBOARD_RUNTIME_PORT ?? process.env.FLOWBOARD_PORT ?? '3000')
  const usingFallback = !configuredHost && !forwardedHost && !requestHost
  const hasPort = /^\[[^\]]+\]:\d+$/.test(host) || /:\d+$/.test(host)
  const hostWithPort = usingFallback && !hasPort ? `${host}:${runtimePort}` : host
  return `${protocol}://${hostWithPort}/share/${token}`
}

function permissionValue(value: unknown): SharePermission | null {
  return value === 'view' || value === 'edit' ? value : null
}

function smtpConfig() {
  const host = process.env.FLOWBOARD_SMTP_HOST ?? 'smtp.qq.com'
  const port = Number(process.env.FLOWBOARD_SMTP_PORT ?? '465')
  const secure = /^(1|true|yes|on)$/i.test(process.env.FLOWBOARD_SMTP_SECURE ?? '') || port === 465
  const user = process.env.FLOWBOARD_SMTP_USER?.trim() || DEFAULT_ADMIN_EMAIL
  const password = process.env.FLOWBOARD_SMTP_PASS
  const from = process.env.FLOWBOARD_SMTP_FROM?.trim() || user
  if (!user || !password || !from) throw new Error('SMTP is not configured')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP port')
  if ([user, from].some(value => /[\r\n<>]/.test(value))) throw new Error('Invalid SMTP sender')
  return { host, port, secure, user, password, from }
}

class SmtpClient {
  private buffer = ''
  private readonly socket: net.Socket | tls.TLSSocket

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket
    socket.setEncoding('utf8')
  }

  private readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.off('data', onData)
        this.socket.off('error', onError)
        this.socket.off('close', onClose)
      }
      const consume = () => {
        const end = this.buffer.indexOf('\r\n')
        if (end < 0) return false
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 2)
        cleanup()
        resolve(line)
        return true
      }
      const onData = (value: string | Buffer) => {
        this.buffer += value.toString()
        consume()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onClose = () => {
        cleanup()
        reject(new Error('SMTP connection closed'))
      }
      if (!consume()) {
        this.socket.on('data', onData)
        this.socket.once('error', onError)
        this.socket.once('close', onClose)
      }
    })
  }

  async response(): Promise<{ code: number; text: string }> {
    const first = await this.readLine()
    const code = Number(first.slice(0, 3))
    if (!Number.isInteger(code)) throw new Error(`Invalid SMTP response: ${first}`)
    const lines = [first.slice(4)]
    if (first[3] === '-') {
      while (true) {
        const line = await this.readLine()
        lines.push(line.slice(4))
        if (line.slice(0, 3) === String(code) && line[3] !== '-') break
      }
    }
    return { code, text: lines.join('\n') }
  }

  async command(command: string, expected: number | number[]): Promise<void> {
    this.socket.write(`${command}\r\n`)
    const result = await this.response()
    const accepted = Array.isArray(expected) ? expected.includes(result.code) : result.code === expected
    if (!accepted) throw new Error(`SMTP ${command.split(' ')[0]} failed: ${result.code} ${result.text}`)
  }

  close(): void {
    this.socket.end()
  }
}

async function connectSmtp(host: string, port: number, secure: boolean): Promise<net.Socket | tls.TLSSocket> {
  const socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port })
  await new Promise<void>((resolve, reject) => {
    const readyEvent = secure ? 'secureConnect' : 'connect'
    const onReady = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const cleanup = () => {
      socket.off(readyEvent, onReady)
      socket.off('error', onError)
    }
    socket.once(readyEvent, onReady)
    socket.once('error', onError)
  })
  return socket
}

function encodedSubject(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export async function sendSmtpMail(to: string, code: string): Promise<void> {
  const config = smtpConfig()
  const socket = await connectSmtp(config.host, config.port, config.secure)
  const smtp = new SmtpClient(socket)
  try {
    const greeting = await smtp.response()
    if (greeting.code !== 220) throw new Error(`SMTP greeting failed: ${greeting.code}`)
    await smtp.command('EHLO flowboard.local', 250)
    await smtp.command('AUTH LOGIN', 334)
    await smtp.command(Buffer.from(config.user, 'utf8').toString('base64'), 334)
    await smtp.command(Buffer.from(config.password, 'utf8').toString('base64'), 235)
    await smtp.command(`MAIL FROM:<${config.from}>`, 250)
    await smtp.command(`RCPT TO:<${to}>`, [250, 251])
    await smtp.command('DATA', 354)
    const message = [
      `From: ${config.from}`,
      `To: ${to}`,
      `Subject: ${encodedSubject('FlowBoard 注册验证码')}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      '你的 FlowBoard 注册验证码是：',
      '',
      code,
      '',
      '验证码 10 分钟内有效。如果不是你本人操作，请忽略此邮件。',
    ].join('\r\n').replace(/^\./gm, '..')
    socket.write(`${message}\r\n.\r\n`)
    const sent = await smtp.response()
    if (sent.code !== 250) throw new Error(`SMTP message failed: ${sent.code}`)
    await smtp.command('QUIT', 221)
  } finally {
    smtp.close()
  }
}

async function sendVerificationCode(email: string, code: string): Promise<boolean> {
  if ((process.env.FLOWBOARD_EMAIL_MODE ?? 'smtp').toLowerCase() === 'console') {
    console.log(`[FlowBoard] Verification code for ${email}: ${code}`)
    return true
  }
  await sendSmtpMail(email, code)
  return false
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, pathname: string): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = await currentUser(req, paths)
    sendJson(res, 200, { user: user ? authUser(user) : null, guestMode: guestModeEnabled() })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/send-code') {
    const body = await readBody(req)
    const email = normalizeEmail(body.email)
    const purpose = typeof body.purpose === 'string' ? body.purpose : 'register'
    if (!validEmail(email)) {
      sendError(res, 400, '请输入有效邮箱地址')
      return true
    }
    const users = await loadUsers(paths)
    if (purpose === 'register' && users.some(user => user.email === email)) {
      sendError(res, 409, '该邮箱已注册')
      return true
    }
    if (purpose === 'reset' && !users.some(user => user.email === email)) {
      sendError(res, 404, '该邮箱未注册')
      return true
    }
    if (purpose === 'register' && email !== DEFAULT_ADMIN_EMAIL) {
      if (users.length >= DEFAULT_MAX_USERS) {
        sendError(res, 403, `服务器已达到注册上限（${DEFAULT_MAX_USERS} 人），请联系管理员`)
        return true
      }
      const inviteCode = normalizeInviteCode(body.inviteCode)
      const invite = (await loadInvites(paths)).find(item => item.code === inviteCode)
      if (!inviteIsUsable(invite)) {
        sendError(res, 403, '邀请码无效、已停用或使用次数已耗尽')
        return true
      }
    }
    const now = Date.now()
    const existingCodes = await loadVerificationCodes(paths)
    const previous = existingCodes.find(item => item.email === email && item.expiresAt > now)
    if (previous && now - previous.sentAt < VERIFICATION_RESEND_DELAY) {
      sendError(res, 429, '验证码发送过于频繁', { retryAfter: Math.ceil((VERIFICATION_RESEND_DELAY - now + previous.sentAt) / 1000) })
      return true
    }
    const code = newVerificationCode()
    let development = false
    try {
      development = await sendVerificationCode(email, code)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendRuntimeLog(paths, { level: 'error', event: 'auth.verification_failed', message, details: { email } })
      if (message === 'SMTP is not configured') sendError(res, 503, '服务器尚未配置邮箱服务，请管理员设置 SMTP 配置')
      else sendError(res, 502, '验证码发送失败，请检查 SMTP 配置')
      return true
    }
    const codes = existingCodes.filter(item => item.email !== email && item.expiresAt > now)
    codes.push({ email, codeHash: hashCode(code), createdAt: now, sentAt: now, expiresAt: now + VERIFICATION_TTL, attempts: 0 })
    await saveVerificationCodes(paths, codes)
    sendJson(res, 200, { ok: true, expiresIn: VERIFICATION_TTL / 1000, resendAfter: VERIFICATION_RESEND_DELAY / 1000, ...(development ? { developmentCode: code } : {}) })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const body = await readBody(req)
    const email = normalizeEmail(body.email)
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const inviteCode = normalizeInviteCode(body.inviteCode)
    if (!validEmail(email) || !/^\d{6}$/.test(code) || password.length < PASSWORD_MIN_LENGTH) {
      sendError(res, 400, `邮箱、6 位验证码和至少 ${PASSWORD_MIN_LENGTH} 位密码均为必填项`)
      return true
    }
    const users = await loadUsers(paths)
    if (users.some(user => user.email === email)) {
      sendError(res, 409, '该邮箱已注册')
      return true
    }
    let invite: StoredInvite | undefined
    let invites: StoredInvite[] = []
    if (email !== DEFAULT_ADMIN_EMAIL) {
      if (users.length >= DEFAULT_MAX_USERS) {
        sendError(res, 403, `服务器已达到注册上限（${DEFAULT_MAX_USERS} 人），请联系管理员`)
        return true
      }
      invites = await loadInvites(paths)
      invite = invites.find(item => item.code === inviteCode)
      if (!inviteIsUsable(invite)) {
        sendError(res, 403, '邀请码无效、已停用或使用次数已耗尽')
        return true
      }
    }
    const now = Date.now()
    const codes = await loadVerificationCodes(paths)
    const record = codes.find(item => item.email === email)
    const codeMatches = record && record.expiresAt > now && record.attempts < MAX_VERIFICATION_ATTEMPTS && sameHash(record.codeHash, hashCode(code))
    if (!codeMatches) {
      if (record) {
        record.attempts += 1
        await saveVerificationCodes(paths, codes.filter(item => item.expiresAt > now && item.attempts < MAX_VERIFICATION_ATTEMPTS))
      }
      sendError(res, 400, '验证码无效或已过期')
      return true
    }
    const user: StoredUser = {
      id: newId('usr'),
      email,
      passwordHash: await passwordDigest(password),
      createdAt: now,
      verifiedAt: now,
      isAdmin: email === DEFAULT_ADMIN_EMAIL,
    }
    await saveUsers(paths, [...users, user])
    if (invite) {
      const usedAt = Date.now()
      await saveInvites(paths, invites.map(item => item.code === invite.code
        ? { ...item, usedCount: item.usedCount + 1, lastUsedAt: usedAt }
        : item))
    }
    await saveVerificationCodes(paths, codes.filter(item => item.email !== email))
    await claimLegacyProjects(paths, user.id)
    await createSession(user.id, paths, res)
    sendJson(res, 201, { user: authUser(user) })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    const body = await readBody(req)
    const email = normalizeEmail(body.email)
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!validEmail(email) || !/^\d{6}$/.test(code) || password.length < PASSWORD_MIN_LENGTH) {
      sendError(res, 400, `邮箱、6 位验证码和至少 ${PASSWORD_MIN_LENGTH} 位新密码均为必填项`)
      return true
    }
    const users = await loadUsers(paths)
    const user = users.find(item => item.email === email)
    if (!user) {
      sendError(res, 404, '该邮箱未注册')
      return true
    }
    const now = Date.now()
    const codes = await loadVerificationCodes(paths)
    const record = codes.find(item => item.email === email)
    const codeMatches = record && record.expiresAt > now && record.attempts < MAX_VERIFICATION_ATTEMPTS && sameHash(record.codeHash, hashCode(code))
    if (!codeMatches) {
      if (record) {
        record.attempts += 1
        await saveVerificationCodes(paths, codes.filter(item => item.expiresAt > now && item.attempts < MAX_VERIFICATION_ATTEMPTS))
      }
      sendError(res, 400, '验证码无效或已过期')
      return true
    }
    const updatedUser = { ...user, passwordHash: await passwordDigest(password) }
    await saveUsers(paths, users.map(item => item.id === user.id ? updatedUser : item))
    await saveVerificationCodes(paths, codes.filter(item => item.email !== email))
    sendJson(res, 200, { ok: true })
    return true
  }


  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req)
    const email = normalizeEmail(body.email)
    const password = typeof body.password === 'string' ? body.password : ''
    // 登录失败限流：同一邮箱连续失败 5 次锁定 5 分钟（防爆破）
    const attempts = await loadLoginAttempts(paths)
    const attempt = attempts.find(item => item.email === email)
    const now = Date.now()
    if (attempt && now - attempt.lastFailAt < LOGIN_LOCK_MS && attempt.count >= LOGIN_MAX_ATTEMPTS) {
      const retryAfter = Math.ceil((LOGIN_LOCK_MS - (now - attempt.lastFailAt)) / 1000)
      sendError(res, 429, `尝试过于频繁，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`, { retryAfter })
      return true
    }
    const user = (await loadUsers(paths)).find(item => item.email === email)
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      // 记录失败
      const next = attempts.filter(item => item.email !== email)
      next.push({ email, count: (attempt?.count ?? 0) + 1, lastFailAt: now })
      await saveLoginAttempts(paths, next)
      sendError(res, 401, '邮箱或密码错误')
      return true
    }
    // 登录成功：清除失败记录
    await saveLoginAttempts(paths, attempts.filter(item => item.email !== email))
    const updatedUser = { ...user, lastLoginAt: now }
    await saveUsers(paths, (await loadUsers(paths)).map(item => item.id === user.id ? updatedUser : item))
    await claimLegacyProjects(paths, user.id)
    await createSession(user.id, paths, res)
    sendJson(res, 200, { user: authUser(updatedUser) })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    await removeSession(req, paths)
    clearSessionCookie(res)
    sendJson(res, 200, { ok: true })
    return true
  }
  return false
}

async function handleShare(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, pathname: string): Promise<boolean> {
  const match = pathname.match(/^\/api\/share\/([A-Za-z0-9_-]+)$/)
  if (!match) return false
  const token = match[1]!
  const share = (await loadShares(paths)).find(item => item.token === token)
  if (!share) {
    sendError(res, 404, '分享链接不存在或已撤销')
    return true
  }
  const now = Date.now()
  if (share.expiresAt !== undefined && share.expiresAt <= now) {
    sendError(res, 410, '分享链接已过期')
    return true
  }
  // 访问密码校验：优先 header X-Share-Password，其次 query ?password=
  if (share.passwordHash) {
    const password = (typeof req.headers['x-share-password'] === 'string' ? req.headers['x-share-password'] : '')
      || new URL(req.url ?? '/', 'http://localhost').searchParams.get('password') || ''
    const ok = await verifyPassword(password, share.passwordHash)
    if (!ok) {
      sendError(res, 401, '分享密码错误')
      return true
    }
  }
  const project = await readProject(paths, share.projectId)
  if (!project) {
    sendError(res, 404, '项目不存在')
    return true
  }
  if (req.method === 'GET') {
    sendJson(res, 200, projectResponse(project, share.permission))
    return true
  }
  if (req.method === 'PUT') {
    if (share.permission !== 'edit') {
      sendError(res, 403, '此分享链接仅允许查看')
      return true
    }
    const body = await readBody(req)
    if (body.id !== project.id) {
      sendError(res, 400, '项目 ID 不匹配')
      return true
    }
    await writeProject(paths, body, project.ownerId ?? '', project)
    sendJson(res, 200, { ok: true, permission: share.permission })
    return true
  }
  sendError(res, 405, 'Method not allowed')
  return true
}

// ── 图片资源接口 ──────────────────────────────────────────
// POST /api/assets        上传 dataURL，返回内容寻址 URL（同内容去重）
// GET  /api/assets/<name> 读取图片本体
// 注意：GET 必须免登录——分享链接的匿名访客也要能加载图片，
// 安全性由内容 hash（40 位十六进制，不可枚举）保证，与 Figma 的能力 URL 同思路。
async function handleAssets(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, pathname: string): Promise<boolean> {
  if (pathname === '/api/assets' && req.method === 'POST') {
    const body = await readBody(req)
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
    const decoded = decodeImageDataUrl(dataUrl)
    if (!decoded) {
      sendError(res, 400, '仅支持 base64 编码的图片 dataURL')
      return true
    }
    if (decoded.buffer.length > MAX_ASSET_BYTES) {
      sendError(res, 413, '图片不能超过 8 MiB')
      return true
    }
    const stored = await storeAssetBuffer(paths, decoded.buffer, decoded.extension)
    sendJson(res, 200, { url: stored.url, bytes: decoded.buffer.length, deduped: stored.deduped })
    return true
  }

  const match = pathname.match(/^\/api\/assets\/([A-Za-z0-9._-]+)$/)
  if (match && (req.method === 'GET' || req.method === 'HEAD')) {
    const name = match[1]!
    if (!ASSET_FILE_PATTERN.test(name)) {
      sendError(res, 404, '资源不存在')
      return true
    }
    try {
      const content = await fsp.readFile(path.join(assetsDirectory(paths), name))
      res.statusCode = 200
      res.setHeader('Content-Type', ASSET_MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream')
      // 内容寻址：内容变则 URL 变，可以放心长期强缓存
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch {
      sendError(res, 404, '资源不存在')
    }
    return true
  }
  return false
}

async function handleProjects(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, pathname: string): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/projects') {
    const user = await requireUser(req, res, paths)
    if (!user) return true
    await claimLegacyProjects(paths, user.id)
    let files: string[] = []
    try { files = (await fsp.readdir(paths.dataDirectory)).filter(file => file.endsWith('.json')) } catch { /* empty */ }
    const projects = await Promise.all(files.map(async file => {
      try {
        const project = JSON.parse(await fsp.readFile(path.join(paths.dataDirectory, file), 'utf8')) as StoredDocument
        // 排除回收站中的文档
        if (project.ownerId !== user.id || project.deletedAt) return null
        return projectSummary(project, 'owner')
      } catch { return null }
    }))
    sendJson(res, 200, projects.filter((project): project is ProjectSummary => project !== null).sort((a, b) => b.updatedAt - a.updatedAt))
    return true
  }

  // 回收站列表
  if (req.method === 'GET' && pathname === '/api/projects/trash') {
    const user = await requireUser(req, res, paths)
    if (!user) return true
    let files: string[] = []
    try { files = (await fsp.readdir(paths.dataDirectory)).filter(file => file.endsWith('.json')) } catch { /* empty */ }
    const projects = await Promise.all(files.map(async file => {
      try {
        const project = JSON.parse(await fsp.readFile(path.join(paths.dataDirectory, file), 'utf8')) as StoredDocument
        if (project.ownerId !== user.id || !project.deletedAt) return null
        return { ...projectSummary(project, 'owner'), deletedAt: project.deletedAt }
      } catch { return null }
    }))
    sendJson(res, 200, projects.filter((project): project is ProjectSummary & { deletedAt: number } => project !== null).sort((a, b) => b.deletedAt - a.deletedAt))
    return true
  }

  // 版本历史：创建/列表/回滚
  const versionListMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/versions$/)
  const versionRestoreMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/versions\/([a-zA-Z0-9_-]+)\/restore$/)
  if (versionListMatch || versionRestoreMatch) {
    const user = await requireUser(req, res, paths)
    if (!user) return true
    const projectId = (versionListMatch ?? versionRestoreMatch)![1]!
    const project = await readProject(paths, projectId)
    if (!project) {
      sendError(res, 404, '文档不存在')
      return true
    }
    if (!canManageProject(user, project)) {
      sendError(res, 403, '没有文档管理权限')
      return true
    }
    const versionsDir = path.join(paths.dataDirectory, 'versions', projectId)

    if (req.method === 'GET' && versionListMatch) {
      // 列出版本
      let files: string[] = []
      try { files = (await fsp.readdir(versionsDir)).filter(file => file.endsWith('.json')) } catch { /* empty */ }
      const versions = await Promise.all(files.map(async file => {
        try {
          const version = JSON.parse(await fsp.readFile(path.join(versionsDir, file), 'utf8')) as { id: string; name: string; createdAt: number }
          return { id: version.id, name: version.name, createdAt: version.createdAt }
        } catch { return null }
      }))
      sendJson(res, 200, versions.filter((v): v is { id: string; name: string; createdAt: number } => v !== null).sort((a, b) => b.createdAt - a.createdAt))
      return true
    }

    if (req.method === 'POST' && versionListMatch) {
      // 创建版本快照
      const body = await readBody(req)
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : `版本 ${new Date().toLocaleString('zh-CN')}`
      const content = typeof body.content === 'string' ? body.content : JSON.stringify(projectCanvas(project))
      const versionIdNew = `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const version = { id: versionIdNew, name, content, createdAt: Date.now() }
      await fsp.mkdir(versionsDir, { recursive: true })
      await writeJson(path.join(versionsDir, `${versionIdNew}.json`), version)
      sendJson(res, 201, { id: versionIdNew, name, createdAt: version.createdAt })
      return true
    }

    // 恢复版本
    if (req.method === 'POST' && versionRestoreMatch) {
      const versionId = versionRestoreMatch[2]!
      const versionPath = path.join(versionsDir, `${versionId}.json`)
      try {
        const version = JSON.parse(await fsp.readFile(versionPath, 'utf8')) as { content: string; name?: string }
        const canvas = JSON.parse(version.content)
        const restored: StoredDocument = { ...project, canvas, updatedAt: Date.now() }
        await writeJson(projectPath(paths, projectId), restored)
        sendJson(res, 200, { ok: true, name: version.name })
      } catch {
        sendError(res, 404, '版本不存在或已损坏')
      }
      return true
    }
    return true
  }

  // 恢复/彻底删除
  const trashAction = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/(restore|forever)$/)
  if (trashAction) {
    const user = await requireUser(req, res, paths)
    if (!user) return true
    const id = trashAction[1]!
    const action = trashAction[2]!
    const project = await readProject(paths, id)
    if (!project) {
      sendError(res, 404, '文档不存在')
      return true
    }
    if (!canManageProject(user, project)) {
      sendError(res, 403, '没有项目管理权限')
      return true
    }
    if (action === 'restore') {
      if (!project.deletedAt) {
        sendError(res, 400, '文档不在回收站中')
        return true
      }
      const restored: StoredDocument = { ...project, deletedAt: undefined, updatedAt: Date.now() }
      await writeJson(projectPath(paths, id), restored)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (action === 'forever') {
      if (!project.deletedAt) {
        sendError(res, 400, '文档不在回收站中')
        return true
      }
      await fsp.unlink(projectPath(paths, id))
      const shares = await loadShares(paths)
      await saveShares(paths, shares.filter(share => share.projectId !== id))
      sendJson(res, 200, { ok: true })
      return true
    }
  }

  const shareCollection = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/shares$/)
  const shareItem = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/shares\/([A-Za-z0-9_-]+)$/)
  if (shareCollection || shareItem) {
    const user = await requireUser(req, res, paths)
    if (!user) return true
    const projectId = (shareCollection ?? shareItem)![1]!
    const project = await readProject(paths, projectId)
    if (!project) {
      sendError(res, 404, '项目不存在')
      return true
    }
    if (!canManageProject(user, project)) {
      sendError(res, 403, '没有项目管理权限')
      return true
    }
    const shares = await loadShares(paths)
    if (req.method === 'GET' && shareCollection) {
      const now = Date.now()
      sendJson(res, 200, shares.filter(share => share.projectId === projectId).map(share => ({
        ...share,
        url: shareUrl(req, share.token),
        passwordHash: undefined,
        expired: share.expiresAt !== undefined && share.expiresAt <= now,
      })))
      return true
    }
    if (req.method === 'POST' && shareCollection) {
      const body = await readBody(req)
      const permission = permissionValue(body.permission)
      if (!permission) {
        sendError(res, 400, '权限必须是 view 或 edit')
        return true
      }
      // 可选有效期（小时）与访问密码
      let expiresAt: number | undefined
      const expiresInHours = Number(body.expiresInHours)
      if (Number.isFinite(expiresInHours) && expiresInHours > 0) {
        expiresAt = Date.now() + Math.min(expiresInHours, 24 * 365) * 3600 * 1000
      }
      let passwordHash: string | undefined
      const password = typeof body.password === 'string' ? body.password : ''
      if (password) {
        if (password.length < 4 || password.length > 64) {
          sendError(res, 400, '分享密码长度需在 4-64 位之间')
          return true
        }
        passwordHash = await passwordDigest(password)
      }
      const now = Date.now()
      const share: StoredShare = { token: randomBytes(32).toString('base64url'), projectId, permission, createdAt: now, updatedAt: now, expiresAt, passwordHash }
      await saveShares(paths, [...shares, share])
      sendJson(res, 201, { ...share, passwordHash: undefined, url: shareUrl(req, share.token) })
      return true
    }
    if (shareItem) {
      const token = shareItem[2]!
      const share = shares.find(item => item.token === token && item.projectId === projectId)
      if (!share) {
        sendError(res, 404, '分享链接不存在')
        return true
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req)
        const permission = permissionValue(body.permission)
        if (!permission) {
          sendError(res, 400, '权限必须是 view 或 edit')
          return true
        }
        // 支持设置/清除有效期与密码
        let updated = { ...share, permission, updatedAt: Date.now() } as StoredShare
        const expiresInHours = Number(body.expiresInHours)
        if (Number.isFinite(expiresInHours) && expiresInHours > 0) {
          updated.expiresAt = Date.now() + Math.min(expiresInHours, 24 * 365) * 3600 * 1000
        } else if (body.clearExpires === true) {
          updated.expiresAt = undefined
        }
        const password = typeof body.password === 'string' ? body.password : ''
        if (password) {
          if (password.length < 4 || password.length > 64) {
            sendError(res, 400, '分享密码长度需在 4-64 位之间')
            return true
          }
          updated.passwordHash = await passwordDigest(password)
        } else if (body.clearPassword === true) {
          updated.passwordHash = undefined
        }
        await saveShares(paths, shares.map(item => item.token === token ? updated : item))
        sendJson(res, 200, { ...updated, passwordHash: undefined, url: shareUrl(req, token) })
        return true
      }
      if (req.method === 'DELETE') {
        await saveShares(paths, shares.filter(item => item.token !== token))
        sendJson(res, 200, { ok: true })
        return true
      }
    }
    sendError(res, 405, 'Method not allowed')
    return true
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)$/)
  if (!projectMatch) return false
  const user = await requireUser(req, res, paths)
  if (!user) return true
  const id = projectMatch[1]!
  const project = await readProject(paths, id)
  if (req.method === 'PUT') {
    if (project && !canManageProject(user, project)) {
      sendError(res, 403, '没有项目编辑权限')
      return true
    }
    await writeProject(paths, await readBody(req), user.id, project ?? undefined)
    sendJson(res, 200, { ok: true })
    return true
  }
  if (!project) {
    sendError(res, 404, '项目不存在')
    return true
  }
  if (!canManageProject(user, project)) {
    sendError(res, 403, '没有项目访问权限')
    return true
  }
  if (req.method === 'GET') {
    sendJson(res, 200, projectResponse(project, 'owner'))
    return true
  }
  if (req.method === 'DELETE') {
    // 软删除：标记 deletedAt 进入回收站，不直接删文件
    const now = Date.now()
    const updated: StoredDocument = { ...project, deletedAt: now, updatedAt: now }
    await writeJson(projectPath(paths, id), updated)
    // 删除相关分享链接
    const shares = await loadShares(paths)
    await saveShares(paths, shares.filter(share => share.projectId !== id))
    sendJson(res, 200, { ok: true, softDeleted: true })
    return true
  }
  sendError(res, 405, 'Method not allowed')
  return true
}

// 日志缓冲：合并写入 + 超限轮转。
// 每条日志一次 appendFile 在低配服务器上是可观开销，这里按 1 秒 / 50 条批量落盘。
const LOG_FLUSH_INTERVAL_MS = 1000
const LOG_FLUSH_MAX_LINES = 50
const LOG_ROTATE_BYTES = 5 * 1024 * 1024

const pendingLogLines = new Map<string, string[]>()
let logFlushTimer: NodeJS.Timeout | undefined

/** 日志超过 5 MiB 时轮转为 .1（避免单个日志文件无限增长） */
async function rotateLogIfNeeded(file: string): Promise<void> {
  try {
    const stat = await fsp.stat(file)
    if (stat.size < LOG_ROTATE_BYTES) return
    await fsp.rename(file, `${file}.1`).catch(() => undefined)
  } catch {
    // 文件不存在：无需轮转
  }
}

async function flushRuntimeLogs(paths: RuntimePaths): Promise<void> {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer)
    logFlushTimer = undefined
  }
  if (pendingLogLines.size === 0) return
  const batches = [...pendingLogLines.entries()]
  pendingLogLines.clear()
  await Promise.all(batches.map(async ([name, lines]) => {
    if (lines.length === 0) return
    const target = path.join(paths.logDirectory, name)
    await rotateLogIfNeeded(target)
    await fsp.appendFile(target, lines.join(''), 'utf8').catch(() => undefined)
  }))
}

async function appendRuntimeLog(paths: RuntimePaths, entry: ClientLog): Promise<void> {
  const line = `${JSON.stringify({
    timestamp: entry.timestamp ?? new Date().toISOString(),
    level: entry.level ?? 'info',
    event: entry.event ?? 'unknown',
    message: entry.message ?? '',
    documentId: entry.documentId,
    details: entry.details,
  })}\n`
  const append = (name: string) => {
    const lines = pendingLogLines.get(name) ?? []
    lines.push(line)
    pendingLogLines.set(name, lines)
  }
  append('operations.log')
  if (entry.level === 'error') append('errors.log')

  let total = 0
  for (const lines of pendingLogLines.values()) total += lines.length
  if (total >= LOG_FLUSH_MAX_LINES) {
    await flushRuntimeLogs(paths)
    return
  }
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => { void flushRuntimeLogs(paths) }, LOG_FLUSH_INTERVAL_MS)
    logFlushTimer.unref?.()
  }
}

async function handleLogs(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, pathname: string, url: URL): Promise<boolean> {
  if (req.method === 'POST' && pathname === '/api/logs') {
    await appendRuntimeLog(paths, await readBody(req) as ClientLog)
    sendJson(res, 200, { ok: true })
    return true
  }
  if (req.method === 'GET' && pathname === '/api/logs/latest') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
    const readLines = async (file: string) => {
      try { return (await fsp.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).slice(-limit) } catch { return [] }
    }
    const [operations, errors] = await Promise.all([
      readLines(path.join(paths.logDirectory, 'operations.log')),
      readLines(path.join(paths.logDirectory, 'errors.log')),
    ])
    sendJson(res, 200, { operations, errors })
    return true
  }
  return false
}

interface CanvasGraph {
  version?: number
  shapes?: Record<string, Record<string, unknown>>
  groups?: Record<string, Record<string, unknown> & { id?: string; name?: string; childIds?: string[]; parentId?: string }>
  order?: string[]
  [key: string]: unknown
}

function canvasGraph(project: StoredDocument): CanvasGraph {
  const canvas = projectCanvas(project)
  if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas)) return { version: 3, shapes: {}, groups: {}, order: [] }
  return JSON.parse(JSON.stringify(canvas)) as CanvasGraph
}

function collectGroupGraph(canvas: CanvasGraph, rootId: string): { groupIds: string[]; shapeIds: string[] } | null {
  const groups = canvas.groups ?? {}
  const shapes = canvas.shapes ?? {}
  if (!groups[rootId]) return null
  const groupIds: string[] = []
  const shapeIds: string[] = []
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const groupId = stack.pop()!
    if (seen.has(groupId)) continue
    seen.add(groupId)
    const group = groups[groupId]
    if (!group) continue
    groupIds.push(groupId)
    for (const childId of Array.isArray(group.childIds) ? group.childIds : []) {
      if (groups[childId]) stack.push(childId)
      else if (shapes[childId]) shapeIds.push(childId)
    }
  }
  return { groupIds, shapeIds: [...new Set(shapeIds)] }
}

function cloneGroupIntoCanvas(source: CanvasGraph, target: CanvasGraph, rootId: string): { groupId: string; groupName: string } | null {
  const graph = collectGroupGraph(source, rootId)
  if (!graph) return null
  const sourceGroups = source.groups ?? {}
  const sourceShapes = source.shapes ?? {}
  target.groups ??= {}
  target.shapes ??= {}
  target.order ??= []

  const idMap = new Map<string, string>()
  for (const id of graph.groupIds) idMap.set(id, newId('g'))
  for (const id of graph.shapeIds) idMap.set(id, newId('s'))

  for (const sourceId of graph.groupIds) {
    const original = sourceGroups[sourceId]!
    const mappedId = idMap.get(sourceId)!
    const cloned = JSON.parse(JSON.stringify(original)) as Record<string, unknown> & { childIds?: string[]; parentId?: string; id?: string }
    cloned.id = mappedId
    cloned.childIds = (Array.isArray(original.childIds) ? original.childIds : []).map(id => idMap.get(id)).filter((id): id is string => Boolean(id))
    cloned.parentId = sourceId === rootId ? undefined : (original.parentId ? idMap.get(original.parentId) : undefined)
    target.groups[mappedId] = cloned
  }

  for (const sourceId of graph.shapeIds) {
    const original = sourceShapes[sourceId]!
    const mappedId = idMap.get(sourceId)!
    const cloned = JSON.parse(JSON.stringify(original)) as Record<string, unknown> & {
      id?: string
      x?: number
      y?: number
      groupId?: string
      link?: { kind?: string; targetId?: string; [key: string]: unknown }
      startBinding?: { shapeId?: string; [key: string]: unknown }
      endBinding?: { shapeId?: string; [key: string]: unknown }
    }
    cloned.id = mappedId
    if (typeof cloned.x === 'number') cloned.x += 40
    if (typeof cloned.y === 'number') cloned.y += 40
    if (cloned.groupId) cloned.groupId = idMap.get(cloned.groupId)
    if (cloned.link?.kind === 'shape' && cloned.link.targetId) {
      const mapped = idMap.get(cloned.link.targetId)
      cloned.link = mapped ? { ...cloned.link, targetId: mapped } : undefined
    }
    if (cloned.startBinding?.shapeId) {
      const mapped = idMap.get(cloned.startBinding.shapeId)
      cloned.startBinding = mapped ? { ...cloned.startBinding, shapeId: mapped } : undefined
    }
    if (cloned.endBinding?.shapeId) {
      const mapped = idMap.get(cloned.endBinding.shapeId)
      cloned.endBinding = mapped ? { ...cloned.endBinding, shapeId: mapped } : undefined
    }
    target.shapes[mappedId] = cloned
  }

  const newRootId = idMap.get(rootId)!
  target.order.push(newRootId)
  return { groupId: newRootId, groupName: String(sourceGroups[rootId]?.name ?? '未命名分组') }
}
export async function handleAdmin(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, pathname: string): Promise<boolean> {
  // 仅处理 /api/admin/* 路径，其他路径不拦截
  if (!pathname.startsWith('/api/admin/')) return false
  // 管理接口：仅管理员可用（通过命令行 admin set-admin <email> 设置管理员）
  const user = await requireUser(req, res, paths)
  if (!user) return true
  if (user.id === 'guest') return true
  const users = await loadUsers(paths)
  const admin = users.find(item => item.id === user.id && item.isAdmin === true)
  if (!admin) {
    sendError(res, 403, '需要管理员权限')
    return true
  }

  // GET /api/admin/users —— 查看所有注册用户
  if (req.method === 'GET' && pathname === '/api/admin/users') {
    sendJson(res, 200, users.map(item => ({
      id: item.id,
      email: item.email,
      createdAt: item.createdAt,
      lastLoginAt: item.lastLoginAt,
      isAdmin: item.isAdmin === true,
      isRootAdmin: item.email.toLowerCase() === DEFAULT_ADMIN_EMAIL,
    })).sort((a, b) => b.createdAt - a.createdAt))
    return true
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]+)$/)
  if (adminUserMatch && req.method === 'PATCH') {
    const targetId = adminUserMatch[1]!
    const body = await readBody(req)
    const target = users.find(item => item.id === targetId)
    if (!target) { sendError(res, 404, '用户不存在'); return true }
    if (body.isAdmin === false && (target.email.toLowerCase() === DEFAULT_ADMIN_EMAIL || target.id === user.id)) {
      sendError(res, 400, '不能取消默认根管理员或当前登录管理员自己的管理员权限')
      return true
    }
    if (typeof body.isAdmin === 'boolean') target.isAdmin = body.isAdmin
    await saveUsers(paths, users)
    sendJson(res, 200, { user: authUser(target) })
    return true
  }

  if (adminUserMatch && req.method === 'DELETE') {
    const targetId = adminUserMatch[1]!
    const target = users.find(item => item.id === targetId)
    if (!target) { sendError(res, 404, '用户不存在'); return true }
    if (target.email.toLowerCase() === DEFAULT_ADMIN_EMAIL || target.id === user.id) {
      sendError(res, 400, '不能删除当前管理员或默认根管理员')
      return true
    }
    let files: string[] = []
    try { files = (await fsp.readdir(paths.dataDirectory)).filter(file => file.endsWith('.json')) } catch { /* empty */ }
    let deletedDocs = 0
    const deletedDocIds = new Set<string>()
    for (const file of files) {
      const fullPath = path.join(paths.dataDirectory, file)
      try {
        const project = JSON.parse(await fsp.readFile(fullPath, 'utf8')) as StoredDocument
        if (project.ownerId === target.id) {
          deletedDocIds.add(project.id)
          await fsp.unlink(fullPath)
          deletedDocs++
        }
      } catch { /* skip */ }
    }
    await saveUsers(paths, users.filter(item => item.id !== target.id))
    const sessions = await loadSessions(paths)
    await saveSessions(paths, sessions.filter(item => item.userId !== target.id))
    if (deletedDocIds.size > 0) {
      const shares = await loadShares(paths)
      await saveShares(paths, shares.filter(share => !deletedDocIds.has(share.projectId)))
    }
    sendJson(res, 200, { ok: true, deletedDocs })
    return true
  }

  // 邀请码管理
  if (pathname === '/api/admin/invites' && req.method === 'GET') {
    const invites = await loadInvites(paths)
    sendJson(res, 200, invites.sort((a, b) => b.createdAt - a.createdAt))
    return true
  }
  if (pathname === '/api/admin/invites' && req.method === 'POST') {
    const body = await readBody(req)
    const requested = Number(body.maxUses ?? 1)
    const maxUses = Math.max(1, Math.min(100, Number.isFinite(requested) ? Math.floor(requested) : 1))
    const invites = await loadInvites(paths)
    let code = newInviteCode()
    while (invites.some(item => item.code === code)) code = newInviteCode()
    const invite: StoredInvite = { code, createdAt: Date.now(), createdBy: user.id, maxUses, usedCount: 0 }
    await saveInvites(paths, [invite, ...invites])
    sendJson(res, 201, invite)
    return true
  }
  const inviteMatch = pathname.match(/^\/api\/admin\/invites\/([A-Z0-9]+)$/)
  if (inviteMatch && req.method === 'DELETE') {
    const code = inviteMatch[1]!
    const invites = await loadInvites(paths)
    if (!invites.some(item => item.code === code)) { sendError(res, 404, '邀请码不存在'); return true }
    await saveInvites(paths, invites.map(item => item.code === code ? { ...item, disabled: true } : item))
    sendJson(res, 200, { ok: true })
    return true
  }

  // GET /api/admin/docs —— 查看所有用户的画册
  if (req.method === 'GET' && pathname === '/api/admin/docs') {
    let files: string[] = []
    try { files = (await fsp.readdir(paths.dataDirectory)).filter(file => file.endsWith('.json')) } catch { /* empty */ }
    const emailById = new Map(users.map(u => [u.id, u.email]))
    const projects = await Promise.all(files.map(async file => {
      try {
        const project = JSON.parse(await fsp.readFile(path.join(paths.dataDirectory, file), 'utf8')) as StoredDocument
        if (typeof project.id !== 'string' || !project.id) return null
        return {
          id: project.id,
          title: project.title,
          ownerEmail: project.ownerId ? (emailById.get(project.ownerId) ?? project.ownerId) : '(无主)',
          updatedAt: project.updatedAt,
          createdAt: project.createdAt,
        }
      } catch { return null }
    }))
    sendJson(res, 200, projects.filter((p): p is NonNullable<typeof p> => p !== null).sort((a, b) => b.updatedAt - a.updatedAt))
    return true
  }

  // GET /api/admin/docs/:docId/groups —— 列出某画布中的全部分组
  const groupListMatch = pathname.match(/^\/api\/admin\/docs\/([a-zA-Z0-9_-]+)\/groups$/)
  if (req.method === 'GET' && groupListMatch) {
    const source = await readProject(paths, groupListMatch[1]!)
    if (!source) { sendError(res, 404, '文档不存在'); return true }
    const canvas = canvasGraph(source)
    const groups = canvas.groups ?? {}
    const result = Object.entries(groups).map(([id, group]) => {
      const graph = collectGroupGraph(canvas, id)
      return {
        id,
        name: String(group.name ?? '未命名分组'),
        parentId: typeof group.parentId === 'string' ? group.parentId : undefined,
        shapeCount: graph?.shapeIds.length ?? 0,
        groupCount: graph?.groupIds.length ?? 1,
      }
    })
    sendJson(res, 200, result)
    return true
  }

  // POST /api/admin/copy-group —— 把他人画布的指定分组复制到管理员自己的指定画布
  if (req.method === 'POST' && pathname === '/api/admin/copy-group') {
    const body = await readBody(req)
    const sourceDocId = typeof body.sourceDocId === 'string' ? body.sourceDocId : ''
    const targetDocId = typeof body.targetDocId === 'string' ? body.targetDocId : ''
    const groupId = typeof body.groupId === 'string' ? body.groupId : ''
    if (!validProjectId(sourceDocId) || !validProjectId(targetDocId) || !validProjectId(groupId)) {
      sendError(res, 400, 'sourceDocId、targetDocId、groupId 均为必填项')
      return true
    }
    const [source, target] = await Promise.all([readProject(paths, sourceDocId), readProject(paths, targetDocId)])
    if (!source || !target) { sendError(res, 404, '源文档或目标文档不存在'); return true }
    if (target.ownerId !== user.id) {
      sendError(res, 403, '目标画布必须属于当前管理员账号')
      return true
    }
    const targetCanvas = canvasGraph(target)
    const copied = cloneGroupIntoCanvas(canvasGraph(source), targetCanvas, groupId)
    if (!copied) { sendError(res, 404, '源分组不存在'); return true }
    await writeJson(projectPath(paths, target.id), { ...target, canvas: targetCanvas, updatedAt: Date.now() } satisfies StoredDocument)
    sendJson(res, 201, { ok: true, ...copied, targetDocId: target.id })
    return true
  }

  // POST /api/admin/copy-doc/:docId —— 复制他人画册到自己的画册
  const copyMatch = pathname.match(/^\/api\/admin\/copy-doc\/([a-zA-Z0-9_-]+)$/)
  if (req.method === 'POST' && copyMatch) {
    const sourceId = copyMatch[1]!
    const source = await readProject(paths, sourceId)
    if (!source) {
      sendError(res, 404, '文档不存在')
      return true
    }
    const now = Date.now()
    const copy: StoredDocument = {
      ...source,
      id: `doc_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: `${source.title}（副本）`,
      ownerId: user.id,
      createdAt: now,
      updatedAt: now,
    }
    await writeProject(paths, copy as unknown as Record<string, unknown>, user.id)
    sendJson(res, 201, { ok: true, id: copy.id, title: copy.title })
    return true
  }

  // GET /api/admin/backup —— 导出全部数据为 .json.gz 备份文件
  if (req.method === 'GET' && pathname === '/api/admin/backup') {
    const dataFiles = await fsp.readdir(paths.dataDirectory).catch(() => [] as string[])
    const authFiles = await fsp.readdir(paths.authDirectory).catch(() => [] as string[])
    const payload: Record<string, unknown> = {
      meta: { app: 'FlowBoard', backupAt: new Date().toISOString() },
      data: {} as Record<string, unknown>,
      auth: {} as Record<string, unknown>,
    }
    const data = payload.data as Record<string, unknown>
    const auth = payload.auth as Record<string, unknown>
    for (const file of dataFiles.filter(f => f.endsWith('.json'))) {
      try { data[file] = JSON.parse(await fsp.readFile(path.join(paths.dataDirectory, file), 'utf8')) } catch { /* skip */ }
    }
    for (const file of authFiles.filter(f => f.endsWith('.json'))) {
      try { auth[file] = JSON.parse(await fsp.readFile(path.join(paths.authDirectory, file), 'utf8')) } catch { /* skip */ }
    }
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/gzip')
    res.setHeader('Content-Disposition', `attachment; filename="flowboard-backup-${new Date().toISOString().slice(0, 10)}.json.gz"`)
    res.end(compressed)
    return true
  }

  // POST /api/admin/restore —— 从备份恢复（body 为 gzip 压缩的 JSON 或纯 JSON）
  if (req.method === 'POST' && pathname === '/api/admin/restore') {
    const body = await readBodyRaw(req)
    let text: string
    try {
      text = gunzipSync(body).toString('utf8')
    } catch {
      text = body.toString('utf8')
    }
    let payload: { data?: Record<string, unknown>; auth?: Record<string, unknown> }
    try {
      payload = JSON.parse(text)
    } catch {
      sendError(res, 400, '备份文件格式无效')
      return true
    }
    let restored = 0
    if (payload.data && typeof payload.data === 'object') {
      for (const [file, content] of Object.entries(payload.data)) {
        if (!file.endsWith('.json') || file.includes('..')) continue
        await fsp.writeFile(path.join(paths.dataDirectory, file), JSON.stringify(content), 'utf8')
        restored++
      }
    }
    if (payload.auth && typeof payload.auth === 'object') {
      for (const [file, content] of Object.entries(payload.auth)) {
        if (!file.endsWith('.json') || file.includes('..')) continue
        await fsp.writeFile(path.join(paths.authDirectory, file), JSON.stringify(content), 'utf8')
        restored++
      }
    }
    sendJson(res, 200, { ok: true, restored })
    return true
  }

  return false
}

async function handleSettings(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, pathname: string): Promise<boolean> {
  if (pathname !== '/api/settings' && pathname !== '/api/settings/smtp-test') return false
  // SMTP 是服务器级配置，仅管理员可修改或测试。
  const user = await requireUser(req, res, paths)
  if (!user) return true
  if (user.id === 'guest' || user.isAdmin !== true) {
    sendError(res, 403, '仅管理员可管理服务器 SMTP 配置')
    return true
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    const configured = !!process.env.FLOWBOARD_SMTP_PASS
    sendJson(res, 200, {
      emailMode: process.env.FLOWBOARD_EMAIL_MODE ?? 'smtp',
      smtp: {
        configured,
        host: process.env.FLOWBOARD_SMTP_HOST ?? 'smtp.qq.com',
        port: Number(process.env.FLOWBOARD_SMTP_PORT ?? '465'),
        secure: /^(1|true|yes|on)$/i.test(process.env.FLOWBOARD_SMTP_SECURE ?? 'true'),
        user: process.env.FLOWBOARD_SMTP_USER ?? DEFAULT_ADMIN_EMAIL,
        from: process.env.FLOWBOARD_SMTP_FROM ?? DEFAULT_ADMIN_EMAIL,
        // 不回传密码明文，仅标记是否已设置
        hasPassword: !!process.env.FLOWBOARD_SMTP_PASS,
      },
      envFile: path.join(paths.authDirectory, '..', process.platform === 'win32' ? 'flowboard.env.cmd' : 'flowboard.env'),
    })
    return true
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req)
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : 'smtp.qq.com'
    const port = Number(body.port ?? 465)
    const secure = body.secure !== false
    const userValue = typeof body.user === 'string' && body.user.trim() ? body.user.trim() : DEFAULT_ADMIN_EMAIL
    const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : userValue
    // 密码可选：留空表示保持现有密码
    const password = typeof body.password === 'string' ? body.password.trim() : ''
    if (!host || !userValue) {
      sendError(res, 400, 'SMTP 主机与账号不能为空')
      return true
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      sendError(res, 400, 'SMTP 端口不合法')
      return true
    }
    if (password && (password.length < 4 || password.length > 128)) {
      sendError(res, 400, 'SMTP 授权码长度需在 4-128 位之间')
      return true
    }

    // 写入环境变量（立即生效，不需要重启）
    process.env.FLOWBOARD_SMTP_HOST = host
    process.env.FLOWBOARD_SMTP_PORT = String(port)
    process.env.FLOWBOARD_SMTP_SECURE = secure ? 'true' : 'false'
    process.env.FLOWBOARD_SMTP_USER = userValue
    process.env.FLOWBOARD_SMTP_FROM = from
    if (password) process.env.FLOWBOARD_SMTP_PASS = password

    // 持久化到运行目录：Windows 写 .cmd，Linux 写可被 start-server.sh source 的 flowboard.env。
    try {
      const envFile = path.join(paths.authDirectory, '..', process.platform === 'win32' ? 'flowboard.env.cmd' : 'flowboard.env')
      const values: Array<[string, string | undefined]> = [
        ['FLOWBOARD_SMTP_HOST', host],
        ['FLOWBOARD_SMTP_PORT', String(port)],
        ['FLOWBOARD_SMTP_SECURE', secure ? 'true' : 'false'],
        ['FLOWBOARD_SMTP_USER', userValue],
        ['FLOWBOARD_SMTP_PASS', password || process.env.FLOWBOARD_SMTP_PASS],
        ['FLOWBOARD_SMTP_FROM', from],
      ]
      let text: string
      if (process.platform === 'win32') {
        text = ['@echo off', ...values.filter(([, value]) => Boolean(value)).map(([key, value]) => `set "${key}=${value}"`)].join('\r\n') + '\r\n'
      } else {
        const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
        text = values.filter(([, value]) => Boolean(value)).map(([key, value]) => `${key}=${quote(String(value))}`).join('\n') + '\n'
      }
      await fsp.writeFile(envFile, text, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      sendError(res, 500, `SMTP 配置已生效但写入文件失败: ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
    sendJson(res, 200, { ok: true, message: 'SMTP 配置已保存并立即生效' })
    return true
  }

  if (pathname === '/api/settings/smtp-test' && req.method === 'POST') {
    const body = await readBody(req)
    const to = typeof body.to === 'string' ? body.to.trim() : user.email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      sendError(res, 400, '请输入有效的测试收件邮箱')
      return true
    }
    try {
      await sendSmtpMail(to, 'FlowBoard SMTP 测试邮件，发送成功 ✓')
      sendJson(res, 200, { ok: true, message: `测试邮件已发送到 ${to}` })
    } catch (error) {
      await appendRuntimeLog(paths, { level: 'error', event: 'settings.smtp_test_failed', message: error instanceof Error ? error.message : String(error) })
      sendError(res, 502, `测试邮件发送失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }
  return false
}

export async function handleRuntimeRequest(req: IncomingMessage, res: ServerResponse, context: RuntimeContext): Promise<boolean> {
  const { paths } = context
  const url = new URL(req.url ?? '/', 'http://flowboard.local')
  const pathname = url.pathname
  // 提前记录客户端是否接受 gzip（sendJson 里无法可靠拿到请求头）
  ;(res as GzipAwareResponse).__acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
  try {
    if (await handleAuth(req, res, paths, pathname)) return true
    if (await handleAssets(req, res, paths, pathname)) return true
    if (await handleShare(req, res, paths, pathname)) return true
    if (await handleProjects(req, res, paths, pathname)) return true
    if (await handleAdmin(req, res, paths, pathname)) return true
    if (await handleSettings(req, res, paths, pathname)) return true
    if (await handleLogs(req, res, paths, pathname, url)) return true
    if (req.method === 'GET' && pathname === '/api/health') {
      // 返回运行状态 + 本机全部可用访问地址（供前端状态栏 / 分享页展示）
      const lanAddresses = detectLanIPv4Addresses()
      const publicHost = preferredPublicHost()
      const port = Number(process.env.FLOWBOARD_PORT ?? '3000')
      const localUrl = `http://127.0.0.1:${port}`
      const urls: string[] = []
      if (publicHost !== 'localhost') urls.push(`http://${publicHost}:${port}`)
      else if (lanAddresses.length > 0) urls.push(...lanAddresses.map(address => `http://${address}:${port}`))
      urls.push(localUrl)
      sendJson(res, 200, {
        status: 'ok',
        app: 'FlowBoard',
        version: typeof (process.env as Record<string, string | undefined>).FLOWBOARD_VERSION === 'string'
          ? (process.env as Record<string, string | undefined>).FLOWBOARD_VERSION
          : 'dev-build',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        urls: [...new Set(urls)],
        lanAddresses,
      })
      return true
    }
    return false
  } catch (error) {
    const isClientError = error instanceof RequestBodyError
    await appendRuntimeLog(paths, {
      level: isClientError ? 'warn' : 'error',
      event: isClientError ? 'runtime.invalid_request' : 'runtime.request_failed',
      message: error instanceof Error ? error.message : String(error),
      details: { method: req.method, url: req.url },
    })
    sendError(res, isClientError ? error.status : 500, error instanceof Error ? error.message : String(error))
    return true
  }
}

// ── 数据维护：内嵌图片迁移 / 孤儿资源回收 ──────────────────

export interface AssetMigrationResult {
  scanned: number
  converted: number
  written: number
  deduped: number
  bytesBefore: number
  bytesAfter: number
}

/** 收集所有含画布内容的 JSON：文档本体 + 版本快照 */
async function collectDocumentFiles(paths: RuntimePaths): Promise<string[]> {
  const files: string[] = []
  try {
    for (const name of await fsp.readdir(paths.dataDirectory)) {
      if (name.endsWith('.json')) files.push(path.join(paths.dataDirectory, name))
    }
  } catch { /* 数据目录不存在 */ }
  const versionsRoot = path.join(paths.dataDirectory, 'versions')
  try {
    for (const projectDir of await fsp.readdir(versionsRoot)) {
      const dir = path.join(versionsRoot, projectDir)
      try {
        for (const name of await fsp.readdir(dir)) {
          if (name.endsWith('.json')) files.push(path.join(dir, name))
        }
      } catch { /* 跳过不可读目录 */ }
    }
  } catch { /* 无版本目录 */ }
  return files
}

/**
 * 把文档（含版本快照）里内嵌的 base64 图片抽到 assets 目录，src 替换为外置 URL。
 * 幂等：已是外置引用的内容不会被重复处理。
 */
export async function migrateInlineAssets(paths: RuntimePaths): Promise<AssetMigrationResult> {
  const result: AssetMigrationResult = { scanned: 0, converted: 0, written: 0, deduped: 0, bytesBefore: 0, bytesAfter: 0 }
  for (const file of await collectDocumentFiles(paths)) {
    let raw: string
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    result.scanned++
    const before = Buffer.byteLength(raw)
    result.bytesBefore += before
    const matches = [...new Set(raw.match(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g) ?? [])]
    if (matches.length === 0) {
      result.bytesAfter += before
      continue
    }
    let updated = raw
    for (const dataUrl of matches) {
      const decoded = decodeImageDataUrl(dataUrl)
      if (!decoded) continue
      const stored = await storeAssetBuffer(paths, decoded.buffer, decoded.extension)
      updated = updated.split(dataUrl).join(stored.url)
      result.converted++
      if (stored.deduped) result.deduped++
      else result.written++
    }
    if (updated !== raw) {
      try {
        await writeJson(file, JSON.parse(updated))
      } catch {
        result.bytesAfter += before
        continue
      }
    }
    result.bytesAfter += Buffer.byteLength(updated)
  }
  return result
}

export interface AssetGcResult {
  referenced: number
  removed: number
  kept: number
  bytesFreed: number
}

/** 回收没有被任何文档/版本快照引用的孤儿图片 */
export async function collectOrphanAssets(paths: RuntimePaths): Promise<AssetGcResult> {
  const referenced = new Set<string>()
  for (const file of await collectDocumentFiles(paths)) {
    let raw: string
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const url of raw.match(/\/api\/assets\/[a-zA-Z0-9._-]+/g) ?? []) {
      const name = url.split('/').pop()
      if (name) referenced.add(name)
    }
  }
  const result: AssetGcResult = { referenced: referenced.size, removed: 0, kept: 0, bytesFreed: 0 }
  const directory = assetsDirectory(paths)
  let names: string[] = []
  try {
    names = await fsp.readdir(directory)
  } catch {
    return result
  }
  for (const name of names) {
    if (!ASSET_FILE_PATTERN.test(name)) continue
    if (referenced.has(name)) {
      result.kept++
      continue
    }
    try {
      const stat = await fsp.stat(path.join(directory, name))
      await fsp.unlink(path.join(directory, name))
      result.removed++
      result.bytesFreed += stat.size
    } catch { /* 跳过 */ }
  }
  return result
}