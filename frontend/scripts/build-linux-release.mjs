import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const bundlePath = path.join(root, 'server-bundle.cjs')
const releaseDir = path.join(root, '.flowboard-linux-release')
const archivePath = path.join(root, 'FlowBoard-linux.tar.gz')

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}

function ensureFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`)
}

run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build'])
run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
  'exec',
  'esbuild',
  'server.ts',
  '--bundle',
  '--platform=node',
  '--target=node20',
  `--outfile=${bundlePath}`,
  '--external:node:*',
  '--format=cjs',
  '--minify',
])
ensureFile(bundlePath, 'Linux server bundle')
ensureFile(path.join(distDir, 'index.html'), 'Frontend build')

fs.rmSync(releaseDir, { recursive: true, force: true })
fs.mkdirSync(releaseDir, { recursive: true })
fs.copyFileSync(bundlePath, path.join(releaseDir, 'server-bundle.cjs'))
fs.cpSync(distDir, path.join(releaseDir, 'dist'), { recursive: true })
for (const file of ['start-server.sh', 'healthcheck.cjs', 'install-linux.sh', 'LINUX-ARMHF.md', 'PMOS-DIOR.md', 'DIOR-ALWAYS-ON.md', 'flowboard.env.example', 'flowboard.service', 'flowboard.openrc', 'nginx.flowboard.conf.example']) {
  ensureFile(path.join(root, file), file)
  // A Windows checkout may use CRLF. Linux shebangs and service scripts need LF.
  fs.writeFileSync(path.join(releaseDir, file), fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'), 'utf8')
}
fs.writeFileSync(
  path.join(releaseDir, 'BUILD.txt'),
  `FlowBoard ARMv7 Linux release\nBuilt: ${new Date().toISOString()}\nRuntime: postmarketOS/Alpine OpenRC or Debian 13 armhf / Node.js 20.19+\nDefault admin: 804559340@qq.com\n`,
  'utf8',
)
fs.chmodSync(path.join(releaseDir, 'start-server.sh'), 0o755)
fs.chmodSync(path.join(releaseDir, 'install-linux.sh'), 0o755)
fs.chmodSync(path.join(releaseDir, 'flowboard.openrc'), 0o755)

if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath)
run('tar', ['-czf', archivePath, '-C', releaseDir, '.'])
fs.rmSync(releaseDir, { recursive: true, force: true })
fs.unlinkSync(bundlePath)
console.log(`Linux package: ${archivePath}`)
