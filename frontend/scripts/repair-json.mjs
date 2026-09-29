#!/usr/bin/env node
/**
 * JSON 文档修复工具
 * ============================================================
 * 症状：文档 JSON 解析失败，报 "Unexpected non-whitespace character after JSON"。
 * 成因：某次写入未截断文件——新的（较短的）内容写入后，旧文件尾部残留下来，
 *       形成「完整 JSON + 一段垃圾尾巴」的结构。多见于早期版本或写入被中断。
 *
 * 修复：利用 JSON.parse 的报错位置逐步截断，直到解析成功。
 *       截断丢弃的是上一次写入的残留，当前文档内容（shapes/order/ownerId 等）完整。
 *
 * 用法：
 *   node scripts/repair-json.mjs <project-data 目录> [--dry-run]
 *   例：node scripts/repair-json.mjs ../FlowBoard-发布包/project-data --dry-run
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const target = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
if (!target) {
  console.error('用法: node scripts/repair-json.mjs <project-data 目录> [--dry-run]')
  process.exit(1)
}

const dataDirectory = path.resolve(target)

/** 逐步截断直到 JSON 可解析；返回 { parsed, end } 或 null */
function tryRepair(text) {
  let end = text.length
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = text.slice(0, end)
    try {
      return { parsed: JSON.parse(candidate), end }
    } catch (error) {
      const match = /position (\d+)/.exec(error.message)
      let next = match ? Number(match[1]) : -1
      if (!(next > 0 && next < end)) next = candidate.lastIndexOf('}')
      if (next <= 0) return null
      end = next
    }
  }
  return null
}

async function collectFiles() {
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

async function main() {
  const files = await collectFiles()
  let healthy = 0
  let repaired = 0
  let failed = 0

  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8').catch(() => null)
    if (raw === null) continue
    try {
      JSON.parse(raw)
      healthy++
      continue
    } catch {
      // 继续尝试修复
    }
    const result = tryRepair(raw)
    const label = path.relative(dataDirectory, file)
    if (!result) {
      failed++
      console.log(`  无法修复  ${label}`)
      continue
    }
    const shapeCount = Object.keys(result.parsed?.canvas?.shapes ?? {}).length
    const orderCount = Array.isArray(result.parsed?.canvas?.order) ? result.parsed.canvas.order.length : 0
    repaired++
    console.log(`  已修复    ${label}  丢弃尾部 ${raw.length - result.end} 字符  shapes=${shapeCount} order=${orderCount}`)
    if (!dryRun) {
      await fs.writeFile(file, `${JSON.stringify(result.parsed, null, 2)}\n`, 'utf8')
    }
  }

  console.log('')
  console.log(dryRun ? '（试运行，未写入任何文件）' : '修复完成')
  console.log(`  正常 ${healthy} / 已修复 ${repaired} / 无法修复 ${failed}`)
}

main().catch(error => {
  console.error('修复失败:', error)
  process.exit(1)
})
