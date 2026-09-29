const fs = require('fs')
const p = 'd:\\新建文件夹\\996工具\\快速开发工具\\local_programs\\编辑平台\\frontend\\tmp-icons\\canvas-dump.txt'
const out = 'd:\\新建文件夹\\996工具\\快速开发工具\\local_programs\\编辑平台\\frontend\\tmp-icons\\canvas.png'
const s = fs.readFileSync(p, 'utf8').trim()
const b64 = s.split(',')[1]
fs.writeFileSync(out, Buffer.from(b64, 'base64'))
console.log('ok', fs.statSync(out).size)
