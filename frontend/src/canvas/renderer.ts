import type {
  ArrowShape,
  Camera,
  ConnectionAnchor,
  DrawShape,
  ImageShape,
  Shape,
  ShapeGroup,
  WorkspaceBounds,
} from './types'
import { collectShapeDescendants, isArrowShape, isDrawShape, isImageShape, resolveGeoRatio } from './types'

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

export interface Handle {
  x: number
  y: number
  type: string
}

const imageCache = new Map<string, HTMLImageElement>()
/** 加载失败的图片 src，用于区分"加载中"与"加载失败" */
const imageErrorCache = new Set<string>()
/**
 * 外置图片（/api/assets/...）需要网络请求，是异步加载的。
 * 画布只在"脏标记"时重绘，因此加载完成后必须主动通知画布重绘，
 * 否则会一直停留在"图片加载中"占位。
 */
let imageLoadListener: (() => void) | null = null

export function setImageLoadListener(listener: (() => void) | null): void {
  imageLoadListener = listener
}
// 运行环境可能在画布创建后替换 fillText。保存原型引用并在实际调用时降级，
// 避免递归包装函数让渲染帧循环持续抛出 RangeError。
const protoFillText = typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype.fillText : null
let canRenderText = protoFillText !== null
const protoStrokeText = typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype.strokeText : null
let activeTextStroke: { color: string; width: number } | null = null

function fillTextSafe(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
  if (!canRenderText || !protoFillText) return
  try {
    if (activeTextStroke && protoStrokeText) {
      ctx.strokeStyle = activeTextStroke.color
      ctx.lineWidth = activeTextStroke.width
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      if (maxWidth === undefined) protoStrokeText.call(ctx, text, x, y)
      else protoStrokeText.call(ctx, text, x, y, maxWidth)
    }
    if (maxWidth === undefined) protoFillText.call(ctx, text, x, y)
    else protoFillText.call(ctx, text, x, y, maxWidth)
  } catch {
    canRenderText = false
  }
}

export function render(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  selectedIds: string[],
  camera: Camera,
  gridVisible: boolean,
  width: number,
  height: number,
  groups: Record<string, ShapeGroup> = {},
  selectedGroupIds: string[] = [],
  workspace?: WorkspaceBounds,
  selectionBox?: Bounds | null,
  readOnly = false,
  canvasBackground = '#fafafa',
  gridSize = 20,
) {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = workspace ? '#eef1f5' : canvasBackground
  ctx.fillRect(0, 0, width, height)
  ctx.save()
  ctx.translate(camera.x, camera.y)
  ctx.scale(camera.zoom, camera.zoom)
  if (workspace) drawWorkspace(ctx, workspace, gridVisible, camera, width, height, canvasBackground, gridSize)
  const shapeById = Object.fromEntries(shapes.map((shape) => [shape.id, shape]))
  // 可视区裁剪：计算视口对应的世界坐标矩形，跳过完全在视口外的形状（大文档性能关键）。
  const viewportLeft = -camera.x / camera.zoom - 64
  const viewportTop = -camera.y / camera.zoom - 64
  const viewportRight = (width - camera.x) / camera.zoom + 64
  const viewportBottom = (height - camera.y) / camera.zoom + 64
  const isVisible = (shape: Shape) => {
    // 旋转形状按外接包围盒判定；留 64px 余量避免边缘闪烁。
    if (shape.w <= 0 || shape.h <= 0) return shape.x <= viewportRight && shape.x + shape.w >= viewportLeft && shape.y <= viewportBottom && shape.y + shape.h >= viewportTop
    const radius = Math.sqrt(shape.w * shape.w + shape.h * shape.h) / 2
    const centerX = shape.x + shape.w / 2
    const centerY = shape.y + shape.h / 2
    return centerX + radius >= viewportLeft && centerX - radius <= viewportRight && centerY + radius >= viewportTop && centerY - radius <= viewportBottom
  }
  // 只画选中的顶层分组的包围框（避免子分组也画框，保持视觉整洁）。
  for (const groupId of selectedGroupIds) {
    const group = groups[groupId]
    if (group && group.parentId === undefined) drawGroup(ctx, group, shapeById, groups, camera.zoom)
  }
  for (const shape of shapes) if (shape.visible && isVisible(shape)) drawShape(ctx, shape, shapeById)
  if (readOnly) {
    for (const shape of shapes) {
      if (shape.visible && shape.description) drawPlanBadge(ctx, shape.x + shape.w, shape.y, camera.zoom)
    }
    for (const group of Object.values(groups)) {
      if (group.visible && group.description) {
        const bounds = getGroupBounds(group, shapeById, groups)
        if (bounds) drawPlanBadge(ctx, bounds.x + bounds.w + 18, bounds.y - 18, camera.zoom)
      }
    }
  }
  const selectedShapes = selectedIds.map((id) => shapeById[id]).filter(Boolean) as Shape[]
  if (selectedShapes.length > 0) drawSelection(ctx, selectedShapes, shapeById, camera.zoom)
  for (const groupId of selectedGroupIds) {
    const bounds = getGroupBounds(groups[groupId], shapeById, groups)
    if (bounds) drawGroupSelection(ctx, bounds, camera.zoom)
  }
  if (selectionBox) drawSelectionBox(ctx, selectionBox, camera.zoom)
  ctx.restore()
}

function drawWorkspace(
  ctx: CanvasRenderingContext2D,
  workspace: WorkspaceBounds,
  gridVisible: boolean,
  camera: Camera,
  viewportWidth: number,
  viewportHeight: number,
  canvasBackground = '#fafafa',
  gridSize = 20,
) {
  ctx.save()
  ctx.fillStyle = canvasBackground
  ctx.fillRect(workspace.x, workspace.y, workspace.w, workspace.h)
  if (gridVisible) {
    const visibleLeft = Math.max(workspace.x, -camera.x / camera.zoom)
    const visibleTop = Math.max(workspace.y, -camera.y / camera.zoom)
    const visibleRight = Math.min(workspace.x + workspace.w, (viewportWidth - camera.x) / camera.zoom)
    const visibleBottom = Math.min(workspace.y + workspace.h, (viewportHeight - camera.y) / camera.zoom)
    const firstX = workspace.x + Math.max(0, Math.ceil((visibleLeft - workspace.x) / gridSize)) * gridSize
    const firstY = workspace.y + Math.max(0, Math.ceil((visibleTop - workspace.y) / gridSize)) * gridSize
    ctx.strokeStyle = '#e4e7ec'
    ctx.lineWidth = 1 / camera.zoom
    ctx.beginPath()
    for (let x = firstX; x <= visibleRight; x += gridSize) {
      ctx.moveTo(x, visibleTop)
      ctx.lineTo(x, visibleBottom)
    }
    for (let y = firstY; y <= visibleBottom; y += gridSize) {
      ctx.moveTo(visibleLeft, y)
      ctx.lineTo(visibleRight, y)
    }
    ctx.stroke()
  }
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 1 / camera.zoom
  ctx.strokeRect(workspace.x, workspace.y, workspace.w, workspace.h)
  ctx.restore()
}

export function getGroupBounds(group: ShapeGroup | undefined, shapes: Record<string, Shape>, groups?: Record<string, ShapeGroup>): Bounds | null {
  if (!group) return null
  // 递归收集所有后代图形来计算包围盒。
  const childShapes = groups
    ? collectShapeDescendants(group.id, groups).map((id) => shapes[id]).filter(Boolean) as Shape[]
    : group.childIds.map((id) => shapes[id]).filter(Boolean) as Shape[]
  return getSelectionBounds(childShapes)
}

export function hitTestGroup(group: ShapeGroup | undefined, shapes: Record<string, Shape>, px: number, py: number, threshold = 10): boolean {
  const bounds = getGroupBounds(group, shapes)
  if (!bounds) return false
  const outer = { x: bounds.x - 18 - threshold, y: bounds.y - 18 - threshold, w: bounds.w + 36 + threshold * 2, h: bounds.h + 36 + threshold * 2 }
  return px >= outer.x && px <= outer.x + outer.w && py >= outer.y && py <= outer.y + outer.h
}


function drawGroup(ctx: CanvasRenderingContext2D, group: ShapeGroup, shapes: Record<string, Shape>, groups: Record<string, ShapeGroup>, zoom: number) {
  if (!group.visible) return
  const childShapes = collectShapeDescendants(group.id, groups).map((id) => shapes[id]).filter((shape) => shape?.visible) as Shape[]
  const bounds = getSelectionBounds(childShapes)
  if (!bounds) return
  const padding = 18
  ctx.save()
  ctx.strokeStyle = group.stroke ?? (group.locked ? '#ef4444' : '#94a3b8')
  ctx.fillStyle = group.fill ?? 'rgba(255,255,255,0.46)'
  ctx.lineWidth = 1 / zoom
  ctx.setLineDash([6 / zoom, 4 / zoom])
  ctx.fillRect(bounds.x - padding, bounds.y - padding, bounds.w + padding * 2, bounds.h + padding * 2)
  ctx.strokeRect(bounds.x - padding, bounds.y - padding, bounds.w + padding * 2, bounds.h + padding * 2)
  ctx.setLineDash([])
  ctx.font = `${12 / zoom}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  ctx.fillStyle = '#64748b'
  ctx.textBaseline = 'bottom'
  fillTextSafe(ctx, group.name, bounds.x - padding, bounds.y - padding - 4 / zoom)
  ctx.restore()
}

function applyShapeStyle(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.globalAlpha = shape.opacity
  ctx.strokeStyle = shape.stroke === 'none' ? 'transparent' : shape.stroke
  ctx.fillStyle = shape.fill === 'none' ? 'transparent' : shape.fill
  ctx.lineWidth = shape.strokeWidth
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.shadowBlur = shape.shadowBlur
  ctx.shadowColor = shape.shadowColor
  if (shape.lineStyle === 'dashed') ctx.setLineDash([10, 6])
  else if (shape.lineStyle === 'dotted') ctx.setLineDash([2, 5])
  else ctx.setLineDash([])
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, shapes: Record<string, Shape>) {
  ctx.save()
  applyShapeStyle(ctx, shape)

  if (isArrowShape(shape)) {
    drawArrow(ctx, shape, shapes)
    ctx.restore()
    return
  }

  ctx.translate(shape.x + shape.w / 2, shape.y + shape.h / 2)
  if (shape.rotation) ctx.rotate(shape.rotation)
  ctx.translate(-shape.w / 2, -shape.h / 2)

  switch (shape.type) {
    case 'rectangle':
    case 'square':
    case 'note':
    case 'button':
    case 'input':
    case 'panel':
      drawRoundedRect(ctx, shape)
      break
    case 'dialog':
      drawDialog(ctx, shape)
      break
    case 'circle':
      drawCircle(ctx, shape)
      break
    case 'ellipse':
      drawEllipse(ctx, shape)
      break
    case 'diamond':
      drawDiamond(ctx, shape)
      break
    case 'triangle':
      drawTriangle(ctx, shape)
      break
    case 'star':
      drawStar(ctx, shape)
      break
    case 'pentagon':
    case 'hexagon':
    case 'parallelogram':
    case 'trapezoid':
    case 'cross':
    case 'heart':
    case 'cloud':
    case 'block-arrow':
      drawPolygonShape(ctx, shape)
      break
    case 'line':
      drawLine(ctx, shape)
      break
    case 'text':
      drawText(ctx, shape)
      break
    case 'draw':
      if (isDrawShape(shape)) drawPath(ctx, shape)
      break
    case 'image':
      if (isImageShape(shape)) drawImageShape(ctx, shape)
      break
    case 'progress':
    case 'healthbar':
      drawMeter(ctx, shape)
      break
    case 'minimap':
      drawMinimap(ctx, shape)
      break
    case 'inventory-slot':
      drawInventorySlot(ctx, shape)
      break
    case 'checkbox':
      drawCheckbox(ctx, shape)
      break
    case 'slider':
      drawSlider(ctx, shape)
      break
    case 'icon':
      drawIcon(ctx, shape)
      break
  }
  drawBadge(ctx, shape)
  ctx.restore()
}

const ICON_PATHS: Record<string, string> = {
  'play-circle': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-2 6 6 4-6 4V8Z',
  'arrow-solid': 'M2 10h11V6l9 6-9 6v-4H2v-4Z',
  'arrow-left': 'M22 10H11V6l-9 6 9 6v-4h11v-4Z',
  'arrow-down': 'M10 2v11H6l6 9 6-9h-4V2H10Z',
  'arrow-up': 'M14 22V11h4l-6-9-6 9h4v11h4Z',
  'chevron-double': 'M2 4l8 8-8 8h4l8-8-8-8H2Zm8 0l8 8-8 8h4l8-8-8-8h-4Z',
  'arrow-curved': 'M3 19c7 1 12-3 14-9l-3 1 5-6 2 7-3-1c-2 7-8 11-15 8Z',
  'refresh': 'M12 5a7 7 0 1 0 7 7h-2.5a4.5 4.5 0 1 1-4.5-4.5V5Zm0-4 4 4-4 4V1Z',
  'four-way': 'M12 2l3 4h-2v5h5V9l4 3-4 3v-2h-5v5h2l-3 4-3-4h2v-5H6v2l-4-3 4-3v2h5V6H9l3-4Z',
  'left-right': 'M7 7L2 12l5 5v-3h10v3l5-5-5-5v3H7V7Z',
  'striped-arrow': 'M2 8h2v8H2V8Zm4 0h2v8H6V8Zm4 0h2v8h-2V8Zm4-1 8 5-8 5V7Z',
  'arrow-double': 'M2 12l5-5v3h10V7l5 5-5 5v-3H7v3l-5-5Z',
}

export const ICON_NAMES = Object.keys(ICON_PATHS)

export const ICON_LABELS: Record<string, string> = {
  'play-circle': '圆形播放',
  'arrow-solid': '实心箭头',
  'arrow-left': '左箭头',
  'arrow-down': '下箭头',
  'arrow-up': '上箭头',
  'chevron-double': '双V箭头',
  'arrow-curved': '弯曲箭头',
  'refresh': '循环箭头',
  'four-way': '四向箭头',
  'left-right': '左右箭头',
  'striped-arrow': '条纹箭头',
  'arrow-double': '双头实心箭头',
}

function drawIcon(ctx: CanvasRenderingContext2D, shape: Shape) {
  const name = shape.iconName && ICON_PATHS[shape.iconName] ? shape.iconName : 'arrow-solid'
  const path = new Path2D(ICON_PATHS[name])
  ctx.save()
  ctx.scale(shape.w / 24, shape.h / 24)
  if (shape.fill !== 'none') {
    ctx.fillStyle = shape.fill
    ctx.fill(path, 'evenodd')
  }
  if (shape.stroke !== 'none' && shape.strokeWidth > 0) ctx.stroke(path)
  ctx.restore()
  if (shape.text) drawShapeText(ctx, shape)
}

function drawBadge(ctx: CanvasRenderingContext2D, shape: Shape) {
  if (!shape.badgeType || shape.badgeType === 'none') return
  const color = shape.badgeColor && shape.badgeColor !== 'none' ? shape.badgeColor : '#8b1a1a'
  const text = shape.badgeText ?? ''
  const m = Math.min(shape.w, shape.h)
  const bandH = Math.max(10, m * 0.24)
  const fs = Math.max(8, bandH * 0.58)
  ctx.save()
  ctx.shadowBlur = 0
  if (shape.badgeType === 'seal') {
    const r = Math.max(14, m * 0.22)
    const cx = shape.w - r * 0.7
    const cy = r * 0.7
    const spikes = 14
    ctx.beginPath()
    for (let i = 0; i < spikes * 2; i++) {
      const rad = i % 2 === 0 ? r : r * 0.86
      const a = (Math.PI * i) / spikes
      const px = cx + Math.cos(a) * rad
      const py = cy + Math.sin(a) * rad
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 1
    ctx.stroke()
    if (text) {
      const hex = color.replace('#', '')
      const rr = parseInt(hex.slice(0, 2), 16)
      const gg = parseInt(hex.slice(2, 4), 16)
      const bb = parseInt(hex.slice(4, 6), 16)
      const bright = (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255
      ctx.font = `bold ${Math.max(8, r * 0.62)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
      ctx.fillStyle = Number.isFinite(bright) && bright > 0.55 ? '#6b4413' : '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      fillTextSafe(ctx, text, cx, cy)
    }
    ctx.restore()
    return
  }
  ctx.beginPath()
  ctx.rect(0, 0, shape.w, shape.h)
  ctx.clip()
  const k = m * 0.72
  ctx.translate(k / 2, k / 2)
  ctx.rotate(-Math.PI / 4)
  const L = m * 1.8
  ctx.fillStyle = color
  ctx.fillRect(-L / 2, -bandH / 2, L, bandH)
  ctx.strokeStyle = 'rgba(255, 215, 130, 0.9)'
  ctx.lineWidth = Math.max(1, bandH * 0.08)
  ctx.strokeRect(-L / 2, -bandH / 2, L, bandH)
  if (text) {
    ctx.font = `bold ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
    ctx.fillStyle = '#ffe9a8'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    fillTextSafe(ctx, text, 0, 0)
  }
  ctx.restore()
}

function pathRoundedRect(ctx: CanvasRenderingContext2D, width: number, height: number, radius: number) {
  ctx.beginPath()
  ctx.roundRect(0, 0, width, height, Math.min(radius, width / 2, height / 2))
}

function fillAndStroke(ctx: CanvasRenderingContext2D, shape: Shape) {
  if (shape.fill !== 'none') ctx.fill()
  if (shape.stroke !== 'none' && shape.strokeWidth > 0) ctx.stroke()
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, shape: Shape) {
  pathRoundedRect(ctx, shape.w, shape.h, shape.cornerRadius)
  fillAndStroke(ctx, shape)
  if (shape.type === 'panel') {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, 34)
    ctx.lineTo(shape.w, 34)
    ctx.stroke()
    ctx.restore()
  }
  if (shape.text) drawShapeText(ctx, shape)
}

function drawDialog(ctx: CanvasRenderingContext2D, shape: Shape) {
  const tailSize = Math.max(8, Math.min(shape.h * 0.35, shape.dialogTailSize ?? 20))
  const bodyHeight = Math.max(10, shape.h - tailSize)
  const center = shape.dialogTailPosition === 'right' ? shape.w * 0.78 : shape.dialogTailPosition === 'center' ? shape.w * 0.5 : shape.w * 0.22
  pathRoundedRect(ctx, shape.w, bodyHeight, shape.cornerRadius)
  ctx.moveTo(center - tailSize * 0.55, bodyHeight - 1)
  ctx.lineTo(center, shape.h)
  ctx.lineTo(center + tailSize * 0.55, bodyHeight - 1)
  ctx.closePath()
  fillAndStroke(ctx, shape)
  if (shape.text) drawShapeText(ctx, { ...shape, h: bodyHeight })
}

function drawPolygonShape(ctx: CanvasRenderingContext2D, shape: Shape) {
  const w = shape.w
  const h = shape.h
  ctx.beginPath()
  if (shape.type === 'pentagon' || shape.type === 'hexagon') {
    const sides = shape.type === 'pentagon' ? 5 : 6
    for (let index = 0; index < sides; index++) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / sides
      const x = w / 2 + Math.cos(angle) * w / 2
      const y = h / 2 + Math.sin(angle) * h / 2
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
  } else if (shape.type === 'parallelogram') {
    const skewRatio = resolveGeoRatio(shape, 'parallelogram')
    ctx.moveTo(w * skewRatio, 0); ctx.lineTo(w, 0); ctx.lineTo(w * (1 - skewRatio), h); ctx.lineTo(0, h); ctx.closePath()
  } else if (shape.type === 'trapezoid') {
    const insetRatio = resolveGeoRatio(shape, 'trapezoid')
    ctx.moveTo(w * insetRatio, 0); ctx.lineTo(w * (1 - insetRatio), 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath()
  } else if (shape.type === 'cross') {
    const crossRatio = resolveGeoRatio(shape, 'cross')
    const crossLeft = w * (0.5 - crossRatio / 2)
    const crossRight = w * (0.5 + crossRatio / 2)
    const crossTop = h * (0.5 - crossRatio / 2)
    const crossBottom = h * (0.5 + crossRatio / 2)
    ctx.moveTo(crossLeft, 0); ctx.lineTo(crossRight, 0); ctx.lineTo(crossRight, crossTop); ctx.lineTo(w, crossTop); ctx.lineTo(w, crossBottom); ctx.lineTo(crossRight, crossBottom); ctx.lineTo(crossRight, h); ctx.lineTo(crossLeft, h); ctx.lineTo(crossLeft, crossBottom); ctx.lineTo(0, crossBottom); ctx.lineTo(0, crossTop); ctx.lineTo(crossLeft, crossTop); ctx.closePath()
  } else if (shape.type === 'heart') {
    const dipRatio = resolveGeoRatio(shape, 'heart')
    const dipY = h * (0.08 + dipRatio * 0.5)
    ctx.moveTo(w / 2, h); ctx.bezierCurveTo(w * 0.12, h * 0.7, 0, h * 0.42, 0, h * 0.24); ctx.bezierCurveTo(0, 0, w * 0.34, -h * 0.08, w / 2, dipY); ctx.bezierCurveTo(w * 0.66, -h * 0.08, w, 0, w, h * 0.24); ctx.bezierCurveTo(w, h * 0.42, w * 0.88, h * 0.7, w / 2, h); ctx.closePath()
  } else if (shape.type === 'cloud') {
    ctx.moveTo(w * 0.2, h * 0.8); ctx.bezierCurveTo(0, h * 0.8, 0, h * 0.45, w * 0.2, h * 0.45); ctx.bezierCurveTo(w * 0.2, h * 0.18, w * 0.46, h * 0.08, w * 0.62, h * 0.28); ctx.bezierCurveTo(w * 0.82, h * 0.18, w, h * 0.36, w * 0.94, h * 0.58); ctx.bezierCurveTo(w, h * 0.8, w * 0.8, h * 0.92, w * 0.65, h * 0.8); ctx.closePath()
  } else {
    const bodyRatio = resolveGeoRatio(shape, 'block-arrow')
    const bodyTop = h * (0.5 - bodyRatio / 2)
    const bodyBottom = h * (0.5 + bodyRatio / 2)
    ctx.moveTo(0, bodyTop); ctx.lineTo(w * 0.62, bodyTop); ctx.lineTo(w * 0.62, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w * 0.62, h); ctx.lineTo(w * 0.62, bodyBottom); ctx.lineTo(0, bodyBottom); ctx.closePath()
  }
  fillAndStroke(ctx, shape)
  if (shape.text) drawShapeText(ctx, shape)
}

function drawCircle(ctx: CanvasRenderingContext2D, shape: Shape) {
  const diameter = Math.min(shape.w, shape.h)
  ctx.beginPath()
  ctx.arc(shape.w / 2, shape.h / 2, diameter / 2, 0, Math.PI * 2)
  fillAndStroke(ctx, shape)
  if (shape.text) drawShapeText(ctx, shape)
}

function drawEllipse(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.beginPath()
  ctx.ellipse(shape.w / 2, shape.h / 2, shape.w / 2, shape.h / 2, 0, 0, Math.PI * 2)
  fillAndStroke(ctx, shape)
  if (shape.text) drawShapeText(ctx, shape)
}

function drawDiamond(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.beginPath()
  ctx.moveTo(shape.w / 2, 0)
  ctx.lineTo(shape.w, shape.h / 2)
  ctx.lineTo(shape.w / 2, shape.h)
  ctx.lineTo(0, shape.h / 2)
  ctx.closePath()
  fillAndStroke(ctx, shape)
  if (shape.text) drawShapeText(ctx, shape)
}

function drawTriangle(ctx: CanvasRenderingContext2D, shape: Shape) {
  const apexX = shape.w * resolveGeoRatio(shape, 'triangle')
  ctx.beginPath()
  ctx.moveTo(apexX, 0)
  ctx.lineTo(shape.w, shape.h)
  ctx.lineTo(0, shape.h)
  ctx.closePath()
  fillAndStroke(ctx, shape)
  if (shape.text) drawShapeText(ctx, shape)
}

function drawStar(ctx: CanvasRenderingContext2D, shape: Shape) {
  const centerX = shape.w / 2
  const centerY = shape.h / 2
  const outer = Math.min(shape.w, shape.h) / 2
  const inner = outer * resolveGeoRatio(shape, 'star')
  ctx.beginPath()
  for (let index = 0; index < 10; index++) {
    const radius = index % 2 === 0 ? outer : inner
    const angle = -Math.PI / 2 + index * Math.PI / 5
    const x = centerX + Math.cos(angle) * radius
    const y = centerY + Math.sin(angle) * radius
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  fillAndStroke(ctx, shape)
  if (shape.text) drawShapeText(ctx, shape)
}

function drawLine(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.beginPath()
  ctx.moveTo(0, shape.h / 2)
  ctx.lineTo(shape.w, shape.h / 2)
  ctx.stroke()
}

function drawText(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.fillStyle = shape.textColor
  ctx.font = `${shape.fontWeight} ${shape.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  ctx.textBaseline = 'top'
  activeTextStroke = shape.textStroke && shape.textStroke !== 'none' && (shape.textStrokeWidth ?? 0) > 0 ? { color: shape.textStroke, width: shape.textStrokeWidth ?? 1 } : null
  const lineHeight = shape.fontSize * (shape.lineHeight ?? 1.3)
  const lines = shape.text.split('\n')
  const totalTextHeight = lines.length * lineHeight
  // 垂直居中偏移
  const yOffset = Math.max(0, (shape.h - totalTextHeight) / 2)

  if (shape.textDirection === 'vertical') {
    const columns = lines
    const columnWidth = lineHeight
    const totalWidth = columns.length * columnWidth
    const startX = shape.textAlign === 'left' ? shape.fontSize / 2 : shape.textAlign === 'right' ? shape.w - totalWidth + shape.fontSize / 2 : (shape.w - totalWidth) / 2 + shape.fontSize / 2
    // 背景只画文字区域
    if (shape.textBackground && shape.textBackground !== 'none') {
      ctx.fillStyle = shape.textBackground
      const bgX = startX - shape.fontSize / 2
      const maxColLen = Math.max(...columns.map((c) => c.length), 1)
      ctx.fillRect(bgX, yOffset, totalWidth, maxColLen * lineHeight)
    }
    ctx.fillStyle = shape.textColor
    ctx.textAlign = 'center'
    columns.forEach((column, columnIndex) => [...column].forEach((character, rowIndex) => fillTextSafe(ctx, character, startX + columnIndex * columnWidth, yOffset + rowIndex * lineHeight)))
    activeTextStroke = null
    return
  }

  // 水平模式：测量文字实际宽度用于背景
  ctx.textAlign = shape.textAlign
  const x = shape.textAlign === 'left' ? 0 : shape.textAlign === 'right' ? shape.w : shape.w / 2

  if (shape.textBackground && shape.textBackground !== 'none') {
    // 测量每行宽度，取最大值
    let maxLineWidth = 0
    for (const line of lines) {
      const m = ctx.measureText(line)
      if (m.width > maxLineWidth) maxLineWidth = m.width
    }
    // 背景区域：水平居中于组件，垂直居中于组件
    const bgW = Math.min(shape.w, maxLineWidth + 4)
    const bgX = shape.textAlign === 'left' ? 0 : shape.textAlign === 'right' ? shape.w - bgW : (shape.w - bgW) / 2
    ctx.fillStyle = shape.textBackground
    ctx.fillRect(bgX, yOffset, bgW, totalTextHeight)
  }

  ctx.fillStyle = shape.textColor
  lines.forEach((line, index) => fillTextSafe(ctx, line, x, yOffset + index * lineHeight, shape.w))
  activeTextStroke = null
}

function drawShapeText(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.save()
  activeTextStroke = shape.textStroke && shape.textStroke !== 'none' && (shape.textStrokeWidth ?? 0) > 0 ? { color: shape.textStroke, width: shape.textStrokeWidth ?? 1 } : null
  ctx.shadowBlur = 0
  ctx.fillStyle = shape.textColor
  ctx.font = `${shape.fontWeight} ${shape.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  ctx.textAlign = shape.textAlign
  ctx.textBaseline = 'middle'
  const x = shape.textAlign === 'left' ? 12 : shape.textAlign === 'right' ? shape.w - 12 : shape.w / 2
  const lines = shape.text.split('\n')
  const lineHeight = shape.fontSize * 1.3
  const startY = shape.h / 2 - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((line, index) => fillTextSafe(ctx, line, x, startY + index * lineHeight, Math.max(10, shape.w - 20)))
  activeTextStroke = null
  ctx.restore()
}

function drawPath(ctx: CanvasRenderingContext2D, shape: DrawShape) {
  if (shape.points.length < 2) return
  ctx.beginPath()
  const first = shape.points[0]!
  ctx.moveTo(first[0] ?? 0, first[1] ?? 0)
  for (let index = 1; index < shape.points.length; index++) {
    const point = shape.points[index]!
    ctx.lineTo(point[0] ?? 0, point[1] ?? 0)
  }
  ctx.stroke()
}

function drawImageShape(ctx: CanvasRenderingContext2D, shape: ImageShape) {
  if (!shape.src) return
  let image = imageCache.get(shape.src)
  if (!image) {
    image = new Image()
    // 外置资源异步加载：完成或失败后都要请求重绘，否则画面停在占位状态
    image.onload = () => { imageLoadListener?.() }
    image.onerror = () => {
      imageErrorCache.add(shape.src)
      imageLoadListener?.()
    }
    image.src = shape.src
    imageCache.set(shape.src, image)
  }
  if (image.complete && image.naturalWidth > 0) {
    ctx.save()
    pathRoundedRect(ctx, shape.w, shape.h, shape.cornerRadius)
    ctx.clip()
    ctx.drawImage(image, 0, 0, shape.w, shape.h)
    ctx.restore()
  } else {
    ctx.fillStyle = '#e2e8f0'
    ctx.fillRect(0, 0, shape.w, shape.h)
    ctx.fillStyle = '#64748b'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    fillTextSafe(ctx, imageErrorCache.has(shape.src) ? '图片加载失败' : '图片加载中', shape.w / 2, shape.h / 2)
  }
}

function meterValue(shape: Shape) {
  if (shape.progressValue !== undefined) return Math.min(100, Math.max(0, shape.progressValue)) / 100
  const match = shape.text.match(/(\d+)/)
  return Math.min(100, Math.max(0, Number(match?.[1] ?? 65))) / 100
}

function drawMeter(ctx: CanvasRenderingContext2D, shape: Shape) {
  pathRoundedRect(ctx, shape.w, shape.h, shape.cornerRadius)
  fillAndStroke(ctx, shape)
  const width = shape.w * meterValue(shape)
  ctx.save()
  pathRoundedRect(ctx, shape.w, shape.h, shape.cornerRadius)
  ctx.clip()
  ctx.fillStyle = shape.progressColor ?? (shape.type === 'healthbar' ? '#22c55e' : '#3b82f6')
  ctx.fillRect(0, 0, width, shape.h)
  if (shape.progressStyle === 'striped') {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 6
    for (let x = -shape.h; x < width + shape.h; x += 16) {
      ctx.beginPath(); ctx.moveTo(x, shape.h); ctx.lineTo(x + shape.h, 0); ctx.stroke()
    }
  } else if (shape.progressStyle === 'segmented') {
    ctx.strokeStyle = shape.fill === 'none' ? '#ffffff' : shape.fill
    ctx.lineWidth = 3
    for (let index = 1; index < 10; index++) {
      const x = shape.w * index / 10
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, shape.h); ctx.stroke()
    }
  }
  ctx.restore()
  if (shape.text) drawShapeText(ctx, shape)
}

function drawMinimap(ctx: CanvasRenderingContext2D, shape: Shape) {
  pathRoundedRect(ctx, shape.w, shape.h, shape.cornerRadius)
  fillAndStroke(ctx, shape)
  ctx.save()
  ctx.strokeStyle = '#86efac'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(shape.w * 0.15, shape.h * 0.75)
  ctx.lineTo(shape.w * 0.34, shape.h * 0.38)
  ctx.lineTo(shape.w * 0.55, shape.h * 0.55)
  ctx.lineTo(shape.w * 0.8, shape.h * 0.2)
  ctx.stroke()
  ctx.fillStyle = '#ef4444'
  ctx.beginPath()
  ctx.arc(shape.w * 0.55, shape.h * 0.55, 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawInventorySlot(ctx: CanvasRenderingContext2D, shape: Shape) {
  pathRoundedRect(ctx, shape.w, shape.h, shape.cornerRadius)
  fillAndStroke(ctx, shape)
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'
  ctx.strokeRect(6, 6, shape.w - 12, shape.h - 12)
  ctx.restore()
  if (shape.text) drawShapeText(ctx, shape)
}

function drawCheckbox(ctx: CanvasRenderingContext2D, shape: Shape) {
  const size = Math.min(shape.h - 4, 24)
  ctx.beginPath()
  ctx.roundRect(2, (shape.h - size) / 2, size, size, 4)
  fillAndStroke(ctx, shape)
  if (shape.checked === false) {
    // 未勾选: 只画边框, 内部留白
    if (shape.text) {
      const labelShape = { ...shape, x: 0, y: 0, textAlign: 'left' as const }
      ctx.save()
      ctx.translate(size + 8, 0)
      drawShapeText(ctx, { ...labelShape, w: Math.max(10, shape.w - size - 8) })
      ctx.restore()
    }
    return
  }
  ctx.save()
  ctx.strokeStyle = shape.textColor
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(7, shape.h / 2)
  ctx.lineTo(11, shape.h / 2 + 4)
  ctx.lineTo(18, shape.h / 2 - 5)
  ctx.stroke()
  ctx.restore()
  if (shape.text) {
    const labelShape = { ...shape, x: 0, y: 0, textAlign: 'left' as const }
    ctx.save()
    ctx.translate(size + 8, 0)
    drawShapeText(ctx, { ...labelShape, w: Math.max(10, shape.w - size - 8) })
    ctx.restore()
  }
}

function drawSlider(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.save()
  ctx.strokeStyle = shape.stroke
  ctx.lineWidth = Math.max(4, shape.strokeWidth)
  ctx.beginPath()
  ctx.moveTo(6, shape.h / 2)
  ctx.lineTo(shape.w - 6, shape.h / 2)
  ctx.stroke()
  ctx.fillStyle = '#3b82f6'
  ctx.beginPath()
  ctx.arc(6 + (shape.w - 12) * meterValue(shape), shape.h / 2, Math.min(8, shape.h / 2), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

export function getAnchorPoint(shape: Shape, anchor: ConnectionAnchor, offset = 0) {
  let point: { x: number; y: number }
  if (anchor === 'top') point = { x: shape.x + shape.w / 2, y: shape.y - offset }
  else if (anchor === 'right') point = { x: shape.x + shape.w + offset, y: shape.y + shape.h / 2 }
  else if (anchor === 'bottom') point = { x: shape.x + shape.w / 2, y: shape.y + shape.h + offset }
  else point = { x: shape.x - offset, y: shape.y + shape.h / 2 }
  if (shape.rotation) {
    return rotatePointAround(point.x, point.y, shape.x + shape.w / 2, shape.y + shape.h / 2, shape.rotation)
  }
  return point
}

export function getConnectionAnchors(shape: Shape, offset = 18): Handle[] {
  return (['top', 'right', 'bottom', 'left'] as ConnectionAnchor[]).map((anchor) => ({ ...getAnchorPoint(shape, anchor, offset), type: anchor }))
}

export function createConnectionRoute(start: { x: number; y: number }, end: { x: number; y: number }, anchor: ConnectionAnchor) {
  const gap = 48
  if (anchor === 'top') return [start, { x: start.x, y: start.y - gap }, { x: end.x, y: start.y - gap }, end]
  if (anchor === 'bottom') return [start, { x: start.x, y: start.y + gap }, { x: end.x, y: start.y + gap }, end]
  if (anchor === 'right') return [start, { x: start.x + gap, y: start.y }, { x: start.x + gap, y: end.y }, end]
  return [start, { x: start.x - gap, y: start.y }, { x: start.x - gap, y: end.y }, end]
}

export function getArrowWorldPoints(shape: ArrowShape, shapes: Record<string, Shape>) {
  const points = shape.points.map(([x = 0, y = 0]) => ({ x: shape.x + x, y: shape.y + y }))
  if (shape.startBinding) {
    const bound = shapes[shape.startBinding.shapeId]
    if (bound) points[0] = getAnchorPoint(bound, shape.startBinding.anchor)
  }
  if (shape.endBinding) {
    const bound = shapes[shape.endBinding.shapeId]
    if (bound) points[points.length - 1] = getAnchorPoint(bound, shape.endBinding.anchor)
  }
  return points
}

function drawArrowHeadAngle(ctx: CanvasRenderingContext2D, point: { x: number; y: number }, angle: number) {
  const size = 12
  ctx.beginPath()
  ctx.moveTo(point.x, point.y)
  ctx.lineTo(point.x - Math.cos(angle - Math.PI / 6) * size, point.y - Math.sin(angle - Math.PI / 6) * size)
  ctx.lineTo(point.x - Math.cos(angle + Math.PI / 6) * size, point.y - Math.sin(angle + Math.PI / 6) * size)
  ctx.closePath()
  ctx.fillStyle = ctx.strokeStyle
  ctx.fill()
}

function drawArrowHead(ctx: CanvasRenderingContext2D, point: { x: number; y: number }, previous: { x: number; y: number }) {
  drawArrowHeadAngle(ctx, point, Math.atan2(point.y - previous.y, point.x - previous.x))
}

// 绑定到锚点时，箭头垂直进入目标控件（上锚点=向下进入，以此类推）。
const ANCHOR_ENTER_DIR: Record<ConnectionAnchor, { x: number; y: number }> = {
  top: { x: 0, y: 1 },
  bottom: { x: 0, y: -1 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
}

function drawArrow(ctx: CanvasRenderingContext2D, shape: ArrowShape, shapes: Record<string, Shape>) {
  const points = getArrowWorldPoints(shape, shapes)
  if (points.length < 2) return
  ctx.beginPath()
  ctx.moveTo(points[0]!.x, points[0]!.y)
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y)
  ctx.stroke()
  if (shape.endArrow) {
    const last = points.at(-1)!
    if (shape.endBinding) {
      const dir = ANCHOR_ENTER_DIR[shape.endBinding.anchor]
      drawArrowHeadAngle(ctx, last, Math.atan2(dir.y, dir.x))
    } else {
      // 箭头方向跟随最后一段线段(折线/轨迹箭头的箭头不会歪)
      let previous = points.at(-2)!
      for (let index = points.length - 2; index >= 0; index--) {
        const candidate = points[index]!
        if (candidate.x !== last.x || candidate.y !== last.y) { previous = candidate; break }
      }
      drawArrowHead(ctx, last, previous)
    }
  }
  if (shape.startArrow) drawArrowHead(ctx, points[0]!, points[1]!)
  if (shape.text) {
    const middle = points[Math.floor(points.length / 2)]!
    ctx.save()
    ctx.fillStyle = shape.textColor
    ctx.font = `${shape.fontSize}px sans-serif`
    ctx.textAlign = 'center'
    fillTextSafe(ctx, shape.text, middle.x, middle.y - 8)
    ctx.restore()
  }
}

export function rotatePointAround(px: number, py: number, cx: number, cy: number, angle: number) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = px - cx
  const dy = py - cy
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

export function shapeAABB(shape: Shape): Bounds {
  if (!shape.rotation) return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
  const cx = shape.x + shape.w / 2
  const cy = shape.y + shape.h / 2
  const corners = [
    rotatePointAround(shape.x, shape.y, cx, cy, shape.rotation),
    rotatePointAround(shape.x + shape.w, shape.y, cx, cy, shape.rotation),
    rotatePointAround(shape.x + shape.w, shape.y + shape.h, cx, cy, shape.rotation),
    rotatePointAround(shape.x, shape.y + shape.h, cx, cy, shape.rotation),
  ]
  const minX = Math.min(...corners.map((p) => p.x))
  const minY = Math.min(...corners.map((p) => p.y))
  const maxX = Math.max(...corners.map((p) => p.x))
  const maxY = Math.max(...corners.map((p) => p.y))
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

export function getSelectionBounds(shapes: Shape[]): Bounds | null {
  if (shapes.length === 0) return null
  const boxes = shapes.map(shapeAABB)
  const minX = Math.min(...boxes.map((box) => box.x))
  const minY = Math.min(...boxes.map((box) => box.y))
  const maxX = Math.max(...boxes.map((box) => box.x + box.w))
  const maxY = Math.max(...boxes.map((box) => box.y + box.h))
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

export function getHandles(bounds: Bounds): Handle[] {
  const { x, y, w, h } = bounds
  return [
    { x, y, type: 'nw' },
    { x: x + w / 2, y, type: 'n' },
    { x: x + w, y, type: 'ne' },
    { x: x + w, y: y + h / 2, type: 'e' },
    { x: x + w, y: y + h, type: 'se' },
    { x: x + w / 2, y: y + h, type: 's' },
    { x, y: y + h, type: 'sw' },
    { x, y: y + h / 2, type: 'w' },
  ]
}

export function getRotationHandle(bounds: Bounds, offset = 28): Handle {
  return { x: bounds.x + bounds.w / 2, y: bounds.y - offset, type: 'rotate' }
}

export function hitTestRotationHandle(bounds: Bounds, px: number, py: number, threshold = 10, rotation = 0, offset = 28): boolean {
  let tx = px
  let ty = py
  if (rotation) {
    const local = rotatePointAround(px, py, bounds.x + bounds.w / 2, bounds.y + bounds.h / 2, -rotation)
    tx = local.x
    ty = local.y
  }
  const handle = getRotationHandle(bounds, offset)
  return Math.hypot(tx - handle.x, ty - handle.y) <= threshold
}

function drawSelection(ctx: CanvasRenderingContext2D, selected: Shape[], shapes: Record<string, Shape>, zoom: number) {
  if (selected.length === 1 && selected[0] && isArrowShape(selected[0])) {
    const arrow = selected[0]
    const points = getArrowWorldPoints(arrow, shapes)
    ctx.save()
    ctx.lineWidth = 1.5 / zoom
    points.forEach((point, index) => {
      ctx.fillStyle = index === 0 || index === points.length - 1 ? '#3b63f6' : '#f59e0b'
      ctx.strokeStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(point.x, point.y, 6 / zoom, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    })
    ctx.restore()
    return
  }

  const bounds = getSelectionBounds(selected)
  if (!bounds) return
  ctx.save()
  ctx.strokeStyle = '#3b63f6'
  ctx.lineWidth = 1.5 / zoom
  if (selected.length > 1) {
    // 多选：逐个画外框，不合并成一个大包围框。
    for (const shape of selected) {
      if (isArrowShape(shape)) {
        const points = getArrowWorldPoints(shape, shapes)
        const xs = points.map((point) => point.x)
        const ys = points.map((point) => point.y)
        const boxX = Math.min(...xs)
        const boxY = Math.min(...ys)
        ctx.strokeRect(boxX, boxY, Math.max(...xs) - boxX, Math.max(...ys) - boxY)
      } else if (shape.rotation) {
        const rcx = shape.x + shape.w / 2
        const rcy = shape.y + shape.h / 2
        ctx.save()
        ctx.translate(rcx, rcy)
        ctx.rotate(shape.rotation)
        ctx.translate(-rcx, -rcy)
        ctx.strokeRect(shape.x, shape.y, shape.w, shape.h)
        ctx.restore()
      } else {
        ctx.strokeRect(shape.x, shape.y, shape.w, shape.h)
      }
    }
    // 保留整体缩放手柄（不画大框）。
    for (const handle of getHandles(bounds)) {
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = '#3b63f6'
      ctx.beginPath()
      ctx.arc(handle.x, handle.y, 5 / zoom, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
    return
  }
  const rotatedSingle =
    selected.length === 1 && selected[0] && !isArrowShape(selected[0]) && selected[0].rotation
      ? selected[0]
      : null
  if (rotatedSingle) {
    const rcx = rotatedSingle.x + rotatedSingle.w / 2
    const rcy = rotatedSingle.y + rotatedSingle.h / 2
    ctx.translate(rcx, rcy)
    ctx.rotate(rotatedSingle.rotation)
    ctx.translate(-rcx, -rcy)
  }
  const frameBounds = rotatedSingle
    ? { x: rotatedSingle.x, y: rotatedSingle.y, w: rotatedSingle.w, h: rotatedSingle.h }
    : bounds
  ctx.setLineDash([6 / zoom, 4 / zoom])
  ctx.strokeRect(frameBounds.x, frameBounds.y, frameBounds.w, frameBounds.h)
  ctx.setLineDash([])
  for (const handle of getHandles(frameBounds)) {
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#3b63f6'
    ctx.beginPath()
    ctx.arc(handle.x, handle.y, 5 / zoom, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  if (selected.length === 1) {
    const rotationHandle = getRotationHandle(frameBounds, 28 / zoom)
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.75)'
    ctx.lineWidth = 1 / zoom
    ctx.beginPath()
    ctx.moveTo(frameBounds.x + frameBounds.w / 2, frameBounds.y)
    ctx.lineTo(rotationHandle.x, rotationHandle.y)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(rotationHandle.x, rotationHandle.y, 6 / zoom, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
  if (selected.length === 1 && selected[0] && !isArrowShape(selected[0])) {
    for (const anchor of getConnectionAnchors(selected[0], 18 / zoom))
      drawConnectionAnchor(ctx, anchor, zoom, selected[0].rotation)
  }
}

function drawConnectionAnchor(ctx: CanvasRenderingContext2D, anchor: Handle, zoom: number, extraRotation = 0) {
  const angles: Record<ConnectionAnchor, number> = { top: -Math.PI / 2, right: 0, bottom: Math.PI / 2, left: Math.PI }
  ctx.save()
  ctx.translate(anchor.x, anchor.y)
  ctx.rotate(angles[anchor.type as ConnectionAnchor] + extraRotation)
  ctx.fillStyle = 'rgba(37, 99, 235, 0.48)'
  ctx.strokeStyle = 'rgba(37, 99, 235, 0.9)'
  ctx.lineWidth = 1 / zoom
  ctx.beginPath()
  ctx.moveTo(7 / zoom, 0)
  ctx.lineTo(-5 / zoom, -5 / zoom)
  ctx.lineTo(-5 / zoom, 5 / zoom)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}
function drawGroupSelection(ctx: CanvasRenderingContext2D, bounds: Bounds, zoom: number) {
  const padding = 18
  const outer = { x: bounds.x - padding, y: bounds.y - padding, w: bounds.w + padding * 2, h: bounds.h + padding * 2 }
  ctx.save()
  ctx.strokeStyle = '#2563eb'
  ctx.lineWidth = 1.5 / zoom
  ctx.setLineDash([6 / zoom, 4 / zoom])
  ctx.strokeRect(outer.x, outer.y, outer.w, outer.h)
  ctx.setLineDash([])
  for (const handle of getHandles(outer)) {
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#2563eb'
    ctx.beginPath()
    ctx.arc(handle.x, handle.y, 5 / zoom, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}
function drawSelectionBox(ctx: CanvasRenderingContext2D, bounds: Bounds, zoom: number) {
  if (bounds.w < 1 && bounds.h < 1) return
  ctx.save()
  ctx.fillStyle = 'rgba(59, 99, 246, 0.10)'
  ctx.strokeStyle = '#3b63f6'
  ctx.lineWidth = 1 / zoom
  ctx.setLineDash([6 / zoom, 4 / zoom])
  ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h)
  ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h)
  ctx.restore()
}

function pointToSegmentDistance(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) return Math.hypot(px - a.x, py - a.y)
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

export function hitTest(shape: Shape, px: number, py: number, shapes: Record<string, Shape> = {}, threshold = 6): boolean {
  if (!shape.visible || shape.locked) return false
  if (isArrowShape(shape)) {
    const points = getArrowWorldPoints(shape, shapes)
    return points.slice(1).some((point, index) => pointToSegmentDistance(px, py, points[index]!, point) <= threshold)
  }
  if (shape.rotation) {
    const local = rotatePointAround(px, py, shape.x + shape.w / 2, shape.y + shape.h / 2, -shape.rotation)
    return local.x >= shape.x && local.x <= shape.x + shape.w && local.y >= shape.y && local.y <= shape.y + shape.h
  }
  return px >= shape.x && px <= shape.x + shape.w && py >= shape.y && py <= shape.y + shape.h
}

export function hitTestHandle(bounds: Bounds, px: number, py: number, threshold = 10, rotation = 0): string | null {
  let tx = px
  let ty = py
  if (rotation) {
    const local = rotatePointAround(px, py, bounds.x + bounds.w / 2, bounds.y + bounds.h / 2, -rotation)
    tx = local.x
    ty = local.y
  }
  return getHandles(bounds).find((handle) => Math.abs(tx - handle.x) <= threshold && Math.abs(ty - handle.y) <= threshold)?.type ?? null
}

export function hitTestConnectionAnchor(shape: Shape, px: number, py: number, threshold: number, offset: number): ConnectionAnchor | null {
  const handle = getConnectionAnchors(shape, offset).find((anchor) => Math.hypot(px - anchor.x, py - anchor.y) <= threshold)
  return handle?.type as ConnectionAnchor | null
}

export function hitTestArrowPoint(shape: ArrowShape, shapes: Record<string, Shape>, px: number, py: number, threshold: number): number | null {
  const index = getArrowWorldPoints(shape, shapes).findIndex((point) => Math.hypot(px - point.x, py - point.y) <= threshold)
  return index >= 0 ? index : null
}

function drawPlanBadge(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number) {
  const r = 7 / zoom
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = '#3b63f6'
  ctx.fill()
  ctx.lineWidth = 1.5 / zoom
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  const dw = 6 / zoom
  const dh = 8 / zoom
  const dx = x - dw / 2
  const dy = y - dh / 2
  const fold = 2.2 / zoom
  ctx.beginPath()
  ctx.moveTo(dx, dy)
  ctx.lineTo(dx + dw - fold, dy)
  ctx.lineTo(dx + dw, dy + fold)
  ctx.lineTo(dx + dw, dy + dh)
  ctx.lineTo(dx, dy + dh)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#3b63f6'
  ctx.lineWidth = 0.8 / zoom
  ctx.beginPath()
  for (let i = 1; i <= 3; i++) {
    const ly = dy + fold + ((dh - fold) * i) / 4
    ctx.moveTo(dx + 1.4 / zoom, ly)
    ctx.lineTo(dx + dw - 1.4 / zoom, ly)
  }
  ctx.stroke()
  ctx.restore()
}
