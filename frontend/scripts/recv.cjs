const http = require('http')
const fs = require('fs')
const out = 'd:\\新建文件夹\\996工具\\快速开发工具\\local_programs\\编辑平台\\frontend\\tmp-icons\\canvas.png'
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end('ok'); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const b64 = body.split(',')[1]
      fs.mkdirSync(require('path').dirname(out), { recursive: true })
      fs.writeFileSync(out, Buffer.from(b64, 'base64'))
      res.end('saved')
      console.log('saved', fs.statSync(out).size)
    } catch (e) { res.end('err') }
  })
})
server.listen(8799, () => console.log('listen 8799'))
