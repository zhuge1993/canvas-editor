import type { AIDataExport, AIShareScope, ManagementAttachment, ManagementEvent, ManagementProject, ManagementStats } from './managementTypes.js'
import { MANAGEMENT_STATUS_LABELS, ManagementWorkflowError, validateManagementStageMetadata } from './managementWorkflow.js'

export interface ExportCanvas { id: string; title: string; canvas?: unknown; content?: string; thumbnail?: string }
export interface ManagementExportInput {
  kind: 'management' | 'canvas'; resourceId: string; scope: AIShareScope
  project?: ManagementProject; canvases: ExportCanvas[]; assets: ManagementAttachment[]
  assetUrls: Record<string, string>; baseUrl: string; now: number; stats?: ManagementStats
  offset: number; limit: number; historyOffset: number; historyLimit: number
}

type JsonRecord = Record<string, unknown>
const record = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const LEGACY_ASSET = /^\/api\/assets\/[a-f0-9]{16,64}\.(?:png|jpg|jpeg|webp|gif)$/i
const ENABLED = (value: boolean | undefined) => value !== false
interface AssetPolicy { enabled: boolean; urls: Record<string, string>; assets: Map<string, ManagementAttachment>; hideCommunication?: boolean }
const PRIVATE_COMMUNICATION = new Set(['recipientIds', 'memberIds', 'members', 'access', 'notifications', 'inbox', 'notificationReceipts', 'recipients'])

function sanitizedText(value: string, policy: AssetPolicy): string {
  if (policy.urls[value]) return policy.urls[value]!
  if (/^data:image\//i.test(value)) return ''
  return value.replace(/\/api\/assets\/[a-f0-9]{16,64}\.(?:png|jpg|jpeg|webp|gif)\b/gi,
    ref => policy.urls[ref] ?? '[asset omitted]')
    .replace(/\/api\/management\/projects\/[A-Za-z0-9_-]+\/assets\/[A-Za-z0-9_-]+/g,
      ref => policy.urls[ref] ?? '[asset omitted]')
    .replace(/data:image\/[^\s"'<>)]*/gi, '[image omitted]')
}

function attachmentHistory(value: unknown, policy: AssetPolicy): unknown {
  if (!policy.enabled || !Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!record(item) || typeof item.url !== 'string') return []
    const url = policy.urls[item.url] ?? item.url
    const asset = policy.assets.get(url)
    return asset ? [{ ...asset }] : []
  })
}

function jsonCopy(value: unknown, policy?: AssetPolicy, depth = 0, budget = { left: 500000 }): unknown {
  if (--budget.left < 0 || depth > 100) throw new Error('Canvas JSON exceeds export complexity limits')
  if (typeof value === 'string' && policy) return sanitizedText(value, policy)
  if (Array.isArray(value)) return value.map(item => jsonCopy(item, policy, depth + 1, budget))
  if (!record(value)) return value
  const copy: JsonRecord = Object.create(null)
  for (const [key, item] of Object.entries(value)) {
    if (policy?.hideCommunication && PRIVATE_COMMUNICATION.has(key)) continue
    if (policy && (key === 'src' || key === 'thumbnail') && typeof item === 'string')
      copy[key] = policy.urls[item] ?? (policy.assets.has(item) ? item : '')
    else if (policy && (key === 'attachments' || ((key === 'before' || key === 'after') && value.field === 'attachments')))
      copy[key] = attachmentHistory(item, policy)
    else copy[key] = jsonCopy(item, policy, depth + 1, budget)
  }
  return copy
}

function canvasData(canvas: ExportCanvas): unknown {
  if (canvas.canvas !== undefined) return canvas.canvas
  if (typeof canvas.content === 'string') {
    try { return JSON.parse(canvas.content) } catch { return canvas.content }
  }
  return null
}

/** No filesystem, network or data-URI decoding. Only exact legacy asset refs. */
export function collectCanvasAssetRefs(canvas: unknown): string[] {
  const refs = new Set<string>()
  let budget = 500000
  function visit(value: unknown, depth: number): void {
    if (--budget < 0 || depth > 100) throw new Error('Canvas JSON exceeds export complexity limits')
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    if (!record(value)) return
    for (const [key, item] of Object.entries(value)) {
      if (key === 'src' && typeof item === 'string' && LEGACY_ASSET.test(item)) refs.add(item)
      else visit(item, depth + 1)
    }
  }
  visit(canvas, 0)
  return [...refs]
}

function tokenAssetUrl(value: string): boolean {
  try {
    const url = new URL(value, 'https://relative.invalid')
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password &&
      !url.search && !url.hash && /^\/ai\/[A-Za-z0-9_-]{8,160}\/assets\/[A-Za-z0-9_.-]{1,200}$/.test(url.pathname)
  } catch { return false }
}

function exportUrls(baseUrl: string): { base: string; markdownUrl: string; jsonUrl: string } {
  const url = new URL(baseUrl)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash ||
      !/^\/ai\/[A-Za-z0-9_-]{8,160}\/?$/.test(url.pathname)) throw new Error('Invalid AI export base URL')
  const base = url.origin + url.pathname.replace(/\/$/, '')
  return { base, markdownUrl: base, jsonUrl: base + '/data.json' }
}

function safeAssetMap(input: ManagementExportInput, base: string): Record<string, string> {
  const urls: Record<string, string> = Object.create(null)
  const expected = new URL(base)
  for (const [source, target] of Object.entries(input.assetUrls)) {
    if (!tokenAssetUrl(target)) continue
    const url = new URL(target, base)
    if (url.origin === expected.origin && url.pathname.startsWith(expected.pathname + '/assets/')) urls[source] = url.href
  }
  return urls
}

function page(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : fallback
}

function transitionNote(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 2000 || /\0/.test(value))
    throw new ManagementWorkflowError('流转说明必须是不超过2000字的文本')
  return value
}

export function buildManagementExport(input: ManagementExportInput): AIDataExport {
  const urls = exportUrls(input.baseUrl)
  if (input.kind === 'management' && (!input.project || input.project.id !== input.resourceId)) throw new Error('Management export resource mismatch')
  const permitted = new Set(input.kind === 'canvas' ? [input.resourceId] : input.project!.canvasIds)
  const requested = input.scope.canvasIds === undefined ? permitted : new Set(input.scope.canvasIds.filter(id => permitted.has(id)))
  const selectedCanvases = input.canvases.filter(canvas => permitted.has(canvas.id) && requested.has(canvas.id))
  const mapped = ENABLED(input.scope.includeAttachments) ? safeAssetMap(input, urls.base) : Object.create(null) as Record<string, string>
  const eventSelection = input.scope.eventIds === undefined ? undefined : new Set(input.scope.eventIds)
  const selectedEvents = input.kind === 'management'
    ? input.project!.events.filter(event => eventSelection === undefined || eventSelection.has(event.id)) : []
  const selectedEventIds = new Set(selectedEvents.map(event => event.id))
  const selectedHistory = input.kind === 'management' && ENABLED(input.scope.includeHistory)
    ? input.project!.history.filter(entry => !entry.eventId || selectedEventIds.has(entry.eventId)) : []
  const offset = page(input.offset, 0, Number.MAX_SAFE_INTEGER)
  const limit = Math.max(1, page(input.limit, 100, 500))
  const historyOffset = page(input.historyOffset, 0, Number.MAX_SAFE_INTEGER)
  const historyLimit = Math.max(1, page(input.historyLimit, 100, 500))
  const nextPage = (eventOffset: number, auditOffset: number) => urls.jsonUrl + '?' + new URLSearchParams({
    offset: String(eventOffset), limit: String(limit), historyOffset: String(auditOffset), historyLimit: String(historyLimit),
  }).toString()
  const attachmentUrls = new Set(selectedEvents.flatMap(event => event.attachments.map(asset => mapped[asset.url] ?? asset.url)))
  const referencedUrls = new Set(selectedCanvases.flatMap(canvas => collectCanvasAssetRefs(canvasData(canvas))).map(ref => mapped[ref]).filter(Boolean))
  const assets = ENABLED(input.scope.includeAttachments) ? input.assets.flatMap(asset => {
    if (!tokenAssetUrl(asset.url)) return []
    const url = new URL(asset.url, urls.base), expected = new URL(urls.base)
    if (url.origin !== expected.origin || !url.pathname.startsWith(expected.pathname + '/assets/') ||
        (!attachmentUrls.has(url.href) && !referencedUrls.has(url.href))) return []
    return [{ id: asset.id, name: asset.name, mime: asset.mime, bytes: asset.bytes, url: url.href, createdAt: asset.createdAt }]
  }) : []
  const assetByUrl = new Map(assets.map(asset => [asset.url, asset]))
  const allowedMap: Record<string, string> = Object.create(null)
  for (const [source, target] of Object.entries(mapped)) if (assetByUrl.has(target)) allowedMap[source] = target
  const policy: AssetPolicy = { enabled: ENABLED(input.scope.includeAttachments), urls: allowedMap, assets: assetByUrl }
  const events: ManagementEvent[] = selectedEvents.slice(offset, offset + limit).map(event => jsonCopy({
    id: event.id, title: event.title, description: event.description, roleId: event.roleId, categoryId: event.categoryId,
    source: event.source, recorder: event.recorder, assignee: event.assignee, priority: event.priority, status: event.status,
    createdAt: event.createdAt, updatedAt: event.updatedAt,
    ...validateManagementStageMetadata(event),
    ...(event.transitionNote === undefined ? {} : { transitionNote: transitionNote(event.transitionNote) }),
    ...(event.completedAt === undefined ? {} : { completedAt: event.completedAt }),
    ...(event.values === undefined ? {} : { values: Object.fromEntries(
      (input.project?.tableConfig?.customFields ?? []).filter(field => !field.roleId || field.roleId === event.roleId)
        .filter(field => Object.hasOwn(event.values!, field.id)).map(field => [field.id, event.values![field.id]])) }),
    attachments: ENABLED(input.scope.includeAttachments) ? event.attachments.flatMap(asset => {
      const allowed = assetByUrl.get(allowedMap[asset.url] ?? asset.url)
      return allowed ? [{ ...allowed }] : []
    }) : [],
  }, policy) as ManagementEvent)
  const result: AIDataExport = {
    kind: input.kind, name: sanitizedText(input.project?.name ?? input.canvases.find(canvas => canvas.id === input.resourceId)?.title ?? input.resourceId, policy),
    description: input.kind === 'management' ? sanitizedText(input.project!.description, policy) : '',
    canvases: selectedCanvases.map(canvas => ({ id: canvas.id, title: sanitizedText(canvas.title, policy),
      jsonUrl: urls.base + '/canvases/' + encodeURIComponent(canvas.id) + '.json',
      ...(ENABLED(input.scope.includePreview) ? { previewUrl: urls.base + '/canvases/' + encodeURIComponent(canvas.id) + '/preview.svg' } : {}),
    })), assets: assets.map(asset => ({ ...asset })), markdownUrl: urls.markdownUrl, jsonUrl: urls.jsonUrl, generatedAt: input.now,
  }
  if (input.kind === 'canvas' && selectedCanvases.length) result.canvas = jsonCopy(canvasData(selectedCanvases[0]!), policy)
  if (input.kind === 'management') {
    const project = input.project!
    result.project = jsonCopy({ id: project.id, name: project.name, description: project.description, color: project.color, icon: project.icon,
      roles: project.roles.map(role => ({ id: role.id, name: role.name, color: role.color })),
      categories: project.categories.map(category => ({ id: category.id, name: category.name, color: category.color })),
      canvasIds: selectedCanvases.map(canvas => canvas.id), createdAt: project.createdAt, updatedAt: project.updatedAt,
      ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }), revision: project.revision }, policy) as AIDataExport['project']
    if (project.tableConfig) result.project!.tableConfig = jsonCopy({
      configured: project.tableConfig.configured,
      visibleBaseFields: project.tableConfig.visibleBaseFields.filter(field => field !== 'recipients'),
      baseLabels: Object.fromEntries(Object.entries(project.tableConfig.baseLabels).filter(([field]) => field !== 'recipients')),
      customFields: project.tableConfig.customFields.map(field => ({ id: field.id, name: field.name, type: field.type,
        ...(field.required === undefined ? {} : { required: field.required }),
        ...(field.roleId === undefined ? {} : { roleId: field.roleId }),
        ...(field.options === undefined ? {} : { options: [...field.options] }) })),
    }, policy) as NonNullable<ManagementProject['tableConfig']>
    result.events = events
    result.pagination = { offset, limit, total: selectedEvents.length,
      ...(offset + limit < selectedEvents.length ? { nextUrl: nextPage(offset + limit, historyOffset) } : {}) }
    if (ENABLED(input.scope.includeHistory)) {
      result.history = selectedHistory.slice(historyOffset, historyOffset + historyLimit).map(entry => jsonCopy({ ...entry,
        ...(entry.note === undefined ? {} : { note: transitionNote(entry.note) }),
        changes: entry.changes.filter(change => !PRIVATE_COMMUNICATION.has(change.field)) },
      { ...policy, hideCommunication: true }) as typeof entry)
      result.historyPagination = { offset: historyOffset, limit: historyLimit, total: selectedHistory.length,
        ...(historyOffset + historyLimit < selectedHistory.length ? { nextUrl: nextPage(offset, historyOffset + historyLimit) } : {}) }
    }
    if (ENABLED(input.scope.includeStats) && input.stats) result.stats = jsonCopy(input.stats, policy) as ManagementStats
  }
  return result
}

function markdown(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&').replace(/\r\n?/g, '\n')
}

function link(label: string, url: string): string { return `[${markdown(label)}](<${url.replace(/>/g, '%3E').replace(/</g, '%3C')}>)` }

export function renderManagementMarkdown(data: AIDataExport): string {
  const lines = [`# ${markdown(data.name)}`, '', markdown(data.description), '', '## Directory', '',
    `- ${link('Structured JSON', data.jsonUrl)}`, `- ${link('Markdown', data.markdownUrl)}`]
  for (const canvas of data.canvases) lines.push(`- ${link(canvas.title, canvas.jsonUrl)}${canvas.previewUrl ? ' | ' + link('SVG preview', canvas.previewUrl) : ''}`)
  if (data.assets.length) {
    lines.push('', '## Included assets', '')
    for (const asset of data.assets) lines.push(`- ${link(asset.name, asset.url)} (${markdown(asset.mime)}, ${asset.bytes} bytes)`)
  }
  if (data.stats) {
    lines.push('', '## Scoped statistics', '', `Total: ${data.stats.total}; active: ${data.stats.activeTotal}; cancelled: ${data.stats.cancelled}; completion: ${data.stats.completionPercent}%.`)
    for (const stage of data.stats.byStatus ?? []) lines.push(`- ${markdown(stage.label)} (${markdown(stage.id)}): ${stage.count}`)
    if (data.stats.byRole.length) lines.push('', '### Role statistics', '')
    for (const role of data.stats.byRole) {
      lines.push(`- ${markdown(role.name)}: ${role.count} total; ${role.activeCount} active; handling ${role.handlingMs} ms (including the current interval).`)
      for (const [stage, count] of Object.entries(role.statusCounts ?? {}))
        lines.push(`  - ${markdown(MANAGEMENT_STATUS_LABELS[stage as keyof typeof MANAGEMENT_STATUS_LABELS] ?? stage)}: ${count} events; ${role.stageDurationMs?.[stage as keyof typeof MANAGEMENT_STATUS_LABELS] ?? 0} ms observed.`)
    }
  }
  if (data.events) {
    const pagination = data.pagination!
    lines.push('', '## Events', '', `Page offset ${pagination.offset}; ${data.events.length} of ${pagination.total} included events.`)
    const roles = new Map(data.project?.roles.map(role => [role.id, role.name]) ?? [])
    const categories = new Map(data.project?.categories.map(category => [category.id, category.name]) ?? [])
    for (const event of data.events) {
      lines.push('', `### ${markdown(event.title)}`, '',
        `ID: ${markdown(event.id)}; status: ${markdown(event.status)} (${markdown(MANAGEMENT_STATUS_LABELS[event.status] ?? event.status)}); priority: ${markdown(event.priority)}.`,
        `Role: ${markdown(roles.get(event.roleId) ?? event.roleId)}; category: ${markdown(categories.get(event.categoryId) ?? event.categoryId)}.`,
        `Source: ${markdown(event.source)}; recorder: ${markdown(event.recorder)}; assignee: ${markdown(event.assignee)}.`,
        '', markdown(event.description))
      if (event.transitionNote !== undefined) lines.push(`Stage transition note: ${markdown(transitionNote(event.transitionNote))}`)
      if (event.stageChangedAt !== undefined) lines.push(`Current stage entered: ${markdown(new Date(event.stageChangedAt).toISOString())}.`)
      for (const [stage, duration] of Object.entries(event.stageTimes ?? {}))
        lines.push(`- ${markdown(MANAGEMENT_STATUS_LABELS[stage as keyof typeof MANAGEMENT_STATUS_LABELS] ?? stage)}: ${duration} ms in completed intervals.`)
      for (const asset of event.attachments) lines.push(`- ${link(asset.name, asset.url)}`)
      const fieldNames = new Map(data.project?.tableConfig?.customFields.map(field => [field.id, field.name]) ?? [])
      for (const [field, value] of Object.entries(event.values ?? {}))
        lines.push(`- ${markdown(fieldNames.get(field) ?? field)}: ${markdown(value)}`)
    }
    if (pagination.nextUrl) lines.push('', `Next event page: ${link('Continue events', pagination.nextUrl)}`)
  }
  if (data.history) {
    const pagination = data.historyPagination!
    lines.push('', '## Included history', '', `Page offset ${pagination.offset}; ${data.history.length} of ${pagination.total} included entries.`)
    for (const entry of data.history) lines.push(`- ${markdown(new Date(entry.at).toISOString())}: ${markdown(entry.action)}${entry.eventId ? ' (' + markdown(entry.eventId) + ')' : ''}${entry.actorName ? '; actor: ' + markdown(entry.actorName) : ''}${entry.note !== undefined ? '; note: ' + markdown(transitionNote(entry.note)) : ''}; ${markdown(JSON.stringify(entry.changes))}`)
    if (pagination.nextUrl) lines.push('', `Next history page: ${link('Continue history', pagination.nextUrl)}`)
  }
  if (data.canvas !== undefined) lines.push('', 'The structured JSON retains the selected native canvas nodes, positions, styles, text and groups. The SVG link is a static preview.')
  return lines.join('\n') + '\n'
}

function xml(value: unknown): string {
  const valid = Array.from(String(value ?? '')).map(char => {
    const code = char.codePointAt(0)!
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xD7FF) ||
      (code >= 0xE000 && code <= 0xFFFD) || code >= 0x10000 ? char : '\uFFFD'
  }).join('')
  return valid.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function number(value: unknown, fallback = 0, max = 1e7): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(-max, value)) : fallback
}

function paint(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const color = value.trim()
  return /^(?:#[a-f0-9]{3,8}|[a-z]{1,30}|(?:rgb|rgba|hsl|hsla)\([0-9.,% +\/-]+\))$/i.test(color) ? color : fallback
}

/** Static SVG only. Unsupported shapes keep their bounds/text; native JSON is exact. */
export function renderCanvasPreview(canvas: unknown, assetUrls: Record<string, string>): string {
  const source = record(canvas) ? canvas : {}
  const shapes = record(source.shapes) ? source.shapes : {}
  const groups = record(source.groups) ? source.groups : {}
  if (Object.keys(shapes).length > 10000) throw new Error('Canvas exceeds SVG preview complexity limits')
  const ordered: JsonRecord[] = [], seen = new Set<string>(), visiting = new Set<string>()
  function visit(id: string, hidden = false, depth = 0): void {
    if (depth > 100 || seen.size > 100000) throw new Error('Canvas group exceeds SVG preview complexity limits')
    if (visiting.has(id)) throw new Error('Canvas group cycle in SVG preview')
    if (seen.has(id)) return
    seen.add(id)
    const group = groups[id]
    if (record(group) && Array.isArray(group.childIds)) {
      visiting.add(id)
      for (const child of group.childIds) if (typeof child === 'string') visit(child, hidden || group.visible === false, depth + 1)
      visiting.delete(id)
      return
    }
    const shape = shapes[id]
    if (record(shape) && !hidden && shape.visible !== false) ordered.push(shape)
  }
  if (Array.isArray(source.order)) for (const id of source.order) if (typeof id === 'string') visit(id)
  for (const id of Object.keys(shapes)) if (!seen.has(id)) visit(id)
  const workspace = record(source.workspace) ? source.workspace : {}
  const x = number(workspace.x), y = number(workspace.y)
  const width = Math.max(1, number(workspace.w, 1200)), height = Math.max(1, number(workspace.h, 800))
  const body = ordered.map(shape => {
    const sx = number(shape.x), sy = number(shape.y), w = Math.max(0, number(shape.w)), h = Math.max(0, number(shape.h))
    const fill = xml(paint(shape.fill, 'none')), stroke = xml(paint(shape.stroke, '#444'))
    const opacity = Math.max(0, Math.min(1, number(shape.opacity, 1, 1)))
    const common = `fill="${fill}" stroke="${stroke}" stroke-width="${Math.max(0, number(shape.strokeWidth, 1, 1000))}" opacity="${opacity}"`
    const rotation = number(shape.rotation, 0, 36000)
    const transform = rotation ? ` transform="rotate(${rotation} ${sx+w/2} ${sy+h/2})"` : ''
    let geometry = ''
    if (shape.type === 'circle' || shape.type === 'ellipse') geometry = `<ellipse cx="${sx+w/2}" cy="${sy+h/2}" rx="${w/2}" ry="${h/2}" ${common}/>`
    else if (shape.type === 'diamond') geometry = `<polygon points="${sx+w/2},${sy} ${sx+w},${sy+h/2} ${sx+w/2},${sy+h} ${sx},${sy+h/2}" ${common}/>`
    else if (shape.type === 'triangle') geometry = `<polygon points="${sx+w/2},${sy} ${sx+w},${sy+h} ${sx},${sy+h}" ${common}/>`
    else if (shape.type === 'line' || shape.type === 'arrow' || shape.type === 'draw') {
      const points = Array.isArray(shape.points) ? shape.points : [[0, 0], [w, h]]
      if (points.length > 100000) throw new Error('Canvas path exceeds SVG preview complexity limits')
      const path = points.filter(Array.isArray).map((point, index) => `${index ? 'L' : 'M'}${sx+number(point[0])},${sy+number(point[1])}`).join(' ')
      geometry = `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${Math.max(0, number(shape.strokeWidth, 1, 1000))}" opacity="${opacity}"/>`
    } else if (shape.type === 'image') {
    const href = typeof shape.src === 'string' ? assetUrls[shape.src] : undefined
      // A static preview uses a same-origin token route even when the caller's
      // public mapping is absolute. No external host can be fetched by SVG.
      const localHref = href && tokenAssetUrl(href) ? new URL(href, 'https://relative.invalid').pathname : undefined
      geometry = localHref ? `<image x="${sx}" y="${sy}" width="${w}" height="${h}" href="${xml(localHref)}" opacity="${opacity}"/>`
        : `<rect x="${sx}" y="${sy}" width="${w}" height="${h}" fill="#eeeeee" stroke="#888888"/>`
    } else if (shape.type !== 'text') geometry = `<rect x="${sx}" y="${sy}" width="${w}" height="${h}" rx="${Math.max(0, Math.min(w/2, h/2, number(shape.cornerRadius)))}" ${common}/>`
    const fontSize = Math.max(1, number(shape.fontSize, 16, 1000))
    const align = shape.textAlign === 'left' ? 'start' : shape.textAlign === 'right' ? 'end' : 'middle'
    const tx = align === 'start' ? sx : align === 'end' ? sx+w : sx+w/2
    const text = typeof shape.text === 'string' ? shape.text.split('\n') : []
    const textSvg = text.map((line, index) => `<text x="${tx}" y="${sy+fontSize+index*fontSize*Math.max(0.5, number(shape.lineHeight, 1.3, 10))}" font-size="${fontSize}" font-family="${xml(typeof shape.fontFamily === 'string' ? shape.fontFamily : 'system-ui,sans-serif')}" font-weight="${shape.fontWeight === 'bold' ? 'bold' : 'normal'}" text-anchor="${align}" fill="${xml(paint(shape.textColor, '#111'))}" opacity="${opacity}">${xml(line)}</text>`).join('')
    return `<g${transform}>${geometry}${textSvg}</g>`
  }).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${xml(paint(source.backgroundColor, '#ffffff'))}"/>${body}</svg>`
}
