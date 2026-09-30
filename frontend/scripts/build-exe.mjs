/**
 * 构建 FlowBoard Windows Server 2012 兼容版 EXE。
 * 使用 pkg 的 Node 14 运行时；Server 2012 不需要另装 Node.js。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const bundlePath = path.join(root, 'server-bundle.cjs')
const pkgConfigPath = path.join(root, 'pkg-temp.json')
const exeName = process.env.FLOWBOARD_EXE_NAME ?? 'FlowBoard.exe'
const outputPath = path.join(root, exeName)
const target = process.env.FLOWBOARD_PKG_TARGET ?? 'node14-win-x64'
const releaseZipPath = path.join(root, 'FlowBoard-build.zip')
const releaseDirectory = path.join(root, '.flowboard-release')
/** 版本号：优先环境变量，否则从 exe 文件名推导轮次（如 FlowBoard-r12.exe -> 1.0.12） */
const versionMatch = exeName.match(/r(\d+)/i)
const flowboardVersion = process.env.FLOWBOARD_VERSION
  ?? (versionMatch ? `1.0.${String(Number(versionMatch[1]))}` : '1.0.0')

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`)
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: false,
  })
}

function ensureFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`)
}

function createReleasePackage() {
  fs.rmSync(releaseDirectory, { recursive: true, force: true })
  fs.mkdirSync(releaseDirectory, { recursive: true })
  // exe 使用本次构建的产物名（可能是 FlowBoard-rNN.exe），在包内统一命名为 FlowBoard.exe
  fs.copyFileSync(outputPath, path.join(releaseDirectory, 'FlowBoard.exe'))
  const releaseFiles = ['start-server.cmd', 'start-daemon.cmd', 'allow-firewall.cmd', 'configure-smtp.cmd', 'flowboard.env.cmd.example']
  if (fs.existsSync(path.join(root, 'flowboard.env.cmd'))) releaseFiles.push('flowboard.env.cmd')
  for (const file of releaseFiles) {
    const source = path.join(root, file)
    ensureFile(source, `Release file ${file}`)
    fs.copyFileSync(source, path.join(releaseDirectory, file))
  }
  fs.cpSync(distDir, path.join(releaseDirectory, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(releaseDirectory, 'BUILD.txt'), `FlowBoard packaged release\nTarget: ${target}\nBuilt: ${new Date().toISOString()}\n`, 'utf8')
  if (fs.existsSync(releaseZipPath)) fs.unlinkSync(releaseZipPath)
  const sourcePath = path.join(releaseDirectory, '*').replace(/'/g, "''")
  const destinationPath = releaseZipPath.replace(/'/g, "''")
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${sourcePath}' -DestinationPath '${destinationPath}' -Force`], { cwd: root, stdio: 'inherit', windowsHide: false })
  fs.rmSync(releaseDirectory, { recursive: true, force: true })
}

console.log('\n[0/3] 构建最新前端资源...')
run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build'])
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.log('dist/ 不存在，先构建前端...')
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build'])
}
ensureFile(path.join(distDir, 'index.html'), 'Frontend build')

console.log(`\n[1/3] 打包服务器代码（${target}, version=${flowboardVersion}）...`)
const esbuild = await import('esbuild')
await esbuild.build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node14',
  outfile: bundlePath,
  external: ['node:*'],
  minify: true,
  define: { 'process.env.FLOWBOARD_VERSION': JSON.stringify(flowboardVersion) },
})
ensureFile(bundlePath, 'Server bundle')

console.log('\n[2/3] 生成兼容 EXE...')
fs.writeFileSync(pkgConfigPath, JSON.stringify({
  name: 'flowboard',
  version: '1.0.0',
  bin: 'server-bundle.cjs',
  pkg: {
    assets: ['dist/**/*', 'scripts/qrlib/**/*'],
    targets: [target],
  },
}, null, 2))

run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
  'dlx',
  'pkg@5.8.1',
  '--config',
  pkgConfigPath,
  '--targets',
  target,
  '--output',
  outputPath,
  '--compress',
  'GZip',
  '--no-bytecode',
  '--public',
  '--public-packages',
  '*',
  'server-bundle.cjs',
])

ensureFile(outputPath, 'FlowBoard executable')
const sizeMB = fs.statSync(outputPath).size / 1024 / 1024
if (sizeMB < 5) throw new Error(`EXE is unexpectedly small (${sizeMB.toFixed(1)} MiB)`)
createReleasePackage()

console.log('\n[3/3] 清理临时构建文件...')
for (const file of [bundlePath, pkgConfigPath]) {
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

console.log('\n构建成功')
console.log(`文件: ${outputPath}`)
console.log(`大小: ${sizeMB.toFixed(1)} MiB`)
console.log('运行示例: FlowBoard.exe --host 0.0.0.0 --port 3000 --debug --no-open')
