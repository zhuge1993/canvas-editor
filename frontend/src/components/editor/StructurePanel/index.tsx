/**
 * =============================================================
 * StructurePanel —— 结构树面板(图层 / 组件目录)
 * =============================================================
 * 职责:
 *   把画布元素按分组层级渲染成树(顶层 order + groups 嵌套, 显示顺序是
 *   reverse 过的), 支持选择、重命名、折叠分组、显隐、定位等。
 * 数据来源: useCanvasStore(order / shapes / groups / 选择 等)
 * 交互清单:
 *   - 单击选中; Ctrl/Cmd 加减选; Shift 区间选(按 visibleNodes 顺序)
 *   - 双击或 F2 重命名(分组走 renameGroup, 组件走 updateShape name)
 *   - 拖拽已禁用: 为避免编辑分组名称时选字误触发拖动, 结构树不再支持拖动组件
 *   - 收藏组件: 改为从画布上把组件拖进 LeftToolbar 的"常用组件"区
 *   - 悬停按钮: 定位居中(focusShape / focusGroup)、显示/隐藏
 *   - 分组 ⋯ 菜单: 仅删除目录(ungroup, 保留组件) / 删除目录及内组件(deleteGroup)
 *   - 选中变化时自动展开父分组并滚动到可见位置(文件后段 useEffect)
 * 区域划分(文件内搜 "====="):
 *   ① 树遍历与可见节点列表 (visibleNodes)
 *   ② 选择逻辑 (selectStructureNode)
 *   ③ 收藏拖拽载荷 (已删除: 收藏改为从画布拖入常用组件区)
 *   ④ 定位居中 (focusBounds / focusShape / focusGroup)
 *   ⑤ 重命名 (startRename / finishRename)
 *   ⑥ 拖拽已移除(防止改名时误移动组件)
 *   ⑦ 行渲染 (renderName / renderShapeRow / renderGroupRow)
 *   ⑧ 面板主 JSX
 * =============================================================
 */
import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  LocateFixed,
  Square,
  Lock,
  MoreHorizontal,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import {
  collectShapeDescendants,
  constrainCameraToWorkspace,
  type Shape,
} from '@/canvas/types'
import { getShapeTypeName } from '@/canvas/types'

export default function StructurePanel() {
  const order = useCanvasStore((state) => state.order)
  const shapes = useCanvasStore((state) => state.shapes)
  const groups = useCanvasStore((state) => state.groups)
  const workspace = useCanvasStore((state) => state.workspace)
  const camera = useCanvasStore((state) => state.camera)
  const setCamera = useCanvasStore((state) => state.setCamera)
  const selectedIds = useCanvasStore((state) => state.selectedIds)
  const selectedGroupIds = useCanvasStore((state) => state.selectedGroupIds)
  const select = useCanvasStore((state) => state.select)
  const selectNodes = useCanvasStore((state) => state.selectNodes)
  const selectGroup = useCanvasStore((state) => state.selectGroup)
  const toggleGroupSelect = useCanvasStore((state) => state.toggleGroupSelect)
  const toggleSelect = useCanvasStore((state) => state.toggleSelect)
  const toggleGroup = useCanvasStore((state) => state.toggleGroup)
  const updateShape = useCanvasStore((state) => state.updateShape)
  const renameGroup = useCanvasStore((state) => state.renameGroup)
  const ungroup = useCanvasStore((state) => state.ungroup)
  const deleteGroup = useCanvasStore((state) => state.deleteGroup)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [groupMenuId, setGroupMenuId] = useState<string | null>(null)
  const selectionAnchorRef = useRef<{ id: string; kind: 'shape' | 'group' } | null>(null)

  /* ===== ① 树遍历: 生成当前可见节点列表(受分组折叠影响) ===== */
  function visibleNodes(): Array<{ id: string; kind: 'shape' | 'group' }> {
    const nodes: Array<{ id: string; kind: 'shape' | 'group' }> = []
    const walk = (ids: string[]) => {
      for (const id of [...ids].reverse()) {
        const group = groups[id]
        if (group) {
          nodes.push({ id, kind: 'group' })
          if (!group.collapsed) walk(group.childIds)
        } else if (shapes[id]) {
          nodes.push({ id, kind: 'shape' })
        }
      }
    }
    walk(order)
    return nodes
  }

  /* ===== ② 选择逻辑: 单击 / Ctrl 加减选 / Shift 区间选 ===== */
  function selectStructureNode(id: string, kind: 'shape' | 'group', event: React.MouseEvent) {
    const anchor = selectionAnchorRef.current
    if (event.shiftKey && anchor) {
      const nodes = visibleNodes()
      const anchorIndex = nodes.findIndex((node) => node.id === anchor.id && node.kind === anchor.kind)
      const targetIndex = nodes.findIndex((node) => node.id === id && node.kind === kind)
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex < targetIndex
          ? [anchorIndex, targetIndex]
          : [targetIndex, anchorIndex]
        const range = nodes.slice(start, end + 1)
        selectNodes(
          range.filter((node) => node.kind === 'shape').map((node) => node.id),
          range.filter((node) => node.kind === 'group').map((node) => node.id),
        )
        return
      }
    }
    if (event.ctrlKey || event.metaKey) {
      if (kind === 'shape') toggleSelect(id)
      else toggleGroupSelect(id)
    } else if (kind === 'shape') {
      select([id])
    } else {
      selectGroup(id)
    }
    selectionAnchorRef.current = { id, kind }
  }

  /* ===== ③ 收藏拖拽载荷: 已移除(收藏改为从画布把组件拖进 LeftToolbar 常用组件区) ===== */
  /* ===== ④ 定位居中: 把包围盒适配到视口中央 ===== */
  function focusBounds(bounds: { x: number; y: number; w: number; h: number }) {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (!canvas) return
    const padding = 96
    const fitZoom = Math.min(
      (canvas.clientWidth - padding * 2) / Math.max(1, bounds.w),
      (canvas.clientHeight - padding * 2) / Math.max(1, bounds.h),
      4,
    )
    const zoom = Math.max(0.1, Math.min(camera.zoom, fitZoom))
    setCamera(
      constrainCameraToWorkspace(
        {
          x: canvas.clientWidth / 2 - (bounds.x + bounds.w / 2) * zoom,
          y: canvas.clientHeight / 2 - (bounds.y + bounds.h / 2) * zoom,
          zoom,
        },
        workspace,
        canvas.clientWidth,
        canvas.clientHeight,
      ),
    )
  }

  function focusShape(id: string) {
    const shape = shapes[id]
    if (!shape) return
    select([id])
    focusBounds(shape)
  }

  function focusGroup(id: string) {
    const group = groups[id]
    if (!group) return
    const childIds = collectShapeDescendants(id, groups)
    const children = childIds.map((childId) => shapes[childId]).filter(Boolean) as Shape[]
    if (children.length === 0) return
    const minX = Math.min(...children.map((shape) => shape.x))
    const minY = Math.min(...children.map((shape) => shape.y))
    const maxX = Math.max(...children.map((shape) => shape.x + shape.w))
    const maxY = Math.max(...children.map((shape) => shape.y + shape.h))
    selectGroup(id)
    focusBounds({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
  }

  /* ===== ⑤ 重命名: 双击或 F2 触发, Enter 确认 / Esc 取消 ===== */
  function startRename(id: string, value: string) {
    setEditingId(id)
    setEditingValue(value)
  }

  function finishRename() {
    if (!editingId) return
    if (groups[editingId]) renameGroup(editingId, editingValue)
    else updateShape(editingId, { name: editingValue.trim() || shapes[editingId]?.name })
    setEditingId(null)
  }

  /* ===== ⑥ 拖拽已移除: 避免编辑名称选字时把组件拖走(收藏请从画布拖入常用组件区) ===== */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const activeElement = document.activeElement as HTMLElement | null
      if (
        event.key !== 'F2' ||
        activeElement?.matches('input,textarea,select') ||
        activeElement?.isContentEditable
      ) return
      if (selectedGroupIds.length === 1) {
        const id = selectedGroupIds[0]!
        const group = groups[id]
        if (!group) return
        event.preventDefault()
        startRename(id, group.name)
      } else if (selectedIds.length === 1) {
        const id = selectedIds[0]!
        const shape = shapes[id]
        if (!shape) return
        event.preventDefault()
        startRename(id, shape.name)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [groups, selectedGroupIds, selectedIds, shapes])

  /* ===== 选中联动: 画布上改了选择 → 自动展开父分组并滚动到该行 ===== */
  // Reveal the selected node in the structure list and center it in view.
  useEffect(() => {
    const targetId = selectedGroupIds[selectedGroupIds.length - 1] ?? selectedIds[selectedIds.length - 1] ?? null
    if (!targetId) return
    const state = useCanvasStore.getState()
    const parentOf = new Map<string, string>()
    const walk = (ids: string[], parent: string | null) => {
      for (const id of ids) {
        const group = state.groups[id]
        if (group) {
          if (parent) parentOf.set(id, parent)
          walk(group.childIds, id)
        } else if (parent) {
          parentOf.set(id, parent)
        }
      }
    }
    walk(state.order, null)
    const toExpand: string[] = []
    let cursor = parentOf.get(targetId)
    while (cursor) {
      if (state.groups[cursor]?.collapsed) toExpand.push(cursor)
      cursor = parentOf.get(cursor)
    }
    if (toExpand.length > 0) toExpand.forEach((groupId) => state.toggleGroup(groupId))
    const scrollTargetIntoCenter = () => {
      const element = document.querySelector(`[data-structure-node="${CSS.escape(targetId)}"]`)
      element?.scrollIntoView({ block: 'center', inline: 'nearest' })
    }
    if (toExpand.length > 0) window.setTimeout(scrollTargetIntoCenter, 60)
    else scrollTargetIntoCenter()
  }, [selectedIds, selectedGroupIds])

  /* ===== ⑦ 行渲染: 名称(编辑态变输入框) ===== */
  function renderName(id: string, fallback: string) {
    if (editingId === id) {
      return (
        <input
          autoFocus
          value={editingValue}
          onChange={(event) => setEditingValue(event.target.value)}
          onBlur={finishRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') finishRename()
            if (event.key === 'Escape') setEditingId(null)
          }}
          className="min-w-0 flex-1 rounded border border-brand-400 bg-white px-1 text-xs outline-none"
        />
      )
    }
    return <span className="min-w-0 flex-1 truncate">{fallback}</span>
  }

  /* ===== ⑦ 行渲染: 组件行(图标/名称/锁定标记/定位/显隐按钮) ===== */
  function renderShapeRow(id: string, _parentId: string | null) {
    const shape = shapes[id]
    if (!shape) return null
    const selected = selectedIds.includes(id)
    return (
      <div
        key={id}
        data-structure-node={id}
        className={`group flex h-8 items-center gap-1 px-2 text-xs ${selected ? 'bg-brand-50 text-brand-700' : 'text-ink-muted hover:bg-surface-muted'}`}
        onClick={(event) => selectStructureNode(id, 'shape', event)}
        onDoubleClick={() => startRename(id, shape.name)}
      >
        <span className="flex w-5 shrink-0 items-center justify-end" aria-hidden="true">
          <Square size={12} className="text-surface-border" />
        </span>
        {renderName(id, shape.name || getShapeTypeName(shape.type))}
        {shape.locked && <Lock size={12} />}
        <button
          className="invisible ml-auto group-hover:visible"
          title="查看组件"
          aria-label={`查看组件 ${shape.name}`}
          onClick={(event) => {
            event.stopPropagation()
            focusShape(id)
          }}
        >
          <LocateFixed size={12} />
        </button>
        <button
          className="invisible group-hover:visible"
          title={shape.visible ? '隐藏' : '显示'}
          onClick={(event) => {
            event.stopPropagation()
            updateShape(id, { visible: !shape.visible })
          }}
        >
          {shape.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      </div>
    )
  }

    /* ===== ⑦ 行渲染: 分组行(折叠箭头/子级数/定位/⋯菜单/递归子级) ===== */
function renderGroupRow(id: string, _parentId: string | null) {
    const group = groups[id]
    if (!group) return null
    const selected = selectedGroupIds.includes(id)
    const childCount = group.childIds.length
    return (
      <div
        key={id}
      >
        <div
          data-structure-node={id}
          className={`group flex h-8 items-center gap-1 px-2 text-xs ${selected ? 'bg-brand-100 text-brand-700' : 'text-ink-muted hover:bg-surface-muted'}`}
          onClick={(event) => selectStructureNode(id, 'group', event)}
          onDoubleClick={() => startRename(id, group.name)}
        >
          <span className="flex w-5 shrink-0 items-center justify-end" aria-hidden="true">
            <button
              onClick={(event) => {
                event.stopPropagation()
                toggleGroup(id)
              }}
              aria-label={group.collapsed ? '展开分组' : '折叠分组'}
            >
              {group.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
            {group.collapsed ? <Folder size={12} /> : <FolderOpen size={12} />}
          </span>
          {renderName(id, group.name)}
          <span className="text-[10px] text-ink-muted">{childCount}</span>
          <button
            className="invisible ml-auto group-hover:visible"
            title="查看分组"
            aria-label={`查看分组 ${group.name}`}
            onClick={(event) => {
              event.stopPropagation()
              focusGroup(id)
            }}
          >
            <LocateFixed size={12} />
          </button>
          <button
            className="invisible group-hover:visible"
            title="分组操作"
            aria-label={`分组操作 ${group.name}`}
            aria-haspopup="menu"
            aria-expanded={groupMenuId === id}
            onMouseEnter={() => setGroupMenuId(id)}
            onClick={(event) => {
              event.stopPropagation()
              setGroupMenuId(id)
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
        {groupMenuId === id && (
          <div
            role="menu"
            aria-label={`${group.name} 分组操作`}
            className="mx-2 mb-1 flex flex-col gap-0.5 rounded border border-surface-border bg-white p-1 text-[10px] shadow-sm"
            onMouseLeave={() => setGroupMenuId(null)}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              role="menuitem"
              className="rounded px-2 py-1 text-left text-ink-muted hover:bg-surface-muted hover:text-ink"
              onClick={() => {
                setGroupMenuId(null)
                ungroup(id)
              }}
            >
              仅删除目录
            </button>
            <button
              role="menuitem"
              className="rounded px-2 py-1 text-left text-red-600 hover:bg-red-50"
              onClick={() => {
                setGroupMenuId(null)
                deleteGroup(id)
              }}
            >
              删除目录及内组件
            </button>
            <button
              role="menuitem"
              className="rounded px-2 py-1 text-left text-ink-muted hover:bg-surface-muted"
              onClick={() => setGroupMenuId(null)}
            >
              取消
            </button>
          </div>
        )}
        {!group.collapsed && (
          <div
            className="ml-2.5 border-l border-surface-border pl-1"
          >
            {group.childIds.slice().reverse().map((childId) => {
              if (groups[childId]) return renderGroupRow(childId, id)
              return renderShapeRow(childId, id)
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-surface-border">
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <div className="mx-2 overflow-hidden rounded border border-surface-border">
          <div className="sticky top-0 z-10 flex h-8 items-center gap-1 border-b border-surface-border bg-white px-2 text-xs font-medium text-ink">
            <FolderOpen size={13} className="text-brand-600" />
            <span className="min-w-0 flex-1 truncate">基础画布</span>
            <span className="text-[10px] font-normal text-ink-muted">
              {Math.round(workspace.w)} × {Math.round(workspace.h)}
            </span>
          </div>
          <div
            className="ml-2 border-l border-surface-border pb-1 pl-1"
          >
            {order.slice().reverse().map((id) => {
              if (groups[id]) return renderGroupRow(id, null)
              return renderShapeRow(id, null)
            })}
            {order.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-ink-muted">暂无组件</p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
