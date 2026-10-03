import type { IncomingMessage, ServerResponse } from 'node:http'

/** Keeps ordinary request bodies and responses within a fixed concurrent memory budget. */
export function createApiRequestGate(maxActive = 32) {
  let active = 0
  return {
    admit(req: IncomingMessage, res: ServerResponse): boolean {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!pathname.startsWith('/api/')) return true
      if (req.method === 'GET' && (pathname === '/api/health'
        || /^\/api\/management\/projects\/[A-Za-z0-9_-]+\/live$/.test(pathname))) return true
      if (active >= maxActive) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Retry-After', '2')
        res.setHeader('Connection', 'close')
        // Drain without storing rejected uploads. Connection: close prevents a
        // queued request on the same connection from bypassing admission.
        req.resume()
        res.end(JSON.stringify({ error: '服务器正在处理较多请求，请稍后重试', code: 'SERVER_BUSY' }))
        return false
      }
      active += 1
      let released = false
      const release = () => {
        if (released) return
        released = true
        active -= 1
        res.off('finish', release)
        res.off('close', release)
      }
      // The route may return while a streamed or backpressured response is
      // still live. Its memory belongs to the slot until completion or close.
      res.once('finish', release)
      res.once('close', release)
      return true
    },
    get active() { return active },
  }
}
