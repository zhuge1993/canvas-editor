/**
 * =============================================================
 * TopMenu —— 编辑器顶部菜单栏(含 ExportDialog 导出对话框)
 * =============================================================
 * 布局(左 → 右):
 *   ① 返回按钮 + FlowBoard logo
 *   ② 对齐 / 分布 / 分组工具(只读模式隐藏; 对齐需选中≥2项, 分布需≥3项)
 *   ③ 文档标题输入框(失焦为空时回退 "未命名画布")
 *   ④ 缩放百分比输入、保存状态文字、撤销/重做/网格/保存、适合窗口、导出按钮
 * Props:
 *   - onSave / onBack: 保存与返回回调(由 pages/Editor 传入)
 *   - saveDisabled: 禁用保存; readOnly: 只读模式(分享查看页)
 * 重要提示:
 *   ★ ExportDialog 导出对话框也定义在本文件末尾(components/editor/ExportDialog/
 *     目录是空的)。导出三种: 交互点击指引 HTML(createGuideHtml 生成独立网页) /
 *     当前视图 PNG / .fboard 项目源文件。
 * 区域划分(文件内搜 "====="):
 *   ① TopMenu 主组件(setZoomPercent 按百分比缩放 / zoomToFit 适合窗口)
 *   ② 导出辅助函数 (escapeHtml / download / createGuideHtml)
 *   ③ ExportDialog 导出对话框组件
 * =============================================================
 */
import { useEffect, useState } from 'react'
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter,
  AlignStartHorizontal, AlignStartVertical, ArrowLeft, AlignVerticalDistributeCenter, Download, Grid3X3, Group, HelpCircle, History, Maximize, Moon,
  Redo2, Save, Sun, Undo2, X,
} from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useEditorStore } from '@/store/useEditorStore'
import { constrainCameraToWorkspace, flattenRenderOrder, isArrowShape } from '@/canvas/types'
import { getArrowWorldPoints, render } from '@/canvas/renderer'
import { exportShapesToSVG } from '@/utils/svgExport'
import { inlineExternalAssets } from '@/utils/image'
import { logOperation } from '@/utils/logger'

interface TopMenuProps {
  onSave: () => Promise<void | boolean>
  onBack: () => Promise<void>
  saveDisabled: boolean
  readOnly?: boolean
  docId?: string | null
  getContent?: () => string
  onRestoreVersion?: () => void
}

export default function TopMenu({ onSave, onBack, saveDisabled, readOnly = false, docId, getContent, onRestoreVersion }: TopMenuProps) {
  const [showExport, setShowExport] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const camera = useCanvasStore((state) => state.camera)
  const workspace = useCanvasStore((state) => state.workspace)
  const setCamera = useCanvasStore((state) => state.setCamera)
  const [zoomInput, setZoomInput] = useState(String(Math.round(camera.zoom * 100)))
  const undo = useCanvasStore((state) => state.undo)
  const redo = useCanvasStore((state) => state.redo)
  const toggleGrid = useCanvasStore((state) => state.toggleGrid)
  const gridVisible = useCanvasStore((state) => state.gridVisible)
  const selectedIds = useCanvasStore((state) => state.selectedIds)
  const selectedGroupIds = useCanvasStore((state) => state.selectedGroupIds)
  const alignSelected = useCanvasStore((state) => state.alignSelected)
  const distributeSelected = useCanvasStore((state) => state.distributeSelected)
  const createGroup = useCanvasStore((state) => state.createGroup)
  const saveStatus = useEditorStore((state) => state.saveStatus)
  const theme = useEditorStore((state) => state.theme)
  const toggleTheme = useEditorStore((state) => state.toggleTheme)
  const documentTitle = useEditorStore((state) => state.documentTitle)
  const setDocumentTitle = useEditorStore((state) => state.setDocumentTitle)
  const pastLength = useCanvasStore((state) => state.past.length)
  const futureLength = useCanvasStore((state) => state.future.length)

  const selectedNodeCount = selectedIds.length + selectedGroupIds.length
  const alignDisabled = selectedNodeCount < 2
  const distributeDisabled = selectedNodeCount < 3
  const statusText = { saved: '已保存', saving: '保存中...', unsaved: '未保存', error: '保存失败' }[saveStatus]
  const statusColor = { saved: 'text-green-600', saving: 'text-yellow-600', unsaved: 'text-ink-muted', error: 'text-red-500' }[saveStatus]


  /* ===== 缩放: 按百分比设置(以画布中心为锚点, 限制 0.1~4 倍) ===== */
  function setZoomPercent(rawValue: string) {
    const percentage = Number(rawValue.trim().replace('%', ''))
    if (!Number.isFinite(percentage)) {
      setZoomInput(String(Math.round(camera.zoom * 100)))
      return
    }
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (!canvas) return
    const zoom = Math.min(4, Math.max(0.1, percentage / 100))
    const centerX = canvas.clientWidth / 2
    const centerY = canvas.clientHeight / 2
    const worldX = (centerX - camera.x) / camera.zoom
    const worldY = (centerY - camera.y) / camera.zoom
    setCamera(
      constrainCameraToWorkspace(
        { x: centerX - worldX * zoom, y: centerY - worldY * zoom, zoom },
        workspace,
        canvas.clientWidth,
        canvas.clientHeight,
      ),
    )
  }
  /* ===== 缩放: 适合窗口(按所有可见元素包围盒适配) ===== */
  function zoomToFit() {
    const shapes = useCanvasStore.getState().getAllShapes().filter((shape) => shape.visible)
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (shapes.length === 0 || !canvas) return
    const minX = Math.min(...shapes.map((shape) => shape.x))
    const minY = Math.min(...shapes.map((shape) => shape.y))
    const maxX = Math.max(...shapes.map((shape) => shape.x + shape.w))
    const maxY = Math.max(...shapes.map((shape) => shape.y + shape.h))
    const padding = 80
    const zoom = Math.min(
      Math.max(1, canvas.clientWidth - padding * 2) / Math.max(1, maxX - minX),
      Math.max(1, canvas.clientHeight - padding * 2) / Math.max(1, maxY - minY),
      4,
    )
    setCamera(
      constrainCameraToWorkspace(
        {
          x: canvas.clientWidth / 2 - ((minX + maxX) / 2) * zoom,
          y: canvas.clientHeight / 2 - ((minY + maxY) / 2) * zoom,
          zoom: Math.max(0.1, zoom),
        },
        workspace,
        canvas.clientWidth,
        canvas.clientHeight,
      ),
    )
  }

  return (
    <>
      <header className="flex h-menu items-center justify-between border-b border-surface-border bg-surface px-3 select-none">
        <div className="flex min-w-52 items-center gap-2">
          <button className="tool-btn !h-8 !w-8" title="返回画布列表" aria-label="返回画布列表" onClick={() => void onBack()}>
            <ArrowLeft size={16} />
          </button>
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600"><span className="text-xs font-bold text-white">F</span></div>
          <span className="text-sm font-semibold text-ink">FlowBoard</span>
        </div>

          {/* ===== ② 对齐 / 分布 / 分组(仅编辑模式显示) ===== */}
        {!readOnly && <div className="flex flex-1 items-center justify-center gap-1">
          <button className="tool-btn !h-8 !w-8" title="左对齐" disabled={alignDisabled} onClick={() => alignSelected('left')}><AlignStartVertical size={16} /></button>
          <button className="tool-btn !h-8 !w-8" title="水平居中" disabled={alignDisabled} onClick={() => alignSelected('center')}><AlignCenterVertical size={16} /></button>
          <button className="tool-btn !h-8 !w-8" title="右对齐" disabled={alignDisabled} onClick={() => alignSelected('right')}><AlignEndVertical size={16} /></button>
          <button className="tool-btn !h-8 !w-8" title="顶部对齐" disabled={alignDisabled} onClick={() => alignSelected('top')}><AlignStartHorizontal size={16} /></button>
          <button className="tool-btn !h-8 !w-8" title="垂直居中" disabled={alignDisabled} onClick={() => alignSelected('middle')}><AlignCenterHorizontal size={16} /></button>
          <button className="tool-btn !h-8 !w-8" title="底部对齐" disabled={alignDisabled} onClick={() => alignSelected('bottom')}><AlignEndHorizontal size={16} /></button>
          <div className="mx-1 h-5 w-px bg-surface-border" />
          <button className="tool-btn !h-8 !w-8" title="水平分布" disabled={distributeDisabled} onClick={() => distributeSelected('horizontal')}><AlignHorizontalDistributeCenter size={16} /></button>
          <button className="tool-btn !h-8 !w-8" title="垂直分布" disabled={distributeDisabled} onClick={() => distributeSelected('vertical')}><AlignVerticalDistributeCenter size={16} /></button>
          <button className="tool-btn !h-8 !w-8" title="创建分组 (Ctrl+G)" disabled={selectedIds.length === 0 && selectedGroupIds.length === 0} onClick={() => createGroup()}><Group size={16} /></button>
        </div>}

        <div className="flex min-w-0 flex-1 justify-center px-3">
          <input
            aria-label="项目名称"
            value={documentTitle}
            readOnly={readOnly}
            onChange={(event) => setDocumentTitle(event.target.value)}
            onBlur={() => { if (!documentTitle.trim()) setDocumentTitle('未命名画布') }}
            className="w-full max-w-64 rounded border border-transparent bg-transparent px-2 py-1 text-center text-sm font-medium text-ink outline-none hover:border-surface-border focus:border-brand-400 focus:bg-white read-only:cursor-default"
          />
        </div>

          {/* ===== ④ 右侧: 缩放输入 / 保存状态 / 撤销重做 / 网格 / 保存 / 适合窗口 / 导出 ===== */}
        <div className="flex min-w-80 items-center justify-end gap-1">
          <label className="mr-1 flex h-8 items-center rounded border border-surface-border bg-surface-muted px-1.5 text-xs text-ink-muted" title="输入画布缩放百分比">
            <input
              aria-label="画布缩放百分比"
              inputMode="numeric"
              value={zoomInput}
              onChange={(event) => setZoomInput(event.target.value)}
              onBlur={() => setZoomPercent(zoomInput)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur()
                  setZoomPercent(zoomInput)
                }
                if (event.key === 'Escape') {
                  setZoomInput(String(Math.round(camera.zoom * 100)))
                  event.currentTarget.blur()
                }
              }}
              className="w-10 bg-transparent text-right text-xs text-ink outline-none"
            />
            <span>%</span>
          </label>
          {readOnly ? <span className="mr-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">仅查看</span> : <><span className={`mr-1 text-xs ${statusColor}`}>{statusText}</span><button className="tool-btn !h-8 !w-8" title="撤销" onClick={undo} disabled={pastLength === 0}><Undo2 size={16} /></button><button className="tool-btn !h-8 !w-8" title="重做" onClick={redo} disabled={futureLength === 0}><Redo2 size={16} /></button><button className={`tool-btn !h-8 !w-8 ${gridVisible ? 'active' : ''}`} title="网格" onClick={toggleGrid}><Grid3X3 size={16} /></button><button className="tool-btn !h-8 !w-8" title="保存" disabled={saveDisabled || saveStatus === 'saving'} onClick={() => { void onSave() }}><Save size={16} /></button></>}
          <button className="tool-btn !h-8 !w-8" title="适合窗口" onClick={zoomToFit}><Maximize size={16} /></button>
          {!readOnly && docId && <button className="tool-btn !h-8 !w-8" title="版本历史" onClick={() => setShowVersions(true)}><History size={16} /></button>}
          <button className="tool-btn !h-8 !w-8" title={theme === 'dark' ? '切换到亮色' : '切换到暗色'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
          <button className="tool-btn !h-8 !w-8" title="快捷键帮助" onClick={() => setShowHelp(true)}><HelpCircle size={16} /></button>
          <button className="btn-primary !px-2 text-xs" title="导出" onClick={() => setShowExport(true)}><Download size={14} />导出</button>
        </div>
      </header>
      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
      {showVersions && docId && <VersionsDialog docId={docId} getContent={getContent} onRestore={onRestoreVersion} onClose={() => setShowVersions(false)} />}
    </>
  )
}

/* ===== 版本历史对话框 ===== */
function VersionsDialog({ docId, getContent, onRestore, onClose }: { docId: string; getContent?: () => string; onRestore?: () => void; onClose: () => void }) {
  const [versions, setVersions] = useState<Array<{ id: string; name: string; createdAt: number }>>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void loadVersions()
  }, [])

  async function loadVersions() {
    try {
      const { getVersions } = await import('@/utils/storage')
      setVersions(await getVersions(docId))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载版本失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate() {
    setBusy(true)
    setError('')
    try {
      const { createVersion } = await import('@/utils/storage')
      const content = getContent?.() ?? ''
      await createVersion(docId, '', content)
      await loadVersions()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建版本失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleRestore(versionId: string, name: string) {
    if (!window.confirm(`确定恢复到「${name}」吗？当前内容将被覆盖（建议先创建当前版本备份）。`)) return
    setBusy(true)
    setError('')
    try {
      const { restoreVersion } = await import('@/utils/storage')
      await restoreVersion(docId, versionId)
      onRestore?.()
      onClose()
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : '恢复失败')
    } finally {
      setBusy(false)
    }
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-[420px] max-h-[70vh] overflow-y-auto rounded-md border border-surface-border bg-white p-4 shadow-float" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><span className="text-sm font-semibold text-ink">版本历史</span><button className="tool-btn !h-7 !w-7" onClick={onClose}><X size={16} /></button></div>
        {error && <div className="mb-3 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
        <button className="btn-primary w-full text-sm mb-3" disabled={busy} onClick={() => void handleCreate()}>{busy ? '创建中...' : '创建当前版本快照'}</button>
        {loading ? <div className="py-6 text-center text-xs text-ink-muted">加载中...</div> : versions.length === 0 ? (
          <div className="py-6 text-center text-xs text-ink-muted">暂无版本快照。点上方按钮创建第一个版本。</div>
        ) : (
          <div className="space-y-2">
            {versions.map((version) => (
              <div key={version.id} className="flex items-center justify-between rounded border border-surface-border bg-surface-muted px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{version.name}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">{formatTime(version.createdAt)}</p>
                </div>
                <button className="btn-ghost !h-7 shrink-0 text-xs" disabled={busy} onClick={() => void handleRestore(version.id, version.name)}>恢复</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ===== 帮助对话框(快捷键/操作说明) ===== */
function HelpDialog({ onClose }: { onClose: () => void }) {
  const sections = [
    { title: '基础操作', items: [
      ['Ctrl+S', '保存文档'], ['Ctrl+Z', '撤销'], ['Ctrl+Y / Ctrl+Shift+Z', '重做'],
      ['Ctrl+C / Ctrl+V', '复制 / 粘贴'], ['Ctrl+X / Del', '剪切 / 删除'], ['Ctrl+D', '快速复制'],
      ['Ctrl+A', '全选'], ['Ctrl+G', '组合选中'], ['Ctrl+Shift+G', '取消组合'],
    ]},
    { title: '画布操作', items: [
      ['空格+拖拽 / 中键拖拽', '平移画布'], ['Alt+滚轮', '缩放画布'], ['Ctrl+0', '适合窗口'],
      ['双击图形', '编辑文字'], ['双击箭头', '增删转折点'], ['右键', '上下文菜单'],
    ]},
    { title: '层级与对齐', items: [
      ['Ctrl+]', '上移一层'], ['Ctrl+[', '下移一层'], ['Ctrl+Shift+]', '置于顶层'], ['Ctrl+Shift+[', '置于底层'],
      ['多选后对齐按钮', '左/中/右/顶/底对齐'], ['多选后分布按钮', '水平/垂直等距分布'],
    ]},
    { title: '其他', items: [
      ['Ctrl+F', '查找替换'], ['F1 / ?', '打开帮助'], ['Esc', '关闭对话框'],
      ['拖入图片', '直接插入'], ['Ctrl+V 粘贴图片', '插入剪贴板图片'],
    ]},
  ]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-[480px] max-h-[80vh] overflow-y-auto rounded-md border border-surface-border bg-white p-4 shadow-float" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><span className="text-sm font-semibold text-ink">快捷键帮助</span><button className="tool-btn !h-7 !w-7" onClick={onClose}><X size={16} /></button></div>
        <div className="space-y-4">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="mb-2 text-xs font-semibold text-ink-muted">{section.title}</h3>
              <div className="grid grid-cols-2 gap-1.5">
                {section.items.map(([keys, desc]) => (
                  <div key={keys} className="flex items-center justify-between rounded border border-surface-border bg-surface-muted px-2 py-1">
                    <span className="text-xs text-ink">{desc}</span>
                    <kbd className="rounded border border-surface-border bg-white px-1.5 py-0.5 text-[10px] font-mono text-ink-muted">{keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ===== ② 导出辅助函数(供 ExportDialog 使用) ===== */
function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

function createGuideHtml() {
  const state = useCanvasStore.getState()
  const shapes = state.getAllShapes().filter((shape) => shape.visible)
  const minX = Math.min(0, ...shapes.map((shape) => shape.x)) - 40
  const minY = Math.min(0, ...shapes.map((shape) => shape.y)) - 40
  const maxX = Math.max(960, ...shapes.map((shape) => shape.x + shape.w)) + 40
  const maxY = Math.max(540, ...shapes.map((shape) => shape.y + shape.h)) + 40
  const shapeElements = shapes.filter((shape) => !isArrowShape(shape)).map((shape) => {
    const link = shape.link?.kind === 'url' ? shape.link.url : shape.link?.targetId ? `#${shape.link.targetId}` : ''
    const title = shape.link?.label || shape.text || shape.name
    return `<a id="${escapeHtml(shape.id)}" class="node ${shape.type}" style="left:${shape.x}px;top:${shape.y}px;width:${shape.w}px;height:${shape.h}px;background:${shape.fill === 'none' ? 'transparent' : shape.fill};border:${shape.strokeWidth}px solid ${shape.stroke};border-radius:${shape.cornerRadius}px;color:${shape.textColor};opacity:${shape.opacity}" ${link ? `href="${escapeHtml(link || '#')}"` : ''} data-preview="${escapeHtml(title)}"><span>${escapeHtml(shape.text || shape.name)}</span></a>`
  }).join('\n')
  const arrows = shapes.filter(isArrowShape).map((arrow) => {
    const points = getArrowWorldPoints(arrow, state.shapes).map((point) => `${point.x},${point.y}`).join(' ')
    return `<polyline points="${points}" fill="none" stroke="${escapeHtml(arrow.stroke)}" stroke-width="${arrow.strokeWidth}" marker-end="url(#arrowhead)" />`
  }).join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(useEditorStore.getState().documentTitle)} - 交互指引</title><style>*{box-sizing:border-box}body{margin:0;background:#eef1f5;font-family:system-ui,sans-serif}.guide{position:relative;width:${maxX - minX}px;height:${maxY - minY}px;transform:translate(${-minX}px,${-minY}px);transform-origin:0 0}.node{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;text-decoration:none;overflow:hidden;box-shadow:0 4px 14px rgba(15,23,42,.12)}.node:hover{outline:3px solid #3b63f6;z-index:5}.node:hover:after{content:attr(data-preview);position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);min-width:160px;max-width:280px;padding:8px 10px;border-radius:6px;background:#111827;color:white;font-size:12px;white-space:normal;pointer-events:none}svg{position:absolute;inset:0;pointer-events:none}</style></head><body><main class="guide">${shapeElements}<svg width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0,10 3.5,0 7" fill="#334155"/></marker></defs>${arrows}</svg></main></body></html>`
}

/* ===== ③ ExportDialog 导出对话框(注意: 定义在 TopMenu 文件内, ExportDialog/ 目录为空) ===== */
function ExportDialog({ onClose }: { onClose: () => void }) {
  const shapes = useCanvasStore((state) => state.shapes)
  const order = useCanvasStore((state) => state.order)
  const groups = useCanvasStore((state) => state.groups)
  const workspace = useCanvasStore((state) => state.workspace)
  const snapshot = useCanvasStore((state) => state.getSnapshot)

  function exportPNG() {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (!canvas) return
    canvas.toBlob((blob) => { if (blob) download('flowboard.png', blob) }, 'image/png')
    logOperation('export.png', 'Exported PNG')
  }

  /** 全画布 PNG：按内容 bounds 裁剪，支持 DPI 缩放（默认 2x 高清）。 */
  function exportFullCanvasPNG() {
    const allShapes = flattenRenderOrder(order, shapes, groups)
    if (allShapes.length === 0) return
    // 计算内容包围盒（含旋转外接盒）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const shape of allShapes) {
      const radius = Math.sqrt(shape.w * shape.w + shape.h * shape.h) / 2
      const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2
      minX = Math.min(minX, cx - radius)
      minY = Math.min(minY, cy - radius)
      maxX = Math.max(maxX, cx + radius)
      maxY = Math.max(maxY, cy + radius)
    }
    const padding = 32
    minX -= padding; minY -= padding; maxX += padding; maxY += padding
    const width = Math.ceil(maxX - minX)
    const height = Math.ceil(maxY - minY)
    const scale = 2 // 2x DPI（高清导出）
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(scale, scale)
    ctx.translate(-minX, -minY)
    render(ctx, allShapes, [], { x: 0, y: 0, zoom: 1 }, false, width, height, groups, [], workspace)
    canvas.toBlob((blob) => {
      if (blob) download('flowboard-full.png', blob)
    }, 'image/png')
    logOperation('export.fullCanvas', 'Exported full canvas PNG', { width, height, scale })
  }

  /** 导出真矢量 SVG（基础图形矢量化，复杂形状降级为矩形+文本，外置图片内嵌为 dataURL）。 */
  async function exportSVG() {
    const allShapes = flattenRenderOrder(order, shapes, groups)
    if (allShapes.length === 0) return
    const svg = await exportShapesToSVG(allShapes)
    download('flowboard.svg', new Blob([svg], { type: 'image/svg+xml' }))
    logOperation('export.svg', 'Exported SVG', { count: allShapes.length })
  }

  /** 导出 .fboard 源文件：外置图片内嵌为 dataURL，保证文件自包含、脱离服务器也能打开。 */
  async function exportSource() {
    const source = await inlineExternalAssets(snapshot())
    download('flowboard.fboard', new Blob([JSON.stringify(source, null, 2)], { type: 'application/json' }))
    logOperation('export.source', 'Exported source project')
  }

  function exportGuide() {
    download('flowboard-guide.html', new Blob([createGuideHtml()], { type: 'text/html' }))
    logOperation('export.guide', 'Exported interactive click guide', { linkedShapes: Object.values(shapes).filter((shape) => shape.link).length })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-96 rounded-md border border-surface-border bg-white p-4 shadow-float" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between"><span className="text-sm font-semibold text-ink">导出项目</span><button className="tool-btn !h-7 !w-7" title="关闭" onClick={onClose}><X size={16} /></button></div>
        <div className="space-y-2">
          <button className="btn-primary w-full text-sm" onClick={exportGuide}>导出交互点击指引 HTML</button>
          <button className="btn-ghost w-full border border-surface-border text-sm" onClick={exportFullCanvasPNG}>导出全画布 PNG（2x 高清）</button>
          <button className="btn-ghost w-full border border-surface-border text-sm" onClick={() => void exportSVG()}>导出 SVG（矢量）</button>
          <button className="btn-ghost w-full border border-surface-border text-sm" onClick={exportPNG}>导出当前视图 PNG</button>
          <button className="btn-ghost w-full border border-surface-border text-sm" onClick={() => void exportSource()}>导出 .fboard 项目源文件</button>
        </div>
      </div>
    </div>
  )
}
