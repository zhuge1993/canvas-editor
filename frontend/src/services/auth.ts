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
  url: string
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

export function sendVerificationCode(email: string, purpose?: 'register' | 'reset'): Promise<{ ok: boolean; expiresIn: number; resendAfter: number; developmentCode?: string }> {
  return request('/api/auth/send-code', { method: 'POST', body: JSON.stringify({ email, purpose }) })
}

export function register(email: string, code: string, password: string): Promise<{ user: AuthUser }> {
  return request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, code, password }) })
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

export function createShareLink(projectId: string, permission: 'view' | 'edit'): Promise<ShareLink> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/shares`, { method: 'POST', body: JSON.stringify({ permission }) })
}

export function updateShareLink(projectId: string, token: string, permission: 'view' | 'edit'): Promise<ShareLink> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ permission }) })
}

export function revokeShareLink(projectId: string, token: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(token)}`, { method: 'DELETE' })
}

export function getSharedProject(token: string): Promise<ProjectAccess> {
  return request(`/api/share/${encodeURIComponent(token)}`)
}

export function saveSharedProject(token: string, project: { id: string; title: string; content: string; createdAt: number; updatedAt: number }): Promise<{ ok: boolean; permission: 'edit' }> {
  return request(`/api/share/${encodeURIComponent(token)}`, { method: 'PUT', body: JSON.stringify(project) })
}

/** 管理员：查看所有用户的画册 */
export function adminGetAllDocs(): Promise<Array<{ id: string; title: string; ownerEmail: string; updatedAt: number; createdAt: number }>> {
  return request('/api/admin/docs')
}

/** 管理员：复制他人画册到自己的画册 */
export function adminCopyDoc(docId: string): Promise<{ ok: boolean; id: string; title: string }> {
  return request(`/api/admin/copy-doc/${encodeURIComponent(docId)}`, { method: 'POST' })
}
