import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const outDir = path.join(root, 'tmp-anchor')
fs.mkdirSync(outDir, { recursive: true })

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    try {
      const data = JSON.parse(body)
      const b64 = String(data.dataUrl || '').split(',')[1] || ''
      const file = path.join(outDir, (data.name || 'shot') + '.png')
      fs.writeFileSync(file, Buffer.from(b64, 'base64'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, file }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(err) }))
    }
  })
})
server.listen(8791, '127.0.0.1', () => console.log('receiver ready on 8791'))
