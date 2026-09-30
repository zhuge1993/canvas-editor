/** 画布状态：图形、分组、层级顺序和可撤销操作统一在这里管理。 */
import { create } from 'zustand'
import type {
  CanvasDocument,
  Camera,
  Shape,
  ShapeGroup,
  Tool,
  WorkspaceBounds,
} from '@/canvas/types'
import {
  DEFAULT_WORKSPACE,
  collectShapeDescendants,
  expandWorkspaceToFit,
  flattenRenderOrder,
  genId,
  getAllShapesInOrder,
  isAncestor,
  isArrowShape,
  normalizeCanvasDocument,
} from '@/canvas/types'
import { logOperation } from '@/utils/logger'

function cloneDocument(document: CanvasDocument): CanvasDocument {
  return structuredClone(document)
}
function clearDeletedShapeReferences(shapes: Record<string, Shape>, deletedIds: Set<string>) {
  for (const [id, shape] of Object.entries(shapes)) {
    let next = shape
    if (next.link?.targetId && deletedIds.has(next.link.targetId)) {
      next = { ...next, link: undefined }
    }
    if (isArrowShape(next)) {
      const startBinding = next.startBinding && deletedIds.has(next.startBinding.shapeId)
        ? undefined
        : next.startBinding
      const endBinding = next.endBinding && deletedIds.has(next.endBinding.shapeId)
        ? undefined
        : next.endBinding
      if (startBinding !== next.startBinding || endBinding !== next.endBinding) {
        next = { ...next, startBinding, endBinding }
      }
    }
    if (next !== shape) shapes[id] = next
  }
}



export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

interface CanvasStore {
  shapes: Record<string, Shape>
  /** 根节点顺序：图形 id 和顶层分组 id 混合排列。 */
  order: string[]
  groups: Record<string, ShapeGroup>
  workspace: WorkspaceBounds
  canvasBackground: string
  gridSize: number
  selectedIds: string[]
  selectedGroupIds: string[]
  activeTool: Tool
  camera: Camera
  gridVisible: boolean
  past: CanvasDocument[]
  future: CanvasDocument[]

  setTool: (tool: Tool) => void
  addShape: (shape: Shape) => void
  addShapes: (shapes: Shape[]) => void
  insertGraph: (shapes: Shape[], groups: ShapeGroup[], rootGroupIds: string[]) => void
  updateShape: (id: string, patch: Partial<Shape>) => void
  updateShapes: (ids: string[], patch: Partial<Shape>) => void
  deleteShapes: (ids: string[]) => void
  deleteGroup: (groupId: string) => void
  deleteGroups: (groupIds: string[]) => void
  replaceText: (search: string, replacement: string, ids?: string[]) => number
  select: (ids: string[]) => void
  selectNodes: (shapeIds: string[], groupIds: string[]) => void
  toggleSelect: (id: string) => void
  selectAll: () => void
  selectGroup: (groupId: string, additive?: boolean) => void
  toggleGroupSelect: (groupId: string) => void
  clearSelection: () => void
  setCamera: (camera: Partial<Camera>) => void
  toggleGrid: () => void
  setCanvasBackground: (color: string) => void
  setGridSize: (size: number) => void
  pushHistory: () => void
  undo: () => void
  redo: () => void
  /** 将节点移动到目标父节点下指定位置（根或某分组内）。 */
  moveNode: (id: string, parentId: string | null, targetId?: string, before?: boolean) => void
  reorderNode: (id: string, targetId: string, before: boolean) => void
  moveLayer: (id: string, direction: 'up' | 'down' | 'front' | 'back') => void
  moveSelectedLayer: (direction: 'up' | 'down' | 'front' | 'back') => void
  createGroup: (ids?: string[], name?: string) => string | null
  renameGroup: (id: string, name: string) => void
  updateGroup: (id: string, patch: Partial<ShapeGroup>) => void
  ungroup: (id: string) => void
  toggleGroup: (id: string) => void
  alignSelected: (alignment: Alignment) => void
  distributeSelected: (axis: 'horizontal' | 'vertical') => void
  loadDocument: (document: unknown) => void
  getSnapshot: () => CanvasDocument
  getAllShapes: () => Shape[]
  getRenderShapes: () => Shape[]
}

function snapshotFromState(state: Pick<CanvasStore, 'shapes' | 'order' | 'groups' | 'workspace' | 'canvasBackground' | 'gridSize'>): CanvasDocument {
  return {
    version: 3,
    shapes: state.shapes,
    order: state.order,
    groups: state.groups,
    workspace: state.workspace,
    backgroundColor: state.canvasBackground,
    gridSize: state.gridSize,
  }
}

type LayerDirection = 'up' | 'down' | 'front' | 'back'

/** 在某个父节点列表中移动 ids，支持 up/down/front/back。 */
function moveIdsInList(list: string[], ids: string[], direction: LayerDirection): string[] {
  const selected = new Set(ids)
  const moving = list.filter((id) => selected.has(id))
  if (moving.length === 0) return list
  if (direction === 'front') return [...list.filter((id) => !selected.has(id)), ...moving]
  if (direction === 'back') return [...moving, ...list.filter((id) => !selected.has(id))]

  const others = list.filter((id) => !selected.has(id))
  if (direction === 'up') {
    // 前移一层: 朝列表尾部(=结构树上方/更前层)移动一步, 与块后第一个非选中节点交换。
    const lastSelectedIndex = list.length - 1 - [...list].reverse().findIndex((id) => selected.has(id))
    const target = Math.min(others.length, lastSelectedIndex - moving.length + 2)
    return [...others.slice(0, target), ...moving, ...others.slice(target)]
  }
  // 后移一层: 朝列表头部(=结构树下方/更后层)移动一步, 与块前最后一个非选中节点交换。
  const firstSelectedIndex = list.findIndex((id) => selected.has(id))
  const target = Math.max(0, firstSelectedIndex - 1)
  return [...others.slice(0, target), ...moving, ...others.slice(target)]
}

/** 查找节点 id 在哪个父节点列表中：返回父分组 id（null 表示根）。 */
function findParentList(id: string, state: Pick<CanvasStore, 'order' | 'groups'>): { parentId: string | null, list: string[] } | null {
  if (state.order.includes(id)) return { parentId: null, list: state.order }
  for (const [groupId, group] of Object.entries(state.groups)) {
    if (group.childIds.includes(id)) return { parentId: groupId, list: group.childIds }
  }
  return null
}

/** 按展开结构树移动单个图形，边界处进入相邻展开分组或移出当前分组。 */
function moveSingleNodeHierarchically(state: CanvasStore, id: string, direction: LayerDirection): { order: string[]; groups: Record<string, ShapeGroup>; shapes: Record<string, Shape> } | null {
  const location = findParentList(id, state)
  if (!location) return null
  const sourceList = [...location.list]
  const sourceIndex = sourceList.indexOf(id)
  if (sourceIndex < 0) return null
  const groups = structuredClone(state.groups)
  const shapes = { ...state.shapes }
  let order = [...state.order]
  const writeList = (parentId: string | null, list: string[]) => {
    if (parentId === null) order = list
    else if (groups[parentId]) groups[parentId] = { ...groups[parentId]!, childIds: list }
  }
  const setParent = (nodeId: string, parentId: string | null) => {
    if (shapes[nodeId]) shapes[nodeId] = { ...shapes[nodeId]!, groupId: parentId ?? undefined }
    else if (groups[nodeId]) groups[nodeId] = { ...groups[nodeId]!, parentId: parentId ?? undefined }
  }

  if (direction === 'front' || direction === 'back') {
    const next = moveIdsInList(sourceList, [id], direction)
    if (next.every((nodeId, index) => nodeId === sourceList[index])) return null
    writeList(location.parentId, next)
    return { order, groups, shapes }
  }

  const step = direction === 'up' ? 1 : -1
  const adjacentIndex = sourceIndex + step
  if (adjacentIndex >= 0 && adjacentIndex < sourceList.length) {
    const adjacentId = sourceList[adjacentIndex]!
    const adjacentGroup = groups[adjacentId]
    // 图形与分组都可移入相邻的展开分组(此前仅图形可入, 分组按 Ctrl+[ ] 会直接跳过目标分组); 禁止分组移入自身后代分组, 防止循环嵌套。
    const movingIsGroup = Boolean(groups[id])
    const wouldNestIntoDescendant = movingIsGroup && isAncestor(id, adjacentId, groups)
    if (adjacentGroup && !adjacentGroup.collapsed && !wouldNestIntoDescendant) {
      writeList(location.parentId, sourceList.filter((nodeId) => nodeId !== id))
      const childIds = adjacentGroup.childIds.filter((nodeId) => nodeId !== id)
      childIds.splice(direction === 'down' ? childIds.length : 0, 0, id)
      groups[adjacentId] = { ...adjacentGroup, childIds }
      setParent(id, adjacentId)
      return { order, groups, shapes }
    }
    const next = sourceList.slice()
    ;[next[sourceIndex], next[adjacentIndex]] = [next[adjacentIndex]!, next[sourceIndex]!]
    writeList(location.parentId, next)
    return { order, groups, shapes }
  }

  if (location.parentId === null) return null
  const container = groups[location.parentId]
  if (!container) return null
  const outerParentId = container.parentId ?? null
  const outerList = outerParentId === null ? [...order] : [...(groups[outerParentId]?.childIds ?? [])]
  const containerIndex = outerList.indexOf(container.id)
  if (containerIndex < 0) return null
  writeList(location.parentId, sourceList.filter((nodeId) => nodeId !== id))
  outerList.splice(containerIndex + (direction === 'up' ? 1 : 0), 0, id)
  writeList(outerParentId, outerList)
  setParent(id, outerParentId)
  return { order, groups, shapes }
}
interface LayoutItem {
  id: string
  x: number
  y: number
  w: number
  h: number
  shapeIds: string[]
}

function getGroupLayoutItem(
  groupId: string,
  groups: Record<string, ShapeGroup>,
  shapes: Record<string, Shape>,
): LayoutItem | null {
  const shapeIds = collectShapeDescendants(groupId, groups).filter((id) => Boolean(shapes[id]))
  const childShapes = shapeIds.map((id) => shapes[id]!).filter(Boolean)
  if (childShapes.length === 0) return null
  const minX = Math.min(...childShapes.map((shape) => shape.x))
  const minY = Math.min(...childShapes.map((shape) => shape.y))
  const maxX = Math.max(...childShapes.map((shape) => shape.x + shape.w))
  const maxY = Math.max(...childShapes.map((shape) => shape.y + shape.h))
  return { id: groupId, x: minX, y: minY, w: maxX - minX, h: maxY - minY, shapeIds }
}

function getSelectedLayoutItems(state: Pick<CanvasStore, 'selectedIds' | 'selectedGroupIds' | 'shapes' | 'groups'>): LayoutItem[] {
  const selectedGroups = new Set(state.selectedGroupIds.filter((id) => Boolean(state.groups[id])))
  const rootGroups = [...selectedGroups].filter(
    (id) => ![...selectedGroups].some((candidate) => candidate !== id && isAncestor(candidate, id, state.groups)),
  )
  const groupItems = rootGroups
    .map((id) => getGroupLayoutItem(id, state.groups, state.shapes))
    .filter((item): item is LayoutItem => Boolean(item))
  const coveredShapeIds = new Set(groupItems.flatMap((item) => item.shapeIds))
  const shapeItems = state.selectedIds
    .map((id) => state.shapes[id])
    .filter((shape): shape is Shape => shape !== undefined && !coveredShapeIds.has(shape.id))
    .map((shape) => ({ id: shape.id, x: shape.x, y: shape.y, w: shape.w, h: shape.h, shapeIds: [shape.id] }))
  return [...groupItems, ...shapeItems]
}

function moveLayoutItem(shapes: Record<string, Shape>, item: LayoutItem, deltaX: number, deltaY: number) {
  if (deltaX === 0 && deltaY === 0) return
  for (const id of item.shapeIds) {
    const shape = shapes[id]
    if (shape) shapes[id] = { ...shape, x: shape.x + deltaX, y: shape.y + deltaY }
  }
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  shapes: {},
  order: [],
  groups: {},
  workspace: { ...DEFAULT_WORKSPACE },
  canvasBackground: '#fafafa',
  gridSize: 20,
  selectedIds: [],
  selectedGroupIds: [],
  activeTool: 'select',
  camera: { x: 0, y: 0, zoom: 1 },
  gridVisible: true,
  past: [],
  future: [],

  setTool: (activeTool) => set({ activeTool }),

  addShape: (shape) => {
    get().pushHistory()
    set((state) => ({
      shapes: { ...state.shapes, [shape.id]: shape },
      order: [...state.order, shape.id],
      workspace: expandWorkspaceToFit(state.workspace, shape),
    }))
    logOperation('shape.created', 'Created shape', { id: shape.id, type: shape.type, name: shape.name })
  },

  addShapes: (newShapes) => {
    if (newShapes.length === 0) return
    get().pushHistory()
    set((state) => {
      const shapes = { ...state.shapes }
      const order = [...state.order]
      const groups = { ...state.groups }
      let workspace = state.workspace
      for (const shape of newShapes) {
        shapes[shape.id] = shape
        // A shape whose group still exists stays inside that group instead of floating to the top level.
        if (shape.groupId && groups[shape.groupId]) {
          const parent = groups[shape.groupId]!
          if (!parent.childIds.includes(shape.id)) groups[shape.groupId] = { ...parent, childIds: [...parent.childIds, shape.id] }
        } else if (!order.includes(shape.id)) {
          order.push(shape.id)
        }
        workspace = expandWorkspaceToFit(workspace, shape)
      }
      return { shapes, order, groups, workspace }
    })
    logOperation('shape.batch_created', 'Created multiple shapes', { count: newShapes.length })
  },
  insertGraph: (newShapes, newGroups, rootGroupIds) => {
    if (newShapes.length === 0 || newGroups.length === 0 || rootGroupIds.length === 0) return
    const state = get()
    const newIds = [...newShapes.map((shape) => shape.id), ...newGroups.map((group) => group.id)]
    if (
      new Set(newIds).size !== newIds.length ||
      newIds.some((id) => Boolean(state.shapes[id]) || Boolean(state.groups[id]))
    ) return
    const insertedGroupIds = new Set(newGroups.map((group) => group.id))
    const roots = rootGroupIds.filter((id) => insertedGroupIds.has(id))
    if (roots.length === 0) return
    get().pushHistory()
    set((current) => {
      const shapes = { ...current.shapes }
      const groups = { ...current.groups }
      let workspace = current.workspace
      for (const shape of newShapes) {
        shapes[shape.id] = shape
        workspace = expandWorkspaceToFit(workspace, shape)
      }
      for (const group of newGroups) groups[group.id] = group
      // A pasted group whose original parent still exists is re-attached to that parent
      // (stays inside the group) instead of being detached to the top level.
      const attached = new Set<string>()
      for (const rootId of roots) {
        const parentId = groups[rootId]?.parentId
        if (parentId && current.groups[parentId] && groups[parentId]) {
          const parent = groups[parentId]!
          if (!parent.childIds.includes(rootId)) groups[parentId] = { ...parent, childIds: [...parent.childIds, rootId] }
          attached.add(rootId)
        }
      }
      const topLevel = roots.filter((id) => !attached.has(id))
      return {
        shapes,
        groups,
        order: [...current.order, ...topLevel],
        workspace,
        selectedIds: [],
        selectedGroupIds: roots,
      }
    })
    logOperation('group.graph_inserted', 'Inserted copied group graph', {
      groupCount: newGroups.length,
      shapeCount: newShapes.length,
      rootGroupIds: roots,
    })
  },


  updateShape: (id, patch) => set((state) => {
    const shape = state.shapes[id]
    if (!shape) return state
    const nextShape = { ...shape, ...patch }
    return {
      shapes: { ...state.shapes, [id]: nextShape },
      workspace: expandWorkspaceToFit(state.workspace, nextShape),
    }
  }),

  updateShapes: (ids, patch) => set((state) => {
    const shapes = { ...state.shapes }
    let workspace = state.workspace
    for (const id of ids) {
      const shape = shapes[id]
      if (!shape) continue
      const nextShape = { ...shape, ...patch }
      shapes[id] = nextShape
      workspace = expandWorkspaceToFit(workspace, nextShape)
    }
    return { shapes, workspace }
  }),

  deleteShapes: (ids) => {
    if (ids.length === 0) return
    get().pushHistory()
    set((state) => {
      const deletedIds = new Set(ids)
      const shapes = { ...state.shapes }
      for (const id of deletedIds) delete shapes[id]
      const groups = structuredClone(state.groups)
      for (const group of Object.values(groups)) group.childIds = group.childIds.filter((childId) => !deletedIds.has(childId))
      clearDeletedShapeReferences(shapes, deletedIds)
      return {
        shapes,
        groups,
        order: state.order.filter((id) => !deletedIds.has(id)),
        selectedIds: state.selectedIds.filter((id) => !deletedIds.has(id)),
        selectedGroupIds: state.selectedGroupIds.filter((groupId) => Boolean(groups[groupId])),
      }
    })
    logOperation('shape.deleted', 'Deleted shapes', { ids })
  },

  deleteGroup: (groupId) => get().deleteGroups([groupId]),

  deleteGroups: (groupIds) => {
    const state = get()
    const selected = new Set(groupIds.filter((id) => Boolean(state.groups[id])))
    const rootGroupIds = [...selected].filter((id) =>
      ![...selected].some((candidate) => candidate !== id && isAncestor(candidate, id, state.groups)),
    )
    if (rootGroupIds.length === 0) return
    get().pushHistory()
    set((current) => {
      const groups = structuredClone(current.groups)
      const shapes = { ...current.shapes }
      const deletedNodeIds = new Set<string>()
      const deletedShapeIds = new Set<string>()
      const stack = [...rootGroupIds]
      while (stack.length > 0) {
        const currentId = stack.pop()!
        if (deletedNodeIds.has(currentId)) continue
        deletedNodeIds.add(currentId)
        const group = groups[currentId]
        if (!group) continue
        for (const childId of group.childIds) {
          if (groups[childId]) stack.push(childId)
          else if (shapes[childId]) {
            deletedNodeIds.add(childId)
            deletedShapeIds.add(childId)
          }
        }
      }
      for (const id of deletedNodeIds) {
        delete groups[id]
        delete shapes[id]
      }
      for (const group of Object.values(groups)) {
        group.childIds = group.childIds.filter((id) => !deletedNodeIds.has(id))
      }
      clearDeletedShapeReferences(shapes, deletedShapeIds)
      return {
        shapes,
        groups,
        order: current.order.filter((id) => !deletedNodeIds.has(id)),
        selectedIds: current.selectedIds.filter((id) => !deletedNodeIds.has(id)),
        selectedGroupIds: current.selectedGroupIds.filter((id) => !deletedNodeIds.has(id)),
      }
    })
    logOperation('group.deleted', 'Deleted groups and descendants', { groupIds: rootGroupIds })
  },

  replaceText: (search, replacement, ids) => {
    if (!search) return 0
    const state = get()
    const allShapeIds = collectShapeDescendantsRecursive(state)
    const targetIds = ids ?? allShapeIds
    const changes = targetIds
      .map((id) => ({ id, shape: state.shapes[id] }))
      .filter(({ shape }) => Boolean(shape?.text.includes(search)))
      .map(({ id, shape }) => shape ? { id, text: shape.text.split(search).join(replacement) } : null)
      .filter((change): change is { id: string; text: string } => change !== null)
    if (changes.length === 0) return 0
    get().pushHistory()
    set((current) => {
      const shapes = { ...current.shapes }
      for (const change of changes) {
        const shape = shapes[change.id]
        if (shape) shapes[change.id] = { ...shape, text: change.text }
      }
      return { shapes }
    })
    logOperation('text.replaced', 'Replaced text', { search, replacement, count: changes.length })
    return changes.length
  },

  select: (selectedIds) => set({ selectedIds, selectedGroupIds: [] }),
  selectNodes: (selectedIds, selectedGroupIds) => set((state) => ({
    selectedIds: Array.from(new Set(selectedIds.filter((id) => Boolean(state.shapes[id])))),
    selectedGroupIds: Array.from(new Set(selectedGroupIds.filter((id) => Boolean(state.groups[id])))),
  })),

  toggleSelect: (id) => set((state) => ({
    selectedIds: state.selectedIds.includes(id)
      ? state.selectedIds.filter((selectedId) => selectedId !== id)
      : [...state.selectedIds, id],
  })),

  selectAll: () => set((state) => ({ selectedIds: [...state.order], selectedGroupIds: [] })),

  selectGroup: (groupId, additive = false) => set((state) => {
    if (!state.groups[groupId]) return state
    return {
      selectedIds: [],
      selectedGroupIds: additive ? Array.from(new Set([...state.selectedGroupIds, groupId])) : [groupId],
    }
  }),

  toggleGroupSelect: (groupId) => set((state) => {
    if (!state.groups[groupId]) return state
    return {
      selectedGroupIds: state.selectedGroupIds.includes(groupId)
        ? state.selectedGroupIds.filter((selectedId) => selectedId !== groupId)
        : [...state.selectedGroupIds, groupId],
    }
  }),

  clearSelection: () => set({ selectedIds: [], selectedGroupIds: [] }),

  setCamera: (camera) => set((state) => ({ camera: { ...state.camera, ...camera } })),
  toggleGrid: () => set((state) => ({ gridVisible: !state.gridVisible })),
  setCanvasBackground: (color) => set({ canvasBackground: color }),
  setGridSize: (size) => set({ gridSize: Math.max(8, Math.min(100, size)) }),

  pushHistory: () => set((state) => ({
    past: [...state.past.slice(-49), cloneDocument(snapshotFromState(state))],
    future: [],
  })),

  undo: () => set((state) => {
    const previous = state.past.at(-1)
    if (!previous) return state
    const current = snapshotFromState(state)
    const restored = cloneDocument(previous)
    logOperation('history.undo', 'Undo canvas operation')
    return {
      ...restored,
      past: state.past.slice(0, -1),
      future: [cloneDocument(current), ...state.future],
      selectedIds: [],
      selectedGroupIds: [],
    }
  }),

  redo: () => set((state) => {
    const next = state.future[0]
    if (!next) return state
    const current = snapshotFromState(state)
    const restored = cloneDocument(next)
    logOperation('history.redo', 'Redo canvas operation')
    return {
      ...restored,
      future: state.future.slice(1),
      past: [...state.past, cloneDocument(current)],
      selectedIds: [],
      selectedGroupIds: [],
    }
  }),

  moveNode: (id, parentId, targetId, before = true) => {
    const state = get()
    if (id === targetId || (!state.shapes[id] && !state.groups[id])) return
    if (parentId && (!state.groups[parentId] || id === parentId || isAncestor(id, parentId, state.groups))) return
    get().pushHistory()
    set((current) => {
      const groups = structuredClone(current.groups)
      const shapes = { ...current.shapes }
      let order = [...current.order]
      const oldLocation = findParentList(id, { order, groups })
      if (oldLocation?.parentId === null) order = order.filter((item) => item !== id)
      else if (oldLocation?.parentId && groups[oldLocation.parentId]) {
        groups[oldLocation.parentId] = {
          ...groups[oldLocation.parentId]!,
          childIds: groups[oldLocation.parentId]!.childIds.filter((item) => item !== id),
        }
      }

      if (shapes[id]) shapes[id] = { ...shapes[id]!, groupId: parentId ?? undefined }
      if (groups[id]) groups[id] = { ...groups[id]!, parentId: parentId ?? undefined }

      if (parentId === null) {
        const targetIndex = targetId ? order.indexOf(targetId) : -1
        order.splice(targetIndex < 0 ? order.length : targetIndex + (before ? 0 : 1), 0, id)
      } else {
        const childIds = groups[parentId]!.childIds.filter((item) => item !== id)
        const targetIndex = targetId ? childIds.indexOf(targetId) : -1
        childIds.splice(targetIndex < 0 ? childIds.length : targetIndex + (before ? 0 : 1), 0, id)
        groups[parentId] = { ...groups[parentId]!, childIds }
      }

      return {
        order,
        groups,
        shapes,
        selectedIds: shapes[id] ? [id] : [],
        selectedGroupIds: groups[id] ? [id] : [],
      }
    })
    logOperation('node.moved', 'Moved node to new parent', { id, parentId, targetId, before })
  },

  reorderNode: (id, targetId, before) => moveNodeInSameParent(id, targetId, before, get, set),

  moveLayer: (id, direction) => {
    get().pushHistory()
    set((state) => {
      const location = findParentList(id, state)
      if (!location) return state
      const newList = moveIdsInList(location.list, [id], direction)
      if (location.parentId === null) return { order: newList }
      return { groups: { ...state.groups, [location.parentId]: { ...state.groups[location.parentId]!, childIds: newList } } }
    })
    logOperation('layer.moved', 'Moved layer', { id, direction })
  },

  moveSelectedLayer: (direction) => {
    const state = get()
    const totalSelected = state.selectedIds.length + state.selectedGroupIds.length
    const selectedId = state.selectedIds.length === 1 ? state.selectedIds[0] : null
    const selectedGroupId = state.selectedGroupIds.length === 1 ? state.selectedGroupIds[0] : null
    const nodeId = selectedId ?? selectedGroupId
    if (totalSelected === 1 && nodeId) {
      const moved = moveSingleNodeHierarchically(state, nodeId, direction)
      if (!moved) return
      get().pushHistory()
      set({ ...moved, selectedIds: selectedId ? [selectedId] : [], selectedGroupIds: selectedGroupId ? [selectedGroupId] : [] })
      logOperation('layer.selection_moved', 'Moved selected node through hierarchy', { direction, shapeIds: selectedId ? [selectedId] : [], groupIds: selectedGroupId ? [selectedGroupId] : [] })
      return
    }
    if (totalSelected === 0) return
    // 多选：按父列表分桶整块移动；边界处与单选一致——进入相邻展开分组或移出当前分组。
    const selectedGroupSet = new Set(state.selectedGroupIds.filter((id) => Boolean(state.groups[id])))
    const nodeIds = [
      ...selectedGroupSet,
      ...state.selectedIds.filter((id) => {
        const shape = state.shapes[id]
        if (!shape) return false
        return !(shape.groupId && selectedGroupSet.has(shape.groupId))
      }),
    ]
    if (nodeIds.length === 0) return
    const buckets = new Map<string | null, string[]>()
    for (const id of nodeIds) {
      const location = findParentList(id, state)
      if (!location) continue
      const bucket = buckets.get(location.parentId) ?? []
      bucket.push(id)
      buckets.set(location.parentId, bucket)
    }
    const groups = structuredClone(state.groups)
    const shapes = { ...state.shapes }
    let order = [...state.order]
    let changed = false
    const writeList = (parentId: string | null, list: string[]) => {
      if (parentId === null) order = list
      else if (groups[parentId]) groups[parentId] = { ...groups[parentId]!, childIds: list }
    }
    const setParent = (nodeId: string, parentId: string | null) => {
      if (shapes[nodeId]) shapes[nodeId] = { ...shapes[nodeId]!, groupId: parentId ?? undefined }
      else if (groups[nodeId]) groups[nodeId] = { ...groups[nodeId]!, parentId: parentId ?? undefined }
    }
    for (const [parentId, ids] of buckets) {
      const list = parentId === null ? order : groups[parentId]?.childIds ?? []
      const indices = ids.map((id) => list.indexOf(id)).filter((index) => index >= 0)
      if (indices.length === 0) continue
      const blockIds = list.filter((id) => ids.includes(id))
      if (direction === 'front' || direction === 'back') {
        const next = moveIdsInList(list, blockIds, direction)
        if (next.some((item, index) => item !== list[index])) {
          writeList(parentId, next)
          changed = true
        }
        continue
      }
      const maxIndex = Math.max(...indices)
      const minIndex = Math.min(...indices)
      const rest = list.filter((id) => !ids.includes(id))
      const adjacentId = direction === 'up' ? list[maxIndex + 1] : list[minIndex - 1]
      const adjacentGroup = adjacentId ? groups[adjacentId] : undefined
      // 相邻分组若本身在选中块内、或是块内某分组的后代, 则跳过(防止循环嵌套)。
      const createsCycle = adjacentId !== undefined && blockIds.some((blockId) => groups[blockId] && isAncestor(blockId, adjacentId, groups))
      if (adjacentId && adjacentGroup && !adjacentGroup.collapsed && !ids.includes(adjacentId) && !createsCycle) {
        writeList(parentId, rest)
        const childIds = adjacentGroup.childIds.filter((cid) => !ids.includes(cid))
        childIds.splice(direction === 'down' ? childIds.length : 0, 0, ...blockIds)
        groups[adjacentId] = { ...adjacentGroup, childIds }
        for (const id of blockIds) setParent(id, adjacentId)
        changed = true
        continue
      }
      const atBoundary = direction === 'up' ? maxIndex === list.length - 1 : minIndex === 0
      if (atBoundary && parentId !== null) {
        const container = groups[parentId]
        const outerParentId = container?.parentId ?? null
        const outerList = outerParentId === null ? order : groups[outerParentId]?.childIds ?? []
        const containerIndex = outerList.indexOf(parentId)
        if (container && containerIndex >= 0) {
          writeList(parentId, rest)
          const nextOuter = [...outerList]
          nextOuter.splice(containerIndex + (direction === 'up' ? 1 : 0), 0, ...blockIds)
          writeList(outerParentId, nextOuter)
          for (const id of blockIds) setParent(id, outerParentId)
          changed = true
          continue
        }
      }
      const next = moveIdsInList(list, blockIds, direction)
      if (next.some((item, index) => item !== list[index])) {
        writeList(parentId, next)
        changed = true
      }
    }
    if (!changed) return
    get().pushHistory()
    set({ order, groups, shapes })
    logOperation('layer.selection_moved', 'Moved selected nodes through hierarchy', { direction, shapeIds: state.selectedIds, groupIds: state.selectedGroupIds })
  },

  createGroup: (ids = [...get().selectedIds, ...get().selectedGroupIds], name = '新建分组') => {
    const state = get()
    // 顶层选中项：控件与分组混选时按各自节点参与合并，原分组保持不变。
    const selection = Array.from(new Set(ids)).filter((id) => state.shapes[id] || state.groups[id])
    if (selection.length < 1) return null
    const selectedGroupSet = new Set(selection.filter((id) => state.groups[id]))
    // 已属于被选分组的控件随分组整体并入，不重复作为直接子级。
    const nodeIds = selection.filter((id) => {
      if (state.groups[id]) return true
      const gid = state.shapes[id]?.groupId
      return !(gid && selectedGroupSet.has(gid))
    })
    if (nodeIds.length < 1) return null
    // 所有参与节点必须处于同一父级（根或同一分组）。
    const levelParentIds = new Set<string | null>(
      nodeIds.map((id) => (state.groups[id] ? state.groups[id]?.parentId ?? null : state.shapes[id]?.groupId ?? null)),
    )
    if (levelParentIds.size > 1) {
      logOperation('group.create_failed', 'Cannot group items from different parents')
      return null
    }
    const commonParentId = levelParentIds.values().next().value ?? null
    if (commonParentId !== null && !state.groups[commonParentId]) return null
    const groupId = genId('g')
    get().pushHistory()
    set((current) => {
      const groups = structuredClone(current.groups)
      const shapes = { ...current.shapes }
      const parentList = commonParentId === null ? [...current.order] : [...(groups[commonParentId]?.childIds ?? [])]
      const memberIds = parentList.filter((nodeId) => nodeIds.includes(nodeId))
      const firstIndex = parentList.findIndex((nodeId) => nodeIds.includes(nodeId))
      const filtered = parentList.filter((nodeId) => !nodeIds.includes(nodeId))
      const group: ShapeGroup = {
        id: groupId,
        name,
        childIds: memberIds,
        parentId: commonParentId ?? undefined,
        collapsed: false,
        visible: true,
        locked: false,
      }
      groups[groupId] = group
      for (const nodeId of memberIds) {
        if (shapes[nodeId]) shapes[nodeId] = { ...shapes[nodeId]!, groupId }
        else if (groups[nodeId]) groups[nodeId] = { ...groups[nodeId]!, parentId: groupId }
      }
      filtered.splice(firstIndex < 0 ? filtered.length : firstIndex, 0, groupId)
      if (commonParentId === null) return { groups, shapes, order: filtered, selectedIds: [], selectedGroupIds: [groupId] }
      groups[commonParentId] = { ...groups[commonParentId]!, childIds: filtered }
      return { groups, shapes, selectedIds: [], selectedGroupIds: [groupId] }
    })
    logOperation('group.created', 'Created group', { id: groupId, name, childIds: nodeIds, parentId: commonParentId })
    return groupId
  },

  renameGroup: (id, name) => {
    const trimmed = name.trim()
    const currentGroup = get().groups[id]
    if (!trimmed || !currentGroup) return
    get().pushHistory()
    set((state) => ({ groups: { ...state.groups, [id]: { ...currentGroup, name: trimmed } } }))
    logOperation('group.renamed', 'Renamed group', { id, name: trimmed })
  },

  updateGroup: (id, patch) => {
    const currentGroup = get().groups[id]
    if (!currentGroup) return
    set((state) => ({ groups: { ...state.groups, [id]: { ...state.groups[id]!, ...patch, id } } }))
    logOperation('group.updated', 'Updated group', { id, keys: Object.keys(patch) })
  },

  ungroup: (id) => {
    if (!get().groups[id]) return
    get().pushHistory()
    set((state) => {
      const groups = structuredClone(state.groups)
      const group = groups[id]
      if (!group) return state
      const shapes = { ...state.shapes }
      let order = [...state.order]
      const parentId = group.parentId ?? null
      const childIds = [...group.childIds]

      for (const childId of childIds) {
        if (shapes[childId]) shapes[childId] = { ...shapes[childId]!, groupId: parentId ?? undefined }
        if (groups[childId]) groups[childId] = { ...groups[childId]!, parentId: parentId ?? undefined }
      }

      delete groups[id]
      if (parentId === null) {
        const index = order.indexOf(id)
        order = order.filter((nodeId) => nodeId !== id)
        order.splice(index < 0 ? order.length : index, 0, ...childIds)
      } else {
        const parentGroup = groups[parentId]
        if (parentGroup) {
          const index = parentGroup.childIds.indexOf(id)
          const parentChildren = parentGroup.childIds.filter((nodeId) => nodeId !== id)
          parentChildren.splice(index < 0 ? parentChildren.length : index, 0, ...childIds)
          groups[parentId] = { ...parentGroup, childIds: parentChildren }
        } else {
          order.push(...childIds)
          for (const childId of childIds) {
            if (shapes[childId]) shapes[childId] = { ...shapes[childId]!, groupId: undefined }
            if (groups[childId]) groups[childId] = { ...groups[childId]!, parentId: undefined }
          }
        }
      }

      return { groups, shapes, order, selectedIds: [], selectedGroupIds: [] }
    })
    logOperation('group.ungrouped', 'Ungrouped', { id })
  },

  toggleGroup: (id) => {
    const group = get().groups[id]
    if (!group) return
    set((state) => ({ groups: { ...state.groups, [id]: { ...group, collapsed: !group.collapsed } } }))
  },

  alignSelected: (alignment) => {
    const state = get()
    const items = getSelectedLayoutItems(state)
    if (items.length < 2) return
    const minX = Math.min(...items.map((item) => item.x))
    const maxX = Math.max(...items.map((item) => item.x + item.w))
    const minY = Math.min(...items.map((item) => item.y))
    const maxY = Math.max(...items.map((item) => item.y + item.h))
    get().pushHistory()
    set((current) => {
      const shapes = { ...current.shapes }
      for (const item of items) {
        const targetX = alignment === 'left'
          ? minX
          : alignment === 'center'
            ? (minX + maxX - item.w) / 2
            : alignment === 'right'
              ? maxX - item.w
              : item.x
        const targetY = alignment === 'top'
          ? minY
          : alignment === 'middle'
            ? (minY + maxY - item.h) / 2
            : alignment === 'bottom'
              ? maxY - item.h
              : item.y
        moveLayoutItem(shapes, item, targetX - item.x, targetY - item.y)
      }
      return { shapes }
    })
    logOperation('layout.aligned', 'Aligned selected nodes', { alignment, ids: items.map((item) => item.id) })
  },

  distributeSelected: (axis) => {
    const state = get()
    const items = getSelectedLayoutItems(state)
    if (items.length < 3) return
    const sorted = [...items].sort((a, b) => axis === 'horizontal' ? a.x - b.x : a.y - b.y)
    const first = sorted[0]!
    const last = sorted.at(-1)!
    const totalSpan = axis === 'horizontal'
      ? last.x + last.w - first.x
      : last.y + last.h - first.y
    const totalSize = sorted.reduce((sum, item) => sum + (axis === 'horizontal' ? item.w : item.h), 0)
    const gap = (totalSpan - totalSize) / Math.max(1, sorted.length - 1)
    get().pushHistory()
    set((current) => {
      const shapes = { ...current.shapes }
      let cursor = axis === 'horizontal' ? first.x : first.y
      for (const item of sorted) {
        moveLayoutItem(
          shapes,
          item,
          axis === 'horizontal' ? cursor - item.x : 0,
          axis === 'vertical' ? cursor - item.y : 0,
        )
        cursor += (axis === 'horizontal' ? item.w : item.h) + gap
      }
      return { shapes }
    })
    logOperation('layout.distributed', 'Distributed selected nodes', { axis, ids: items.map((item) => item.id) })
  },

  loadDocument: (document) => {
    const normalized = normalizeCanvasDocument(document)
    set({
      ...normalized,
      canvasBackground: normalized.backgroundColor ?? '#fafafa',
      gridSize: normalized.gridSize ?? 20,
      past: [],
      future: [],
      selectedIds: [],
      selectedGroupIds: [],
    })
  },

  getSnapshot: () => cloneDocument(snapshotFromState(get())),
  getAllShapes: () => getAllShapesInOrder(get().order, get().shapes, get().groups),
  getRenderShapes: () => flattenRenderOrder(get().order, get().shapes, get().groups),
}))

/** 收集所有图形 id（按树遍历）。 */
function collectShapeDescendantsRecursive(state: Pick<CanvasStore, 'order' | 'groups' | 'shapes'>): string[] {
  const result: string[] = []
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const group = state.groups[id]
      if (group) walk(group.childIds)
      else if (state.shapes[id]) result.push(id)
    }
  }
  walk(state.order)
  return result
}

/** 在同一父节点内重新排序节点。 */
function moveNodeInSameParent(
  id: string,
  targetId: string,
  before: boolean,
  get: () => CanvasStore,
  set: (fn: (state: CanvasStore) => Partial<CanvasStore>) => void,
) {
  if (id === targetId) return
  const state = get()
  const idLocation = findParentList(id, state)
  const targetLocation = findParentList(targetId, state)
  if (!idLocation || !targetLocation) return
  if (idLocation.parentId !== targetLocation.parentId) return
  get().pushHistory()
  set((current) => {
    const list = [...targetLocation.list]
    const filtered = list.filter((item) => item !== id)
    const targetIndex = filtered.indexOf(targetId)
    if (targetIndex < 0) return {}
    filtered.splice(before ? targetIndex : targetIndex + 1, 0, id)
    if (targetLocation.parentId === null) return { order: filtered }
    return { groups: { ...current.groups, [targetLocation.parentId]: { ...current.groups[targetLocation.parentId]!, childIds: filtered } } }
  })
  logOperation('node.reordered', 'Reordered node in same parent', { id, targetId, before })
}