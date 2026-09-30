#!/usr/bin/env node
/**
 * 内嵌图片 → 外置资源迁移脚本
 * ============================================================
 * 把 project-data 里文档（含版本快照）内嵌的 base64 图片抽取为独立文件：
 *   <project-data>/assets/<sha256 前 40 位>.<ext>
 * 并把文档中的 src 替换为 /api/assets/<name>。
 *
 * 效果：单文档从 MB 级降到几十 KB；图片按内容去重、可走浏览器强缓存。
 * 幂等：已外置的内容不会被重复处理；同内容图片自动去重。
 *
 * 用法：
 *   node scripts/migrate-assets.mjs <project-data 目录>
 *   例：node scripts/migrate-assets.mjs ../FlowBoard-发布包/project-data
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const IMAGE_PATTERN = /data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)/g
const HASH_LENGTH = 40
const EXTENSION_ALIAS = { jpeg: 'jpg' }

const target = process.argv[2]
if (!target) {
  console.error('用法: node scripts/migrate-assets.mjs <project-data 目录>')
  console.error('  例: node scripts/migrate-assets.mjs ../FlowBoard-发布包/project-data')
  process.exit(1)
}

const dataDirectory = path.resolve(target)
const assetsDirectory = path.join(dataDirectory, 'assets')

/** 收集所有含画布内容的 JSON：文档本体 + versions/<docId>/*.json */
async function collectDocumentFiles() {
  const files = []
  for (const name of await fs.readdir(dataDirectory).catch(() => [])) {
    if (name.endsWith('.json')) files.push(path.join(dataDirectory, name))
  }
  const versionsRoot = path.join(dataDirectory, 'versions')
  for (const projectDir of await fs.readdir(versionsRoot).catch(() => [])) {
    const dir = path.join(versionsRoot, projectDir)
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (name.endsWith('.json')) files.push(path.join(dir, name))
    }
  }
  return files
}

/** 内容寻址写入，返回 URL；同内容已存在时直接复用 */
async function storeAsset(buffer, extension) {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, HASH_LENGTH)
  const name = `${hash}.${extension}`
  const file = path.join(assetsDirectory, name)
  try {
    await fs.access(file)
    return { url: `/api/assets/${name}`, deduped: true }
  } catch {
    await fs.writeFile(file, buffer)
    return { url: `/api/assets/${name}`, deduped: false }
  }
}

async function main() {
  await fs.mkdir(assetsDirectory, { recursive: true })
  const files = await collectDocumentFiles()
  const stats = { scanned: 0, converted: 0, written: 0, deduped: 0, bytesBefore: 0, bytesAfter: 0 }

  for (const file of files) {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    stats.scanned++
    const before = Buffer.byteLength(raw)
    stats.bytesBefore += before

    const dataUrls = [...new Set([...raw.matchAll(IMAGE_PATTERN)].map(match => match[0]))]
    if (dataUrls.length === 0) {
      stats.bytesAfter += before
      continue
    }

    let updated = raw
    for (const dataUrl of dataUrls) {
      const header = dataUrl.match(/^data:image\/([a-z]+);base64,/)
      const payload = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s+/g, '')
      const extension = EXTENSION_ALIAS[header?.[1] ?? ''] ?? header?.[1]
      if (!extension || !payload) continue
      const stored = await storeAsset(Buffer.from(payload, 'base64'), extension)
      updated = updated.split(dataUrl).join(stored.url)
      stats.converted++
      if (stored.deduped) stats.deduped++
      else stats.written++
    }

    if (updated !== raw) {
      await fs.writeFile(file, `${JSON.stringify(JSON.parse(updated), null, 2)}\n`, 'utf8')
      console.log(`  已处理 ${path.relative(dataDirectory, file)}  ${(before / 1024).toFixed(0)} KB → ${(Buffer.byteLength(updated) / 1024).toFixed(0)} KB`)
    }
    stats.bytesAfter += Buffer.byteLength(updated)
  }

  console.log('')
  console.log('迁移完成')
  console.log(`  扫描文档/快照 : ${stats.scanned}`)
  console.log(`  抽取图片      : ${stats.converted} 张（新写入 ${stats.written}，命中去重 ${stats.deduped}）`)
  console.log(`  文档总体积    : ${(stats.bytesBefore / 1048576).toFixed(2)} MB → ${(stats.bytesAfter / 1048576).toFixed(2)} MB`)
  console.log(`  图片目录      : ${assetsDirectory}`)
}

main().catch(error => {
  console.error('迁移失败:', error)
  process.exit(1)
})
