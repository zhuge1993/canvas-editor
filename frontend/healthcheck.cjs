#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

function runtimePort() {
  // Read only the port; do not evaluate or print the private environment file.
  let configured = process.env.FLOWBOARD_PORT
  if (configured === undefined) {
    try {
      const text = fs.readFileSync(path.join(__dirname, 'flowboard.env'), 'utf8')
      configured = text.match(/^\s*FLOWBOARD_PORT\s*=\s*['"]?(\d+)['"]?\s*$/m)?.[1]
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const port = Number(configured ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FlowBoard port')
  return port
}

function check(port) {
  return new Promise((resolve) => {
    let finished = false
    const finish = (ok) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      request.destroy()
      resolve(ok)
    }
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', agent: false }, (response) => {
      if (response.statusCode !== 200) return finish(false)
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (part) => {
        text += part
        if (text.length > 4096) finish(false)
      })
      response.on('error', () => finish(false))
      response.on('end', () => {
        try {
          const body = JSON.parse(text)
          finish(body.app === 'FlowBoard' && body.status === 'ok')
        } catch { finish(false) }
      })
    })
    const deadline = setTimeout(() => finish(false), 5000)
    request.on('error', () => finish(false))
  })
}

async function main() {
  const port = runtimePort()
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await check(port)) return
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('FlowBoard local HTTP health check failed')
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
