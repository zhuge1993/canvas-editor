/** 项目存储：local 模式只使用本地运行时服务；offline 模式显式使用浏览器 IndexedDB。 */
import { logOperation } from './logger'

const DB_NAME = 'flowboard'
const DB_VERSION = 1
const STORE_NAME = 'documents'
const offlineMode = import.meta.env.VITE_STORAGE_MODE === 'offline'

export interface StoredDocument {
  id: string
  title: string
  /** 画布内容 JSON。列表接口只返回元数据，因此列表项中该字段为空；
   *  完整内容请通过 getDocument(id) 单独获取。 */
  content?: string
  thumbnail?: string
  createdAt: number
  updatedAt: number
  permission?: 'owner' | 'view' | 'edit'
}

export class StorageRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'StorageRequestError'
    this.status = status
  }
}

async function runtimeRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const maxRetries = 3
  const retryDelayMs = 600
  let lastError: StorageRequestError | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...init?.headers } })
      const payload = await response.json().catch(() => undefined) as (T & { error?: string }) | undefined
      if (!response.ok) throw new StorageRequestError(response.status, payload?.error ?? `请求失败 (${response.status})`)
      return payload as T
    } catch (error) {
      const isNetworkError = error instanceof TypeError
      if (isNetworkError && attempt < maxRetries) {
        // 本地服务重启/断连：自动重试（服务守护进程拉起后即可恢复）
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)))
        lastError = new StorageRequestError(0, '无法连接本地服务，正在自动重连...')
        continue
      }
      if (error instanceof StorageRequestError) throw error
      throw new StorageRequestError(0, error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务')
    }
  }
  throw lastError ?? new StorageRequestError(0, '无法连接本地服务')
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function getAllDocumentsFromDB(): Promise<StoredDocument[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).index('updatedAt').getAll()
    request.onsuccess = () => resolve((request.result as StoredDocument[]).reverse())
    request.onerror = () => reject(request.error)
  })
}

async function getDocumentFromDB(id: string): Promise<StoredDocument | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
    request.onsuccess = () => resolve(request.result as StoredDocument | undefined)
    request.onerror = () => reject(request.error)
  })
}

async function saveDocumentToDB(doc: StoredDocument): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(doc)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function deleteDocumentFromDB(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getAllDocuments(): Promise<StoredDocument[]> {
  if (offlineMode) return getAllDocumentsFromDB()
  const runtime = await runtimeRequest<StoredDocument[]>('/api/projects')
  return runtime.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getDocument(id: string): Promise<StoredDocument | undefined> {
  if (offlineMode) return getDocumentFromDB(id)
  return runtimeRequest<StoredDocument>(`/api/projects/${encodeURIComponent(id)}`)
}

export async function saveDocument(doc: StoredDocument): Promise<void> {
  if (offlineMode) {
    await saveDocumentToDB(doc)
    logOperation('project.saved.indexeddb', 'Saved project to browser IndexedDB', { id: doc.id })
    return
  }
  await runtimeRequest<{ ok: boolean }>(`/api/projects/${encodeURIComponent(doc.id)}`, {
    method: 'PUT',
    body: JSON.stringify(doc),
  })
  logOperation('project.saved.root', 'Saved project to runtime service', { id: doc.id })
}
export async function deleteDocument(id: string): Promise<void> {
  if (offlineMode) {
    await deleteDocumentFromDB(id)
  } else {
    await runtimeRequest<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  logOperation('project.deleted', 'Deleted project', { id })
}

/** 回收站：列出已删除文档 */
export async function getTrashDocuments(): Promise<Array<StoredDocument & { deletedAt: number }>> {
  if (offlineMode) return []
  return runtimeRequest('/api/projects/trash')
}

/** 回收站：恢复文档 */
export async function restoreDocument(id: string): Promise<void> {
  await runtimeRequest<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/restore`, { method: 'POST' })
}

/** 回收站：彻底删除 */
export async function deleteDocumentForever(id: string): Promise<void> {
  await runtimeRequest<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/forever`, { method: 'DELETE' })
}

/** 版本历史：列出版本 */
export async function getVersions(docId: string): Promise<Array<{ id: string; name: string; createdAt: number }>> {
  return runtimeRequest(`/api/projects/${encodeURIComponent(docId)}/versions`)
}

/** 版本历史：创建版本快照 */
export async function createVersion(docId: string, name: string, content: string): Promise<{ id: string; name: string; createdAt: number }> {
  return runtimeRequest(`/api/projects/${encodeURIComponent(docId)}/versions`, {
    method: 'POST',
    body: JSON.stringify({ name, content }),
  })
}

/** 版本历史：恢复到指定版本 */
export async function restoreVersion(docId: string, versionId: string): Promise<void> {
  await runtimeRequest(`/api/projects/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: 'POST' })
}

export function generateId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
