import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
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
const PASSWORD_MAX_LENGTH = 256
const AUTH_REQUEST_MAX_BYTES = 16 * 1024
const SMTP_TIMEOUT_MS = Math.max(5000, Math.min(60000, Number(process.env.FLOWBOARD_SMTP_TIMEOUT_MS ?? '15000') || 15000))
const DEFAULT_ADMIN_EMAIL = (process.env.FLOWBOARD_DEFAULT_ADMIN_EMAIL ?? '804559340@qq.com').trim().toLowerCase()
const configuredMaxUsers = Number(process.env.FLOWBOARD_MAX_USERS ?? '20')
const DEFAULT_MAX_USERS = Number.isFinite(configuredMaxUsers)
  ? Math.max(2, Math.min(1000, Math.floor(configuredMaxUsers)))
  : 20

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
  isRootAdmin?: boolean
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
const projectMutationTails = new Map<string, Promise<void>>()
const shareMutationTails = new Map<string, Promise<void>>()

async function withProjectMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectMutationTails.get(projectId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  projectMutationTails.set(projectId, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    void tail.finally(() => {
      if (projectMutationTails.get(projectId) === tail) projectMutationTails.delete(projectId)
    })
  }
}

async function withShareMutation<T>(token: string, operation: () => Promise<T>): Promise<T> {
  const previous = shareMutationTails.get(token) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  shareMutationTails.set(token, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    void tail.finally(() => {
      if (shareMutationTails.get(token) === tail) shareMutationTails.delete(token)
    })
  }
}

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
const MAX_ASSET_REQUEST_BYTES = Math.ceil(MAX_ASSET_BYTES * 4 / 3) + 64 * 1024
const MAX_LOG_REQUEST_BYTES = 128 * 1024
const MAX_ASSET_STORAGE_MB = Math.max(64, Math.min(4096, Number(process.env.FLOWBOARD_MAX_ASSET_STORAGE_MB ?? '512') || 512))
const MAX_ASSET_STORAGE_BYTES = MAX_ASSET_STORAGE_MB * 1024 * 1024
const ASSET_GC_MIN_AGE_MS = 60 * 60 * 1000
const assetStorageUsageCache = new Map<string, number>()
const assetStorageMutationTails = new Map<string, Promise<void>>()
const MAX_WEB_BACKUP_ASSET_BYTES = 48 * 1024 * 1024
const MAX_WEB_BACKUP_DOCUMENT_BYTES = 20 * 1024 * 1024
const MAX_RESTORE_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_RESTORE_JSON_BYTES = 96 * 1024 * 1024
const configuredMinFreeStorageMb = Number(process.env.FLOWBOARD_MIN_FREE_STORAGE_MB ?? '128')
const MIN_FREE_STORAGE_MB = Number.isFinite(configuredMinFreeStorageMb)
  ? Math.max(0, Math.min(4096, Math.floor(configuredMinFreeStorageMb)))
  : 128
const MIN_FREE_STORAGE_BYTES = MIN_FREE_STORAGE_MB * 1024 * 1024
const configuredMaxInflightBodyMb = Number(process.env.FLOWBOARD_MAX_INFLIGHT_BODY_MB ?? '64')
const MAX_INFLIGHT_BODY_MB = Number.isFinite(configuredMaxInflightBodyMb)
  ? Math.max(16, Math.min(512, Math.floor(configuredMaxInflightBodyMb)))
  : 64
const MAX_INFLIGHT_BODY_BYTES = MAX_INFLIGHT_BODY_MB * 1024 * 1024
let inFlightRequestBodyBytes = 0

/** 从 dataURL 中解析出图片本体；非图片 dataURL 返回 null */
function decodeImageDataUrl(dataUrl: string): { buffer: Buffer; extension: string } | null {
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/)
  if (!match) return null
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1]!
  const buffer = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64')
  return buffer.length > 0 ? { buffer, extension } : null
}

async function withAssetStorageMutation<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = assetStorageMutationTails.get(directory) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  assetStorageMutationTails.set(directory, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    void tail.finally(() => {
      if (assetStorageMutationTails.get(directory) === tail) assetStorageMutationTails.delete(directory)
    })
  }
}

async function assetStorageUsage(directory: string): Promise<number> {
  const cached = assetStorageUsageCache.get(directory)
  if (cached !== undefined) return cached
  let total = 0
  for (const name of await fsp.readdir(directory).catch(() => [] as string[])) {
    if (!ASSET_FILE_PATTERN.test(name)) continue
    try { total += (await fsp.stat(path.join(directory, name))).size } catch { /* file vanished */ }
  }
  assetStorageUsageCache.set(directory, total)
  return total
}

/** 内容寻址写入：返回可直接引用的 URL，同内容自动去重，并限制资源库总容量。 */
async function storeAssetBuffer(paths: RuntimePaths, buffer: Buffer, extension: string): Promise<{ url: string; deduped: boolean }> {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 40)
  const name = `${hash}.${extension}`
  const directory = assetsDirectory(paths)
  await fsp.mkdir(directory, { recursive: true })
  const file = path.join(directory, name)

  return withAssetStorageMutation(directory, async () => {
    let exists = true
    try {
      await fsp.access(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false
      else throw error
    }

    if (exists) {
      // 去重命中也代表这张图刚被重新使用。刷新 mtime，让孤儿 GC 的宽限期
      // 从本次使用重新计算，避免“旧孤儿图刚复用、画布尚未保存”时被误删。
      const now = new Date()
      await fsp.utimes(file, now, now)
      return { url: `/api/assets/${name}`, deduped: true }
    }

    const used = await assetStorageUsage(directory)
    if (used + buffer.length > MAX_ASSET_STORAGE_BYTES) {
      throw new RequestBodyError(
        `图片资源库已达到容量上限（${MAX_ASSET_STORAGE_MB} MiB），请管理员清理孤儿图片或调整 FLOWBOARD_MAX_ASSET_STORAGE_MB`,
        507,
      )
    }
    await writeBufferAtomic(file, buffer)
    assetStorageUsageCache.set(directory, used + buffer.length)
    return { url: `/api/assets/${name}`, deduped: false }
  })
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function ensureFreeStorageForWrite(file: string, bytesToWrite: number): Promise<void> {
  if (MIN_FREE_STORAGE_BYTES <= 0) return
  const directory = path.dirname(file)
  try {
    const stat = await fsp.statfs(directory)
    const available = stat.bavail * stat.bsize
    if (available - Math.max(0, bytesToWrite) < MIN_FREE_STORAGE_BYTES) {
      throw new RequestBodyError(
        `磁盘剩余空间不足；至少需要保留 ${MIN_FREE_STORAGE_MB} MiB 空闲空间`,
        507,
      )
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error
    // 某些非标准文件系统若不支持 statfs，不让兼容性检查阻断正常写入。
    if ((error as NodeJS.ErrnoException).code !== 'ENOSYS') throw error
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  await ensureFreeStorageForWrite(file, Buffer.byteLength(serialized, 'utf8'))
  // 同一 Node 进程可能并发保存同一画布；仅使用 PID 会让两个写入共用同一个 .tmp。
  // 随机后缀保证每次原子替换都有独立临时文件，并把 JSON 默认落成仅服务账号可读。
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fsp.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
    await fsp.rename(temporary, file)
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function writeBufferAtomic(file: string, value: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await ensureFreeStorageForWrite(file, value.length)
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fsp.writeFile(temporary, value, { mode: 0o600 })
    await fsp.rename(temporary, file)
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function queueJsonWrite(file: string, value: unknown): Promise<void> {
  // 认证/会话文件写入量很小，优先保证严格顺序和错误可见性。
  // 不做定时防抖：清除前一个 timer 会让前一个 Promise 永远不结束，
  // 并且不能把磁盘写入失败伪装成成功。
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => writeJson(file, value))
  writeQueues.set(file, next)
  return next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
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
function readBodyRaw(req: IncomingMessage, maxBytes = 50 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let cleaned = false

    const cleanup = (dropChunks = false) => {
      if (cleaned) return
      cleaned = true
      inFlightRequestBodyBytes = Math.max(0, inFlightRequestBodyBytes - size)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      if (dropChunks) chunks.length = 0
    }

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (size + buffer.length > maxBytes) {
        cleanup(true)
        req.resume()
        reject(new RequestBodyError(`请求体不能超过 ${Math.ceil(maxBytes / 1024 / 1024)} MiB`, 413))
        return
      }
      if (inFlightRequestBodyBytes + buffer.length > MAX_INFLIGHT_BODY_BYTES) {
        cleanup(true)
        req.resume()
        reject(new RequestBodyError(
          `服务器当前请求体内存负载过高（上限 ${MAX_INFLIGHT_BODY_MB} MiB），请稍后重试`,
          503,
        ))
        return
      }
      size += buffer.length
      inFlightRequestBodyBytes += buffer.length
      chunks.push(buffer)
    }
    const onEnd = () => {
      const body = Buffer.concat(chunks)
      cleanup()
      resolve(body)
    }
    const onError = (error: Error) => {
      cleanup(true)
      reject(error)
    }
    const onAborted = () => {
      cleanup(true)
      reject(new RequestBodyError('请求已中止'))
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

async function readBody(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Record<string, unknown>> {
  // 注意：Node 14 的 IncomingMessage 不原生支持 asyncIterator（pkg target），
  // 因此使用传统 data/end 事件模式代替 for await...of。
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let cleaned = false

    const cleanup = (dropChunks = false) => {
      if (cleaned) return
      cleaned = true
      inFlightRequestBodyBytes = Math.max(0, inFlightRequestBodyBytes - size)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      if (dropChunks) chunks.length = 0
    }

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (size + buffer.length > maxBytes) {
        cleanup(true)
        req.resume()
        reject(new RequestBodyError(`请求体不能超过 ${Math.ceil(maxBytes / 1024 / 1024)} MiB`, 413))
        return
      }
      if (inFlightRequestBodyBytes + buffer.length > MAX_INFLIGHT_BODY_BYTES) {
        cleanup(true)
        req.resume()
        reject(new RequestBodyError(
          `服务器当前请求体内存负载过高（上限 ${MAX_INFLIGHT_BODY_MB} MiB），请稍后重试`,
          503,
        ))
        return
      }
      size += buffer.length
      inFlightRequestBodyBytes += buffer.length
      chunks.push(buffer)
    }
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8')
      cleanup()
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
    const onError = (error: Error) => {
      cleanup(true)
      reject(new RequestBodyError(error.message))
    }
    const onAborted = () => {
      cleanup(true)
      reject(new RequestBodyError('请求已中止'))
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function validEmail(email: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && email.length <= 320
}

function validProjectId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateRestoredUsers(value: unknown): StoredUser[] {
  if (!Array.isArray(value)) throw new RequestBodyError('备份中的 users.json 格式无效')
  const users: StoredUser[] = []
  const ids = new Set<string>()
  const emails = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.id !== 'string' || !validProjectId(item.id)
      || typeof item.email !== 'string' || !validEmail(item.email.toLowerCase())
      || typeof item.passwordHash !== 'string' || !parsePasswordDigest(item.passwordHash)
      || !isFiniteNumber(item.createdAt) || !isFiniteNumber(item.verifiedAt)
      || (item.lastLoginAt !== undefined && !isFiniteNumber(item.lastLoginAt))
      || (item.isAdmin !== undefined && typeof item.isAdmin !== 'boolean')) {
      throw new RequestBodyError('备份中的 users.json 包含无效用户记录')
    }
    const email = item.email.trim().toLowerCase()
    if (ids.has(item.id) || emails.has(email)) throw new RequestBodyError('备份中的 users.json 存在重复用户')
    ids.add(item.id)
    emails.add(email)
    users.push({
      id: item.id,
      email,
      passwordHash: item.passwordHash,
      createdAt: item.createdAt,
      verifiedAt: item.verifiedAt,
      lastLoginAt: item.lastLoginAt as number | undefined,
      isAdmin: item.isAdmin as boolean | undefined,
    })
  }
  return users
}

function validateRestoredInvites(value: unknown): StoredInvite[] {
  if (!Array.isArray(value)) throw new RequestBodyError('备份中的 invites.json 格式无效')
  const invites: StoredInvite[] = []
  const codes = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.code !== 'string' || !/^[A-Z0-9]{4,64}$/.test(item.code)
      || !isFiniteNumber(item.createdAt)
      || typeof item.createdBy !== 'string'
      || !Number.isInteger(item.maxUses) || (item.maxUses as number) < 1
      || !Number.isInteger(item.usedCount) || (item.usedCount as number) < 0 || (item.usedCount as number) > (item.maxUses as number)
      || (item.lastUsedAt !== undefined && !isFiniteNumber(item.lastUsedAt))
      || (item.disabled !== undefined && typeof item.disabled !== 'boolean')) {
      throw new RequestBodyError('备份中的 invites.json 包含无效邀请码记录')
    }
    if (codes.has(item.code)) throw new RequestBodyError('备份中的 invites.json 存在重复邀请码')
    codes.add(item.code)
    invites.push(item as unknown as StoredInvite)
  }
  return invites
}

function validateRestoredShares(value: unknown): StoredShare[] {
  if (!Array.isArray(value)) throw new RequestBodyError('备份中的 shares.json 格式无效')
  const shares: StoredShare[] = []
  const tokens = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(item.token)
      || typeof item.projectId !== 'string' || !validProjectId(item.projectId)
      || (item.permission !== 'view' && item.permission !== 'edit')
      || !isFiniteNumber(item.createdAt) || !isFiniteNumber(item.updatedAt)
      || (item.expiresAt !== undefined && !isFiniteNumber(item.expiresAt))
      || (item.passwordHash !== undefined
        && (typeof item.passwordHash !== 'string' || !parsePasswordDigest(item.passwordHash)))) {
      throw new RequestBodyError('备份中的 shares.json 包含无效分享记录')
    }
    if (tokens.has(item.token)) throw new RequestBodyError('备份中的 shares.json 存在重复分享 token')
    tokens.add(item.token)
    shares.push(item as unknown as StoredShare)
  }
  return shares
}

function projectPath(paths: RuntimePaths, id: string): string {
  if (!validProjectId(id)) throw new Error('Invalid project id')
  return path.join(paths.dataDirectory, `${id}.json`)
}

function authUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    isAdmin: user.isAdmin === true,
    isRootAdmin: user.email.toLowerCase() === DEFAULT_ADMIN_EMAIL,
  }
}

async function loadUsers(paths: RuntimePaths): Promise<StoredUser[]> {
  const users = await readJson<StoredUser[]>(filePath(paths, 'users.json'), [])
  // 根管理员权限在读取时强制生效，但读取路径不写磁盘。
  // 这样既保证旧数据里的根管理员永远拥有管理员权限，也避免普通鉴权读取
  // 与注册/用户管理事务并发时通过一次“自动修复写”覆盖 users.json。
  return users.map(user => user.email.toLowerCase() === DEFAULT_ADMIN_EMAIL && user.isAdmin !== true
    ? { ...user, isAdmin: true }
    : user)
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

let authMutationTail: Promise<void> = Promise.resolve()
let loginPasswordTail: Promise<void> = Promise.resolve()

async function withAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const previous = authMutationTail
  authMutationTail = previous.catch(() => undefined).then(() => gate)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
  }
}

async function withLoginPasswordWork<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const previous = loginPasswordTail
  loginPasswordTail = previous.catch(() => undefined).then(() => gate)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
  }
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
const SHARE_PASSWORD_MAX_ATTEMPTS = 5
const SHARE_PASSWORD_LOCK_MS = 5 * 60 * 1000
const sharePasswordAttempts = new Map<string, { count: number; lastFailAt: number }>()

async function loadLoginAttempts(paths: RuntimePaths): Promise<LoginAttempt[]> {
  return readJson(filePath(paths, 'login-attempts.json'), [])
}

async function saveLoginAttempts(paths: RuntimePaths, attempts: LoginAttempt[]): Promise<void> {
  await queueJsonWrite(filePath(paths, 'login-attempts.json'), attempts)
}

async function passwordDigest(password: string): Promise<string> {
  // 哈希生成和密码校验共用同一个 scrypt 工作队列，避免低配 ARM 同时分配多份 scrypt 内存。
  return withLoginPasswordWork(async () => {
    const salt = randomBytes(16).toString('hex')
    const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })
    return `scrypt$16384$8$1$${salt}$${hash.toString('hex')}`
  })
}

function parsePasswordDigest(encoded: string): {
  n: number
  r: number
  p: number
  salt: string
  expectedHex: string
} | null {
  const parts = encoded.split('$')
  if (parts.length === 6 && parts[0] === 'scrypt') {
    const [, nText, rText, pText, salt, expectedHex] = parts
    const n = Number(nText)
    const r = Number(rText)
    const p = Number(pText)
    if (
      n === 16384
      && r === 8
      && p === 1
      && /^[a-f0-9]{32}$/i.test(salt ?? '')
      && /^[a-f0-9]{128}$/i.test(expectedHex ?? '')
    ) {
      return { n, r, p, salt: salt!, expectedHex: expectedHex! }
    }
    return null
  }

  // Compatibility for hashes generated by the short-lived malformed format:
  //   scrypt$16384$8$1<32-hex-salt><128-hex-hash>
  // No password material was lost; p was fixed to 1, so the fields can be recovered exactly.
  const legacy = encoded.match(/^scrypt\$(\d+)\$(\d+)\$1([a-f0-9]{32})([a-f0-9]{128})$/i)
  if (!legacy) return null
  const n = Number(legacy[1])
  const r = Number(legacy[2])
  if (n !== 16384 || r !== 8) return null
  return { n, r, p: 1, salt: legacy[3]!, expectedHex: legacy[4]! }
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordDigest(encoded)
  if (!parsed) return false
  const expected = Buffer.from(parsed.expectedHex, 'hex')
  try {
    const actual = await scryptAsync(password, parsed.salt, expected.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: 32 * 1024 * 1024,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

async function verifySharePasswordAttempt(token: string, passwordHash: string, password: string): Promise<{
  ok: boolean
  status: number
  retryAfter?: number
}> {
  if (!password) return { ok: false, status: 401 }
  if (password.length > 256) return { ok: false, status: 400 }

  return withLoginPasswordWork(async () => {
    const checkedAt = Date.now()
    const attempt = sharePasswordAttempts.get(token)
    if (attempt && checkedAt - attempt.lastFailAt < SHARE_PASSWORD_LOCK_MS && attempt.count >= SHARE_PASSWORD_MAX_ATTEMPTS) {
      return {
        ok: false,
        status: 429,
        retryAfter: Math.ceil((SHARE_PASSWORD_LOCK_MS - (checkedAt - attempt.lastFailAt)) / 1000),
      }
    }

    const ok = await verifyPassword(password, passwordHash)
    if (ok) {
      sharePasswordAttempts.delete(token)
      return { ok: true, status: 200 }
    }

    const failedAt = Date.now()
    const current = sharePasswordAttempts.get(token)
    const recentCount = current && failedAt - current.lastFailAt < SHARE_PASSWORD_LOCK_MS ? current.count : 0
    sharePasswordAttempts.set(token, { count: recentCount + 1, lastFailAt: failedAt })
    return { ok: false, status: 401 }
  })
}

function sendSharePasswordError(res: ServerResponse, result: { status: number; retryAfter?: number }): void {
  if (result.status === 429) {
    sendError(res, 429, '分享密码尝试过于频繁，请稍后再试', { retryAfter: result.retryAfter })
  } else if (result.status === 400) {
    sendError(res, 400, '分享密码过长')
  } else {
    sendError(res, 401, '分享密码错误')
  }
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
  return String(randomInt(100000, 1000000))
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
  if (validSessions.length !== sessions.length) {
    // 清理过期会话也属于 sessions.json 的 read-modify-write，必须进入认证事务锁。
    // 锁内重新读取，避免覆盖同时发生的登录、登出、重置密码或管理员删用户写入。
    void withAuthMutation(async () => {
      const current = await loadSessions(paths)
      const pruned = current.filter(session => session.expiresAt > Date.now())
      if (pruned.length !== current.length) await saveSessions(paths, pruned)
    }).catch(() => undefined)
  }
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

type ProjectAccessFailure = { ok: false; status: number; error: string }
type ProjectAccessSuccess<T> = { ok: true; value: T }

async function withCurrentProjectAccess<T>(
  paths: RuntimePaths,
  requestUser: StoredUser,
  project: StoredDocument,
  operation: (activeUser: StoredUser) => Promise<T>,
): Promise<ProjectAccessFailure | ProjectAccessSuccess<T>> {
  if (requestUser.id === 'guest') {
    if (!canManageProject(requestUser, project)) {
      return { ok: false, status: 403, error: '没有项目管理权限' }
    }
    return { ok: true, value: await operation(requestUser) }
  }

  return withAuthMutation(async () => {
    const activeUser = (await loadUsers(paths)).find(item => item.id === requestUser.id)
    if (!activeUser) return { ok: false as const, status: 401, error: '账号已不存在，请重新登录' }
    if (!canManageProject(activeUser, project)) {
      return { ok: false as const, status: 403, error: '当前账号已没有项目管理权限' }
    }
    return { ok: true as const, value: await operation(activeUser) }
  })
}

async function createSession(userId: string, paths: RuntimePaths, res: ServerResponse): Promise<void> {
  const token = randomBytes(32).toString('base64url')
  await withAuthMutation(async () => {
    const now = Date.now()
    const sessions = (await loadSessions(paths)).filter(session => session.expiresAt > now && session.userId !== userId)
    sessions.push({ token, userId, createdAt: now, expiresAt: now + SESSION_MAX_AGE * 1000 })
    await saveSessions(paths, sessions)
  })
  setSessionCookie(res, token)
}

async function removeSession(req: IncomingMessage, paths: RuntimePaths): Promise<void> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) return
  await withAuthMutation(async () => {
    const sessions = await loadSessions(paths)
    await saveSessions(paths, sessions.filter(session => session.token !== token))
  })
}

/** 遗留文档归属认领：仅需执行一次（用标记文件跳过），否则每次列表请求都要全量读盘解析 */
const LEGACY_CLAIM_MARKER = '.legacy-claimed'

let legacyClaimTail: Promise<void> = Promise.resolve()

async function withLegacyClaim<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const previous = legacyClaimTail
  legacyClaimTail = previous.catch(() => undefined).then(() => gate)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
  }
}

async function claimLegacyProjects(paths: RuntimePaths, userId: string): Promise<void> {
  // 多用户模式下，迁移前没有 ownerId 的旧画布只能归默认根管理员。
  // 普通用户先注册/登录时不得抢占历史数据。
  const claimant = (await loadUsers(paths)).find(user => user.id === userId)
  if (!claimant || claimant.email.toLowerCase() !== DEFAULT_ADMIN_EMAIL) return

  await withLegacyClaim(async () => {
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

    // 串行读取最新内容再落盘，避免两个首次请求同时认领同一历史画布。
    for (const file of files) {
      const fullPath = path.join(paths.dataDirectory, file)
      try {
        const project = JSON.parse(await fsp.readFile(fullPath, 'utf8')) as StoredDocument
        if (!project.ownerId && typeof project.id === 'string') {
          await writeJson(fullPath, { ...project, ownerId: userId })
        }
      } catch {
        // Leave malformed legacy files untouched.
      }
    }

    await fsp.writeFile(marker, String(Date.now()), 'utf8')
  })
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
  if (existing && existing.id !== id) throw new Error('Project ID mismatch')
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
    deletedAt: existing?.deletedAt,
  }
  await writeJson(projectPath(paths, id), project)
}

function forwardedHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value?.split(',')[0]
  const normalized = first?.trim()
  if (!normalized || !/^[A-Za-z0-9.:[\]-]+$/.test(normalized)) return undefined
  return normalized
}

function forwardedHeadersTrusted(req: IncomingMessage): boolean {
  if (/^(1|true|yes|on)$/i.test(process.env.FLOWBOARD_TRUST_PROXY ?? '')) return true
  const remote = req.socket.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function shareUrl(req: IncomingMessage, token: string): string {
  // 显式公网域名优先；同机反代自动信任 X-Forwarded-*。
  // 非回环代理必须显式 FLOWBOARD_TRUST_PROXY=true，避免直连客户端伪造分享域名。
  const configuredHost = process.env.FLOWBOARD_PUBLIC_HOST?.trim()
  const trustForwarded = forwardedHeadersTrusted(req)
  const forwardedHost = trustForwarded ? forwardedHeader(req.headers['x-forwarded-host']) : undefined
  const requestHost = forwardedHeader(req.headers.host)
  const fallbackHost = preferredPublicHost()
  const host = configuredHost || forwardedHost || requestHost || fallbackHost
  const forwardedProtocol = trustForwarded ? forwardedHeader(req.headers['x-forwarded-proto']) : undefined
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

  // 覆盖 TCP/TLS 建连以及后续 SMTP 命令等待；每次网络活动都会重置空闲计时。
  socket.setTimeout(SMTP_TIMEOUT_MS, () => {
    socket.destroy(new Error(`SMTP timeout after ${SMTP_TIMEOUT_MS} ms`))
  })

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
    const body = await readBody(req, AUTH_REQUEST_MAX_BYTES)
    const email = normalizeEmail(body.email)
    const purpose = body.purpose === undefined || body.purpose === 'register'
      ? 'register'
      : body.purpose === 'reset'
        ? 'reset'
        : null
    const inviteCode = normalizeInviteCode(body.inviteCode)
    if (!validEmail(email)) {
      sendError(res, 400, '请输入有效邮箱地址')
      return true
    }
    if (!purpose) {
      sendError(res, 400, '验证码用途必须是 register 或 reset')
      return true
    }

    const code = newVerificationCode()
    const codeHash = hashCode(code)
    const reservation = await withAuthMutation(async () => {
      const users = await loadUsers(paths)
      if (purpose === 'register' && users.some(user => user.email === email)) {
        return { ok: false as const, status: 409, error: '该邮箱已注册' }
      }
      if (purpose === 'reset' && !users.some(user => user.email === email)) {
        return { ok: false as const, status: 404, error: '该邮箱未注册' }
      }
      if (purpose === 'register' && email !== DEFAULT_ADMIN_EMAIL) {
        if (users.length >= DEFAULT_MAX_USERS) {
          return { ok: false as const, status: 403, error: `服务器已达到注册上限（${DEFAULT_MAX_USERS} 人），请联系管理员` }
        }
        const invite = (await loadInvites(paths)).find(item => item.code === inviteCode)
        if (!inviteIsUsable(invite)) {
          return { ok: false as const, status: 403, error: '邀请码无效、已停用或使用次数已耗尽' }
        }
      }

      const now = Date.now()
      const existingCodes = await loadVerificationCodes(paths)
      const previous = existingCodes.find(item => item.email === email && item.expiresAt > now)
      if (previous && now - previous.sentAt < VERIFICATION_RESEND_DELAY) {
        return {
          ok: false as const,
          status: 429,
          error: '验证码发送过于频繁',
          retryAfter: Math.ceil((VERIFICATION_RESEND_DELAY - now + previous.sentAt) / 1000),
        }
      }

      const codes = existingCodes.filter(item => item.email !== email && item.expiresAt > now)
      codes.push({ email, codeHash, createdAt: now, sentAt: now, expiresAt: now + VERIFICATION_TTL, attempts: 0 })
      await saveVerificationCodes(paths, codes)
      return { ok: true as const }
    })

    if (!reservation.ok) {
      sendError(res, reservation.status, reservation.error, reservation.retryAfter ? { retryAfter: reservation.retryAfter } : undefined)
      return true
    }

    let development = false
    try {
      development = await sendVerificationCode(email, code)
    } catch (error) {
      // 邮件发送失败时，仅撤回本次预留的验证码；如果期间已有更新记录则不误删。
      await withAuthMutation(async () => {
        const codes = await loadVerificationCodes(paths)
        const current = codes.find(item => item.email === email)
        if (current?.codeHash === codeHash) await saveVerificationCodes(paths, codes.filter(item => item.email !== email))
      }).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      await appendRuntimeLog(paths, { level: 'error', event: 'auth.verification_failed', message, details: { email } })
      if (message === 'SMTP is not configured') sendError(res, 503, '服务器尚未配置邮箱服务，请管理员设置 SMTP 配置')
      else sendError(res, 502, '验证码发送失败，请检查 SMTP 配置')
      return true
    }

    sendJson(res, 200, { ok: true, expiresIn: VERIFICATION_TTL / 1000, resendAfter: VERIFICATION_RESEND_DELAY / 1000, ...(development ? { developmentCode: code } : {}) })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const body = await readBody(req, AUTH_REQUEST_MAX_BYTES)
    const email = normalizeEmail(body.email)
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const inviteCode = normalizeInviteCode(body.inviteCode)
    if (!validEmail(email) || !/^\d{6}$/.test(code) || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      sendError(res, 400, `邮箱、6 位验证码和 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位密码均为必填项`)
      return true
    }
    // 先快速校验验证码，避免无效请求消耗 scrypt CPU；真正提交时会在全局认证锁内再次校验。
    const preliminaryNow = Date.now()
    const preliminaryCodes = await loadVerificationCodes(paths)
    const preliminaryRecord = preliminaryCodes.find(item => item.email === email)
    const preliminaryMatches = preliminaryRecord
      && preliminaryRecord.expiresAt > preliminaryNow
      && preliminaryRecord.attempts < MAX_VERIFICATION_ATTEMPTS
      && sameHash(preliminaryRecord.codeHash, hashCode(code))
    if (!preliminaryMatches) {
      const expectedHash = preliminaryRecord?.codeHash
      const stillInvalid = await withAuthMutation(async () => {
        const codes = await loadVerificationCodes(paths)
        const now = Date.now()
        const record = codes.find(item => item.email === email)
        const matches = record
          && record.expiresAt > now
          && record.attempts < MAX_VERIFICATION_ATTEMPTS
          && sameHash(record.codeHash, hashCode(code))
        if (matches) return false
        // 如果期间重新发送了验证码，旧请求不能消耗新验证码的失败次数。
        if (record && expectedHash && record.codeHash === expectedHash) {
          record.attempts += 1
          await saveVerificationCodes(paths, codes.filter(item => item.expiresAt > now && item.attempts < MAX_VERIFICATION_ATTEMPTS))
        }
        return true
      })
      if (stillInvalid) {
        sendError(res, 400, '验证码无效或已过期')
        return true
      }
    }

    const passwordHash = await passwordDigest(password)
    const registration = await withAuthMutation(async () => {
      const users = await loadUsers(paths)
      if (users.some(user => user.email === email)) {
        return { ok: false as const, status: 409, error: '该邮箱已注册' }
      }
      if (email !== DEFAULT_ADMIN_EMAIL && users.length >= DEFAULT_MAX_USERS) {
        return { ok: false as const, status: 403, error: `服务器已达到注册上限（${DEFAULT_MAX_USERS} 人），请联系管理员` }
      }

      const now = Date.now()
      const codes = await loadVerificationCodes(paths)
      const record = codes.find(item => item.email === email)
      const codeMatches = record
        && record.expiresAt > now
        && record.attempts < MAX_VERIFICATION_ATTEMPTS
        && sameHash(record.codeHash, hashCode(code))
      if (!codeMatches) {
        return { ok: false as const, status: 400, error: '验证码无效或已过期' }
      }

      let invites: StoredInvite[] = []
      let invite: StoredInvite | undefined
      if (email !== DEFAULT_ADMIN_EMAIL) {
        invites = await loadInvites(paths)
        invite = invites.find(item => item.code === inviteCode)
        if (!inviteIsUsable(invite)) {
          return { ok: false as const, status: 403, error: '邀请码无效、已停用或使用次数已耗尽' }
        }
      }

      const user: StoredUser = {
        id: newId('usr'),
        email,
        passwordHash,
        createdAt: now,
        verifiedAt: now,
        isAdmin: email === DEFAULT_ADMIN_EMAIL,
      }

      await saveUsers(paths, [...users, user])
      if (invite) {
        await saveInvites(paths, invites.map(item => item.code === invite.code
          ? { ...item, usedCount: item.usedCount + 1, lastUsedAt: now }
          : item))
      }
      await saveVerificationCodes(paths, codes.filter(item => item.email !== email))
      return { ok: true as const, user }
    })

    if (!registration.ok) {
      sendError(res, registration.status, registration.error)
      return true
    }

    const user = registration.user
    await claimLegacyProjects(paths, user.id)
    await createSession(user.id, paths, res)
    sendJson(res, 201, { user: authUser(user) })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    const body = await readBody(req, AUTH_REQUEST_MAX_BYTES)
    const email = normalizeEmail(body.email)
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!validEmail(email) || !/^\d{6}$/.test(code) || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      sendError(res, 400, `邮箱、6 位验证码和 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位新密码均为必填项`)
      return true
    }

    const preliminaryNow = Date.now()
    const preliminaryCodes = await loadVerificationCodes(paths)
    const preliminaryRecord = preliminaryCodes.find(item => item.email === email)
    const preliminaryMatches = preliminaryRecord
      && preliminaryRecord.expiresAt > preliminaryNow
      && preliminaryRecord.attempts < MAX_VERIFICATION_ATTEMPTS
      && sameHash(preliminaryRecord.codeHash, hashCode(code))
    if (!preliminaryMatches) {
      const expectedHash = preliminaryRecord?.codeHash
      const stillInvalid = await withAuthMutation(async () => {
        const codes = await loadVerificationCodes(paths)
        const now = Date.now()
        const record = codes.find(item => item.email === email)
        const matches = record
          && record.expiresAt > now
          && record.attempts < MAX_VERIFICATION_ATTEMPTS
          && sameHash(record.codeHash, hashCode(code))
        if (matches) return false
        // 如果期间重新发送了验证码，旧请求不能消耗新验证码的失败次数。
        if (record && expectedHash && record.codeHash === expectedHash) {
          record.attempts += 1
          await saveVerificationCodes(paths, codes.filter(item => item.expiresAt > now && item.attempts < MAX_VERIFICATION_ATTEMPTS))
        }
        return true
      })
      if (stillInvalid) {
        sendError(res, 400, '验证码无效或已过期')
        return true
      }
    }

    const passwordHash = await passwordDigest(password)
    const reset = await withAuthMutation(async () => {
      const users = await loadUsers(paths)
      const user = users.find(item => item.email === email)
      if (!user) return { ok: false as const, status: 404, error: '该邮箱未注册' }

      const now = Date.now()
      const codes = await loadVerificationCodes(paths)
      const record = codes.find(item => item.email === email)
      const codeMatches = record
        && record.expiresAt > now
        && record.attempts < MAX_VERIFICATION_ATTEMPTS
        && sameHash(record.codeHash, hashCode(code))
      if (!codeMatches) return { ok: false as const, status: 400, error: '验证码无效或已过期' }

      const updatedUser = { ...user, passwordHash }
      await saveUsers(paths, users.map(item => item.id === user.id ? updatedUser : item))
      await saveVerificationCodes(paths, codes.filter(item => item.email !== email))
      const sessions = await loadSessions(paths)
      await saveSessions(paths, sessions.filter(item => item.userId !== user.id))
      return { ok: true as const }
    })

    if (!reset.ok) {
      sendError(res, reset.status, reset.error)
      return true
    }
    clearSessionCookie(res)
    sendJson(res, 200, { ok: true })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req, AUTH_REQUEST_MAX_BYTES)
    const email = normalizeEmail(body.email)
    const password = typeof body.password === 'string' ? body.password : ''
    if (!validEmail(email) || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      sendError(res, 400, `请输入有效邮箱和 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位密码`)
      return true
    }

    // Snapdragon 400 这类低功耗机器不适合同时跑大量 scrypt。
    // 串行密码校验，并在每次真正执行 scrypt 前重新检查失败次数；
    // 一旦达到锁定阈值，后续排队请求直接 429，不再继续消耗 CPU。
    const login = await withLoginPasswordWork(async () => {
      const checkedAt = Date.now()
      const attempts = await loadLoginAttempts(paths)
      const attempt = attempts.find(item => item.email === email)
      if (attempt && checkedAt - attempt.lastFailAt < LOGIN_LOCK_MS && attempt.count >= LOGIN_MAX_ATTEMPTS) {
        const retryAfter = Math.ceil((LOGIN_LOCK_MS - (checkedAt - attempt.lastFailAt)) / 1000)
        return {
          ok: false as const,
          status: 429,
          error: `尝试过于频繁，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`,
          retryAfter,
        }
      }

      const userSnapshot = (await loadUsers(paths)).find(item => item.email === email)
      if (!userSnapshot) {
        // 不存在的随机邮箱不进入持久化失败计数，避免公网请求把 login-attempts.json 无限撑大。
        return {
          ok: false as const,
          status: 401,
          error: '邮箱或密码错误',
          retryAfter: undefined as number | undefined,
        }
      }

      const passwordMatches = await verifyPassword(password, userSnapshot.passwordHash)
      if (!passwordMatches) {
        return withAuthMutation(async () => {
          const failedAt = Date.now()
          const currentAttempts = await loadLoginAttempts(paths)
          const currentAttempt = currentAttempts.find(item => item.email === email)
          if (currentAttempt && failedAt - currentAttempt.lastFailAt < LOGIN_LOCK_MS && currentAttempt.count >= LOGIN_MAX_ATTEMPTS) {
            const retryAfter = Math.ceil((LOGIN_LOCK_MS - (failedAt - currentAttempt.lastFailAt)) / 1000)
            return {
              ok: false as const,
              status: 429,
              error: `尝试过于频繁，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`,
              retryAfter,
            }
          }

          const recentCount = currentAttempt && failedAt - currentAttempt.lastFailAt < LOGIN_LOCK_MS ? currentAttempt.count : 0
          const next = currentAttempts.filter(item => item.email !== email)
          next.push({ email, count: recentCount + 1, lastFailAt: failedAt })
          await saveLoginAttempts(paths, next)
          return {
            ok: false as const,
            status: 401,
            error: '邮箱或密码错误',
            retryAfter: undefined as number | undefined,
          }
        })
      }

      // 登录提交与密码重置共用认证锁，避免密码刚重置却又创建旧密码 Session。
      const sessionToken = randomBytes(32).toString('base64url')
      const committed = await withAuthMutation(async () => {
        const currentUsers = await loadUsers(paths)
        const currentUserRecord = currentUsers.find(item => item.id === userSnapshot.id && item.email === email)
        if (!currentUserRecord || currentUserRecord.passwordHash !== userSnapshot.passwordHash) {
          return {
            ok: false as const,
            status: 401,
            error: '邮箱或密码错误',
            retryAfter: undefined as number | undefined,
          }
        }

        const committedAt = Date.now()
        const currentAttempts = await loadLoginAttempts(paths)
        const currentAttempt = currentAttempts.find(item => item.email === email)
        if (currentAttempt && committedAt - currentAttempt.lastFailAt < LOGIN_LOCK_MS && currentAttempt.count >= LOGIN_MAX_ATTEMPTS) {
          const retryAfter = Math.ceil((LOGIN_LOCK_MS - (committedAt - currentAttempt.lastFailAt)) / 1000)
          return {
            ok: false as const,
            status: 429,
            error: `尝试过于频繁，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`,
            retryAfter,
          }
        }

        const updatedUser = { ...currentUserRecord, lastLoginAt: committedAt }
        await saveLoginAttempts(paths, currentAttempts.filter(item => item.email !== email))
        await saveUsers(paths, currentUsers.map(item => item.id === currentUserRecord.id ? updatedUser : item))

        const sessions = (await loadSessions(paths)).filter(session => session.expiresAt > committedAt && session.userId !== currentUserRecord.id)
        sessions.push({
          token: sessionToken,
          userId: currentUserRecord.id,
          createdAt: committedAt,
          expiresAt: committedAt + SESSION_MAX_AGE * 1000,
        })
        await saveSessions(paths, sessions)

        return {
          ok: true as const,
          user: updatedUser,
          sessionToken,
          retryAfter: undefined as number | undefined,
        }
      })
      return committed
    })

    if (!login.ok) {
      sendError(res, login.status, login.error, login.retryAfter !== undefined ? { retryAfter: login.retryAfter } : undefined)
      return true
    }

    setSessionCookie(res, login.sessionToken)
    await claimLegacyProjects(paths, login.user.id)
    sendJson(res, 200, { user: authUser(login.user) })
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
  // 分享密码只接受请求头，避免 ?password=... 进入浏览器历史、反代日志或 Referer。
  // 与登录共用 scrypt 串行队列，避免公开分享链接被并发撞库拖满低功耗 CPU。
  if (share.passwordHash) {
    const passwordHeader = req.headers['x-share-password']
    const password = Array.isArray(passwordHeader) ? (passwordHeader[0] ?? '') : (passwordHeader ?? '')
    const passwordResult = await verifySharePasswordAttempt(token, share.passwordHash, password)
    if (!passwordResult.ok) {
      sendSharePasswordError(res, passwordResult)
      return true
    }
  }
  const project = await readProject(paths, share.projectId)
  if (!project) {
    sendError(res, 404, '项目不存在')
    return true
  }
  if (project.deletedAt) {
    sendError(res, 410, '项目已进入回收站')
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
    if (body.id !== share.projectId) {
      sendError(res, 400, '项目 ID 不匹配')
      return true
    }
    const saved = await withShareMutation(token, async () => {
      const currentShare = (await loadShares(paths)).find(item => item.token === token)
      if (!currentShare) return { ok: false as const, status: 404, error: '分享链接不存在或已撤销' }
      if (currentShare.expiresAt !== undefined && currentShare.expiresAt <= Date.now()) {
        return { ok: false as const, status: 410, error: '分享链接已过期' }
      }
      if (currentShare.permission !== 'edit') {
        return { ok: false as const, status: 403, error: '此分享链接仅允许查看' }
      }
      // 分享权限/密码/有效期在请求期间发生变化时，要求客户端重新加载并重新鉴权。
      if (currentShare.updatedAt !== share.updatedAt || currentShare.passwordHash !== share.passwordHash) {
        return { ok: false as const, status: 409, error: '分享链接已更新，请重新加载后再保存' }
      }

      return withProjectMutation(currentShare.projectId, async () => {
        const latest = await readProject(paths, currentShare.projectId)
        if (!latest) return { ok: false as const, status: 404, error: '项目不存在' }
        if (latest.deletedAt) return { ok: false as const, status: 410, error: '项目已进入回收站' }
        await writeProject(paths, body, latest.ownerId ?? '', latest)
        return { ok: true as const, permission: currentShare.permission }
      })
    })
    if (!saved.ok) {
      sendError(res, saved.status, saved.error)
      return true
    }
    sendJson(res, 200, { ok: true, permission: saved.permission })
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
    // 正常登录用户可上传；匿名用户仅在持有有效的 edit 分享 token 时可上传。
    // edit token 本身已经允许修改对应项目，因此授予图片资源写入不会扩大其项目权限，
    // 同时避免完全匿名上传把低容量 eMMC 打满。
    const user = await currentUser(req, paths)
    if (!user) {
      const shareTokenHeader = req.headers['x-flowboard-share-token']
      const shareToken = Array.isArray(shareTokenHeader) ? shareTokenHeader[0] : shareTokenHeader
      const now = Date.now()
      const share = typeof shareToken === 'string' && shareToken
        ? (await loadShares(paths)).find(item =>
            item.token === shareToken
            && item.permission === 'edit'
            && (item.expiresAt === undefined || item.expiresAt > now))
        : undefined
      if (!share) {
        sendError(res, 401, '登录或有效的可编辑分享链接才能上传图片')
        return true
      }
      if (share.passwordHash) {
        const passwordHeader = req.headers['x-flowboard-share-password']
        const password = Array.isArray(passwordHeader) ? (passwordHeader[0] ?? '') : (passwordHeader ?? '')
        const passwordResult = await verifySharePasswordAttempt(share.token, share.passwordHash, password)
        if (!passwordResult.ok) {
          sendSharePasswordError(res, passwordResult)
          return true
        }
      }
    }
    const body = await readBody(req, MAX_ASSET_REQUEST_BYTES)
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
      const file = path.join(assetsDirectory(paths), name)
      const stat = await fsp.stat(file)
      if (!stat.isFile()) throw new Error('not a file')
      res.statusCode = 200
      res.setHeader('Content-Type', ASSET_MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream')
      res.setHeader('Content-Length', String(stat.size))
      // 内容寻址：内容变则 URL 变，可以放心长期强缓存
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      if (req.method === 'HEAD') {
        res.end()
      } else {
        const stream = createReadStream(file)
        stream.on('error', () => res.destroy())
        stream.pipe(res)
      }
    } catch {
      if (!res.headersSent) sendError(res, 404, '资源不存在')
      else res.destroy()
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
      // 创建版本快照。提交前重新读取最新项目，避免项目/用户删除后旧请求重建孤儿 versions 目录。
      const body = await readBody(req)
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : `版本 ${new Date().toLocaleString('zh-CN')}`
      const requestedContent = typeof body.content === 'string' ? body.content : undefined
      const created = await withProjectMutation(projectId, async () => {
        const latest = await readProject(paths, projectId)
        if (!latest) return { ok: false as const, status: 404, error: '文档不存在' }
        if (latest.deletedAt) return { ok: false as const, status: 410, error: '项目已进入回收站' }
        const access = await withCurrentProjectAccess(paths, user, latest, async () => {
          const content = requestedContent ?? JSON.stringify(projectCanvas(latest))
          const versionIdNew = newId('v')
          const version = { id: versionIdNew, name, content, createdAt: Date.now() }
          await fsp.mkdir(versionsDir, { recursive: true })
          await writeJson(path.join(versionsDir, `${versionIdNew}.json`), version)
          return version
        })
        if (!access.ok) return access
        return { ok: true as const, version: access.value }
      })
      if (!created.ok) { sendError(res, created.status, created.error); return true }
      sendJson(res, 201, { id: created.version.id, name: created.version.name, createdAt: created.version.createdAt })
      return true
    }

    // 恢复版本
    if (req.method === 'POST' && versionRestoreMatch) {
      const versionId = versionRestoreMatch[2]!
      const versionPath = path.join(versionsDir, `${versionId}.json`)
      let version: { content: string; name?: string }
      let canvas: unknown
      try {
        version = JSON.parse(await fsp.readFile(versionPath, 'utf8')) as { content: string; name?: string }
        if (typeof version.content !== 'string') throw new Error('invalid version content')
        canvas = JSON.parse(version.content)
      } catch {
        sendError(res, 404, '版本不存在或已损坏')
        return true
      }

      const result = await withProjectMutation(projectId, async () => {
        const latest = await readProject(paths, projectId)
        if (!latest) return { ok: false as const, status: 404, error: '文档不存在' }
        if (latest.deletedAt) return { ok: false as const, status: 410, error: '项目已进入回收站，请先恢复项目' }
        const access = await withCurrentProjectAccess(paths, user, latest, async () => {
          const restored: StoredDocument = { ...latest, canvas, updatedAt: Date.now() }
          await writeJson(projectPath(paths, projectId), restored)
        })
        if (!access.ok) return access
        return { ok: true as const }
      })
      if (!result.ok) {
        sendError(res, result.status, result.error)
        return true
      }
      sendJson(res, 200, { ok: true, name: version.name })
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
      const result = await withProjectMutation(id, async () => {
        const latest = await readProject(paths, id)
        if (!latest) return { ok: false as const, status: 404, error: '文档不存在' }
        if (!latest.deletedAt) return { ok: false as const, status: 400, error: '文档不在回收站中' }
        const access = await withCurrentProjectAccess(paths, user, latest, async () => {
          const restored: StoredDocument = { ...latest, deletedAt: undefined, updatedAt: Date.now() }
          await writeJson(projectPath(paths, id), restored)
        })
        if (!access.ok) return access
        return { ok: true as const }
      })
      if (!result.ok) { sendError(res, result.status, result.error); return true }
      sendJson(res, 200, { ok: true })
      return true
    }
    if (action === 'forever') {
      const result = await withProjectMutation(id, async () => {
        const latest = await readProject(paths, id)
        if (!latest) return { ok: false as const, status: 404, error: '文档不存在' }
        if (!latest.deletedAt) return { ok: false as const, status: 400, error: '文档不在回收站中' }
        const access = await withCurrentProjectAccess(paths, user, latest, async () => {
          await fsp.unlink(projectPath(paths, id))
          await fsp.rm(path.join(paths.dataDirectory, 'versions', id), { recursive: true, force: true })
        })
        if (!access.ok) return access
        return { ok: true as const }
      })
      if (!result.ok) { sendError(res, result.status, result.error); return true }
      await withAuthMutation(async () => {
        const shares = await loadShares(paths)
        await saveShares(paths, shares.filter(share => share.projectId !== id))
      })
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
    if (req.method === 'GET' && shareCollection) {
      const shares = await loadShares(paths)
      const now = Date.now()
      sendJson(res, 200, shares.filter(share => share.projectId === projectId).map(share => ({
        ...share,
        url: shareUrl(req, share.token),
        passwordHash: undefined,
        hasPassword: Boolean(share.passwordHash),
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
      // 可选有效期（小时）与访问密码。scrypt 在锁外完成，锁内只做最新数组的提交。
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
      const created = await withProjectMutation(projectId, async () => {
        const latest = await readProject(paths, projectId)
        if (!latest) return { ok: false as const, status: 404, error: '项目不存在' }
        if (latest.deletedAt) return { ok: false as const, status: 410, error: '项目已进入回收站' }
        const access = await withCurrentProjectAccess(paths, user, latest, async () => {
          const shares = await loadShares(paths)
          await saveShares(paths, [...shares, share])
        })
        if (!access.ok) return access
        return { ok: true as const }
      })
      if (!created.ok) { sendError(res, created.status, created.error); return true }
      sendJson(res, 201, {
        ...share,
        passwordHash: undefined,
        hasPassword: Boolean(share.passwordHash),
        expired: share.expiresAt !== undefined && share.expiresAt <= Date.now(),
        url: shareUrl(req, share.token),
      })
      return true
    }
    if (shareItem) {
      const token = shareItem[2]!
      if (req.method === 'PATCH') {
        const body = await readBody(req)
        const permission = permissionValue(body.permission)
        if (!permission) {
          sendError(res, 400, '权限必须是 view 或 edit')
          return true
        }
        const expiresInHours = Number(body.expiresInHours)
        const password = typeof body.password === 'string' ? body.password : ''
        let replacementPasswordHash: string | undefined
        if (password) {
          if (password.length < 4 || password.length > 64) {
            sendError(res, 400, '分享密码长度需在 4-64 位之间')
            return true
          }
          replacementPasswordHash = await passwordDigest(password)
        }

        const updateResult = await withShareMutation(token, () => withProjectMutation(projectId, async () => {
          const latest = await readProject(paths, projectId)
          if (!latest) return { ok: false as const, status: 404, error: '项目不存在' }
          if (latest.deletedAt) return { ok: false as const, status: 410, error: '项目已进入回收站' }

          const access = await withCurrentProjectAccess(paths, user, latest, async () => {
            const shares = await loadShares(paths)
            const share = shares.find(item => item.token === token && item.projectId === projectId)
            if (!share) return null

            const next: StoredShare = { ...share, permission, updatedAt: Date.now() }
            if (Number.isFinite(expiresInHours) && expiresInHours > 0) {
              next.expiresAt = Date.now() + Math.min(expiresInHours, 24 * 365) * 3600 * 1000
            } else if (body.clearExpires === true) {
              next.expiresAt = undefined
            }
            if (replacementPasswordHash) {
              next.passwordHash = replacementPasswordHash
            } else if (body.clearPassword === true) {
              next.passwordHash = undefined
            }

            await saveShares(paths, shares.map(item => item.token === token ? next : item))
            return next
          })
          if (!access.ok) return access
          if (!access.value) return { ok: false as const, status: 404, error: '分享链接不存在' }
          return { ok: true as const, share: access.value }
        }))
        if (!updateResult.ok) {
          sendError(res, updateResult.status, updateResult.error)
          return true
        }
        const updated = updateResult.share
        sendJson(res, 200, {
          ...updated,
          passwordHash: undefined,
          hasPassword: Boolean(updated.passwordHash),
          expired: updated.expiresAt !== undefined && updated.expiresAt <= Date.now(),
          url: shareUrl(req, token),
        })
        return true
      }
      if (req.method === 'DELETE') {
        const deleteResult = await withShareMutation(token, () => withProjectMutation(projectId, async () => {
          const latest = await readProject(paths, projectId)
          if (!latest) return { ok: false as const, status: 404, error: '项目不存在' }
          if (latest.deletedAt) return { ok: false as const, status: 410, error: '项目已进入回收站' }

          const access = await withCurrentProjectAccess(paths, user, latest, async () => {
            const shares = await loadShares(paths)
            if (!shares.some(item => item.token === token && item.projectId === projectId)) return false
            await saveShares(paths, shares.filter(item => item.token !== token))
            return true
          })
          if (!access.ok) return access
          if (!access.value) return { ok: false as const, status: 404, error: '分享链接不存在' }
          return { ok: true as const }
        }))
        if (!deleteResult.ok) {
          sendError(res, deleteResult.status, deleteResult.error)
          return true
        }
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
  if (req.method === 'PUT') {
    const body = await readBody(req)
    if (body.id !== id) {
      sendError(res, 400, '项目 ID 与请求路径不匹配')
      return true
    }
    const result = await withProjectMutation(id, async () => {
      const latest = await readProject(paths, id)
      if (latest?.deletedAt) {
        return { ok: false as const, status: 410, error: '项目已进入回收站，请先恢复' }
      }
      if (latest) {
        const access = await withCurrentProjectAccess(paths, user, latest, async (activeUser) => {
          await writeProject(paths, body, activeUser.id, latest)
        })
        if (!access.ok) return access
        return { ok: true as const }
      }

      if (!latest && user.id !== 'guest') {
        // 新建项目时把“账号仍存在”检查与首次文件落盘放进同一认证事务。
        // 避免管理员删除用户后，已通过早期鉴权的旧请求又创建出无主项目。
        return withAuthMutation(async () => {
          const activeUser = (await loadUsers(paths)).find(item => item.id === user.id)
          if (!activeUser) return { ok: false as const, status: 401, error: '账号已不存在，请重新登录' }
          await writeProject(paths, body, activeUser.id)
          return { ok: true as const }
        })
      }

      await writeProject(paths, body, user.id)
      return { ok: true as const }
    })
    if (!result.ok) { sendError(res, result.status, result.error); return true }
    sendJson(res, 200, { ok: true })
    return true
  }
  const project = await readProject(paths, id)
  if (!project) {
    sendError(res, 404, '项目不存在')
    return true
  }
  if (!canManageProject(user, project)) {
    sendError(res, 403, '没有项目访问权限')
    return true
  }
  if (req.method === 'GET') {
    if (project.deletedAt) {
      sendError(res, 410, '项目已进入回收站，请先恢复')
      return true
    }
    sendJson(res, 200, projectResponse(project, 'owner'))
    return true
  }
  if (req.method === 'DELETE') {
    if (project.deletedAt) {
      sendError(res, 400, '项目已经在回收站中')
      return true
    }
    // 软删除：标记 deletedAt 进入回收站，不直接删文件。
    const result = await withProjectMutation(id, async () => {
      const latest = await readProject(paths, id)
      if (!latest) return { ok: false as const, status: 404, error: '项目不存在' }
      const access = await withCurrentProjectAccess(paths, user, latest, async () => {
        const now = Date.now()
        const updated: StoredDocument = { ...latest, deletedAt: now, updatedAt: now }
        await writeJson(projectPath(paths, id), updated)
      })
      if (!access.ok) return access
      return { ok: true as const }
    })
    if (!result.ok) { sendError(res, result.status, result.error); return true }
    // 删除相关分享链接。shares.json 的 read-modify-write 必须与创建/修改分享串行。
    await withAuthMutation(async () => {
      const shares = await loadShares(paths)
      await saveShares(paths, shares.filter(share => share.projectId !== id))
    })
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
    const user = await requireUser(req, res, paths)
    if (!user) return true
    await appendRuntimeLog(paths, await readBody(req, MAX_LOG_REQUEST_BYTES) as ClientLog)
    sendJson(res, 200, { ok: true })
    return true
  }
  if (req.method === 'GET' && pathname === '/api/logs/latest') {
    const user = await requireUser(req, res, paths)
    if (!user) return true
    if (user.id === 'guest' || user.isAdmin !== true) {
      sendError(res, 403, '仅管理员可查看服务器日志')
      return true
    }
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
  workspace?: { x: number; y: number; w: number; h: number }
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

  // 与前端 normalizeCanvasDocument 的旧数据兼容规则保持一致：
  // 某些旧画布只在 shape.groupId 记录分组关系，却漏写 group.childIds。
  const includedGroups = new Set(groupIds)
  for (const [shapeId, shape] of Object.entries(shapes)) {
    if (typeof shape.groupId === 'string' && includedGroups.has(shape.groupId)) shapeIds.push(shapeId)
  }
  return { groupIds, shapeIds: [...new Set(shapeIds)] }
}

function expandCanvasWorkspace(canvas: CanvasGraph, shape: Record<string, unknown>): void {
  if (typeof shape.x !== 'number' || typeof shape.y !== 'number' || typeof shape.w !== 'number' || typeof shape.h !== 'number') return
  const current = canvas.workspace
  const workspace = current
    && Number.isFinite(current.x) && Number.isFinite(current.y)
    && Number.isFinite(current.w) && Number.isFinite(current.h)
    && current.w > 0 && current.h > 0
      ? current
      : { x: 0, y: 0, w: 1200, h: 800 }
  const padding = 50
  const right = Math.max(workspace.x + workspace.w, Math.ceil(shape.x + Math.max(0, shape.w) + padding))
  const bottom = Math.max(workspace.y + workspace.h, Math.ceil(shape.y + Math.max(0, shape.h) + padding))
  const x = Math.min(workspace.x, Math.floor(shape.x - padding))
  const y = Math.min(workspace.y, Math.floor(shape.y - padding))
  canvas.workspace = { x, y, w: right - x, h: bottom - y }
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
    const childIds = (Array.isArray(original.childIds) ? original.childIds : [])
      .map(id => idMap.get(id))
      .filter((id): id is string => Boolean(id))

    // 旧数据中可能只有 shape.groupId，没有写进 group.childIds；把这些直接子图形补进新组。
    for (const [shapeId, shape] of Object.entries(sourceShapes)) {
      if (shape.groupId === sourceId) {
        const mappedShapeId = idMap.get(shapeId)
        if (mappedShapeId && !childIds.includes(mappedShapeId)) childIds.push(mappedShapeId)
      }
    }
    cloned.childIds = childIds
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
    expandCanvasWorkspace(target, cloned)
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
  if (user.id === 'guest') {
    sendError(res, 403, '游客模式没有管理员权限')
    return true
  }
  const users = await loadUsers(paths)
  const admin = users.find(item => item.id === user.id && item.isAdmin === true)
  if (!admin) {
    sendError(res, 403, '需要管理员权限')
    return true
  }
  const isRootAdmin = admin.email.toLowerCase() === DEFAULT_ADMIN_EMAIL
  if ((pathname === '/api/admin/backup' || pathname === '/api/admin/restore') && !isRootAdmin) {
    sendError(res, 403, '只有默认根管理员可以备份或恢复整机数据')
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
    const result = await withAuthMutation(async () => {
      const currentUsers = await loadUsers(paths)
      const target = currentUsers.find(item => item.id === targetId)
      if (!target) return { ok: false as const, status: 404, error: '用户不存在' }
      if (body.isAdmin === false && (target.email.toLowerCase() === DEFAULT_ADMIN_EMAIL || target.id === user.id)) {
        return { ok: false as const, status: 400, error: '不能取消默认根管理员或当前登录管理员自己的管理员权限' }
      }
      if (typeof body.isAdmin === 'boolean') target.isAdmin = body.isAdmin
      await saveUsers(paths, currentUsers)
      return { ok: true as const, target }
    })
    if (!result.ok) { sendError(res, result.status, result.error); return true }
    sendJson(res, 200, { user: authUser(result.target) })
    return true
  }

  if (adminUserMatch && req.method === 'DELETE') {
    const targetId = adminUserMatch[1]!
    const removal = await withAuthMutation(async () => {
      const currentUsers = await loadUsers(paths)
      const target = currentUsers.find(item => item.id === targetId)
      if (!target) return { ok: false as const, status: 404, error: '用户不存在' }
      if (target.email.toLowerCase() === DEFAULT_ADMIN_EMAIL || target.id === user.id) {
        return { ok: false as const, status: 400, error: '不能删除当前管理员或默认根管理员' }
      }
      await saveUsers(paths, currentUsers.filter(item => item.id !== target.id))
      const sessions = await loadSessions(paths)
      await saveSessions(paths, sessions.filter(item => item.userId !== target.id))
      return { ok: true as const, target }
    })
    if (!removal.ok) { sendError(res, removal.status, removal.error); return true }

    let files: string[] = []
    try { files = (await fsp.readdir(paths.dataDirectory)).filter(file => file.endsWith('.json')) } catch { /* empty */ }
    let deletedDocs = 0
    const deletedDocIds = new Set<string>()
    for (const file of files) {
      const fullPath = path.join(paths.dataDirectory, file)
      const fileProjectId = file.slice(0, -5)
      if (!validProjectId(fileProjectId)) continue
      try {
        const deleted = await withProjectMutation(fileProjectId, async () => {
          const project = JSON.parse(await fsp.readFile(fullPath, 'utf8')) as StoredDocument
          if (project.ownerId !== removal.target.id) return null
          await fsp.unlink(fullPath)
          if (project.id === fileProjectId) {
            await fsp.rm(path.join(paths.dataDirectory, 'versions', fileProjectId), { recursive: true, force: true })
          }
          return typeof project.id === 'string' ? project.id : fileProjectId
        })
        if (deleted) {
          deletedDocIds.add(deleted)
          deletedDocs++
        }
      } catch { /* 文件已被其他合法操作移除或损坏则跳过 */ }
    }
    if (deletedDocIds.size > 0) {
      await withAuthMutation(async () => {
        const shares = await loadShares(paths)
        await saveShares(paths, shares.filter(share => !deletedDocIds.has(share.projectId)))
      })
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
    const invite = await withAuthMutation(async () => {
      const invites = await loadInvites(paths)
      let code = newInviteCode()
      while (invites.some(item => item.code === code)) code = newInviteCode()
      const created: StoredInvite = { code, createdAt: Date.now(), createdBy: user.id, maxUses, usedCount: 0 }
      await saveInvites(paths, [created, ...invites])
      return created
    })
    sendJson(res, 201, invite)
    return true
  }
  const inviteMatch = pathname.match(/^\/api\/admin\/invites\/([A-Z0-9]+)$/)
  if (inviteMatch && req.method === 'DELETE') {
    const code = inviteMatch[1]!
    const disabled = await withAuthMutation(async () => {
      const invites = await loadInvites(paths)
      if (!invites.some(item => item.code === code)) return false
      await saveInvites(paths, invites.map(item => item.code === code ? { ...item, disabled: true } : item))
      return true
    })
    if (!disabled) { sendError(res, 404, '邀请码不存在'); return true }
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
        if (typeof project.id !== 'string' || !project.id || project.deletedAt) return null
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
    const source = await readProject(paths, sourceDocId)
    if (!source) { sendError(res, 404, '源文档不存在'); return true }
    if (source.deletedAt) { sendError(res, 410, '源画布已进入回收站'); return true }
    const copied = await withProjectMutation(targetDocId, async () => {
      const target = await readProject(paths, targetDocId)
      if (!target) return { ok: false as const, status: 404, error: '目标文档不存在' }
      if (target.deletedAt) return { ok: false as const, status: 410, error: '目标画布已进入回收站' }
      if (target.ownerId !== user.id) {
        return { ok: false as const, status: 403, error: '目标画布必须属于当前管理员账号' }
      }
      const targetCanvas = canvasGraph(target)
      const result = cloneGroupIntoCanvas(canvasGraph(source), targetCanvas, groupId)
      if (!result) return { ok: false as const, status: 404, error: '源分组不存在' }
      await writeJson(projectPath(paths, target.id), { ...target, canvas: targetCanvas, updatedAt: Date.now() } satisfies StoredDocument)
      return { ok: true as const, ...result, targetDocId: target.id }
    })
    if (!copied.ok) { sendError(res, copied.status, copied.error); return true }
    sendJson(res, 201, copied)
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
    if (source.deletedAt) {
      sendError(res, 410, '源画布已进入回收站')
      return true
    }
    const now = Date.now()
    const copy: StoredDocument = {
      ...source,
      id: newId('doc'),
      title: `${source.title}（副本）`,
      ownerId: user.id,
      createdAt: now,
      updatedAt: now,
      deletedAt: undefined,
    }
    await writeProject(paths, copy as unknown as Record<string, unknown>, user.id)
    sendJson(res, 201, { ok: true, id: copy.id, title: copy.title })
    return true
  }

  // GET /api/admin/backup —— 导出可完整恢复的 .json.gz 备份。
  // Web 备份受低内存门禁保护；大型资源库应直接备份 /opt/flowboard 数据目录。
  if (req.method === 'GET' && pathname === '/api/admin/backup') {
    const dataFiles = await fsp.readdir(paths.dataDirectory).catch(() => [] as string[])
    const authFiles = await fsp.readdir(paths.authDirectory).catch(() => [] as string[])
    const durableAuthFiles = new Set(['users.json', 'invites.json', 'shares.json'])
    const payload: Record<string, unknown> = {
      meta: {
        app: 'FlowBoard',
        backupAt: new Date().toISOString(),
        formatVersion: 3,
        includesAssets: true,
        includesVersions: true,
      },
      data: {} as Record<string, unknown>,
      versions: {} as Record<string, unknown>,
      assets: {} as Record<string, string>,
      auth: {} as Record<string, unknown>,
    }
    const data = payload.data as Record<string, unknown>
    const versions = payload.versions as Record<string, unknown>
    const assets = payload.assets as Record<string, string>
    const auth = payload.auth as Record<string, unknown>

    let documentBytes = 0
    for (const file of dataFiles.filter(file => /^[a-zA-Z0-9_-]+\.json$/.test(file))) {
      const fullPath = path.join(paths.dataDirectory, file)
      try {
        documentBytes += (await fsp.stat(fullPath)).size
        if (documentBytes > MAX_WEB_BACKUP_DOCUMENT_BYTES) {
          sendError(res, 413, '项目与版本历史总量超过 Web 备份安全上限，请直接备份 /opt/flowboard/project-data、auth-data 和 flowboard.env', {
            documentBytes,
            maxDocumentBytes: MAX_WEB_BACKUP_DOCUMENT_BYTES,
          })
          return true
        }
        data[file] = JSON.parse(await fsp.readFile(fullPath, 'utf8'))
      } catch (error) {
        if (error instanceof RequestBodyError) throw error
        // 文件并发消失或损坏则跳过；完整性问题由管理员后续检查。
      }
    }

    const versionsRoot = path.join(paths.dataDirectory, 'versions')
    for (const projectId of await fsp.readdir(versionsRoot).catch(() => [] as string[])) {
      if (!validProjectId(projectId)) continue
      const projectVersions = path.join(versionsRoot, projectId)
      for (const file of await fsp.readdir(projectVersions).catch(() => [] as string[])) {
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) continue
        try {
          const fullPath = path.join(projectVersions, file)
          documentBytes += (await fsp.stat(fullPath)).size
          if (documentBytes > MAX_WEB_BACKUP_DOCUMENT_BYTES) {
            sendError(res, 413, '项目与版本历史总量超过 Web 备份安全上限，请直接备份 /opt/flowboard/project-data、auth-data 和 flowboard.env', {
              documentBytes,
              maxDocumentBytes: MAX_WEB_BACKUP_DOCUMENT_BYTES,
            })
            return true
          }
          versions[`${projectId}/${file}`] = JSON.parse(await fsp.readFile(fullPath, 'utf8'))
        } catch (error) {
          if (error instanceof RequestBodyError) throw error
          // skip malformed/disappearing version
        }
      }
    }

    const assetNames = (await fsp.readdir(assetsDirectory(paths)).catch(() => [] as string[])).filter(name => ASSET_FILE_PATTERN.test(name))
    let assetBytes = 0
    for (const name of assetNames) {
      try {
        assetBytes += (await fsp.stat(path.join(assetsDirectory(paths), name))).size
      } catch { /* skip missing file */ }
      if (assetBytes > MAX_WEB_BACKUP_ASSET_BYTES) {
        sendError(res, 413, '外置图片总量超过 Web 备份安全上限，请直接备份 /opt/flowboard/project-data、auth-data 和 flowboard.env', {
          assetBytes,
          maxAssetBytes: MAX_WEB_BACKUP_ASSET_BYTES,
        })
        return true
      }
    }
    for (const name of assetNames) {
      try { assets[name] = (await fsp.readFile(path.join(assetsDirectory(paths), name))).toString('base64') } catch { /* skip */ }
    }

    for (const file of authFiles.filter(file => durableAuthFiles.has(file))) {
      try { auth[file] = JSON.parse(await fsp.readFile(path.join(paths.authDirectory, file), 'utf8')) } catch { /* skip */ }
    }

    const payloadJson = JSON.stringify(payload)
    const payloadBytes = Buffer.byteLength(payloadJson, 'utf8')
    if (payloadBytes > MAX_RESTORE_JSON_BYTES) {
      sendError(res, 413, 'Web 备份展开后超过 Web 恢复安全上限，请改用文件系统备份', {
        payloadBytes,
        maxPayloadBytes: MAX_RESTORE_JSON_BYTES,
      })
      return true
    }

    // 图片已经是 WebP/PNG/JPEG 等压缩格式；level=1 降低老 ARM CPU 负担。
    const compressed = gzipSync(Buffer.from(payloadJson, 'utf8'), { level: 1 })
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/gzip')
    res.setHeader('Content-Disposition', `attachment; filename="flowboard-backup-${new Date().toISOString().slice(0, 10)}.json.gz"`)
    res.end(compressed)
    return true
  }

  // POST /api/admin/restore —— 从备份恢复（body 为 gzip 压缩的 JSON 或纯 JSON）
  if (req.method === 'POST' && pathname === '/api/admin/restore') {
    const body = await readBodyRaw(req, MAX_RESTORE_ARCHIVE_BYTES)
    let text: string
    const isGzip = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b
    if (isGzip) {
      try {
        text = gunzipSync(body, { maxOutputLength: MAX_RESTORE_JSON_BYTES }).toString('utf8')
      } catch {
        sendError(res, 400, `备份 gzip 已损坏或解压后超过 ${Math.ceil(MAX_RESTORE_JSON_BYTES / 1024 / 1024)} MiB`)
        return true
      }
    } else {
      text = body.toString('utf8')
    }
    let payload: {
      data?: Record<string, unknown>
      versions?: Record<string, unknown>
      assets?: Record<string, unknown>
      auth?: Record<string, unknown>
    }
    try {
      payload = JSON.parse(text)
    } catch {
      sendError(res, 400, '备份文件格式无效')
      return true
    }
    // 第一阶段：只解析与校验，不写盘。坏备份必须在任何持久化修改前失败。
    const stagedProjects: Array<{ projectId: string; file: string; content: Record<string, unknown> }> = []
    const stagedVersions: Array<{ projectId: string; file: string; content: Record<string, unknown> }> = []
    const stagedAssets: Array<{ name: string; buffer: Buffer }> = []
    let stagedUsers: StoredUser[] | undefined
    let stagedInvites: StoredInvite[] | undefined
    let stagedShares: StoredShare[] | undefined

    if (payload.data !== undefined) {
      if (!isRecord(payload.data)) throw new RequestBodyError('备份中的 data 格式无效')
      for (const [file, content] of Object.entries(payload.data)) {
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) throw new RequestBodyError(`备份中的项目文件名无效: ${file}`)
        const projectId = file.slice(0, -5)
        if (!isRecord(content)
          || content.id !== projectId
          || typeof content.title !== 'string' || !content.title.trim()
          || !isFiniteNumber(content.createdAt) || !isFiniteNumber(content.updatedAt)
          || (content.ownerId !== undefined && typeof content.ownerId !== 'string')
          || (content.deletedAt !== undefined && !isFiniteNumber(content.deletedAt))) {
          throw new RequestBodyError(`备份中的项目文件格式无效: ${file}`)
        }
        stagedProjects.push({ projectId, file, content })
      }
    }

    if (payload.versions !== undefined) {
      if (!isRecord(payload.versions)) throw new RequestBodyError('备份中的 versions 格式无效')
      for (const [relativePath, content] of Object.entries(payload.versions)) {
        const match = relativePath.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+\.json)$/)
        if (!match) throw new RequestBodyError(`备份中的版本路径无效: ${relativePath}`)
        const projectId = match[1]!
        const file = match[2]!
        const versionId = file.slice(0, -5)
        if (!isRecord(content)
          || content.id !== versionId
          || typeof content.content !== 'string'
          || !isFiniteNumber(content.createdAt)
          || (content.name !== undefined && typeof content.name !== 'string')) {
          throw new RequestBodyError(`备份中的版本文件格式无效: ${relativePath}`)
        }
        stagedVersions.push({ projectId, file, content })
      }
    }

    if (payload.assets !== undefined) {
      if (!isRecord(payload.assets)) throw new RequestBodyError('备份中的 assets 格式无效')
      let restoredAssetBytes = 0
      for (const [name, encoded] of Object.entries(payload.assets)) {
        if (!ASSET_FILE_PATTERN.test(name) || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
          throw new RequestBodyError(`备份中的图片资源格式无效: ${name}`)
        }
        const buffer = Buffer.from(encoded, 'base64')
        if (buffer.length === 0 || buffer.length > MAX_ASSET_BYTES) {
          throw new RequestBodyError(`备份中的图片资源大小无效: ${name}`)
        }
        restoredAssetBytes += buffer.length
        if (restoredAssetBytes > MAX_WEB_BACKUP_ASSET_BYTES) {
          throw new RequestBodyError('备份中的图片总量超过 Web 恢复安全上限', 413)
        }
        const extension = name.split('.').pop() ?? ''
        const expectedName = `${createHash('sha256').update(buffer).digest('hex').slice(0, 40)}.${extension}`
        if (expectedName !== name) throw new RequestBodyError(`备份图片哈希不匹配: ${name}`)
        stagedAssets.push({ name, buffer })
      }
    }

    if (payload.auth !== undefined) {
      if (!isRecord(payload.auth)) throw new RequestBodyError('备份中的 auth 格式无效')
      if (payload.auth['users.json'] !== undefined) {
        stagedUsers = validateRestoredUsers(payload.auth['users.json'])
        if (stagedUsers.length > DEFAULT_MAX_USERS) {
          throw new RequestBodyError(
            `备份用户数（${stagedUsers.length}）超过当前服务器上限（${DEFAULT_MAX_USERS}）`,
            413,
          )
        }
      }
      if (payload.auth['invites.json'] !== undefined) stagedInvites = validateRestoredInvites(payload.auth['invites.json'])
      if (payload.auth['shares.json'] !== undefined) stagedShares = validateRestoredShares(payload.auth['shares.json'])
    }

    // 第二阶段：所有备份内容已验证后才开始写盘。
    let restored = 0
    for (const item of stagedProjects) {
      await withProjectMutation(item.projectId, () => writeJson(path.join(paths.dataDirectory, item.file), item.content))
      restored++
    }
    for (const item of stagedVersions) {
      await withProjectMutation(item.projectId, () =>
        writeJson(path.join(paths.dataDirectory, 'versions', item.projectId, item.file), item.content))
      restored++
    }

    if (stagedAssets.length > 0) {
      const directory = assetsDirectory(paths)
      await fsp.mkdir(directory, { recursive: true })
      await withAssetStorageMutation(directory, async () => {
        let used = await assetStorageUsage(directory)
        for (const item of stagedAssets) {
          const target = path.join(directory, item.name)
          try {
            await fsp.access(target)
          } catch {
            if (used + item.buffer.length > MAX_ASSET_STORAGE_BYTES) {
              throw new RequestBodyError(
                `恢复后图片资源库将超过容量上限（${MAX_ASSET_STORAGE_MB} MiB）`,
                507,
              )
            }
            await writeBufferAtomic(target, item.buffer)
            used += item.buffer.length
            restored++
          }
        }
        assetStorageUsageCache.set(directory, used)
      })
    }

    const canResumeAdminSession = await withAuthMutation(async () => {
      const currentUsers = await loadUsers(paths)
      const currentRoot = currentUsers.find(item => item.email.toLowerCase() === DEFAULT_ADMIN_EMAIL)

      if (stagedUsers) {
        const restoredUsers = stagedUsers.map(item =>
          item.email === DEFAULT_ADMIN_EMAIL ? { ...item, isAdmin: true } : item)
        const hasRoot = restoredUsers.some(item => item.email === DEFAULT_ADMIN_EMAIL)
        if (!hasRoot && currentRoot) restoredUsers.push({ ...currentRoot, isAdmin: true })
        await writeJson(path.join(paths.authDirectory, 'users.json'), restoredUsers)
        restored++
      }
      if (stagedInvites) {
        await writeJson(path.join(paths.authDirectory, 'invites.json'), stagedInvites)
        restored++
      }
      if (stagedShares) {
        await writeJson(path.join(paths.authDirectory, 'shares.json'), stagedShares)
        restored++
      }

      // 恢复完成后统一撤销所有旧会话和一次性认证状态。
      await saveSessions(paths, [])
      await saveVerificationCodes(paths, [])
      await saveLoginAttempts(paths, [])

      const restoredUsers = await loadUsers(paths)
      return restoredUsers.some(item => item.id === user.id && item.isAdmin === true)
    })

    if (canResumeAdminSession) await createSession(user.id, paths, res)
    else clearSessionCookie(res)
    sendJson(res, 200, {
      ok: true,
      restored,
      sessionsRevoked: true,
      reauthRequired: !canResumeAdminSession,
    })
    return true
  }

  return false
}

async function handleSettings(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, pathname: string): Promise<boolean> {
  if (pathname !== '/api/settings' && pathname !== '/api/settings/smtp-test') return false
  // SMTP 授权码属于整机机密，仅默认根管理员可修改或测试。
  const user = await requireUser(req, res, paths)
  if (!user) return true
  if (user.id === 'guest' || user.email.toLowerCase() !== DEFAULT_ADMIN_EMAIL) {
    sendError(res, 403, '只有默认根管理员可以管理服务器 SMTP 配置')
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
      const smtpKeys = new Set(values.map(([key]) => key))
      let existingLines: string[] = []
      try {
        existingLines = (await fsp.readFile(envFile, 'utf8')).split(/\r?\n/)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }

      // 只替换 SMTP 项，保留监听地址、NODE_OPTIONS、用户上限、根管理员等其他运行配置。
      const preservedLines = existingLines.filter(line => {
        const cmdMatch = line.match(/^\s*set\s+"(FLOWBOARD_[^=]+)=/i)
        const envMatch = line.match(/^\s*(FLOWBOARD_[A-Z0-9_]+)\s*=/i)
        const key = cmdMatch?.[1] ?? envMatch?.[1]
        return !key || !smtpKeys.has(key)
      })
      while (preservedLines.length > 0 && preservedLines[preservedLines.length - 1]?.trim() === '') preservedLines.pop()

      let text: string
      if (process.platform === 'win32') {
        if (!preservedLines.some(line => /^\s*@echo\s+off\s*$/i.test(line))) preservedLines.unshift('@echo off')
        text = [...preservedLines, ...values.filter(([, value]) => Boolean(value)).map(([key, value]) => `set "${key}=${value}"`)].join('\r\n') + '\r\n'
      } else {
        const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
        text = [...preservedLines, ...values.filter(([, value]) => Boolean(value)).map(([key, value]) => `${key}=${quote(String(value))}`)].join('\n') + '\n'
      }

      const temporary = `${envFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await fsp.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
        await fsp.rename(temporary, envFile)
        if (process.platform !== 'win32') await fsp.chmod(envFile, 0o600)
      } finally {
        await fsp.rm(temporary, { force: true }).catch(() => undefined)
      }
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
      const base = {
        status: 'ok',
        app: 'FlowBoard',
        version: typeof (process.env as Record<string, string | undefined>).FLOWBOARD_VERSION === 'string'
          ? (process.env as Record<string, string | undefined>).FLOWBOARD_VERSION
          : 'dev-build',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      }
      // 公网健康检查只需要基础状态；局域网地址属于服务器内部信息，仅登录用户可见。
      const healthUser = await currentUser(req, paths)
      if (!healthUser) {
        sendJson(res, 200, base)
        return true
      }
      const lanAddresses = detectLanIPv4Addresses()
      const publicHost = preferredPublicHost()
      const port = Number(process.env.FLOWBOARD_PORT ?? '3000')
      const localUrl = `http://127.0.0.1:${port}`
      const urls: string[] = []
      if (publicHost !== 'localhost') urls.push(`http://${publicHost}:${port}`)
      else if (lanAddresses.length > 0) urls.push(...lanAddresses.map(address => `http://${address}:${port}`))
      urls.push(localUrl)
      sendJson(res, 200, { ...base, urls: [...new Set(urls)], lanAddresses })
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
  const cutoff = Date.now() - ASSET_GC_MIN_AGE_MS

  return withAssetStorageMutation(directory, async () => {
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
        const file = path.join(directory, name)
        const stat = await fsp.stat(file)
        // 上传与项目自动保存不是一个事务。给新资源留一小时宽限期，
        // 避免图片刚上传、项目引用还没落盘时被 GC 当成孤儿误删。
        if (stat.mtimeMs > cutoff) {
          result.kept++
          continue
        }
        await fsp.unlink(file)
        result.removed++
        result.bytesFreed += stat.size
      } catch { /* 跳过 */ }
    }

    assetStorageUsageCache.delete(directory)
    return result
  })
}