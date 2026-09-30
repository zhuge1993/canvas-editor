/**
 * API 请求封装（Axios）
 * 当前为本地模式，后端接口暂不启用
 */
import axios from 'axios'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL as string,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
})

/** 统一响应格式 */
export interface ApiResponse<T = unknown> {
  code: number
  data: T
  message: string
}

/** 请求拦截器：自动携带 Token（账号系统启用后生效） */
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = localStorage.getItem('flowboard_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

/** 响应拦截器：统一错误处理 */
api.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error) => {
    const message = error.response?.data?.message ?? error.message ?? '网络请求失败'
    console.error('[API Error]', message)
    return Promise.reject(new Error(message))
  },
)

export default api
