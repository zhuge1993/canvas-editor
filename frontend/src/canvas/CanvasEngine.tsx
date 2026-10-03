import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useEditorStore } from '@/store/useEditorStore'
import {
  createConnectionRoute,
  getAnchorPoint,
  getArrowWorldPoints,
  getGroupBounds,
  getSelectionBounds,
  hitTest,
  hitTestArrowPoint,
  hitTestConnectionAnchor,
  hitTestGroup,
  hitTestHandle,
  hitTestRotationHandle,
  render,
  rotatePointAround,
  setImageLoadListener,
  shapeAABB,
  type Bounds,
} from './renderer'
import {
  collectGroupDescendants,
  collectShapeDescendants,
  constrainCameraToWorkspace,
  createShape,
  flattenRenderOrder,
  genId,
  getAllShapesInOrder,
  isAncestor,
  isArrowShape,
  isDrawShape,
  type ArrowShape,
  type ConnectionAnchor,
  type DrawShape,
  type ImageShape,
  type Shape,
  type ShapeGroup,
} from './types'
import { logError, logOperation } from '@/utils/logger'

interface ShapeGeometry {
  id: string
  x: number
  y: number
  w: number
  h: number
  points?: number[][]
}

type Interaction =
  | { type: 'idle' }
  | { type: 'panning'; startX: number; startY: number; cameraX: number; cameraY: number }
  | { type: 'drawing'; shape: Shape; startX: number; startY: number }
  | { type: 'drawingArrow'; shape: ArrowShape; startX: number; startY: number; raw: Array<{ x: number; y: number }> }
  | { type: 'drawingPath'; shape: DrawShape }
  | {
      type: 'moving'
      startX: number
      startY: number
      deltaX: number
      deltaY: number
      items: ShapeGeometry[]
      sourceShapes: Shape[]
      historyPushed: boolean
    }
  | {
      type: 'resizing'
      handle: string
      bounds: Bounds
      items: ShapeGeometry[]
      historyPushed: boolean
    }
  | {
      type: 'rotating'
      id: string
      centerX: number
      centerY: number
      startAngle: number
      rotation: number
      historyPushed: boolean
    }
  | {
      type: 'selecting'
      startX: number
      startY: number
      endX: number
      endY: number
      additive: boolean
      intersectMode: boolean
      initialSelectedIds: string[]
      initialSelectedGroupIds: string[]
      hitShapeId?: string
      hitGroupId?: string
    }
  | { type: 'connecting'; shape: ArrowShape; sourceId: string; sourceAnchor: ConnectionAnchor }
  | {
      type: 'arrowPoint'
      id: string
      pointIndex: number
      worldPoints: Array<{ x: number; y: number }>
      historyPushed: boolean
    }

interface GroupClipboard {
  groups: ShapeGroup[]
  shapes: Shape[]
  rootGroupIds: string[]
}

function collectGroupClipboard(
  selectedGroupIds: string[],
  groups: Record<string, ShapeGroup>,
  shapes: Record<string, Shape>,
): GroupClipboard | null {
  const selected = new Set(selectedGroupIds.filter((id) => Boolean(groups[id])))
  const rootGroupIds = [...selected].filter((id) =>
    ![...selected].some((candidate) => candidate !== id && isAncestor(candidate, id, groups)),
  )
  if (rootGroupIds.length === 0) return null
  const copiedGroups: ShapeGroup[] = []
  const copiedShapes: Shape[] = []
  const seenGroups = new Set<string>()
  const seenShapes = new Set<string>()
  const visit = (groupId: string) => {
    if (seenGroups.has(groupId)) return
    const group = groups[groupId]
    if (!group) return
    seenGroups.add(groupId)
    copiedGroups.push(structuredClone(group))
    for (const childId of group.childIds) {
      if (groups[childId]) visit(childId)
      else if (shapes[childId] && !seenShapes.has(childId)) {
        seenShapes.add(childId)
        copiedShapes.push(structuredClone(shapes[childId]!))
      }
    }
  }
  for (const groupId of rootGroupIds) visit(groupId)
  return { groups: copiedGroups, shapes: copiedShapes, rootGroupIds }
}

function cloneCopiedShape(source: Shape, idMap: Map<string, string>): Shape {
  let copy = {
    ...structuredClone(source),
    id: idMap.get(source.id)!,
    name: source.name.endsWith(' 副本') ? source.name : `${source.name} 副本`,
    x: source.x + 24,
    y: source.y + 24,
    groupId: source.groupId ? idMap.get(source.groupId) ?? source.groupId : undefined,
  } as Shape
  if (copy.link?.kind === 'shape') {
    const targetId = copy.link.targetId ? idMap.get(copy.link.targetId) : undefined
    copy = { ...copy, link: targetId ? { ...copy.link, targetId } : undefined }
  }
  if (isArrowShape(copy)) {
    const startShapeId = copy.startBinding ? idMap.get(copy.startBinding.shapeId) : undefined
    const endShapeId = copy.endBinding ? idMap.get(copy.endBinding.shapeId) : undefined
    copy = {
      ...copy,
      startBinding: startShapeId && copy.startBinding
        ? { ...copy.startBinding, shapeId: startShapeId }
        : undefined,
      endBinding: endShapeId && copy.endBinding
        ? { ...copy.endBinding, shapeId: endShapeId }
        : undefined,
    }
  }
  return copy
}

function cloneShapeClipboard(sourceShapes: Shape[]): Shape[] {
  const uniqueShapes = [...new Map(sourceShapes.map((shape) => [shape.id, shape])).values()]
  const idMap = new Map(uniqueShapes.map((shape) => [shape.id, genId()]))
  return uniqueShapes.map((shape) => cloneCopiedShape(shape, idMap))
}

function cloneGroupClipboard(clipboard: GroupClipboard): GroupClipboard {
  const idMap = new Map<string, string>()
  for (const group of clipboard.groups) idMap.set(group.id, genId('g'))
  for (const shape of clipboard.shapes) idMap.set(shape.id, genId())
  const rootIds = new Set(clipboard.rootGroupIds)
  const groups = clipboard.groups.map((group) => ({
    ...structuredClone(group),
    id: idMap.get(group.id)!,
    name: rootIds.has(group.id) && !group.name.endsWith(' 副本') ? `${group.name} 副本` : group.name,
    childIds: group.childIds.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id)),
    parentId: group.parentId ? idMap.get(group.parentId) ?? group.parentId : undefined,
  }))
  return {
    groups,
    shapes: clipboard.shapes.map((shape) => cloneCopiedShape(shape, idMap)),
    rootGroupIds: clipboard.rootGroupIds.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id)),
  }
}


function normalizeDrawShape(shape: DrawShape): DrawShape | null {
  if (shape.points.length < 2) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x = 0, y = 0] of shape.points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return {
    ...shape,
    x: shape.x + minX,
    y: shape.y + minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    points: shape.points.map(([x = 0, y = 0]) => [x - minX, y - minY]),
  }
}

/** 折线简化(Ramer-Douglas-Peucker): 把拖动轨迹压缩成关键点, 拖直线=2点, 拐弯自动保留转折点 */
function simplifyPolyline(points: Array<{ x: number; y: number }>, tolerance: number): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points.map((point) => ({ ...point }))
  const first = points[0]!
  const last = points[points.length - 1]!
  const edgeX = last.x - first.x
  const edgeY = last.y - first.y
  const edgeLength = Math.hypot(edgeX, edgeY)
  let maxDistance = 0
  let splitIndex = 0
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index]!
    const distance = edgeLength === 0
      ? Math.hypot(point.x - first.x, point.y - first.y)
      : Math.abs(edgeY * point.x - edgeX * point.y + last.x * first.y - last.y * first.x) / edgeLength
    if (distance > maxDistance) {
      maxDistance = distance
      splitIndex = index
    }
  }
  if (maxDistance > tolerance) {
    const left = simplifyPolyline(points.slice(0, splitIndex + 1), tolerance)
    const right = simplifyPolyline(points.slice(splitIndex), tolerance)
    return [...left.slice(0, -1), ...right]
  }
  return [{ ...first }, { ...last }]
}

function normalizeArrow(
  shape: ArrowShape,
  worldPoints: Array<{ x: number; y: number }>,
): ArrowShape {
  const minX = Math.min(...worldPoints.map((point) => point.x))
  const minY = Math.min(...worldPoints.map((point) => point.y))
  const maxX = Math.max(...worldPoints.map((point) => point.x))
  const maxY = Math.max(...worldPoints.map((point) => point.y))
  return {
    ...shape,
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    points: worldPoints.map((point) => [point.x - minX, point.y - minY]),
  }
}

function shapeGeometry(shape: Shape): ShapeGeometry {
  return {
    id: shape.id,
    x: shape.x,
    y: shape.y,
    w: shape.w,
    h: shape.h,
    points: isArrowShape(shape) || isDrawShape(shape) ? structuredClone(shape.points) : undefined,
  }
}

const RATIO_LOCKED_TYPES = new Set<string>(['circle', 'square', 'inventory-slot'])

/** 缩放手柄悬停时的鼠标光标方向 */
const HANDLE_CURSORS: Record<string, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}

function resizeBounds(original: Bounds, handle: string, x: number, y: number): Bounds {
  const right = original.x + original.w
  const bottom = original.y + original.h
  let left = original.x
  let top = original.y
  let nextRight = right
  let nextBottom = bottom
  if (handle.includes('w')) left = Math.min(x, right - 1)
  if (handle.includes('e')) nextRight = Math.max(x, original.x + 1)
  if (handle.includes('n')) top = Math.min(y, bottom - 1)
  if (handle.includes('s')) nextBottom = Math.max(y, original.y + 1)
  return { x: left, y: top, w: nextRight - left, h: nextBottom - top }
}

function resizeCircle(original: ShapeGeometry, handle: string, worldX: number, worldY: number) {
  const right = original.x + original.w
  const bottom = original.y + original.h
  const centerX = original.x + original.w / 2
  const centerY = original.y + original.h / 2
  if (handle === 'e' || handle === 'w') {
    const size = Math.max(1, handle === 'e' ? worldX - original.x : right - worldX)
    return {
      x: handle === 'w' ? right - size : original.x,
      y: centerY - size / 2,
      w: size,
      h: size,
    }
  }
  if (handle === 'n' || handle === 's') {
    const size = Math.max(1, handle === 's' ? worldY - original.y : bottom - worldY)
    return {
      x: centerX - size / 2,
      y: handle === 'n' ? bottom - size : original.y,
      w: size,
      h: size,
    }
  }
  const oppositeX = handle.includes('w') ? right : original.x
  const oppositeY = handle.includes('n') ? bottom : original.y
  const size = Math.max(1, Math.max(Math.abs(worldX - oppositeX), Math.abs(worldY - oppositeY)))
  return {
    x: handle.includes('w') ? oppositeX - size : oppositeX,
    y: handle.includes('n') ? oppositeY - size : oppositeY,
    w: size,
    h: size,
  }
}

export default function CanvasEngine({
  readOnly = false,
  assetShareToken,
  assetSharePassword,
}: {
  readOnly?: boolean
  assetShareToken?: string
  assetSharePassword?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<Interaction>({ type: 'idle' })
  const rafRef = useRef(0)
  const dprRef = useRef(1)
  const renderDirtyRef = useRef(true)
  const spacePressedRef = useRef(false)
  const shapeClipboardRef = useRef<Shape[]>([])
  const groupClipboardRef = useRef<GroupClipboard | null>(null)
  const pendingInternalPastesRef = useRef(0)
  const lastInternalCopyAtRef = useRef(0)
  const lastSeenImageKeyRef = useRef('')
  const lastSeenImageAtRef = useRef(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [planCard, setPlanCard] = useState<{ x: number; y: number; title: string; content: string } | null>(null)
  const [planHint, setPlanHint] = useState<{ x: number; y: number } | null>(null)
  const readOnlyClickRef = useRef<{ x: number; y: number } | null>(null)
  const editingRef = useRef<HTMLTextAreaElement>(null)
  const editingSessionRef = useRef<{ id: string; originalText: string } | null>(null)
  const shapes = useCanvasStore((state) => state.shapes)
  const order = useCanvasStore((state) => state.order)
  const groups = useCanvasStore((state) => state.groups)
  const selectedIds = useCanvasStore((state) => state.selectedIds)
  const selectedGroupIds = useCanvasStore((state) => state.selectedGroupIds)
  const activeTool = useCanvasStore((state) => state.activeTool)
  const camera = useCanvasStore((state) => state.camera)
  const gridVisible = useCanvasStore((state) => state.gridVisible)
  const workspace = useCanvasStore((state) => state.workspace)
  const canvasBackground = useCanvasStore((state) => state.canvasBackground)
  const gridSize = useCanvasStore((state) => state.gridSize)

  const setCamera = useCanvasStore((state) => state.setCamera)
  const setTool = useCanvasStore((state) => state.setTool)
  const addShape = useCanvasStore((state) => state.addShape)
  const addShapes = useCanvasStore((state) => state.addShapes)
  const insertGraph = useCanvasStore((state) => state.insertGraph)
  const updateShape = useCanvasStore((state) => state.updateShape)
  const deleteShapes = useCanvasStore((state) => state.deleteShapes)
  const select = useCanvasStore((state) => state.select)
  const selectNodes = useCanvasStore((state) => state.selectNodes)
  const selectGroup = useCanvasStore((state) => state.selectGroup)
  const toggleSelect = useCanvasStore((state) => state.toggleSelect)
  const toggleGroupSelect = useCanvasStore((state) => state.toggleGroupSelect)
  const clearSelection = useCanvasStore((state) => state.clearSelection)
  const pushHistory = useCanvasStore((state) => state.pushHistory)
  const undo = useCanvasStore((state) => state.undo)
  const redo = useCanvasStore((state) => state.redo)
  const createGroup = useCanvasStore((state) => state.createGroup)
  const deleteGroups = useCanvasStore((state) => state.deleteGroups)
  const ungroup = useCanvasStore((state) => state.ungroup)
  const moveNode = useCanvasStore((state) => state.moveNode)

  const setActiveToolEditor = useEditorStore((state) => state.setActiveTool)
  const setSelectedShapeIdsEditor = useEditorStore((state) => state.setSelectedShapeIds)
  const setZoomLevel = useEditorStore((state) => state.setZoomLevel)
  const setCursorPosition = useEditorStore((state) => state.setCursorPosition)
  const [hoverCursor, setHoverCursor] = useState('')
  const hoverCursorRef = useRef('')
  const moveSelectedLayer = useCanvasStore((state) => state.moveSelectedLayer)
  const constrainCamera = useCallback(
    (nextCamera: Partial<{ x: number; y: number; zoom: number }>) => {
      const canvas = canvasRef.current
      const next = constrainCameraToWorkspace(
        { ...camera, ...nextCamera },
        workspace,
        canvas?.clientWidth ?? 1,
        canvas?.clientHeight ?? 1,
      )
      setCamera(next)
    },
    [camera, setCamera, workspace],
  )

  const screenToWorld = useCallback(
    (screenX: number, screenY: number) => ({
      x: (screenX - camera.x) / camera.zoom,
      y: (screenY - camera.y) / camera.zoom,
    }),
    [camera],
  )

  const orderedShapesRef = useRef<Shape[]>([])
  const orderedShapes = useCallback(() => {
    const latest = flattenRenderOrder(order, shapes, groups)
    orderedShapesRef.current = latest
    return latest
  }, [order, shapes, groups])

  const zoomToFit = useCallback(() => {
    const allShapes = orderedShapes().filter((shape) => shape.visible)
    const canvas = canvasRef.current
    const bounds = getSelectionBounds(allShapes)
    if (!bounds || !canvas) return
    const padding = 80
    const zoom = Math.min(
      Math.max(1, canvas.clientWidth - padding * 2) / Math.max(1, bounds.w),
      Math.max(1, canvas.clientHeight - padding * 2) / Math.max(1, bounds.h),
      4,
    )
    constrainCamera({
      x: canvas.clientWidth / 2 - (bounds.x + bounds.w / 2) * zoom,
      y: canvas.clientHeight / 2 - (bounds.y + bounds.h / 2) * zoom,
      zoom: Math.max(0.1, zoom),
    })
  }, [constrainCamera, orderedShapes])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const resizeCanvas = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const width = Math.max(1, Math.round(container.clientWidth * dpr))
      const height = Math.max(1, Math.round(container.clientHeight * dpr))
      const resized = canvas.width !== width || canvas.height !== height || dprRef.current !== dpr
      dprRef.current = dpr
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      if (resized) renderDirtyRef.current = true
    }

    resizeCanvas()
    const observer = new ResizeObserver(resizeCanvas)
    observer.observe(container)
    window.addEventListener('resize', resizeCanvas)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [])

  useEffect(() => {
    function restoreCanvasShapes(event: Event) {
      const shapesToRestore = (event as CustomEvent<{ shapes: Shape[] }>).detail.shapes
      for (const shape of shapesToRestore) updateShape(shape.id, { x: shape.x, y: shape.y })
    }
    window.addEventListener('flowboard:canvas-drag-restore', restoreCanvasShapes)
    return () => window.removeEventListener('flowboard:canvas-drag-restore', restoreCanvasShapes)
  }, [updateShape])


  // 外置图片（/api/assets/...）异步加载完成后请求重绘，
  // 否则画布会一直停在"图片加载中"占位。
  useEffect(() => {
    setImageLoadListener(() => { renderDirtyRef.current = true })
    return () => setImageLoadListener(null)
  }, [])

  useEffect(() => {
    renderDirtyRef.current = true
  }, [camera, canvasBackground, editingId, gridSize, gridVisible, groups, orderedShapes, selectedGroupIds, selectedIds, workspace])

  useEffect(() => {
    let frame = 0
    const loop = () => {
      const canvas = canvasRef.current
      if (canvas) {
        const interaction = interactionRef.current
        if (interaction.type !== 'idle' || renderDirtyRef.current) {
          renderDirtyRef.current = false
          const context = canvas.getContext('2d')
          if (context) {
            const dpr = dprRef.current
            context.save()
            context.scale(dpr, dpr)
            try {
              const renderedShapes = orderedShapes()
              let allShapes = editingId
                ? renderedShapes.map((shape) => shape.id === editingId ? { ...shape, text: '' } : shape)
                : renderedShapes
              // 拖拽中：用 interaction 里的 delta 覆盖对应形状的位置（不依赖 store，避免重渲染）。
              // 注意：必须生成新数组，不能原地清空 allShapes——未编辑时它与 renderedShapes
              // 是同一引用，清空会连带清空源数组导致画布空白。
              if (interaction.type === 'moving') {
                const deltaById = new Map(interaction.items.map((item) => [item.id, item]))
                allShapes = allShapes.map((shape) => {
                  const item = deltaById.get(shape.id)
                  return item ? { ...shape, x: item.x + interaction.deltaX, y: item.y + interaction.deltaY } : shape
                })
              }
              if (
                interaction.type === 'drawing' ||
                interaction.type === 'drawingPath' ||
                interaction.type === 'drawingArrow' ||
                interaction.type === 'connecting'
              ) {
                // 预览形状：同样避免污染缓存数组
                allShapes = [...allShapes, interaction.shape]
              }
              render(
                context,
                allShapes,
                selectedIds,
                camera,
                gridVisible,
                canvas.width / dpr,
                canvas.height / dpr,
                groups,
                selectedGroupIds,
                workspace,
                interaction.type === 'selecting'
                  ? {
                      x: Math.min(interaction.startX, interaction.endX),
                      y: Math.min(interaction.startY, interaction.endY),
                      w: Math.abs(interaction.endX - interaction.startX),
                      h: Math.abs(interaction.endY - interaction.startY),
                    }
                  : null,
                readOnly,
                canvasBackground,
                gridSize,
              )
            } finally {
              context.restore()
            }
          }
        }
      }
      frame = requestAnimationFrame(loop)
      rafRef.current = frame
    }
    frame = requestAnimationFrame(loop)
    rafRef.current = frame
    return () => cancelAnimationFrame(frame)
  }, [camera, canvasBackground, editingId, gridSize, gridVisible, groups, orderedShapes, selectedGroupIds, selectedIds, workspace])

  useEffect(() => {
    setActiveToolEditor(activeTool)
    setSelectedShapeIdsEditor(selectedIds)
    setZoomLevel(camera.zoom)
  }, [
    activeTool,
    camera.zoom,
    selectedIds,
    setActiveToolEditor,
    setSelectedShapeIdsEditor,
    setZoomLevel,
  ])

  const pointerPosition = useCallback(
    (event: React.PointerEvent | PointerEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const screenX = event.clientX - rect.left
      const screenY = event.clientY - rect.top
      return { screenX, screenY, world: screenToWorld(screenX, screenY) }
    },
    [screenToWorld],
  )

  const topmostHit = useCallback(
    (x: number, y: number, excludedId?: string) => {
      const allShapes = orderedShapes()
      return (
        [...allShapes].reverse()
          .find(
            (shape) =>
              shape && shape.id !== excludedId && hitTest(shape, x, y, shapes, 8 / camera.zoom),
          ) ?? null
      )
    },
    [camera.zoom, orderedShapes, shapes],
  )

  const nearestAnchor = useCallback(
    (x: number, y: number, excludedId?: string) => {
      const allShapes = orderedShapes()
      let best: { shape: Shape; anchor: ConnectionAnchor; distance: number } | null = null
      for (const shape of [...allShapes].reverse()) {
        if (
          !shape ||
          shape.id === excludedId ||
          !shape.visible ||
          shape.locked ||
          isArrowShape(shape)
        )
          continue
        for (const anchor of ['top', 'right', 'bottom', 'left'] as ConnectionAnchor[]) {
          const point = getAnchorPoint(shape, anchor)
          const distance = Math.hypot(x - point.x, y - point.y)
          if (distance <= 24 / camera.zoom && (!best || distance < best.distance))
            best = { shape, anchor, distance }
        }
      }
      return best
    },
    [camera.zoom, orderedShapes],
  )

  const topmostGroupHit = useCallback(
    (x: number, y: number) => {
      const topGroups = order.filter((id) => groups[id])
      for (const groupId of [...topGroups].reverse()) {
        const group = groups[groupId]
        if (group && hitTestGroup(group, shapes, x, y, 6 / camera.zoom)) return groupId
      }
      return null
    },
    [camera.zoom, groups, order, shapes],
  )
  function beginConnection(shape: Shape, anchor: ConnectionAnchor) {
    const start = getAnchorPoint(shape, anchor)
    const route = createConnectionRoute(start, start, anchor)
    const arrow = normalizeArrow(createShape('arrow', start.x, start.y, 1, 1) as ArrowShape, route)
    arrow.name = `${shape.name} 关联箭头`
    arrow.startBinding = { shapeId: shape.id, anchor }
    interactionRef.current = {
      type: 'connecting',
      shape: arrow,
      sourceId: shape.id,
      sourceAnchor: anchor,
    }
  }

  /** 右键上下文菜单：右键点中图形时选中它并弹出菜单 */
  function onContextMenu(event: React.MouseEvent) {
    event.preventDefault()
    if (readOnly) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top)
    // 右键命中检测：从顶层向下找命中的图形
    const topShape = flattenRenderOrder(order, shapes, groups)
      .filter((shape) => shape.visible && !shape.locked)
      .reverse()
      .find((shape) => world.x >= shape.x && world.x <= shape.x + shape.w && world.y >= shape.y && world.y <= shape.y + shape.h)
    if (topShape && !selectedIds.includes(topShape.id)) select([topShape.id])
    setContextMenu({ x: event.clientX, y: event.clientY })
  }

  function onPointerDown(event: React.PointerEvent) {
    // 左键按下时关闭右键菜单
    if (event.button === 0 && contextMenu) setContextMenu(null)
    const canvas = canvasRef.current
    const position = pointerPosition(event)
    if (!canvas || !position) return
    const { screenX, screenY, world } = position
    // 双击的第二次指针按下不进入移动交互，避免控件被轻微位移。
    if (event.detail > 1) {
      interactionRef.current = { type: 'idle' }
      return
    }
    const panning = activeTool === 'hand' || event.button === 1 || (event.button === 0 && spacePressedRef.current)
    if (readOnly && !panning) {
      readOnlyClickRef.current = { x: screenX, y: screenY }
      return
    }

    if (
      activeTool === 'hand' ||
      event.button === 1 ||
      (event.button === 0 && spacePressedRef.current)
    ) {
      interactionRef.current = {
        type: 'panning',
        startX: screenX,
        startY: screenY,
        cameraX: camera.x,
        cameraY: camera.y,
      }
      canvas.setPointerCapture(event.pointerId)
      return
    }

    if (activeTool !== 'select') {
      if (activeTool === 'draw') {
        const shape = createShape('draw', world.x, world.y, 0, 0) as DrawShape
        shape.points = [[0, 0]]
        interactionRef.current = { type: 'drawingPath', shape }
      } else if (activeTool === 'text') {
        const shape = createShape('text', world.x, world.y, 200, 32)
        shape.text = '文本'
        addShape(shape)
        select([shape.id])
        setTool('select')
        return
      } else if (activeTool === 'arrow') {
        const shape = createShape('arrow', world.x, world.y, 1, 1) as ArrowShape
        interactionRef.current = { type: 'drawingArrow', shape, startX: world.x, startY: world.y, raw: [{ x: world.x, y: world.y }] }
      } else if (activeTool === 'table') {
        setTool('select')
        return
      } else {
        const shape = createShape(activeTool, world.x, world.y, 0, 0)
        interactionRef.current = { type: 'drawing', shape, startX: world.x, startY: world.y }
      }
      canvas.setPointerCapture(event.pointerId)
      return
    }
    const selectionModifier = event.ctrlKey || event.metaKey
    if (event.button === 0 && selectionModifier) {
      const hitShape = topmostHit(world.x, world.y)
      const hitGroupId = hitShape ? undefined : topmostGroupHit(world.x, world.y) ?? undefined
      interactionRef.current = {
        type: 'selecting',
        startX: world.x,
        startY: world.y,
        endX: world.x,
        endY: world.y,
        additive: true,
        intersectMode: true,
        initialSelectedIds: [...selectedIds],
        initialSelectedGroupIds: [...selectedGroupIds],
        hitShapeId: hitShape?.id,
        hitGroupId,
      }
      canvas.setPointerCapture(event.pointerId)
      return
    }
    const selectedGroupId = selectedGroupIds.length === 1 ? selectedGroupIds[0] : undefined
    const selectedGroup = selectedGroupId ? groups[selectedGroupId] : undefined
    const selectedGroupBounds = getGroupBounds(selectedGroup, shapes)
    const groupHandle = selectedGroupBounds
      ? hitTestHandle(
          {
            x: selectedGroupBounds.x - 18,
            y: selectedGroupBounds.y - 18,
            w: selectedGroupBounds.w + 36,
            h: selectedGroupBounds.h + 36,
          },
          world.x,
          world.y,
          10 / camera.zoom,
        )
      : null
    if (selectedGroup && selectedGroupBounds && groupHandle) {
      const groupShapes = selectedGroup.childIds.map((id) => shapes[id]).filter(Boolean) as Shape[]
      interactionRef.current = {
        type: 'resizing',
        handle: groupHandle,
        bounds: selectedGroupBounds,
        items: groupShapes.map(shapeGeometry),
        historyPushed: false,
      }
      canvas.setPointerCapture(event.pointerId)
      return
    }

    if (selectedIds.length === 1) {
      const selectedShape = shapes[selectedIds[0]!]
      if (selectedShape) {
        if (isArrowShape(selectedShape)) {
          const pointIndex = hitTestArrowPoint(
            selectedShape,
            shapes,
            world.x,
            world.y,
            10 / camera.zoom,
          )
          if (pointIndex !== null) {
            interactionRef.current = {
              type: 'arrowPoint',
              id: selectedShape.id,
              pointIndex,
              worldPoints: getArrowWorldPoints(selectedShape, shapes),
              historyPushed: false,
            }
            canvas.setPointerCapture(event.pointerId)
            return
          }
        } else {
          const anchor = hitTestConnectionAnchor(
            selectedShape,
            world.x,
            world.y,
            10 / camera.zoom,
            18 / camera.zoom,
          )
          if (anchor) {
            beginConnection(selectedShape, anchor)
            canvas.setPointerCapture(event.pointerId)
            return
          }
        }
      }
    }

    const selectedShapes = selectedIds.map((id) => shapes[id]).filter(Boolean) as Shape[]
    const selectedBounds = getSelectionBounds(selectedShapes)
    const firstSelected = selectedShapes.length === 1 ? selectedShapes[0]! : null
    const rotationTestBounds =
      firstSelected && !isArrowShape(firstSelected)
        ? { x: firstSelected.x, y: firstSelected.y, w: firstSelected.w, h: firstSelected.h }
        : selectedBounds
    if (
      firstSelected &&
      rotationTestBounds &&
      hitTestRotationHandle(rotationTestBounds, world.x, world.y, 10 / camera.zoom, firstSelected.rotation, 28 / camera.zoom)
    ) {
      const selectedShape = selectedShapes[0]!
      const centerX = selectedShape.x + selectedShape.w / 2
      const centerY = selectedShape.y + selectedShape.h / 2
      interactionRef.current = {
        type: 'rotating',
        id: selectedShape.id,
        centerX,
        centerY,
        startAngle: Math.atan2(world.y - centerY, world.x - centerX),
        rotation: selectedShape.rotation,
        historyPushed: false,
      }
      canvas.setPointerCapture(event.pointerId)
      return
    }
    if (selectedBounds && !selectedShapes.some(isArrowShape)) {
      const singleShape = selectedShapes.length === 1 ? selectedShapes[0]! : null
      const handleBounds =
        singleShape
          ? { x: singleShape.x, y: singleShape.y, w: singleShape.w, h: singleShape.h }
          : selectedBounds
      const handle = hitTestHandle(handleBounds, world.x, world.y, 10 / camera.zoom, singleShape?.rotation ?? 0)
      if (handle) {
        interactionRef.current = {
          type: 'resizing',
          handle,
          bounds: handleBounds,
          items: selectedShapes.map(shapeGeometry),
          historyPushed: false,
        }
        canvas.setPointerCapture(event.pointerId)
        return
      }
    }

    const hit = topmostHit(world.x, world.y)
    if (hit) {
      let nextSelection: string[]
      if (event.shiftKey || event.ctrlKey) {
        toggleSelect(hit.id)
        nextSelection = useCanvasStore.getState().selectedIds
      } else if (selectedIds.includes(hit.id)) {
        nextSelection = selectedIds
      } else {
        nextSelection = [hit.id]
        select(nextSelection)
      }
      const movable = nextSelection
        .map((id) => shapes[id])
        .filter((shape) => shape && !shape.locked) as Shape[]
      interactionRef.current = {
        type: 'moving',
        startX: world.x,
        startY: world.y,
        deltaX: 0,
        deltaY: 0,
        items: movable.map(shapeGeometry),
        sourceShapes: structuredClone(movable),
        historyPushed: false,
      }
      canvas.setPointerCapture(event.pointerId)
      return
    }

    const groupHit = topmostGroupHit(world.x, world.y)
    if (groupHit && selectedGroupIds.includes(groupHit)) {
      // 容器已选中：拖拽移动整个容器。
      const group = groups[groupHit]
      if (group) {
        const movable = collectShapeDescendants(groupHit, groups)
          .map((id) => shapes[id])
          .filter((shape) => shape && !shape.locked) as Shape[]
        interactionRef.current = {
          type: 'moving',
          startX: world.x,
          startY: world.y,
          deltaX: 0,
          deltaY: 0,
          items: movable.map(shapeGeometry),
          sourceShapes: structuredClone(movable),
          historyPushed: false,
        }
        canvas.setPointerCapture(event.pointerId)
        return
      }
    }

    // 其它情况（含容器内部空白区域）：所有区域都可拖拽框选；单击时仍可选中命中的容器。
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    if (!additive) clearSelection()
    interactionRef.current = {
      type: 'selecting',
      startX: world.x,
      startY: world.y,
      endX: world.x,
      endY: world.y,
      additive,
      intersectMode: event.ctrlKey || event.metaKey,
      initialSelectedIds: additive ? [...selectedIds] : [],
      initialSelectedGroupIds: additive ? [...selectedGroupIds] : [],
      hitGroupId: groupHit ?? undefined,
    }
    canvas.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent) {
    const position = pointerPosition(event)
    if (!position) return
    const { screenX, screenY, world } = position
    setCursorPosition({ x: Math.round(world.x), y: Math.round(world.y) })
    if (interactionRef.current.type === 'idle' && activeTool === 'select') {
      let nextCursor = ''
      const hoveredSelected = selectedIds.map((id) => shapes[id]).filter(Boolean) as Shape[]
      const hoveredSingle = hoveredSelected.length === 1 ? hoveredSelected[0]! : null
      if (hoveredSingle && !isArrowShape(hoveredSingle) &&
        hitTestRotationHandle({ x: hoveredSingle.x, y: hoveredSingle.y, w: hoveredSingle.w, h: hoveredSingle.h }, world.x, world.y, 10 / camera.zoom, hoveredSingle.rotation, 28 / camera.zoom)) {
        nextCursor = 'grab'
      }
      if (!nextCursor && hoveredSelected.length > 0 && !hoveredSelected.some(isArrowShape)) {
        const hoverBounds = hoveredSingle
          ? { x: hoveredSingle.x, y: hoveredSingle.y, w: hoveredSingle.w, h: hoveredSingle.h }
          : getSelectionBounds(hoveredSelected)
        if (hoverBounds) {
          const hoveredHandle = hitTestHandle(hoverBounds, world.x, world.y, 10 / camera.zoom, hoveredSingle?.rotation ?? 0)
          if (hoveredHandle) nextCursor = HANDLE_CURSORS[hoveredHandle] ?? 'default'
        }
      }
      if (nextCursor !== hoverCursorRef.current) {
        hoverCursorRef.current = nextCursor
        setHoverCursor(nextCursor)
      }
    }
    const interaction = interactionRef.current

    if (readOnly && interaction.type === 'idle') {
      const plannedShape = [...orderedShapes()].reverse().find((shape) => shape && shape.description && hitTest(shape, world.x, world.y, shapes, 8 / camera.zoom)) ?? null
      const hoverGroupId = plannedShape ? null : topmostGroupHit(world.x, world.y)
      const hasPlan = Boolean(plannedShape) || Boolean(hoverGroupId && groups[hoverGroupId]?.description)
      setPlanHint(hasPlan ? { x: screenX, y: screenY } : null)
      return
    }
    if (interaction.type === 'idle') {
      return
    }
    if (interaction.type === 'panning') {
      constrainCamera({
        x: interaction.cameraX + screenX - interaction.startX,
        y: interaction.cameraY + screenY - interaction.startY,
      })
      return
    }
    if (interaction.type === 'drawing') {
      const deltaX = world.x - interaction.startX
      const deltaY = world.y - interaction.startY
      if (RATIO_LOCKED_TYPES.has(interaction.shape.type)) {
        const size = Math.max(Math.abs(deltaX), Math.abs(deltaY))
        interaction.shape.x = deltaX < 0 ? interaction.startX - size : interaction.startX
        interaction.shape.y = deltaY < 0 ? interaction.startY - size : interaction.startY
        interaction.shape.w = size
        interaction.shape.h = size
      } else {
        interaction.shape.x = Math.min(interaction.startX, world.x)
        interaction.shape.y = Math.min(interaction.startY, world.y)
        interaction.shape.w = Math.abs(deltaX)
        interaction.shape.h = Math.abs(deltaY)
      }
      return
    }
    if (interaction.type === 'drawingArrow') {
      // 采样拖动轨迹并实时简化: 拖直线=两个点, 拖出拐弯自动保留转折点
      const lastSample = interaction.raw[interaction.raw.length - 1]!
      if (Math.hypot(world.x - lastSample.x, world.y - lastSample.y) > 2) interaction.raw.push({ x: world.x, y: world.y })
      interaction.shape = normalizeArrow(interaction.shape, simplifyPolyline(interaction.raw, 3))
      interactionRef.current = interaction
      return
    }
    if (interaction.type === 'drawingPath') {
      interaction.shape.points.push([world.x - interaction.shape.x, world.y - interaction.shape.y])
      return
    }
    if (interaction.type === 'moving') {
      const deltaX = world.x - interaction.startX
      const deltaY = world.y - interaction.startY
      const dragThreshold = 3 / camera.zoom
      if (Math.abs(deltaX) < dragThreshold && Math.abs(deltaY) < dragThreshold) return
      if (!interaction.historyPushed) {
        pushHistory()
        interaction.historyPushed = true
      }
      // 拖拽期间只记 delta 不写 store，渲染时用 delta 覆盖；松手时一次性写入 store，
      // 避免每个 pointermove 触发一次全画布 React 重渲染。
      interaction.deltaX = deltaX
      interaction.deltaY = deltaY
      window.dispatchEvent(
        new CustomEvent('flowboard:canvas-drag-move', {
          detail: {
            clientX: event.clientX,
            clientY: event.clientY,
            shapes: interaction.sourceShapes,
          },
        }),
      )
      return
    }
    if (interaction.type === 'rotating') {
      const shape = shapes[interaction.id]
      if (!shape) return
      if (!interaction.historyPushed) {
        pushHistory()
        interaction.historyPushed = true
      }
      const angle = Math.atan2(world.y - interaction.centerY, world.x - interaction.centerX)
      updateShape(interaction.id, {
        rotation: interaction.rotation + angle - interaction.startAngle,
      })
      return
    }
    if (interaction.type === 'resizing') {
      if (!interaction.historyPushed) {
        pushHistory()
        interaction.historyPushed = true
      }
      const rotatedItem = interaction.items.length === 1 ? interaction.items[0] : null
      const rotatedShape = rotatedItem ? shapes[rotatedItem.id] : undefined
      if (rotatedItem && rotatedShape && rotatedShape.rotation) {
        const rcx = interaction.bounds.x + interaction.bounds.w / 2
        const rcy = interaction.bounds.y + interaction.bounds.h / 2
        const local = rotatePointAround(world.x, world.y, rcx, rcy, -rotatedShape.rotation)
        const next =
          RATIO_LOCKED_TYPES.has(rotatedShape.type)
            ? resizeCircle(rotatedItem, interaction.handle, local.x, local.y)
            : resizeBounds(interaction.bounds, interaction.handle, local.x, local.y)
        const worldCenter = rotatePointAround(next.x + next.w / 2, next.y + next.h / 2, rcx, rcy, rotatedShape.rotation)
        updateShape(rotatedItem.id, {
          x: worldCenter.x - next.w / 2,
          y: worldCenter.y - next.h / 2,
          w: next.w,
          h: next.h,
        })
        return
      }
      if (interaction.items.length === 1 && RATIO_LOCKED_TYPES.has(shapes[interaction.items[0]!.id]?.type ?? '')) {
        const item = interaction.items[0]!
        updateShape(item.id, resizeCircle(item, interaction.handle, world.x, world.y))
        return
      }
      const bounds = resizeBounds(interaction.bounds, interaction.handle, world.x, world.y)
      const scaleX = bounds.w / Math.max(1, interaction.bounds.w)
      const scaleY = bounds.h / Math.max(1, interaction.bounds.h)
      for (const item of interaction.items) {
        const shape = shapes[item.id]
        if (!shape) continue
        let width = Math.max(1, item.w * scaleX)
        let height = Math.max(1, item.h * scaleY)
        if (RATIO_LOCKED_TYPES.has(shape.type))
          width = height = Math.max(1, item.w * Math.min(scaleX, scaleY))
        const basePatch: Partial<Shape> = {
          x: bounds.x + (item.x - interaction.bounds.x) * scaleX,
          y: bounds.y + (item.y - interaction.bounds.y) * scaleY,
          w: width,
          h: height,
        }
        if (item.points && isArrowShape(shape)) {
          updateShape(item.id, {
            ...basePatch,
            points: item.points.map(([x = 0, y = 0]) => [x * scaleX, y * scaleY]),
          })
        } else if (item.points && isDrawShape(shape)) {
          updateShape(item.id, {
            ...basePatch,
            points: item.points.map(([x = 0, y = 0]) => [x * scaleX, y * scaleY]),
          })
        } else {
          updateShape(item.id, basePatch)
        }
      }
      return
    }
    if (interaction.type === 'selecting') {
      interaction.endX = world.x
      interaction.endY = world.y
      return
    }
    if (interaction.type === 'connecting') {
      const source = shapes[interaction.sourceId]
      if (!source) return
      const start = getAnchorPoint(source, interaction.sourceAnchor)
      interaction.shape = normalizeArrow(
        interaction.shape,
        createConnectionRoute(start, world, interaction.sourceAnchor),
      )
      interactionRef.current = interaction
      return
    }
    if (interaction.type === 'arrowPoint') {
      const arrow = shapes[interaction.id]
      if (!arrow || !isArrowShape(arrow)) return
      if (!interaction.historyPushed) {
        pushHistory()
        interaction.historyPushed = true
      }
      const points = interaction.worldPoints.map((point) => ({ ...point }))
      points[interaction.pointIndex] = { x: world.x, y: world.y }
      let nextArrow = normalizeArrow(arrow, points)
      if (interaction.pointIndex === 0) nextArrow = { ...nextArrow, startBinding: undefined }
      if (interaction.pointIndex === points.length - 1)
        nextArrow = { ...nextArrow, endBinding: undefined }
      updateShape(arrow.id, nextArrow)
    }
  }

  function finishPointerInteraction(event?: React.PointerEvent) {
    const interaction = interactionRef.current
    const position = event ? pointerPosition(event) : null
    const world = position?.world

    if (readOnly) {
      const clickStart = readOnlyClickRef.current
      readOnlyClickRef.current = null
      if (clickStart && position && Math.hypot(position.screenX - clickStart.x, position.screenY - clickStart.y) < 5 && world) {
        const hitShape = [...orderedShapes()].reverse().find((shape) => shape && hitTest(shape, world.x, world.y, shapes, 8 / camera.zoom)) ?? null
        // 优先：带链接的图形点击跳转
        if (hitShape?.link?.kind === 'url' && hitShape.link.url) {
          window.open(hitShape.link.url, '_blank', 'noopener')
          interactionRef.current = { type: 'idle' }
          return
        }
        const plannedShape = [...orderedShapes()].reverse().find((shape) => shape && shape.description && hitTest(shape, world.x, world.y, shapes, 8 / camera.zoom)) ?? null
        let description: string | undefined = plannedShape?.description
        let title = plannedShape?.name ?? ''
        if (!description) {
          const hitGroupId = topmostGroupHit(world.x, world.y)
          const hitGroup = hitGroupId ? groups[hitGroupId] : null
          description = hitGroup?.description
          title = hitGroup?.name ?? ''
        }
        if (description) setPlanCard({ x: clickStart.x, y: clickStart.y, title: title || '策划案', content: description })
        else setPlanCard(null)
      } else {
        setPlanCard(null)
      }
      interactionRef.current = { type: 'idle' }
      return
    }

    if (interaction.type === 'drawing') {
      const shape = interaction.shape
      const finalShape =
        shape.w < 5 && shape.h < 5
          ? createShape(shape.type, shape.x, shape.y)
          : { ...shape, w: Math.max(1, shape.w), h: Math.max(1, shape.h) }
      addShape(finalShape)
      select([finalShape.id])
      setTool('select')
    } else if (interaction.type === 'drawingArrow') {
      const simplified = simplifyPolyline(interaction.raw, 3)
      const finalArrow = simplified.length >= 2
        ? normalizeArrow(interaction.shape, simplified)
        : createShape('arrow', interaction.startX - 60, interaction.startY - 1, 120, 2)
      addShape(finalArrow)
      select([finalArrow.id])
      setTool('select')
    } else if (interaction.type === 'drawingPath') {
      const shape = normalizeDrawShape(interaction.shape)
      if (shape) {
        addShape(shape)
        select([shape.id])
      }
      setTool('select')
    } else if (interaction.type === 'connecting') {
      let arrow = interaction.shape
      if (world) {
        const target = nearestAnchor(world.x, world.y, interaction.sourceId)
        if (target) {
          arrow = { ...arrow, endBinding: { shapeId: target.shape.id, anchor: target.anchor } }
          const points = getArrowWorldPoints(arrow, shapes)
          arrow = normalizeArrow(arrow, points)
          logOperation('connection.bound', 'Connected two components', {
            from: interaction.sourceId,
            to: target.shape.id,
          })
        }
      }
      addShape(arrow)
      select([arrow.id])
    } else if (interaction.type === 'arrowPoint' && world) {
      const arrow = useCanvasStore.getState().shapes[interaction.id]
      if (
        arrow &&
        isArrowShape(arrow) &&
        (interaction.pointIndex === 0 || interaction.pointIndex === arrow.points.length - 1)
      ) {
        const target = nearestAnchor(world.x, world.y)
        if (target) {
          const next =
            interaction.pointIndex === 0
              ? { ...arrow, startBinding: { shapeId: target.shape.id, anchor: target.anchor } }
              : { ...arrow, endBinding: { shapeId: target.shape.id, anchor: target.anchor } }
          updateShape(
            arrow.id,
            normalizeArrow(next, getArrowWorldPoints(next, useCanvasStore.getState().shapes)),
          )
        }
      }
    }
    if (interaction.type === 'selecting' && world) {
      const minX = Math.min(interaction.startX, world.x)
      const minY = Math.min(interaction.startY, world.y)
      const maxX = Math.max(interaction.startX, world.x)
      const maxY = Math.max(interaction.startY, world.y)
      const intersectMode = interaction.intersectMode
      const shapeIdsInBox = getAllShapesInOrder(order, shapes, groups)
        .filter((shape) => {
          if (!shape.visible) return false
          const box = shapeAABB(shape)
          // Ctrl 状态：碰着就选，不要求完全包含。
          return intersectMode
            ? box.x <= maxX && box.x + box.w >= minX && box.y <= maxY && box.y + box.h >= minY
            : box.x >= minX &&
              box.y >= minY &&
              box.x + box.w <= maxX &&
              box.y + box.h <= maxY
        })
        .map((shape) => shape.id)
      // Ctrl 状态：只逐个选中相交的组件，不整体选中外层大背景容器。
      const selectedInBox = shapeIdsInBox
      const dragDistance = Math.hypot(world.x - interaction.startX, world.y - interaction.startY)
      if (dragDistance < 3 / camera.zoom) {
        if (interaction.hitShapeId) {
          if (interaction.additive) toggleSelect(interaction.hitShapeId)
          else select([interaction.hitShapeId])
        } else if (interaction.hitGroupId) {
          if (interaction.additive) toggleGroupSelect(interaction.hitGroupId)
          else selectGroup(interaction.hitGroupId)
        } else if (!interaction.additive) {
          clearSelection()
        }
      } else if (interaction.additive) {
        selectNodes(
          [...new Set([...interaction.initialSelectedIds, ...selectedInBox])],
          interaction.initialSelectedGroupIds,
        )
      } else {
        select(selectedInBox)
      }
    }

    const favoriteZoneElement = document.querySelector('[data-flowboard-favorite-zone]')
    const favoriteZoneRect = favoriteZoneElement ? favoriteZoneElement.getBoundingClientRect() : null
    const droppedInFavoriteZone = Boolean(
      interaction.type === 'moving' &&
      favoriteZoneRect &&
      event &&
      event.clientX >= favoriteZoneRect.left &&
      event.clientX <= favoriteZoneRect.right &&
      event.clientY >= favoriteZoneRect.top &&
      event.clientY <= favoriteZoneRect.bottom,
    )
    if (interaction.type === 'moving' && interaction.historyPushed && droppedInFavoriteZone) {
      // Saving to favorites: restore original positions and keep group membership untouched.
      // 拖拽期间未写 store，无需还原，分组保持不变即可。
    }
    if (interaction.type === 'moving' && interaction.historyPushed && world && !droppedInFavoriteZone) {
      // 提交拖拽结果：一次性把 delta 写入 store（拖拽期间未写，见 pointermove）。
      for (const item of interaction.items) updateShape(item.id, { x: item.x + interaction.deltaX, y: item.y + interaction.deltaY })
      // 检测拖放后是否落入某个分组区域: 整体拖动的分组作为子分组挂入目标分组(保留内部结构, 成为目标组内的组空间), 零散图形沿用逐件自动归组/移出组。
      const movedIds = interaction.items.map((item) => item.id)
      const movedSet = new Set(movedIds)
      const latestState = useCanvasStore.getState()
      const fullyMovedGroupIds = Object.keys(latestState.groups).filter((groupId) => {
        const descendants = collectShapeDescendants(groupId, latestState.groups)
        return descendants.length > 0 && descendants.every((descendantId) => movedSet.has(descendantId))
      })
      const topMovedGroupIds = fullyMovedGroupIds.filter(
        (groupId) => !fullyMovedGroupIds.some((other) => other !== groupId && isAncestor(other, groupId, latestState.groups)),
      )
      const coveredByMovedGroup = new Set<string>()
      for (const groupId of topMovedGroupIds) {
        for (const descendantId of collectShapeDescendants(groupId, latestState.groups)) coveredByMovedGroup.add(descendantId)
      }
      const findTargetGroup = (cx: number, cy: number, excludeIds: Set<string>): string | null => {
        const currentState = useCanvasStore.getState()
        const pad = 8
        let best: { id: string; area: number } | null = null
        for (const [candidateId, candidateGroup] of Object.entries(currentState.groups)) {
          if (excludeIds.has(candidateId)) continue
          const candidateBounds = getGroupBounds(candidateGroup, currentState.shapes, currentState.groups)
          if (!candidateBounds) continue
          if (
            cx >= candidateBounds.x - pad && cx <= candidateBounds.x + candidateBounds.w + pad &&
            cy >= candidateBounds.y - pad && cy <= candidateBounds.y + candidateBounds.h + pad
          ) {
            const area = candidateBounds.w * candidateBounds.h
            if (!best || area < best.area) best = { id: candidateId, area }
          }
        }
        return best?.id ?? null
      }
      for (const groupId of topMovedGroupIds) {
        const currentState = useCanvasStore.getState()
        const group = currentState.groups[groupId]
        if (!group) continue
        const bounds = getGroupBounds(group, currentState.shapes, currentState.groups)
        if (!bounds) continue
        const cx = bounds.x + bounds.w / 2
        const cy = bounds.y + bounds.h / 2
        const excludeIds = new Set<string>(topMovedGroupIds)
        for (const descendantGroupId of collectGroupDescendants(groupId, currentState.groups)) excludeIds.add(descendantGroupId)
        const targetGroup = findTargetGroup(cx, cy, excludeIds)
        if (targetGroup && targetGroup !== group.parentId) {
          moveNode(groupId, targetGroup)
          continue
        }
        if (!targetGroup && group.parentId) {
          const parent = currentState.groups[group.parentId]
          if (parent) {
            const shapesExcludingGroup = { ...currentState.shapes }
            for (const descendantId of collectShapeDescendants(groupId, currentState.groups)) delete shapesExcludingGroup[descendantId]
            const parentBounds = getGroupBounds(parent, shapesExcludingGroup, currentState.groups)
            if (parentBounds) {
              const pad = 8
              if (
                cx < parentBounds.x - pad || cx > parentBounds.x + parentBounds.w + pad ||
                cy < parentBounds.y - pad || cy > parentBounds.y + parentBounds.h + pad
              ) {
                moveNode(groupId, null)
              }
            }
          }
        }
      }
      for (const movedId of movedIds) {
        if (coveredByMovedGroup.has(movedId)) continue
        const shape = useCanvasStore.getState().shapes[movedId]
        if (!shape) continue
        const cx = shape.x + shape.w / 2
        const cy = shape.y + shape.h / 2
        let targetGroup: string | null = null
        for (const [gid, group] of Object.entries(groups)) {
          if (gid === shape.groupId) continue
          if (isAncestor(gid, shape.groupId ?? '', groups)) continue
          const bounds = getGroupBounds(group, shapes, groups)
          if (!bounds) continue
          const pad = 8
          if (cx >= bounds.x - pad && cx <= bounds.x + bounds.w + pad &&
              cy >= bounds.y - pad && cy <= bounds.y + bounds.h + pad) {
            targetGroup = gid
            break
          }
        }
        if (targetGroup && targetGroup !== shape.groupId) {
          moveNode(movedId, targetGroup)
        } else if (!targetGroup && shape.groupId) {
          const group = groups[shape.groupId]
          if (group) {
            const shapesExcludingMoved = { ...shapes }
            delete shapesExcludingMoved[movedId]
            const bounds = getGroupBounds(group, shapesExcludingMoved, groups)
            if (bounds) {
              const pad = 8
              if (cx < bounds.x - pad || cx > bounds.x + bounds.w + pad ||
                  cy < bounds.y - pad || cy > bounds.y + bounds.h + pad) {
                moveNode(movedId, null)
              }
            }
          }
        }
      }
    }
    if (interaction.type === 'moving' && interaction.historyPushed)
      logOperation('shape.moved', 'Moved selected shapes', {
        ids: interaction.items.map((item) => item.id),
      })
    if (interaction.type === 'resizing' && interaction.historyPushed)
      logOperation('shape.resized', 'Resized selected shapes', {
        ids: interaction.items.map((item) => item.id),
        handle: interaction.handle,
      })
    if (interaction.type === 'rotating' && interaction.historyPushed)
      logOperation('shape.rotated', 'Rotated shape', { id: interaction.id })
    if (interaction.type === 'arrowPoint' && interaction.historyPushed)
      logOperation('arrow.point_moved', 'Moved arrow control point', {
        id: interaction.id,
        pointIndex: interaction.pointIndex,
      })
    interactionRef.current = { type: 'idle' }
    if (event) {
      const canvas = canvasRef.current
      if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    if (interaction.type === 'moving' && event) {
      window.dispatchEvent(
        new CustomEvent('flowboard:canvas-drag-end', {
          detail: {
            clientX: event.clientX,
            clientY: event.clientY,
            shapes: interaction.sourceShapes,
          },
        }),
      )
    }
  }

  function onWheel(event: React.WheelEvent) {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey || event.altKey) {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const screenX = event.clientX - rect.left
      const screenY = event.clientY - rect.top
      const factor = Math.exp(-event.deltaY * 0.0015)
      const zoom = Math.min(4, Math.max(0.1, camera.zoom * factor))
      const worldX = (screenX - camera.x) / camera.zoom
      const worldY = (screenY - camera.y) / camera.zoom
      constrainCamera({ x: screenX - worldX * zoom, y: screenY - worldY * zoom, zoom })
    } else if (event.shiftKey) {
      constrainCamera({ x: camera.x - event.deltaY, y: camera.y })
    } else {
      constrainCamera({ x: camera.x - event.deltaX, y: camera.y - event.deltaY })
    }
  }

  const pasteImage = useCallback(
    async (file: File) => {
      const { prepareImageSrc } = await import('@/utils/image')
      const prepared = await prepareImageSrc(file, undefined, assetShareToken, assetSharePassword)
      const canvas = canvasRef.current
      const center = canvas
        ? screenToWorld(canvas.clientWidth / 2, canvas.clientHeight / 2)
        : { x: 100, y: 100 }
      const shape = createShape(
        'image',
        center.x - prepared.width / 2,
        center.y - prepared.height / 2,
        prepared.width,
        prepared.height,
      ) as ImageShape
      shape.src = prepared.src
      shape.aspectRatio = prepared.width / Math.max(1, prepared.height)
      shape.name = file.name || '粘贴图片'
      addShape(shape)
      select([shape.id])
      logOperation('image.pasted', 'Pasted image from clipboard', {
        id: shape.id,
        width: prepared.width,
        height: prepared.height,
        size: file.size,
        storedBytes: prepared.storedBytes,
        external: prepared.external,
      })
    },
    [addShape, assetSharePassword, assetShareToken, screenToWorld, select],
  )

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (readOnly) return
      const image = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.type.startsWith('image/'))
        ?.getAsFile()
      if (!image) return
      // Staleness check: if this exact image was already seen before the latest
      // internal copy, the internal clipboard is newer and should win.
      const imageKey = `${image.type}:${image.size}`
      const staleImage =
        pendingInternalPastesRef.current > 0 &&
        lastSeenImageKeyRef.current === imageKey &&
        lastInternalCopyAtRef.current >= lastSeenImageAtRef.current
      if (staleImage) return
      pendingInternalPastesRef.current = Math.max(0, pendingInternalPastesRef.current - 1)
      lastSeenImageKeyRef.current = imageKey
      lastSeenImageAtRef.current = Date.now()
      event.preventDefault()
      void pasteImage(image).catch((error) => logError('image.paste_failed', error))
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [pasteImage])

  useEffect(() => {
    if (!readOnly) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlanCard(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [readOnly])

  /** 复制选中图形/分组到内部剪贴板 */
  const copySelection = useCallback(() => {
    lastInternalCopyAtRef.current = Date.now()
    if (selectedGroupIds.length > 0) {
      groupClipboardRef.current = collectGroupClipboard(selectedGroupIds, groups, shapes)
      shapeClipboardRef.current = []
    } else {
      shapeClipboardRef.current = selectedIds
        .map((id) => shapes[id])
        .filter((shape): shape is Shape => Boolean(shape))
        .map((shape) => structuredClone(shape))
      groupClipboardRef.current = null
    }
    logOperation('clipboard.copied', 'Copied', {
      shapes: shapeClipboardRef.current.length || groupClipboardRef.current?.shapes.length || 0,
      groups: groupClipboardRef.current?.groups.length ?? 0,
    })
  }, [groups, selectedGroupIds, selectedIds, shapes])

  /** 粘贴剪贴板内容到画布 */
  const pasteClipboard = useCallback(() => {
    if (groupClipboardRef.current) {
      const clipboard = cloneGroupClipboard(groupClipboardRef.current)
      insertGraph(clipboard.shapes, clipboard.groups, clipboard.rootGroupIds)
      groupClipboardRef.current = clipboard
    } else if (shapeClipboardRef.current.length > 0) {
      const copies = cloneShapeClipboard(shapeClipboardRef.current)
      addShapes(copies)
      select(copies.map((shape) => shape.id))
      shapeClipboardRef.current = copies
    }
  }, [addShapes, insertGraph, select])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (readOnly) return
      const activeElement = document.activeElement as HTMLElement | null
      if (event.code === 'Space') {
        if (
          !activeElement ||
          (!activeElement.matches('input,textarea') && !activeElement.isContentEditable)
        ) {
          event.preventDefault()
          spacePressedRef.current = true
        }
        return
      }
      if (activeElement?.matches('input,textarea,select') || activeElement?.isContentEditable)
        return
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      if (modifier && key === 'c') {
        event.preventDefault()
        copySelection()
      } else if (modifier && key === 'x') {
        event.preventDefault()
        if (selectedGroupIds.length > 0) {
          const clipboard = collectGroupClipboard(selectedGroupIds, groups, shapes)
          groupClipboardRef.current = clipboard
          shapeClipboardRef.current = []
          if (clipboard) deleteGroups(clipboard.rootGroupIds)
        } else {
          shapeClipboardRef.current = selectedIds
            .map((id) => shapes[id])
            .filter((shape): shape is Shape => Boolean(shape))
            .map((shape) => structuredClone(shape))
          groupClipboardRef.current = null
          deleteShapes(selectedIds)
        }
      } else if (modifier && key === 'v') {
        // Internal clipboard empty: leave the native paste alone so external images can be pasted via the window paste listener.
        if (!groupClipboardRef.current && shapeClipboardRef.current.length === 0) return
        pendingInternalPastesRef.current += 1
        window.setTimeout(() => {
          if (pendingInternalPastesRef.current <= 0) return
          pendingInternalPastesRef.current -= 1
          pasteClipboard()
        }, 150)
      } else if (modifier && key === 'd') {
        event.preventDefault()
        if (selectedGroupIds.length > 0) {
          const source = collectGroupClipboard(selectedGroupIds, groups, shapes)
          if (source) {
            const clipboard = cloneGroupClipboard(source)
            insertGraph(clipboard.shapes, clipboard.groups, clipboard.rootGroupIds)
          }
        } else {
          const source = selectedIds
            .map((id) => shapes[id])
            .filter((shape): shape is Shape => Boolean(shape))
          const copies = cloneShapeClipboard(source)
          addShapes(copies)
          select(copies.map((shape) => shape.id))
        }
      } else if (modifier && key === 'g' && event.shiftKey) {
        event.preventDefault()
        const groupIds =
          selectedGroupIds.length > 0
            ? selectedGroupIds
            : (Array.from(
                new Set(selectedIds.map((id) => shapes[id]?.groupId).filter(Boolean)),
              ) as string[])
        for (const groupId of groupIds) ungroup(groupId)
      } else if (modifier && key === 'g') {
        event.preventDefault()
        createGroup()
      } else if (
        modifier &&
        (event.key === '[' ||
          event.key === ']' ||
          event.code === 'BracketLeft' ||
          event.code === 'BracketRight')
      ) {
        event.preventDefault()
        const isUp = event.key === ']' || event.code === 'BracketRight'
        const direction = isUp ? (event.shiftKey ? 'front' : 'up') : event.shiftKey ? 'back' : 'down'
        moveSelectedLayer(direction)
      } else if (modifier && key === 'l') {
        event.preventDefault()
        pushHistory()
        for (const id of selectedIds) updateShape(id, { locked: !event.shiftKey })
      } else if (modifier && key === 's') {
        event.preventDefault()
        document.querySelector<HTMLButtonElement>('button[title=保存]')?.click()
      } else if (modifier && key === 'f') {
        return
      } else if (modifier && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (modifier && key === 'y') {
        event.preventDefault()
        redo()
      } else if (modifier && key === 'a') {
        event.preventDefault()
        useCanvasStore.getState().selectAll()
      } else if (modifier && key === '0') {
        event.preventDefault()
        constrainCamera({ x: 0, y: 0, zoom: 1 })
      } else if (modifier && key === '1') {
        event.preventDefault()
        zoomToFit()
      } else if (event.key === 'F2' && selectedGroupIds.length === 1) {
        return
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        if (selectedGroupIds.length > 0) deleteGroups(selectedGroupIds)
        else deleteShapes(selectedIds)
      } else if (
        (event.key.startsWith('Arrow') || event.code.startsWith('Arrow')) &&
        (selectedIds.length > 0 || selectedGroupIds.length > 0)
      ) {
        event.preventDefault()
        pushHistory()
        const step = event.shiftKey ? 10 : 1
        const arrow = event.code.startsWith('Arrow') ? event.code : event.key
        const deltaX = arrow === 'ArrowLeft' ? -step : arrow === 'ArrowRight' ? step : 0
        const deltaY = arrow === 'ArrowUp' ? -step : arrow === 'ArrowDown' ? step : 0
        const movingIds =
          selectedGroupIds.length > 0
            ? selectedGroupIds.flatMap((groupId) => collectShapeDescendants(groupId, groups))
            : selectedIds
        for (const id of movingIds) {
          const shape = shapes[id]
          if (shape && !shape.locked) updateShape(id, { x: shape.x + deltaX, y: shape.y + deltaY })
        }
      } else if (event.key === 'Escape') {
        interactionRef.current = { type: 'idle' }
        clearSelection()
        setTool('select')
      } else if (!modifier && key === 'v') setTool('select')
      else if (!modifier && key === 'h') setTool('hand')
      else if (!modifier && key === 'r') setTool('rectangle')
      else if (!modifier && key === 's') setTool('square')
      else if (!modifier && key === 'c') setTool('circle')
      else if (!modifier && key === 'o') setTool('ellipse')
      else if (!modifier && key === 'd') setTool('diamond')
      else if (!modifier && key === 'l') setTool('line')
      else if (!modifier && key === 'a') setTool('arrow')
      else if (!modifier && key === 't') setTool('text')
      else if (!modifier && key === 'p') setTool('draw')
      else if (!modifier && key === 'n') setTool('note')
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spacePressedRef.current = false
    }
    const cancelInteraction = () => {
      spacePressedRef.current = false
      interactionRef.current = { type: 'idle' }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', cancelInteraction)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', cancelInteraction)
    }
  }, [
    addShapes,
    deleteGroups,
    clearSelection,
    constrainCamera,
    createGroup,
    deleteShapes,
    groups,
    insertGraph,
    moveSelectedLayer,
    pushHistory,
    redo,
    selectedGroupIds,
    selectedIds,
    select,
    setTool,
    shapes,
    undo,
    ungroup,
    updateShape,
    zoomToFit,
    readOnly,
  ])

  function onDoubleClick(event: React.MouseEvent) {
    if (readOnly) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top)
    const hit = topmostHit(world.x, world.y)
    // 双击空白处：快速创建文本框并进入编辑（提升绘图效率）
    if (!hit) {
      event.preventDefault()
      const textShape = createShape('text', world.x - 80, world.y - 20, 160, 40)
      textShape.text = ''
      addShape(textShape)
      select([textShape.id])
      editingSessionRef.current = { id: textShape.id, originalText: '' }
      setEditingId(textShape.id)
      setEditingText('')
      requestAnimationFrame(() => {
        const editor = editingRef.current
        if (!editor) return
        editor.focus()
      })
      return
    }
    event.preventDefault()
    select([hit.id])
    if (isArrowShape(hit)) {
      const pointIndex = hitTestArrowPoint(hit, shapes, world.x, world.y, 10 / camera.zoom)
      if (pointIndex !== null && pointIndex > 0 && pointIndex < hit.points.length - 1 && hit.points.length > 2) {
        pushHistory()
        const removed = { ...hit, points: hit.points.filter((_, index) => index !== pointIndex) }
        updateShape(removed.id, normalizeArrow(removed, getArrowWorldPoints(removed, shapes)))
        return
      }
      const worldPoints = getArrowWorldPoints(hit, shapes)
      let bestSegment = -1
      let bestDistance = Infinity
      let bestPoint = worldPoints[0]!
      for (let index = 0; index < worldPoints.length - 1; index++) {
        const segmentStart = worldPoints[index]!
        const segmentEnd = worldPoints[index + 1]!
        const segmentX = segmentEnd.x - segmentStart.x
        const segmentY = segmentEnd.y - segmentStart.y
        const lengthSquared = segmentX * segmentX + segmentY * segmentY
        const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((world.x - segmentStart.x) * segmentX + (world.y - segmentStart.y) * segmentY) / lengthSquared))
        const projected = { x: segmentStart.x + segmentX * projection, y: segmentStart.y + segmentY * projection }
        const distance = Math.hypot(world.x - projected.x, world.y - projected.y)
        if (distance < bestDistance) {
          bestDistance = distance
          bestSegment = index
          bestPoint = projected
        }
      }
      if (bestSegment >= 0 && bestDistance < 16 / camera.zoom) {
        pushHistory()
        const points = hit.points.map((point) => [...point])
        points.splice(bestSegment + 1, 0, [bestPoint.x - hit.x, bestPoint.y - hit.y])
        updateShape(hit.id, { ...hit, points })
      }
      return
    }
    editingSessionRef.current = { id: hit.id, originalText: hit.text }
    setEditingId(hit.id)
    setEditingText(hit.text)
    requestAnimationFrame(() => {
      const editor = editingRef.current
      if (!editor) return
      editor.focus()
      editor.setSelectionRange(editor.value.length, editor.value.length)
    })
  }

  function commitTextEdit() {
    const session = editingSessionRef.current
    if (!session) return
    editingSessionRef.current = null
    setEditingId(null)
    setEditingText('')
    if (editingText === session.originalText) return
    pushHistory()
    updateShape(session.id, { text: editingText })
  }

  function cancelTextEdit() {
    editingSessionRef.current = null
    setEditingId(null)
    setEditingText('')
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        data-flowboard-canvas
        className="h-full w-full touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointerInteraction}
        onPointerCancel={() => finishPointerInteraction()}
        onLostPointerCapture={() => {
          if (interactionRef.current.type !== 'idle') interactionRef.current = { type: 'idle' }
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
        style={{
          cursor:
            hoverCursor || (planHint ? 'pointer' : activeTool === 'hand' ? 'grab' : activeTool === 'select' ? 'default' : 'crosshair'),
        }}
      />
      {/* 右键上下文菜单 */}
      {contextMenu && !readOnly && (
        <div
          className="fixed z-50 w-40 rounded-md border border-surface-border bg-white py-1 shadow-float"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {selectedIds.length > 0 && <>
            <button className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); copySelection() }}>复制<span className="text-ink-muted">Ctrl+C</span></button>
            <button className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); pasteClipboard() }}>粘贴<span className="text-ink-muted">Ctrl+V</span></button>
            <button className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); deleteShapes(selectedIds) }}>删除<span className="text-ink-muted">Del</span></button>
            <div className="my-1 border-t border-surface-border" />
            <button className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); moveSelectedLayer('front') }}>置于顶层</button>
            <button className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); moveSelectedLayer('back') }}>置于底层</button>
            <button className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); moveSelectedLayer('up') }}>上移一层</button>
            <button className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); moveSelectedLayer('down') }}>下移一层</button>
            <div className="my-1 border-t border-surface-border" />
            <button className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); createGroup() }}>组合</button>
            <button className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); if (selectedGroupIds.length > 0) for (const groupId of selectedGroupIds) ungroup(groupId) }}>取消组合</button>
          </>}
          {selectedIds.length === 0 && <>
            <button className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); pasteClipboard() }}>粘贴<span className="text-ink-muted">Ctrl+V</span></button>
            <button className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); setCamera({ x: 0, y: 0, zoom: 1 }) }}>回到原点</button>
            <button className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted" onClick={() => { setContextMenu(null); }}>无选中项</button>
          </>}
        </div>
      )}
      {readOnly && planHint && !planCard && (
        <div
          className="pointer-events-none absolute z-20 rounded border border-surface-border bg-white px-2 py-1 text-[10px] text-ink-muted shadow-float"
          style={{ left: planHint.x + 12, top: planHint.y + 12 }}
        >
          点击查看策划案
        </div>
      )}
      {planCard && (
        <div
          className="absolute z-30 w-72 max-w-[80vw] rounded-md border border-surface-border bg-white p-3 shadow-float"
          style={{
            left: Math.min(planCard.x, (containerRef.current?.clientWidth ?? 320) - 300),
            top: Math.min(planCard.y, (containerRef.current?.clientHeight ?? 240) - 180),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{planCard.title}</span>
            <button className="tool-btn !h-6 !w-6" title="关闭" aria-label="关闭策划案" onClick={() => setPlanCard(null)}><X size={13} /></button>
          </div>
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-ink-muted">{planCard.content}</p>
        </div>
      )}
      {editingId && shapes[editingId] && (() => {
        const shape = shapes[editingId]!
        const screenW = Math.max(24, shape.w * camera.zoom)
        const screenH = Math.max(24, shape.h * camera.zoom)
        const fontSize = Math.max(8, shape.fontSize * camera.zoom)
        const lineHeight = fontSize * (shape.type === 'text' ? shape.lineHeight ?? 1.3 : 1.3)
        const lineCount = Math.max(1, editingText.split('\n').length)
        const checkboxOffset = shape.type === 'checkbox'
          ? (Math.min(shape.h - 4, 24) + 8) * camera.zoom
          : 0
        const horizontalPadding = shape.type === 'text' ? 0 : Math.max(3, 12 * camera.zoom)
        const verticalPadding = Math.max(0, (screenH - lineCount * lineHeight) / 2)
        return (
          <textarea
            ref={editingRef}
            aria-label={`编辑 ${shape.name} 文本`}
            value={editingText}
            spellCheck={false}
            onChange={(event) => setEditingText(event.target.value)}
            onBlur={commitTextEdit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                commitTextEdit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelTextEdit()
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="absolute z-30 resize-none overflow-hidden border-0 bg-transparent outline-none"
            style={{
              left: (shape.x + shape.w / 2) * camera.zoom + camera.x + checkboxOffset / 2,
              top: (shape.y + shape.h / 2) * camera.zoom + camera.y,
              width: Math.max(20, screenW - checkboxOffset),
              height: screenH,
              boxSizing: 'border-box',
              paddingTop: verticalPadding,
              paddingRight: horizontalPadding,
              paddingBottom: verticalPadding,
              paddingLeft: horizontalPadding,
              transform: `translate(-50%, -50%) rotate(${shape.rotation}rad)`,
              transformOrigin: 'center',
              backgroundColor: 'transparent',
              boxShadow: 'none',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              fontSize,
              fontWeight: shape.fontWeight,
              lineHeight: `${lineHeight}px`,
              textAlign: shape.textAlign,
              color: shape.textColor,
              caretColor: shape.textColor,
              opacity: shape.opacity,
              writingMode: shape.textDirection === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
            }}
          />
        )
      })()}
    </div>
  )
}
