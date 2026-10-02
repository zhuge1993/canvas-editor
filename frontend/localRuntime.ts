import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Plugin } from 'vite'
import { ensureRuntimeDirs, handleRuntimeRequest } from './runtimeCore.js'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const configuredRuntimeRoot = process.env.FLOWBOARD_RUNTIME_DIR?.trim()
const programRoot = configuredRuntimeRoot ? path.resolve(configuredRuntimeRoot) : path.resolve(moduleDirectory, '..')
const paths = {
  dataDirectory: path.join(programRoot, 'project-data'),
  logDirectory: path.join(programRoot, 'logs'),
  authDirectory: path.join(programRoot, 'auth-data'),
}

export function localRuntimePlugin(): Plugin {
  // Vite 本地开发默认回显验证码；显式设置 FLOWBOARD_EMAIL_MODE 时保留该设置。
  if (process.env.FLOWBOARD_EMAIL_MODE === undefined) process.env.FLOWBOARD_EMAIL_MODE = 'console'

  const middleware = async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    try {
      if (!await handleRuntimeRequest(request, response, { paths })) next()
    } catch (error) {
      next(error)
    }
  }

  return {
    name: 'flowboard-local-runtime',
    async configureServer(server) {
      await ensureRuntimeDirs(paths)
      server.middlewares.use(middleware)
    },
    async configurePreviewServer(server) {
      await ensureRuntimeDirs(paths)
      server.middlewares.use(middleware)
    },
  }
}
