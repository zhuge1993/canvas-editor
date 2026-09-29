/** 自研画布的持久化数据模型。 */

export type ShapeType =
  | 'rectangle'
  | 'square'
  | 'circle'
  | 'ellipse'
  | 'diamond'
  | 'triangle'
  | 'star'
  | 'pentagon'
  | 'hexagon'
  | 'parallelogram'
  | 'trapezoid'
  | 'cross'
  | 'heart'
  | 'cloud'
  | 'block-arrow'
  | 'line'
  | 'arrow'
  | 'text'
  | 'draw'
  | 'note'
  | 'image'
  | 'button'
  | 'input'
  | 'panel'
  | 'progress'
  | 'healthbar'
  | 'minimap'
  | 'inventory-slot'
  | 'dialog'
  | 'checkbox'
  | 'slider'
  | 'icon'

export type Tool =
  | 'select'
  | 'hand'
  | 'rectangle'
  | 'square'
  | 'circle'
  | 'ellipse'
  | 'diamond'
  | 'line'
  | 'arrow'
  | 'text'
  | 'draw'
  | 'note'
  | 'table'

export type ConnectionAnchor = 'top' | 'right' | 'bottom' | 'left'
export type TextAlign = 'left' | 'center' | 'right'
export type TextVerticalAlign = 'top' | 'middle' | 'bottom'
export type LineStyle = 'solid' | 'dashed' | 'dotted'
export type DialogTailPosition = 'left' | 'center' | 'right'
export type ProgressStyle = 'solid' | 'striped' | 'segmented'
export type TextDirection = 'horizontal' | 'vertical'


export interface ShapeBinding {
  shapeId: string
  anchor: ConnectionAnchor
}

export interface ShapeLink {
  kind: 'shape' | 'url'
  targetId?: string
  url?: string
  label?: string
}

export interface BaseShape {
  id: string
  type: ShapeType
  name: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  stroke: string
  fill: string
  strokeWidth: number
  opacity: number
  text: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  textAlign: TextAlign
  textColor: string
  textStroke?: string
  textStrokeWidth?: number
  cornerRadius: number
  lineStyle: LineStyle
  shadowBlur: number
  shadowColor: string
  visible: boolean
  locked: boolean
  groupId?: string
  link?: ShapeLink
  description?: string
  dialogTailPosition?: DialogTailPosition
  dialogTailSize?: number
  progressValue?: number
  progressStyle?: ProgressStyle
  progressColor?: string
  textBackground?: string
  textDirection?: TextDirection
  textVerticalAlign?: TextVerticalAlign
  textOffsetX?: number
  textOffsetY?: number
  /** 几何比例(0~1): 十字臂宽 / 星形内角 / 块箭头箭身 / 梯形上边 / 平行四边形斜边; 未设置(=1)用默认值, 见 GEO_RATIO_DEFAULTS */
  innerScale?: number
  lineHeight?: number
  badgeType?: 'none' | 'ribbon' | 'seal'
  badgeText?: string
  badgeColor?: string
  iconName?: string
  /** 复选框勾选状态（仅 checkbox 类型使用） */
  checked?: boolean
}

export interface ArrowShape extends BaseShape {
  type: 'arrow'
  /** 相对于 shape.x / shape.y 的折线控制点，至少包含起点和终点。 */
  points: number[][]
  startBinding?: ShapeBinding
  endBinding?: ShapeBinding
  startArrow: boolean
  endArrow: boolean
}

export interface ImageShape extends BaseShape {
  type: 'image'
  src: string
  aspectRatio: number
}
export interface DrawShape extends BaseShape {
  type: 'draw'
  /** 相对于 shape.x / shape.y 的自由绘制折线点。 */
  points: number[][]
}


export type Shape = BaseShape | DrawShape | ArrowShape | ImageShape

export function isArrowShape(shape: Shape): shape is ArrowShape {
  return shape.type === 'arrow' && 'points' in shape && 'endArrow' in shape
}

export function isDrawShape(shape: Shape): shape is DrawShape {
  return shape.type === 'draw' && 'points' in shape
}

export function isImageShape(shape: Shape): shape is ImageShape {
  return shape.type === 'image' && 'src' in shape
}

export interface ShapeGroup {
  id: string
  name: string
  description?: string
  /** 该分组内部直接子节点顺序，子节点可以是图形或嵌套分组。 */
  childIds: string[]
  parentId?: string
  collapsed: boolean
  visible: boolean
  locked: boolean
  /** 分组边框颜色（默认灰） */
  stroke?: string
  /** 分组背景色（默认半透明白） */
  fill?: string
}

/** 画布节点类型：图形或分组都算节点，统一参与层级树。 */
export type CanvasNode = Shape | ShapeGroup

export function isShapeNode(node: CanvasNode | undefined): node is Shape {
  return Boolean(node) && 'type' in (node as object) && typeof (node as Shape).type === 'string'
}

export function isGroupNode(node: CanvasNode | undefined): node is ShapeGroup {
  return Boolean(node) && 'childIds' in (node as object)
}

export interface WorkspaceBounds {
  x: number
  y: number
  w: number
  h: number
}

export const DEFAULT_WORKSPACE: WorkspaceBounds = { x: 0, y: 0, w: 1200, h: 800 }
const WORKSPACE_GROW_PADDING = 50

export function expandWorkspaceToFit(
  workspace: WorkspaceBounds,
  shape: Pick<Shape, 'x' | 'y' | 'w' | 'h'>,
): WorkspaceBounds {
  const currentRight = workspace.x + workspace.w
  const currentBottom = workspace.y + workspace.h
  const desiredLeft = Math.floor(shape.x - WORKSPACE_GROW_PADDING)
  const desiredTop = Math.floor(shape.y - WORKSPACE_GROW_PADDING)
  const desiredRight = Math.ceil(shape.x + Math.max(0, shape.w) + WORKSPACE_GROW_PADDING)
  const desiredBottom = Math.ceil(shape.y + Math.max(0, shape.h) + WORKSPACE_GROW_PADDING)
  const x = Math.min(workspace.x, desiredLeft)
  const y = Math.min(workspace.y, desiredTop)
  const right = Math.max(currentRight, desiredRight)
  const bottom = Math.max(currentBottom, desiredBottom)

  if (x === workspace.x && y === workspace.y && right === currentRight && bottom === currentBottom)
    return workspace
  return { x, y, w: right - x, h: bottom - y }
}

export interface CanvasDocument {
  version: 3
  shapes: Record<string, Shape>
  /** 根节点顺序：图形和顶层分组混合排列，决定渲染和结构树根层顺序。 */
  order: string[]
  groups: Record<string, ShapeGroup>
  workspace: WorkspaceBounds
  /** 画布背景色（文档级，默认 #fafafa） */
  backgroundColor?: string
  /** 网格间距（默认 20） */
  gridSize?: number
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

export function constrainCameraToWorkspace(
  camera: Camera,
  workspace: WorkspaceBounds,
  viewportWidth: number,
  viewportHeight: number,
): Camera {
  const zoom = Math.min(4, Math.max(0.1, camera.zoom))
  const constrainAxis = (offset: number, start: number, size: number, viewportSize: number) => {
    const scaledSize = size * zoom
    if (scaledSize <= viewportSize) return (viewportSize - scaledSize) / 2 - start * zoom
    const maximum = -start * zoom
    const minimum = viewportSize - (start + size) * zoom
    return Math.min(maximum, Math.max(minimum, offset))
  }

  return {
    x: constrainAxis(camera.x, workspace.x, workspace.w, viewportWidth),
    y: constrainAxis(camera.y, workspace.y, workspace.h, viewportHeight),
    zoom,
  }
}

/** 几何比例默认值/上限/面板文案: innerScale 未设置时的回退值(改这里和渲染器同步生效) */
export const GEO_RATIO_DEFAULTS: Record<string, { fallback: number; max: number; label: string }> = {
  cross: { fallback: 0.3, max: 0.9, label: '十字臂宽比例' },
  star: { fallback: 0.44, max: 0.9, label: '星形内角比例' },
  'block-arrow': { fallback: 0.4, max: 0.9, label: '箭身粗细比例' },
  trapezoid: { fallback: 0.2, max: 0.45, label: '上边内缩比例' },
  parallelogram: { fallback: 0.2, max: 0.45, label: '斜边偏移比例' },
  heart: { fallback: 0.24, max: 0.9, label: '凹口深度比例' },
  triangle: { fallback: 0.5, max: 0.95, label: '顶点位置比例' },
}

/** 取组件的几何比例: innerScale 在 (0,1) 内才生效, 否则用类型默认值, 并夹在 max 以内 */
export function resolveGeoRatio(shape: { innerScale?: number }, type: string): number {
  const def = GEO_RATIO_DEFAULTS[type]
  if (!def) return 0
  const value = shape.innerScale
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1) return Math.min(value, def.max)
  return def.fallback
}

const SHAPE_NAMES: Record<ShapeType, string> = {
  rectangle: '矩形',
  square: '正方形',
  circle: '圆形',
  ellipse: '椭圆',
  diamond: '菱形',
  triangle: '三角形',
  star: '五角星',
  pentagon: '五边形',
  hexagon: '六边形',
  parallelogram: '平行四边形',
  trapezoid: '梯形',
  cross: '十字形',
  heart: '心形',
  cloud: '云形',
  'block-arrow': '块箭头',
  line: '直线',
  arrow: '箭头',
  text: '文本',
  draw: '手绘',
  note: '便签',
  image: '图片',
  button: '按钮',
  input: '输入框',
  panel: '面板',
  progress: '进度条',
  healthbar: '生命条',
  minimap: '小地图',
  'inventory-slot': '背包栏',
  dialog: '对话框',
  checkbox: '复选框',
  slider: '滑块',
  icon: '图标',
}

export function genId(prefix = 's'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function getShapeTypeName(type: ShapeType): string {
  return SHAPE_NAMES[type]
}

export function createShape(type: ShapeType, x: number, y: number, w = 100, h = 60): Shape {
  const base: BaseShape = {
    id: genId(),
    type,
    name: SHAPE_NAMES[type],
    x,
    y,
    w,
    h,
    rotation: 0,
    stroke: '#1f2430',
    fill: 'none',
    strokeWidth: 2,
    opacity: 1,
    text: '',
    fontSize: 16,
    fontWeight: 'normal',
    textAlign: 'center',
    textColor: '#1f2430',
    textStroke: 'none',
    textStrokeWidth: 0,
    textBackground: 'none',
    textDirection: 'horizontal',
    textVerticalAlign: 'middle',
    textOffsetX: 0,
    textOffsetY: 0,
    innerScale: 1,
    lineHeight: 1.3,
    cornerRadius: 6,
    lineStyle: 'solid',
    shadowBlur: 0,
    shadowColor: 'rgba(15, 23, 42, 0.22)',
    visible: true,
    locked: false,
  }

  if (type === 'draw') return { ...base, type, points: [] }
  if (type === 'arrow') {
    return {
      ...base,
      type,
      fill: 'none',
      points: [[0, h / 2], [w / 2, h / 2], [w, h / 2]],
      startArrow: false,
      endArrow: true,
    }
  }
  if (type === 'image') return { ...base, type, stroke: 'none', src: '', aspectRatio: w / Math.max(1, h) }
  if (type === 'square') {
    const size = Math.max(w, h)
    return { ...base, w: size, h: size }
  }
  if (type === 'circle') return { ...base, w: Math.max(w, h), h: Math.max(w, h) }
  if (type === 'note') return { ...base, fill: '#fef9c3', stroke: '#eab308' }
  if (type === 'button') return { ...base, fill: '#2563eb', stroke: '#1d4ed8', textColor: '#ffffff', fontWeight: 'bold', cornerRadius: 8 }
  if (type === 'input') return { ...base, fill: '#ffffff', stroke: '#94a3b8', textColor: '#64748b', textAlign: 'left', cornerRadius: 6 }
  if (type === 'panel') return { ...base, fill: '#111827', stroke: '#374151', textColor: '#f9fafb', cornerRadius: 8, shadowBlur: 14 }
  if (type === 'progress') return { ...base, fill: '#e2e8f0', stroke: '#94a3b8', cornerRadius: 12, progressValue: 65, progressStyle: 'solid', progressColor: '#3b82f6' }
  if (type === 'healthbar') return { ...base, fill: '#fee2e2', stroke: '#ef4444', cornerRadius: 10, progressValue: 80, progressStyle: 'solid', progressColor: '#22c55e' }
  if (type === 'minimap') return { ...base, fill: '#dcfce7', stroke: '#22c55e', cornerRadius: 4 }
  if (type === 'inventory-slot') return { ...base, fill: '#1f2937', stroke: '#9ca3af', textColor: '#ffffff', cornerRadius: 4 }
  if (type === 'dialog') return { ...base, fill: '#ffffff', stroke: '#475569', textAlign: 'left', cornerRadius: 10, shadowBlur: 18, dialogTailPosition: 'left', dialogTailSize: 20 }
  if (type === 'checkbox') return { ...base, fill: '#ffffff', stroke: '#64748b', textAlign: 'left', cornerRadius: 4, checked: true }
  if (type === 'slider') return { ...base, fill: '#e2e8f0', stroke: '#64748b', cornerRadius: 8 }
  if (type === 'icon') return { ...base, fill: '#111827', stroke: 'none', iconName: 'arrow-solid' }
  return base
}

export function createEmptyCanvasDocument(): CanvasDocument {
  return {
    version: 3,
    shapes: {},
    order: [],
    groups: {},
    workspace: { ...DEFAULT_WORKSPACE },
  }
}

/** 收集某个父节点下的所有后代图形 id（递归）。 */
export function collectShapeDescendants(groupId: string, groups: Record<string, ShapeGroup>): string[] {
  const result: string[] = []
  const stack = [groupId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    const group = groups[current]
    if (!group) continue
    for (const childId of group.childIds) {
      if (groups[childId]) stack.push(childId)
      else result.push(childId)
    }
  }
  return result
}

/** 收集某个父节点下的所有后代分组 id（递归，包含自身）。 */
export function collectGroupDescendants(groupId: string, groups: Record<string, ShapeGroup>): string[] {
  const result: string[] = [groupId]
  const stack = [groupId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    const group = groups[current]
    if (!group) continue
    for (const childId of group.childIds) {
      if (groups[childId]) {
        result.push(childId)
        stack.push(childId)
      }
    }
  }
  return result
}

/** 检查 candidateId 是否为 groupId 的祖先（用于防止循环嵌套）。 */
export function isAncestor(groupId: string, candidateId: string, groups: Record<string, ShapeGroup>): boolean {
  let current = groups[candidateId]?.parentId
  while (current) {
    if (current === groupId) return true
    current = groups[current]?.parentId
  }
  return false
}

/** 按深度优先顺序展开整棵树，返回所有图形的渲染顺序（从底层到顶层）。 */
export function flattenRenderOrder(order: string[], shapes: Record<string, Shape>, groups: Record<string, ShapeGroup>): Shape[] {
  const result: Shape[] = []
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const group = groups[id]
      if (group) {
        if (group.visible) walk(group.childIds)
      } else {
        const shape = shapes[id]
        if (shape?.visible) result.push(shape)
      }
    }
  }
  walk(order)
  return result
}

/** 返回所有图形（不论可见性），按渲染顺序，用于导出等需要全量场景。 */
export function getAllShapesInOrder(order: string[], shapes: Record<string, Shape>, groups: Record<string, ShapeGroup>): Shape[] {
  const result: Shape[] = []
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const group = groups[id]
      if (group) walk(group.childIds)
      else {
        const shape = shapes[id]
        if (shape) result.push(shape)
      }
    }
  }
  walk(order)
  return result
}

/** 计算某个分组（递归收集所有后代图形）的整体包围盒。 */
export function getGroupContentBounds(groupId: string, shapes: Record<string, Shape>, groups: Record<string, ShapeGroup>) {
  const ids = collectShapeDescendants(groupId, groups)
  const children = ids.map((id) => shapes[id]).filter(Boolean) as Shape[]
  if (children.length === 0) return null
  const minX = Math.min(...children.map((s) => s.x))
  const minY = Math.min(...children.map((s) => s.y))
  const maxX = Math.max(...children.map((s) => s.x + s.w))
  const maxY = Math.max(...children.map((s) => s.y + s.h))
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

export function normalizeCanvasDocument(value: unknown): CanvasDocument {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const sourceShapes = raw.shapes && typeof raw.shapes === 'object' ? raw.shapes as Record<string, unknown> : {}
  const shapes: Record<string, Shape> = {}

  for (const [id, source] of Object.entries(sourceShapes)) {
    if (!source || typeof source !== 'object') continue
    const candidate = source as Partial<Shape>
    const type = candidate.type && candidate.type in SHAPE_NAMES ? candidate.type : 'rectangle'
    const fallback = createShape(type, candidate.x ?? 0, candidate.y ?? 0, candidate.w ?? 100, candidate.h ?? 60)
    const shape = { ...fallback, ...candidate, id, type } as Shape
    if (shape.type === 'circle' || shape.type === 'square') shape.w = shape.h = Math.max(shape.w, shape.h)
    if (shape.type === 'arrow') {
      const arrow = shape as ArrowShape
      if (!Array.isArray(arrow.points) || arrow.points.length < 2) {
        arrow.points = [[0, arrow.h / 2], [arrow.w / 2, arrow.h / 2], [arrow.w, arrow.h / 2]]
      }
    }
    shapes[id] = shape
  }

  const groups: Record<string, ShapeGroup> = {}
  const rawGroups = raw.groups && typeof raw.groups === 'object' ? raw.groups as Record<string, Partial<ShapeGroup>> : {}
  for (const [id, source] of Object.entries(rawGroups)) {
    if (!source || typeof source !== 'object') continue
    groups[id] = {
      id,
      name: source.name || '未命名分组',
      childIds: Array.isArray(source.childIds) ? source.childIds.filter((cid): cid is string => typeof cid === 'string') : [],
      parentId: source.parentId,
      collapsed: source.collapsed ?? false,
      visible: source.visible ?? true,
      locked: source.locked ?? false,
      description: typeof source.description === 'string' ? source.description : undefined,
      stroke: typeof source.stroke === 'string' ? source.stroke : undefined,
      fill: typeof source.fill === 'string' ? source.fill : undefined,
    }
  }

  // 旧数据兼容：图形上的 groupId 指向分组但分组 childIds 未包含该图形。
  for (const shape of Object.values(shapes)) {
    const gid = shape.groupId
    if (gid && groups[gid] && !groups[gid]!.childIds.includes(shape.id)) {
      groups[gid]!.childIds.push(shape.id)
    }
  }

  // 清理分组：移除不存在的子节点，空分组删除。
  for (const [id, group] of Object.entries(groups)) {
    group.childIds = group.childIds.filter((cid) => Boolean(shapes[cid]) || Boolean(groups[cid]))
    if (group.childIds.length === 0) delete groups[id]
  }

  // 同步 shape.groupId 为 group.childIds。
  for (const shape of Object.values(shapes)) {
    if (shape.groupId && !groups[shape.groupId]) {
      const { groupId: _gid, ...rest } = shape
      shapes[shape.id] = rest as Shape
    }
  }
  for (const [id, group] of Object.entries(groups)) {
    for (const childId of group.childIds) {
      const shape = shapes[childId]
      if (shape && shape.groupId !== id) shapes[childId] = { ...shape, groupId: id }
    }
  }

  // 构建根节点顺序：order 中可同时包含图形和顶层分组。
  const rawOrder = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === 'string') : []
  const order: string[] = []
  const claimed = new Set<string>()

  // 优先按旧 groupOrder + order 重建根顺序（兼容旧版数据）。
  const legacyGroupOrder = Array.isArray(raw.groupOrder) ? raw.groupOrder.filter((id): id is string => typeof id === 'string') : []
  for (const id of legacyGroupOrder) {
    if (groups[id] && !groups[id]!.parentId && !claimed.has(id)) {
      order.push(id)
      claimed.add(id)
    }
  }
  for (const id of rawOrder) {
    if (claimed.has(id)) continue
    if (shapes[id] && !shapes[id]!.groupId) {
      order.push(id)
      claimed.add(id)
    } else if (groups[id] && !groups[id]!.parentId) {
      order.push(id)
      claimed.add(id)
    }
  }
  // 补全未包含的根节点。
  for (const id of Object.keys(shapes)) {
    if (!shapes[id]!.groupId && !claimed.has(id)) {
      order.push(id)
      claimed.add(id)
    }
  }
  for (const id of Object.keys(groups)) {
    if (!groups[id]!.parentId && !claimed.has(id)) {
      order.push(id)
      claimed.add(id)
    }
  }

  const sourceWorkspace = raw.workspace
  let workspace: WorkspaceBounds =
    sourceWorkspace &&
    typeof sourceWorkspace === 'object' &&
    Number.isFinite((sourceWorkspace as WorkspaceBounds).x) &&
    Number.isFinite((sourceWorkspace as WorkspaceBounds).y) &&
    Number.isFinite((sourceWorkspace as WorkspaceBounds).w) &&
    Number.isFinite((sourceWorkspace as WorkspaceBounds).h) &&
    (sourceWorkspace as WorkspaceBounds).w > 0 &&
    (sourceWorkspace as WorkspaceBounds).h > 0
      ? {
          x: Number((sourceWorkspace as WorkspaceBounds).x),
          y: Number((sourceWorkspace as WorkspaceBounds).y),
          w: Number((sourceWorkspace as WorkspaceBounds).w),
          h: Number((sourceWorkspace as WorkspaceBounds).h),
        }
      : { ...DEFAULT_WORKSPACE }
  for (const shape of Object.values(shapes)) workspace = expandWorkspaceToFit(workspace, shape)

  const backgroundColor = typeof raw.backgroundColor === 'string' ? raw.backgroundColor : undefined
  const gridSize = typeof raw.gridSize === 'number' && raw.gridSize >= 8 && raw.gridSize <= 100 ? raw.gridSize : undefined

  return { version: 3, shapes, order, groups, workspace, backgroundColor, gridSize }
}