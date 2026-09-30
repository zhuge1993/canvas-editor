/**
 * Encoding repair for CanvasEngine.tsx / renderer.ts (ASCII-only script).
 * 1. Patch truncated 3-byte UTF-8 sequences whose 3rd byte became 0x3F.
 * 2. Decode whole lines stored as GBK back into UTF-8.
 * 3. Replace the one double-truncated comment line by signature.
 * All Chinese replacement text is expressed with \uXXXX escapes so this
 * script itself stays pure ASCII and cannot be re-corrupted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['src/canvas/CanvasEngine.tsx', 'src/canvas/renderer.ts']

// two-byte prefix of a truncated 3-byte char -> correct 3rd byte
const THIRD_BYTE = {
  'e59c': 0xa8, // \u5728 zai
  'e380': 0x82, // \u3002 full stop
  'efbc': 0x8c, // \uff0c comma
  'e699': 0xaf, // \u666f jing
  'e7bb': 0x84, // \u7ec4 zu
  'e580': 0xbc, // \u503c zhi
  'e4b8': 0xad, // \u4e2d zhong
}

// correct comment for the line right before "const movedIds"
const MOVED_COMMENT = '      // \u68c0\u6d4b\u62d6\u653e\u540e\u662f\u5426\u843d\u5165\u67d0\u4e2a\u5206\u7ec4\u533a\u57df\uff0c\u81ea\u52a8\u5f52\u7ec4/\u79fb\u51fa\u3002'

function splitLines(buf) {
  const lines = []
  let start = 0
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i))
      start = i + 1
    }
  }
  return lines
}

function isValidUtf8(bytes) {
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) { i++; continue }
    const n = (b >= 0xc2 && b <= 0xdf) ? 1 : (b >= 0xe0 && b <= 0xef) ? 2 : (b >= 0xf0 && b <= 0xf4) ? 3 : -1
    if (n < 0) return false
    if (i + n >= bytes.length) return false
    for (let j = 1; j <= n; j++) {
      const c = bytes[i + j]
      if (c < 0x80 || c >= 0xc0) return false
    }
    i += n + 1
  }
  return true
}

function hasCjk(s) {
  return /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s)
}

function isLikelyAsciiLine(bytes) {
  for (const b of bytes) if (b >= 0x80) return false
  return true
}

let fixedTrunc = 0
let fixedGbk = 0

for (const rel of files) {
  const file = path.join(root, rel)
  const buf = fs.readFileSync(file)
  const lines = splitLines(buf)
  const out = []

  for (const lineBytes of lines) {
    if (isLikelyAsciiLine(lineBytes)) {
      out.push(Buffer.from(lineBytes))
      continue
    }
    // stage 1: patch truncated 3-byte sequences (third byte replaced by 0x3F)
    const patched = Buffer.from(lineBytes)
    for (let i = 0; i + 2 < patched.length; i++) {
      const b = patched[i]
      if (b < 0xe0 || b > 0xef) continue
      const c2 = patched[i + 1]
      const c3 = patched[i + 2]
      if (c2 < 0x80 || c2 >= 0xc0) continue
      if (c3 !== 0x3f) continue
      const prefix = b.toString(16).padStart(2, '0') + c2.toString(16).padStart(2, '0')
      const third = THIRD_BYTE[prefix]
      if (third == null) continue
      patched[i + 2] = third
      fixedTrunc++
    }

    if (isValidUtf8(patched)) {
      out.push(patched)
      continue
    }

    // stage 2: whole line stored as GBK -> decode to UTF-8
    const decoded = new TextDecoder('gbk').decode(patched)
    if (hasCjk(decoded)) {
      fixedGbk++
      out.push(Buffer.from(decoded, 'utf8'))
    } else {
      out.push(Buffer.from(new TextDecoder('utf-8').decode(patched), 'utf8'))
    }
  }

  let text = out.map((b, idx) => idx < out.length - 1 ? b.toString('utf8') + '\n' : b.toString('utf8')).join('')
  // stage 3: line-based replacement of the unrecoverable comment line
  const textLines = text.split('\n')
  for (let li = 0; li < textLines.length; li++) {
    if (textLines[li].includes('const movedIds') && li > 0) {
      const prev = textLines[li - 1]
      if (prev.includes('\u68c0\u6d4b\u62d6\u653e') && prev.trimStart().startsWith('//')) {
        textLines[li - 1] = MOVED_COMMENT
      } else if (!prev.trimStart().startsWith('//')) {
        // garbage line without comment prefix
        textLines[li - 1] = MOVED_COMMENT
      }
      break
    }
  }
  text = textLines.join('\n')
  fs.writeFileSync(file, Buffer.from(text, 'utf8'))
  console.log('[done] ' + rel)
}

console.log('fixed truncated bytes: ' + fixedTrunc + ', fixed GBK lines: ' + fixedGbk)
