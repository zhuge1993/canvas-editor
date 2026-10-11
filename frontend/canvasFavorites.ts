import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RuntimePaths, StoredDocument } from './runtimeCore.js'

export const CANVAS_FAVORITES_FILE = 'canvas-favorites.json'
const MAX_FAVORITES_PER_USER = 200
const MAX_FAVORITES = 10000
const MAX_STORE_BYTES = 4 * 1024 * 1024
const ID = /^[A-Za-z0-9_-]{1,120}$/
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/
const FAVORITE_ID = /^fav_[a-f0-9]{24}$/
interface Favorite {
  id: string; userId: string; shareToken: string; grantFingerprint: string; createdAt: number
}
export interface CanvasFavoriteStore { schemaVersion: 1; favorites: Favorite[] }
interface Share {
  token: string; projectId: string; permission: 'view' | 'edit'; createdAt: number; updatedAt: number
  passwordHash?: string; expiresAt?: number
}
interface User { id: string; email: string }
interface Services {
  currentUser(req: IncomingMessage, paths: RuntimePaths): Promise<User | null>
  loadUsers(paths: RuntimePaths): Promise<User[]>
  loadShares(paths: RuntimePaths): Promise<Share[]>
  readProject(paths: RuntimePaths, id: string): Promise<StoredDocument | null>
  readBody(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>>
  writeJson(file: string, value: unknown): Promise<void>
  verifyPassword(token: string, passwordHash: string, password: string): Promise<{ ok: boolean; status: number; retryAfter?: number }>
  withShare<T>(token: string, operation: () => Promise<T>): Promise<T>
  withProject<T>(projectId: string, operation: () => Promise<T>): Promise<T>
  withAuth<T>(operation: () => Promise<T>): Promise<T>
  projectResponse(project: StoredDocument, permission: 'view'): unknown
  origin(req: IncomingMessage): string
  sendJson(res: ServerResponse, status: number, value: unknown): void
}
export class CanvasFavoriteError extends Error {
  readonly status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
function fail(message: string, status = 400): never { throw new CanvasFavoriteError(message, status) }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000
const queues = new Map<string, Promise<void>>()
export async function withCanvasFavorites<T>(paths: RuntimePaths, operation: () => Promise<T>): Promise<T> {
  const key = path.join(paths.authDirectory, CANVAS_FAVORITES_FILE)
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  queues.set(key, tail)
  await previous.catch(() => undefined)
  try { return await operation() } finally { release(); void tail.finally(() => { if (queues.get(key) === tail) queues.delete(key) }) }
}

/** Validate before any restore writes. Old backups simply omit this optional file. */
export function validateCanvasFavorites(value: unknown): CanvasFavoriteStore {
  if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'favorites'].includes(key))
    || !Array.isArray(value.favorites) || value.favorites.length > MAX_FAVORITES
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_STORE_BYTES) fail('画布收藏存储格式或大小无效')
  const ids = new Set<string>(), references = new Set<string>(), counts = new Map<string, number>()
  const favorites = value.favorites.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'userId', 'shareToken', 'grantFingerprint', 'createdAt'].includes(key))
      || typeof item.id !== 'string' || !FAVORITE_ID.test(item.id)
      || typeof item.userId !== 'string' || !ID.test(item.userId)
      || typeof item.shareToken !== 'string' || !TOKEN.test(item.shareToken)
      || typeof item.grantFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.grantFingerprint) || !timestamp(item.createdAt)) fail('画布收藏记录无效')
    const reference = `${item.userId}:${item.shareToken}`, count = (counts.get(item.userId) ?? 0) + 1
    if (ids.has(item.id) || references.has(reference) || count > MAX_FAVORITES_PER_USER) fail('画布收藏记录重复或超过每人200项')
    ids.add(item.id); references.add(reference); counts.set(item.userId, count)
    return { id: item.id, userId: item.userId, shareToken: item.shareToken, grantFingerprint: item.grantFingerprint, createdAt: item.createdAt as number }
  })
  return { schemaVersion: 1, favorites }
}

export async function readCanvasFavorites(paths: RuntimePaths): Promise<CanvasFavoriteStore> {
  const file = path.join(paths.authDirectory, CANVAS_FAVORITES_FILE)
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) fail('画布收藏存储不可用', 503)
    return validateCanvasFavorites(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, favorites: [] }
    throw error
  }
}

/** Binding is invalidated by a changed password, replaced source or owner.
 * It contains no password and cannot be used on another share token. */
function fingerprint(share: Share, project: StoredDocument) {
  return createHash('sha256').update(JSON.stringify([share.token, share.projectId, share.createdAt, project.ownerId, share.passwordHash ?? ''])).digest('hex')
}
function base(favorite: Favorite) { return { id: favorite.id, shareId: favorite.shareToken, addedAt: favorite.createdAt } }
function summary(favorite: Favorite, project: StoredDocument, author: User) {
  return { ...base(favorite), status: 'active', permission: 'view', projectId: project.id, title: project.title,
    thumbnail: project.thumbnail, createdAt: project.createdAt, updatedAt: project.updatedAt, authorName: author.email.split('@')[0]?.slice(0, 80) ?? '' }
}

async function withSource<T>(req: IncomingMessage, paths: RuntimePaths, services: Services, userId: string, token: string,
  operation: (share: Share, project: StoredDocument, users: User[]) => Promise<T>): Promise<T> {
  return services.withShare(token, async () => {
    const initial = (await services.loadShares(paths)).find(share => share.token === token)
    if (!initial) fail('原画布分享已撤销或不存在', 410)
    return services.withProject(initial.projectId, () => services.withAuth(async () => {
      const active = await services.currentUser(req, paths)
      if (!active || active.id !== userId) fail('登录已失效，请重新登录', 401)
      const users = await services.loadUsers(paths)
      if (!users.some(user => user.id === userId)) fail('账号已不存在', 401)
      const share = (await services.loadShares(paths)).find(item => item.token === token)
      if (!share || share.projectId !== initial.projectId || (share.expiresAt !== undefined && share.expiresAt <= Date.now())) fail('原画布分享已撤销或过期', 410)
      if (share.permission !== 'view' && share.permission !== 'edit') fail('原画布分享权限已失效', 410)
      const project = await services.readProject(paths, share.projectId)
      if (!project || project.id !== share.projectId || project.deletedAt || !users.some(user => user.id === project.ownerId)) fail('原画布或作者已不可用', 410)
      return operation(share, project, users)
    }))
  })
}

export async function handleCanvasFavorites(req: IncomingMessage, res: ServerResponse, paths: RuntimePaths, services: Services): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://flowboard.local').pathname
  const collection = pathname === '/api/canvas/favorites', item = pathname.match(/^\/api\/canvas\/favorites\/(fav_[a-f0-9]{24})(\/content)?$/)
  if (!collection && !item) {
    if (pathname.startsWith('/api/canvas/favorites')) { services.sendJson(res, 404, { error: '收藏不存在' }); return true }
    return false
  }
  const user = await services.currentUser(req, paths)
  if (!user) fail('请先登录后收藏画布', 401)
  if (req.method !== 'GET') {
    const origin = req.headers.origin
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== services.origin(req) && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`)) fail('请在当前网站操作收藏', 403)
  }
  if (collection && req.method === 'GET') {
    const favorites = (await readCanvasFavorites(paths)).favorites.filter(item => item.userId === user.id)
    const result = []
    for (const favorite of favorites) {
      try {
        result.push(await withSource(req, paths, services, user.id, favorite.shareToken, async (share, project, users) => {
          if (favorite.grantFingerprint !== fingerprint(share, project)) fail('原分享密码或来源已变更，请重新收藏', 410)
          return summary(favorite, project, users.find(author => author.id === project.ownerId)!)
        }))
      } catch (error) {
        if (!(error instanceof CanvasFavoriteError) || error.status === 401) throw error
        result.push({ ...base(favorite), status: 'unavailable' })
      }
    }
    services.sendJson(res, 200, result.sort((a, b) => b.addedAt - a.addedAt)); return true
  }
  if (collection && req.method === 'POST') {
    const body = await services.readBody(req, 4096)
    if (Object.keys(body).some(key => key !== 'shareId') || typeof body.shareId !== 'string' || !TOKEN.test(body.shareId)) fail('请提供有效的画布分享链接标识')
    const token = body.shareId
    const initial = (await services.loadShares(paths)).find(share => share.token === token)
    if (!initial || (initial.expiresAt !== undefined && initial.expiresAt <= Date.now())) fail('分享链接已撤销或过期', 410)
    if (initial.passwordHash) {
      const header = req.headers['x-share-password'], password = Array.isArray(header) ? header[0] ?? '' : header ?? ''
      const checked = await services.verifyPassword(token, initial.passwordHash, password)
      if (!checked.ok) { services.sendJson(res, checked.status, { error: checked.status === 429 ? '分享密码尝试过于频繁' : '分享密码错误', ...(checked.retryAfter === undefined ? {} : { retryAfter: checked.retryAfter }) }); return true }
    }
    const saved = await withSource(req, paths, services, user.id, token, async (share, project, users) => {
      if (share.projectId !== initial.projectId || share.createdAt !== initial.createdAt || share.passwordHash !== initial.passwordHash) fail('分享设置已更新，请重新验证后收藏', 409)
      return withCanvasFavorites(paths, async () => {
        const store = await readCanvasFavorites(paths), existing = store.favorites.find(item => item.userId === user.id && item.shareToken === token)
        const grantFingerprint = fingerprint(share, project)
        if (existing?.grantFingerprint === grantFingerprint) return { created: false, value: summary(existing, project, users.find(author => author.id === project.ownerId)!) }
        if (!existing && (store.favorites.filter(item => item.userId === user.id).length >= MAX_FAVORITES_PER_USER || store.favorites.length >= MAX_FAVORITES)) fail('画布收藏已达到数量上限', 413)
        const favorite: Favorite = { id: existing?.id ?? `fav_${randomBytes(12).toString('hex')}`, userId: user.id, shareToken: token, grantFingerprint, createdAt: existing?.createdAt ?? Date.now() }
        const next = { schemaVersion: 1 as const, favorites: existing ? store.favorites.map(item => item.id === existing.id ? favorite : item) : [...store.favorites, favorite] }
        await services.writeJson(path.join(paths.authDirectory, CANVAS_FAVORITES_FILE), validateCanvasFavorites(next))
        return { created: !existing, value: summary(favorite, project, users.find(author => author.id === project.ownerId)!) }
      })
    })
    services.sendJson(res, saved.created ? 201 : 200, saved.value); return true
  }
  if (item && req.method === 'DELETE' && !item[2]) {
    await services.withAuth(async () => {
      const active = await services.currentUser(req, paths)
      if (!active || active.id !== user.id) fail('登录已失效', 401)
      await withCanvasFavorites(paths, async () => {
        const store = await readCanvasFavorites(paths), favorite = store.favorites.find(value => value.id === item[1] && value.userId === user.id)
        if (!favorite) fail('收藏不存在', 404)
        await services.writeJson(path.join(paths.authDirectory, CANVAS_FAVORITES_FILE), { schemaVersion: 1, favorites: store.favorites.filter(value => value.id !== favorite.id) })
      })
    })
    services.sendJson(res, 200, { ok: true }); return true
  }
  if (item && req.method === 'GET' && item[2] === '/content') {
    const favorite = (await readCanvasFavorites(paths)).favorites.find(value => value.id === item[1] && value.userId === user.id)
    if (!favorite) fail('收藏不存在', 404)
    const value = await withSource(req, paths, services, user.id, favorite.shareToken, async (share, project) => {
      if (favorite.grantFingerprint !== fingerprint(share, project)) fail('原分享密码或来源已变更，请从新分享链接重新收藏', 410)
      return { ...(services.projectResponse(project, 'view') as object), favoriteId: favorite.id, shareId: favorite.shareToken }
    })
    services.sendJson(res, 200, value); return true
  }
  fail('请求方法不支持', 405)
}
