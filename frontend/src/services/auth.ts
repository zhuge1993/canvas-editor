export interface AuthUser {
  id: string
  email: string
  createdAt: number
  isAdmin?: boolean
}

export interface ProjectAccess {
  id: string
  title: string
  content: string
  thumbnail?: string
  createdAt: number
  updatedAt: number
  permission: 'owner' | 'view' | 'edit'
}

export interface ShareLink {
  token: string
  projectId: string
  permission: 'view' | 'edit'
  createdAt: number
  updatedAt: number
  expiresAt?: number
  expired?: boolean
  hasPassword?: boolean
  url: string
}

export interface ShareLinkOptions {
  expiresInHours?: number
  password?: string
  clearExpires?: boolean
  clearPassword?: boolean
}

interface ApiErrorPayload {
  error?: string
  retryAfter?: number
}

export class AuthRequestError extends Error {
  readonly status: number
  readonly retryAfter?: number

  constructor(status: number, message: string, retryAfter?: number) {
    super(message)
    this.name = 'AuthRequestError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const maxRetries = 3
  const retryDelayMs = 600
  let lastError: AuthRequestError | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      })
      const payload = await response.json().catch(() => ({})) as T & ApiErrorPayload
      if (!response.ok) throw new AuthRequestError(response.status, payload.error ?? `请求失败 (${response.status})`, payload.retryAfter)
      return payload
    } catch (error) {
      const isNetworkError = error instanceof TypeError
      if (isNetworkError && attempt < maxRetries) {
        // 网络中断（服务重启/断网）：等待后自动重试，实现"自动重连"
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)))
        lastError = new AuthRequestError(0, '无法连接服务器，正在自动重连...')
        continue
      }
      if (error instanceof AuthRequestError) throw error
      throw new AuthRequestError(0, error instanceof Error ? `无法连接服务器：${error.message}` : '无法连接服务器')
    }
  }
  throw lastError ?? new AuthRequestError(0, '无法连接服务器')
}

export function getCurrentUser(): Promise<{ user: AuthUser | null }> {
  return request('/api/auth/me')
}

export function sendVerificationCode(email: string, purpose?: 'register' | 'reset', inviteCode?: string): Promise<{ ok: boolean; expiresIn: number; resendAfter: number; developmentCode?: string }> {
  return request('/api/auth/send-code', { method: 'POST', body: JSON.stringify({ email, purpose, inviteCode }) })
}

export function register(email: string, code: string, password: string, inviteCode?: string): Promise<{ user: AuthUser }> {
  return request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, code, password, inviteCode }) })
}

export function login(email: string, password: string): Promise<{ user: AuthUser }> {
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
}
export function resetPassword(email: string, code: string, password: string): Promise<{ ok: boolean }> {
  return request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, code, password }) })
}


export function logout(): Promise<{ ok: boolean }> {
  return request('/api/auth/logout', { method: 'POST' })
}

export function getShareLinks(projectId: string): Promise<ShareLink[]> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/shares`)
}

export function createShareLink(projectId: string, permission: 'view' | 'edit', options: ShareLinkOptions = {}): Promise<ShareLink> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/shares`, {
    method: 'POST',
    body: JSON.stringify({ permission, ...options }),
  })
}

export function updateShareLink(projectId: string, token: string, permission: 'view' | 'edit', options: ShareLinkOptions = {}): Promise<ShareLink> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(token)}`, {
    method: 'PATCH',
    body: JSON.stringify({ permission, ...options }),
  })
}

export function revokeShareLink(projectId: string, token: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(token)}`, { method: 'DELETE' })
}

export function getSharedProject(token: string, password?: string): Promise<ProjectAccess> {
  return request(`/api/share/${encodeURIComponent(token)}`, {
    headers: password ? { 'X-Share-Password': password } : undefined,
  })
}

export function saveSharedProject(
  token: string,
  project: { id: string; title: string; content: string; createdAt: number; updatedAt: number },
  password?: string,
): Promise<{ ok: boolean; permission: 'edit' }> {
  return request(`/api/share/${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: password ? { 'X-Share-Password': password } : undefined,
    body: JSON.stringify(project),
  })
}

/** 管理员：查看所有用户的画册 */
export function adminGetAllDocs(): Promise<Array<{ id: string; title: string; ownerEmail: string; updatedAt: number; createdAt: number }>> {
  return request('/api/admin/docs')
}

/** 管理员：复制他人画册到自己的画册 */
export function adminCopyDoc(docId: string): Promise<{ ok: boolean; id: string; title: string }> {
  return request(`/api/admin/copy-doc/${encodeURIComponent(docId)}`, { method: 'POST' })
}


export interface AdminUser {
  id: string
  email: string
  createdAt: number
  lastLoginAt?: number
  isAdmin: boolean
  isRootAdmin: boolean
}

export interface AdminInvite {
  code: string
  createdAt: number
  createdBy: string
  maxUses: number
  usedCount: number
  lastUsedAt?: number
  disabled?: boolean
}

export interface AdminDocGroup {
  id: string
  name: string
  parentId?: string
  shapeCount: number
  groupCount: number
}

/** 管理员：查看注册用户 */
export function adminGetUsers(): Promise<AdminUser[]> {
  return request('/api/admin/users')
}

/** 管理员：设置/取消其他管理员 */
export function adminUpdateUser(userId: string, patch: { isAdmin: boolean }): Promise<{ user: AuthUser }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

/** 管理员：删除用户及其画布 */
export function adminDeleteUser(userId: string): Promise<{ ok: boolean; deletedDocs: number }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}

/** 管理员：邀请码列表 */
export function adminGetInvites(): Promise<AdminInvite[]> {
  return request('/api/admin/invites')
}

/** 管理员：生成邀请码 */
export function adminCreateInvite(maxUses = 1): Promise<AdminInvite> {
  return request('/api/admin/invites', { method: 'POST', body: JSON.stringify({ maxUses }) })
}

/** 管理员：停用邀请码 */
export function adminDisableInvite(code: string): Promise<{ ok: boolean }> {
  return request(`/api/admin/invites/${encodeURIComponent(code)}`, { method: 'DELETE' })
}

/** 管理员：读取指定画布的分组树摘要 */
export function adminGetDocGroups(docId: string): Promise<AdminDocGroup[]> {
  return request(`/api/admin/docs/${encodeURIComponent(docId)}/groups`)
}

/** 管理员：把指定画布中的一个完整分组复制到自己的目标画布 */
export function adminCopyGroup(sourceDocId: string, targetDocId: string, groupId: string): Promise<{ ok: boolean; groupId: string; groupName: string; targetDocId: string }> {
  return request('/api/admin/copy-group', { method: 'POST', body: JSON.stringify({ sourceDocId, targetDocId, groupId }) })
}
