import fs from 'node:fs/promises'
import path from 'node:path'

export const MANAGEMENT_UPLOAD_GRACE_MS = 7 * 24 * 60 * 60 * 1000
export const MANAGEMENT_PENDING_UPLOAD_COUNT = 32
export const MANAGEMENT_PENDING_UPLOAD_BYTES = 64 * 1024 * 1024
export const MANAGEMENT_PROJECT_UPLOAD_FILES = 4096
const MAX_JSON_BYTES = 12 * 1024 * 1024
const PROJECT_ID = /^[A-Za-z0-9_-]{1,120}$/
const ASSET_ID = /^asset_[a-f0-9]{24}$/
const ASSET_FILE = /^(asset_[a-f0-9]{24})\.([a-z0-9]+)$/
type Paths = { dataDirectory: string; authDirectory: string }
type ObjectValue = Record<string, unknown>

async function directory(file: string): Promise<boolean> {
  try { const stat = await fs.lstat(file); return stat.isDirectory() && !stat.isSymbolicLink() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function regular(file: string) {
  try { const stat = await fs.lstat(file); return stat.isFile() && !stat.isSymbolicLink() ? stat : undefined }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function json(file: string, optional = false): Promise<unknown> {
  const stat = await regular(file)
  if (!stat) {
    if (optional && !await fs.lstat(file).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error
    })) return undefined
    throw new Error('Management maintenance requires a regular JSON file')
  }
  if (stat.size > MAX_JSON_BYTES) throw new Error('Management maintenance JSON exceeds its read budget')
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown
}
/** Conservative reachability: an asset ID anywhere in durable project/history
 * or notification snapshots protects its bytes, including deleted events. */
export function managementAssetReferences(...values: unknown[]): Set<string> {
  const ids = new Set<string>(), stack = values.map(value => ({ value, depth: 0 }))
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (depth > 100) throw new Error('Management maintenance reference depth exceeds its budget')
    if (typeof value === 'string') { if (ASSET_ID.test(value)) ids.add(value) }
    else if (Array.isArray(value)) for (const item of value) stack.push({ value: item, depth: depth + 1 })
    else if (value && typeof value === 'object') for (const item of Object.values(value)) stack.push({ value: item, depth: depth + 1 })
  }
  return ids
}
async function safeRoots(paths: Paths): Promise<boolean> {
  return await directory(paths.dataDirectory) && await directory(paths.authDirectory) &&
    await directory(path.join(paths.dataDirectory, 'management')) &&
    await directory(path.join(paths.dataDirectory, 'management', 'projects')) &&
    await directory(path.join(paths.dataDirectory, 'management-assets'))
}
async function references(paths: Paths, projectId: string): Promise<Set<string>> {
  const project = await json(path.join(paths.dataDirectory, 'management', 'projects', `${projectId}.json`)) as ObjectValue
  if (!project || project.id !== projectId || !Array.isArray(project.events) || !Array.isArray(project.history))
    throw new Error('Management maintenance project is invalid')
  const notifications = await json(path.join(paths.authDirectory, 'management-notifications.json'), true)
  if (notifications !== undefined && (!notifications || typeof notifications !== 'object' ||
    !Array.isArray((notifications as ObjectValue).notifications))) throw new Error('Management maintenance notifications are invalid')
  return managementAssetReferences(project, notifications)
}
/** Caller holds the management dataset lock. Each pass is bounded, cursored,
 * and never follows directory/file links or traverses unknown filenames. */
export async function sweepManagementUploads(paths: Paths, options: {
  now?: number; afterProject?: string; maxProjects?: number; maxFiles?: number
} = {}): Promise<{ removedFiles: number; removedBytes: number; nextProject?: string }> {
  const now = options.now ?? Date.now(), maxProjects = Math.max(1, Math.min(options.maxProjects ?? 8, 32)),
    maxFiles = Math.max(1, Math.min(options.maxFiles ?? 128, 512))
  let removedFiles = 0, removedBytes = 0
  if (!await safeRoots(paths)) return { removedFiles, removedBytes }
  const assetRoot = path.join(paths.dataDirectory, 'management-assets')
  const projectIds = (await fs.readdir(assetRoot)).filter(id => PROJECT_ID.test(id)).sort()
  const selected = projectIds.filter(id => !options.afterProject || id > options.afterProject).slice(0, maxProjects)
  let lastProject: string | undefined
  for (const projectId of selected) {
    if (removedFiles >= maxFiles) break
    lastProject = projectId
    const assetDirectory = path.join(assetRoot, projectId)
    if (!await directory(assetDirectory)) continue
    let protectedIds: Set<string>
    try { protectedIds = await references(paths, projectId) } catch { continue } // No deletion when reachability is uncertain.
    const files = (await fs.readdir(assetDirectory)).sort()
    for (const filename of files) {
      if (removedFiles >= maxFiles) { lastProject = undefined; break }
      const match = filename.match(ASSET_FILE)
      if (!match || match[2] === 'json' || protectedIds.has(match[1]!)) continue
      const full = path.join(assetDirectory, filename), stat = await regular(full)
      if (!stat || now - stat.mtimeMs < MANAGEMENT_UPLOAD_GRACE_MS) continue
      const assetId = match[1]!, metadataFile = path.join(assetDirectory, `${assetId}.json`)
      let metadata: ObjectValue | undefined
      try { metadata = await json(metadataFile, true) as ObjectValue | undefined } catch { continue }
      if (metadata && (metadata.id !== assetId || metadata.projectId !== projectId || metadata.file !== filename ||
          !Number.isSafeInteger(metadata.createdAt) || now - (metadata.createdAt as number) < MANAGEMENT_UPLOAD_GRACE_MS)) continue
      // Metadata symlinks/nonregular files must not turn into an apparent missing file.
      if (!metadata && await fs.lstat(metadataFile).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error
      })) continue
      await fs.unlink(full); removedFiles++; removedBytes += stat.size
      if (metadata && removedFiles < maxFiles) {
        const metadataStat = await regular(metadataFile)
        if (metadataStat) { await fs.unlink(metadataFile); removedFiles++; removedBytes += metadataStat.size }
      }
    }
    // A crash may have removed the binary before metadata. Clean only a matching
    // old ordinary metadata file that has no reference and no matching binary.
    for (const filename of files) {
      if (removedFiles >= maxFiles) { lastProject = undefined; break }
      if (!filename.endsWith('.json') || !ASSET_ID.test(filename.slice(0, -5)) || protectedIds.has(filename.slice(0, -5))) continue
      const full = path.join(assetDirectory, filename), stat = await regular(full)
      if (!stat || now - stat.mtimeMs < MANAGEMENT_UPLOAD_GRACE_MS) continue
      let metadata: ObjectValue
      try { metadata = await json(full) as ObjectValue } catch { continue }
      if (!metadata || metadata.id !== filename.slice(0, -5) || metadata.projectId !== projectId ||
          typeof metadata.file !== 'string' || !ASSET_FILE.test(metadata.file) || !metadata.file.startsWith(`${metadata.id}.`) ||
          !Number.isSafeInteger(metadata.createdAt) || now - (metadata.createdAt as number) < MANAGEMENT_UPLOAD_GRACE_MS) continue
      if (await fs.lstat(path.join(assetDirectory, metadata.file)).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error
      })) continue
      await fs.unlink(full); removedFiles++; removedBytes += stat.size
    }
  }
  const remaining = lastProject !== undefined && projectIds.some(id => id > lastProject!)
  return { removedFiles, removedBytes, ...(remaining ? { nextProject: lastProject } : {}) }
}
/** Pending uploads are temporary, yet their grace must not allow limitless
 * abandoned files. Saved current/history/notification assets never count here. */
export async function managementPendingUploads(paths: Paths, projectId: string): Promise<{ count: number; bytes: number; directoryFull?: true }> {
  if (!PROJECT_ID.test(projectId)) throw new Error('Management upload project identifier is invalid')
  // Missing roots are normal before a project's first upload. An existing
  // symlink/non-directory is never permission to write through that path.
  for (const full of [paths.dataDirectory, paths.authDirectory, path.join(paths.dataDirectory, 'management'),
    path.join(paths.dataDirectory, 'management', 'projects'), path.join(paths.dataDirectory, 'management-assets')]) {
    const stat = await fs.lstat(full).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!stat) return { count: 0, bytes: 0 }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Management upload directory must be an ordinary directory')
  }
  const assetDirectory = path.join(paths.dataDirectory, 'management-assets', projectId)
  const assetStat = await fs.lstat(assetDirectory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  if (!assetStat) return { count: 0, bytes: 0 }
  if (!assetStat.isDirectory() || assetStat.isSymbolicLink()) throw new Error('Management upload directory must be an ordinary directory')
  const files = await fs.readdir(assetDirectory)
  if (files.length >= MANAGEMENT_PROJECT_UPLOAD_FILES) return { count: 0, bytes: 0, directoryFull: true }
  const protectedIds = await references(paths, projectId)
  let count = 0, bytes = 0
  for (const filename of files) {
    const match = filename.match(ASSET_FILE)
    if (!match || match[2] === 'json' || protectedIds.has(match[1]!)) continue
    const stat = await regular(path.join(assetDirectory, filename))
    if (stat) { count++; bytes += stat.size }
  }
  return { count, bytes }
}
