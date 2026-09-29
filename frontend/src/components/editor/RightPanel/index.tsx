/**
 * =============================================================
 * RightPanel —— 右侧属性面板
 * =============================================================
 * 按选中情况显示三种模式:
 *   ① 未选中 → 画布属性(网格开关 / 缩放百分比)
 *   ② 只选中一个分组 → 分组属性(名称 / 策划案)
 *   ③ 选中组件 → 组件属性(多个 PropertySection 分区)
 * 组件属性分区(自上而下):
 *   组件(名称/类型/显隐/锁定) → 位置·尺寸·角度 → 外观(填充/描边/圆角/透明度)
 *   → 文本排版(字号/行高/字色/对齐/竖排/描边…) → 对话气泡尾角 → 进度条
 *   → 连线(线型/两端箭头) → 图片(按原始比例校正) → 图标样式 → 角标 → 策划案
 * 显隐控制(增删属性分区时重点看这里):
 *   - TEXT_TYPES: 拥有"文本排版"分区的类型集合(已覆盖所有会渲染文字的图形)
 *   - CONTAINER_TYPES: 拥有"外观"分区(填充/描边等)的类型集合
 *   - RATIO_LOCKED_TYPES: 宽高锁定的类型(圆形/正方形/物品格子)
 *   - GEO_RATIO_DEFAULTS(定义在 canvas/types.ts): 十字/星形/块箭头/梯形/平行四边形的几何比例默认值
 *   - 每个分区都用 {singleShape && 条件 && <PropertySection …/>} 控制渲染
 * 通用子组件: PropertySection(分区标题) / NumberField / ColorField / ChoiceRow
 * 快捷调色板: PALETTE(8 色)
 * 手动修改指南:
 *   - 加属性分区 → 在 JSX 末尾仿照现有写法加一个 <PropertySection title="…"> 块
 *   - 加新组件类型 → 先改 @/canvas/types 的 ShapeType 与 renderer, 再把类型加进本文件顶部的集合
 * 箭头提示: 画布上双击箭头=增删转折点; 箭头文字在「连线」分区里改
 * =============================================================
 */
import { useEffect, useState } from 'react'
import { Bold, Eye, EyeOff, FlipHorizontal2, FlipVertical2, Link2, Lock, PanelRightClose, PanelRightOpen, RotateCcw, RotateCw, Unlock } from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useEditorStore } from '@/store/useEditorStore'
import { constrainCameraToWorkspace, GEO_RATIO_DEFAULTS, isArrowShape, isImageShape, type Shape } from '@/canvas/types'
import { ICON_LABELS, ICON_NAMES } from '@/canvas/renderer'
import { logOperation } from '@/utils/logger'

/* ===== 类型集合: 决定哪些属性分区显示(新增组件类型时按需加入) ===== */
// 所有会渲染文字的组件类型都显示「文本排版」分区(改字号/字色/对齐等)
const TEXT_TYPES = new Set<Shape['type']>(['text', 'rectangle', 'square', 'circle', 'ellipse', 'diamond', 'triangle', 'star', 'pentagon', 'hexagon', 'parallelogram', 'trapezoid', 'cross', 'heart', 'cloud', 'block-arrow', 'button', 'input', 'panel', 'dialog', 'note', 'checkbox', 'progress', 'healthbar', 'inventory-slot', 'icon'])
const CONTAINER_TYPES = new Set<Shape['type']>(['rectangle', 'square', 'circle', 'ellipse', 'diamond', 'triangle', 'star', 'pentagon', 'hexagon', 'parallelogram', 'trapezoid', 'cross', 'heart', 'cloud', 'block-arrow', 'button', 'input', 'panel', 'dialog', 'note', 'progress', 'healthbar', 'minimap', 'inventory-slot', 'checkbox', 'slider', 'icon'])
const RATIO_LOCKED_TYPES = new Set<Shape['type']>(['circle', 'square', 'inventory-slot'])
function positiveSize(value: number) { return Number.isFinite(value) && value > 0 ? value : 1 }
const PALETTE = ['#ffffff', '#f1f5f9', '#fee2e2', '#fef3c7', '#dcfce7', '#dbeafe', '#ede9fe', '#111827']

/* ===== 通用属性分区子组件: PropertySection / NumberField / ColorField / ChoiceRow ===== */
function PropertySection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border-t border-surface-border pt-2 first:border-0 first:pt-0"><h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">{title}</h3>{children}</section>
}

function NumberField({ label, value, min, max, step, onFocus, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onFocus: () => void; onChange: (value: number) => void }) {
  return <label className="min-w-0 text-[10px] text-ink-muted"><span className="mb-0.5 block">{label}</span><input type="number" value={Number(value.toFixed(2))} min={min} max={max} step={step} onFocus={onFocus} onChange={(event) => onChange(Number(event.target.value))} className="h-7 w-full min-w-0 rounded border border-surface-border px-1.5 text-xs text-ink outline-none focus:border-brand-400" /></label>
}

function toHexColor(value: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value
  const rgba = value.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (rgba) return '#' + [rgba[1], rgba[2], rgba[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')
  return '#000000'
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="flex min-w-0 items-center gap-1 text-[10px] text-ink-muted"><span>{label}</span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="h-7 min-w-0 flex-1 rounded border border-surface-border bg-white p-0.5" /></label>
}

function ChoiceRow<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <div className={`grid gap-1 ${options.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>{options.map((option) => <button key={option.value} className={`h-7 rounded border text-[11px] ${value === option.value ? 'border-brand-500 bg-brand-50 text-brand-600' : 'border-surface-border text-ink-muted'}`} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
}

/* ===== RightPanel 主组件 ===== */
export default function RightPanel() {
  const collapsed = useEditorStore((state) => state.rightPanelCollapsed)
  const togglePanel = useEditorStore((state) => state.toggleRightPanel)
  const gridVisible = useCanvasStore((state) => state.gridVisible)
  const toggleGrid = useCanvasStore((state) => state.toggleGrid)
  const canvasBackground = useCanvasStore((state) => state.canvasBackground)
  const gridSize = useCanvasStore((state) => state.gridSize)
  const setCanvasBackground = useCanvasStore((state) => state.setCanvasBackground)
  const setGridSize = useCanvasStore((state) => state.setGridSize)
  const camera = useCanvasStore((state) => state.camera)
  const workspace = useCanvasStore((state) => state.workspace)
  const setCamera = useCanvasStore((state) => state.setCamera)
  const [zoomInput, setZoomInput] = useState(() => String(Math.round(camera.zoom * 100)))
  const shapes = useCanvasStore((state) => state.shapes)
  const selectedIds = useCanvasStore((state) => state.selectedIds)
  const selectedGroupIds = useCanvasStore((state) => state.selectedGroupIds)
  const groups = useCanvasStore((state) => state.groups)
  const updateGroup = useCanvasStore((state) => state.updateGroup)
  const updateShape = useCanvasStore((state) => state.updateShape)
  const updateShapes = useCanvasStore((state) => state.updateShapes)
  const pushHistory = useCanvasStore((state) => state.pushHistory)
  useEffect(() => {
    setZoomInput(String(Math.round(camera.zoom * 100)))
  }, [camera.zoom])

  function commitZoom(rawValue: string) {
    const percentage = Number(rawValue.trim().replace('%', ''))
    if (!Number.isFinite(percentage)) {
      setZoomInput(String(Math.round(camera.zoom * 100)))
      return
    }
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (!canvas) return
    const nextZoom = Math.min(4, Math.max(0.1, percentage / 100))
    const centerX = canvas.clientWidth / 2
    const centerY = canvas.clientHeight / 2
    const worldX = (centerX - camera.x) / camera.zoom
    const worldY = (centerY - camera.y) / camera.zoom
    setCamera(
      constrainCameraToWorkspace(
        { x: centerX - worldX * nextZoom, y: centerY - worldY * nextZoom, zoom: nextZoom },
        workspace,
        canvas.clientWidth,
        canvas.clientHeight,
      ),
    )
  }

  const selectedShapes = selectedIds.map((id) => shapes[id]).filter(Boolean) as Shape[]
  const singleShape = selectedShapes.length === 1 ? selectedShapes[0]! : null
  const hasSelection = selectedShapes.length > 0
  const singleGroupId = selectedIds.length === 0 && selectedGroupIds.length === 1 ? selectedGroupIds[0]! : null
  const singleGroup = singleGroupId ? groups[singleGroupId] ?? null : null

  function patchSelected(patch: Partial<Shape>, recordHistory = true) {
    if (recordHistory) pushHistory()
    updateShapes(selectedIds, patch)
    logOperation('property.updated', 'Updated shape properties', { ids: selectedIds, keys: Object.keys(patch) })
  }

  function updateSingle(patch: Partial<Shape>, recordHistory = true) {
    if (!singleShape) return
    if (recordHistory) pushHistory()
    updateShape(singleShape.id, patch)
  }

  /* ===== 折叠态: 面板收起时只显示一个展开按钮 ===== */
  if (collapsed) return <div className="flex h-full w-10 flex-col items-center border-l border-surface-border bg-surface py-2"><button className="tool-btn" onClick={togglePanel} title="展开属性面板"><PanelRightOpen size={16} /></button></div>

  /* ===== 主界面: 三种模式(画布属性 / 分组属性 / 组件属性) ===== */
  return <aside className="flex h-full w-72 flex-col overflow-y-auto border-l border-surface-border bg-surface select-none">
    <div className="flex items-center justify-between border-b border-surface-border px-3 py-1.5"><span className="text-xs font-medium uppercase text-ink-muted">{singleGroup ? '分组属性' : hasSelection ? '组件属性' : '画布属性'}</span><button className="tool-btn !h-6 !w-6" onClick={togglePanel} title="折叠属性面板"><PanelRightClose size={14} /></button></div>
    {!hasSelection && !singleGroup ? <div className="space-y-2 p-3"><PropertySection title="画布"><div className="grid grid-cols-2 gap-2 text-xs"><button className={`h-7 rounded ${gridVisible ? 'bg-brand-50 text-brand-600' : 'bg-surface-muted text-ink-muted'}`} onClick={toggleGrid}>网格 {gridVisible ? '开' : '关'}</button><label className="flex h-7 items-center justify-center gap-1 rounded border border-surface-border bg-surface-muted px-1.5 text-[11px] text-ink-muted" title="输入画布缩放百分比"><input aria-label="右侧画布缩放百分比" inputMode="numeric" value={zoomInput} onChange={(event) => setZoomInput(event.target.value)} onBlur={(event) => commitZoom(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } else if (event.key === 'Escape') { setZoomInput(String(Math.round(camera.zoom * 100))); event.currentTarget.blur() } }} className="w-12 bg-transparent text-right text-xs text-ink outline-none" /><span>%</span></label></div><div className="mt-2 grid grid-cols-2 gap-2"><ColorField label="背景" value={canvasBackground} onChange={setCanvasBackground} /><NumberField label="网格" value={gridSize} min={8} max={100} onFocus={pushHistory} onChange={setGridSize} /></div></PropertySection></div> : singleGroup ? <div className="space-y-2 p-2.5"><PropertySection title="分组"><div className="flex gap-1"><input aria-label="分组名称" value={singleGroup.name} onFocus={pushHistory} onChange={(event) => updateGroup(singleGroup.id, { name: event.target.value })} className="h-7 min-w-0 flex-1 rounded border border-surface-border px-2 text-xs outline-none focus:border-brand-400" /></div></PropertySection><PropertySection title="分组样式"><div className="grid grid-cols-2 gap-1"><ColorField label="边框" value={singleGroup.stroke ?? '#94a3b8'} onChange={(stroke) => updateGroup(singleGroup.id, { stroke })} /><ColorField label="背景" value={singleGroup.fill && singleGroup.fill !== 'rgba(255,255,255,0.46)' ? singleGroup.fill : '#ffffff'} onChange={(fill) => updateGroup(singleGroup.id, { fill })} /></div></PropertySection><PropertySection title="策划案"><textarea aria-label="策划案" value={singleGroup.description ?? ''} onFocus={pushHistory} onChange={(event) => updateGroup(singleGroup.id, { description: event.target.value })} rows={10} placeholder="在这里输入策划案内容，支持换行" className="w-full resize-y rounded border border-surface-border px-2 py-1.5 text-xs leading-5 outline-none focus:border-brand-400" /><div className="mt-1 text-[10px] text-ink-muted">内容会随文档自动保存</div></PropertySection></div> : <div className="space-y-2 p-2.5">
      {singleShape && <PropertySection title="组件"><div className="flex gap-1"><input aria-label="组件名称" value={singleShape.name} onFocus={pushHistory} onChange={(event) => updateShape(singleShape.id, { name: event.target.value })} className="h-7 min-w-0 flex-1 rounded border border-surface-border px-2 text-xs outline-none focus:border-brand-400" /><span className="flex h-7 items-center rounded bg-surface-muted px-2 text-[10px] text-ink-muted">{singleShape.type}</span><button className="tool-btn !h-7 !w-7" title={singleShape.visible === false ? '显示' : '隐藏'} onClick={() => updateSingle({ visible: singleShape.visible === false })}>{singleShape.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}</button><button className="tool-btn !h-7 !w-7" title={singleShape.locked ? '解锁' : '锁定'} onClick={() => updateSingle({ locked: !singleShape.locked })}>{singleShape.locked ? <Lock size={13} /> : <Unlock size={13} />}</button></div></PropertySection>}

      <PropertySection title="位置 · 尺寸 · 角度"><div className="grid grid-cols-5 gap-1">{singleShape ? <><NumberField label="X" value={singleShape.x} onFocus={pushHistory} onChange={(x) => updateShape(singleShape.id, { x })} /><NumberField label="Y" value={singleShape.y} onFocus={pushHistory} onChange={(y) => updateShape(singleShape.id, { y })} /><NumberField label="W" value={singleShape.w} onFocus={pushHistory} onChange={(w) => updateShape(singleShape.id, RATIO_LOCKED_TYPES.has(singleShape.type) ? { w: positiveSize(w), h: positiveSize(w) } : { w: positiveSize(w) })} /><NumberField label="H" value={singleShape.h} onFocus={pushHistory} onChange={(h) => updateShape(singleShape.id, RATIO_LOCKED_TYPES.has(singleShape.type) ? { w: positiveSize(h), h: positiveSize(h) } : { h: positiveSize(h) })} /><NumberField label="°" value={singleShape.rotation * 180 / Math.PI} min={-360} max={360} onFocus={pushHistory} onChange={(degrees) => updateShape(singleShape.id, { rotation: degrees * Math.PI / 180 })} /></> : <><NumberField label="X" value={Math.min(...selectedShapes.map(s => s.x))} onFocus={pushHistory} onChange={(x) => { const dx = x - Math.min(...selectedShapes.map(s => s.x)); pushHistory(); selectedShapes.forEach(s => updateShape(s.id, { x: s.x + dx })) }} /><NumberField label="Y" value={Math.min(...selectedShapes.map(s => s.y))} onFocus={pushHistory} onChange={(y) => { const dy = y - Math.min(...selectedShapes.map(s => s.y)); pushHistory(); selectedShapes.forEach(s => updateShape(s.id, { y: s.y + dy })) }} /><span className="flex h-7 items-center justify-center rounded bg-surface-muted text-[10px] text-ink-muted">批量</span><NumberField label="宽%" value={100} min={1} onFocus={pushHistory} onChange={(w) => { const ratio = w / 100; pushHistory(); selectedShapes.forEach(s => updateShape(s.id, RATIO_LOCKED_TYPES.has(s.type) ? { w: s.w * ratio, h: s.h * ratio } : { w: s.w * ratio })) }} /><NumberField label="高%" value={100} min={1} onFocus={pushHistory} onChange={(h) => { const ratio = h / 100; pushHistory(); selectedShapes.forEach(s => updateShape(s.id, RATIO_LOCKED_TYPES.has(s.type) ? { w: s.w * ratio, h: s.h * ratio } : { h: s.h * ratio })) }} /></>}</div>{hasSelection && <div className="mt-1.5 grid grid-cols-4 gap-1">{(() => { const rotate = (delta: number) => { pushHistory(); selectedShapes.forEach(s => updateShape(s.id, { rotation: s.rotation + delta })) }; const flipH = () => { pushHistory(); selectedShapes.forEach(s => updateShape(s.id, { w: -s.w })) }; const flipV = () => { pushHistory(); selectedShapes.forEach(s => updateShape(s.id, { h: -s.h })) }; return <><button className="tool-btn h-7" title="左旋 90°" onClick={() => rotate(-Math.PI / 2)}><RotateCcw size={13} /></button><button className="tool-btn h-7" title="右旋 90°" onClick={() => rotate(Math.PI / 2)}><RotateCw size={13} /></button><button className="tool-btn h-7" title="水平翻转" onClick={flipH}><FlipHorizontal2 size={13} /></button><button className="tool-btn h-7" title="垂直翻转" onClick={flipV}><FlipVertical2 size={13} /></button></> })()}</div>}</PropertySection>

      {CONTAINER_TYPES.has(singleShape?.type ?? 'line') && <PropertySection title="外观"><div className="space-y-1.5"><div className="grid grid-cols-4 gap-1">{PALETTE.map((color) => <button key={color} className={`h-5 rounded border ${singleShape?.fill === color ? 'border-brand-500 ring-1 ring-brand-300' : 'border-surface-border'}`} style={{ backgroundColor: color }} onClick={() => patchSelected({ fill: color })} />)}</div><div className="grid grid-cols-4 gap-1">{singleShape && <><ColorField label="填" value={singleShape.fill === 'none' ? '#ffffff' : singleShape.fill} onChange={(fill) => patchSelected({ fill })} /><ColorField label="边" value={singleShape.stroke === 'none' ? '#000000' : singleShape.stroke} onChange={(stroke) => patchSelected({ stroke })} /><NumberField label="线宽" value={singleShape.strokeWidth} min={0} max={20} onFocus={pushHistory} onChange={(strokeWidth) => patchSelected({ strokeWidth }, false)} /><NumberField label="圆角" value={singleShape.cornerRadius} min={0} max={100} onFocus={pushHistory} onChange={(cornerRadius) => patchSelected({ cornerRadius }, false)} /></>}</div><div className="grid grid-cols-2 gap-1">{singleShape && <><NumberField label="阴影" value={singleShape.shadowBlur} min={0} max={64} onFocus={pushHistory} onChange={(shadowBlur) => patchSelected({ shadowBlur }, false)} /><NumberField label="透明 %" value={singleShape.opacity * 100} min={0} max={100} onFocus={pushHistory} onChange={(opacity) => patchSelected({ opacity: Math.max(0, Math.min(100, opacity)) / 100 }, false)} /></>}</div><div className="grid grid-cols-4 gap-1">{singleShape && <><div className="col-span-3"><ChoiceRow value={singleShape.lineStyle} options={[{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }]} onChange={(lineStyle) => patchSelected({ lineStyle })} /></div><ColorField label="影色" value={toHexColor(singleShape.shadowColor)} onChange={(shadowColor) => patchSelected({ shadowColor })} /></>}</div></div></PropertySection>}

      {!singleShape && hasSelection && <PropertySection title="批量样式"><div className="space-y-1.5"><div className="grid grid-cols-4 gap-1">{PALETTE.map((color) => <button key={color} className="h-5 rounded border border-surface-border" style={{ backgroundColor: color }} onClick={() => patchSelected({ fill: color })} />)}</div><div className="grid grid-cols-4 gap-1"><ColorField label="填" value="#ffffff" onChange={(fill) => patchSelected({ fill })} /><ColorField label="边" value="#000000" onChange={(stroke) => patchSelected({ stroke })} /><NumberField label="线宽" value={2} min={0} max={20} onFocus={pushHistory} onChange={(strokeWidth) => patchSelected({ strokeWidth }, false)} /><NumberField label="圆角" value={6} min={0} max={100} onFocus={pushHistory} onChange={(cornerRadius) => patchSelected({ cornerRadius }, false)} /></div><div className="grid grid-cols-3 gap-1"><NumberField label="透明 %" value={100} min={0} max={100} onFocus={pushHistory} onChange={(opacity) => patchSelected({ opacity: Math.max(0, Math.min(100, opacity)) / 100 }, false)} /><NumberField label="阴影" value={0} min={0} max={64} onFocus={pushHistory} onChange={(shadowBlur) => patchSelected({ shadowBlur }, false)} /><div className="col-span-1"><ChoiceRow value="solid" options={[{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }]} onChange={(lineStyle) => patchSelected({ lineStyle })} /></div></div>{selectedShapes.every(s => TEXT_TYPES.has(s.type)) && <div className="grid grid-cols-3 gap-1"><NumberField label="字号" value={16} min={8} max={96} onFocus={pushHistory} onChange={(fontSize) => patchSelected({ fontSize })} /><ColorField label="字色" value="#1f2430" onChange={(textColor) => patchSelected({ textColor })} /><button className={`mt-3 h-7 rounded border border-surface-border`} onClick={() => patchSelected({ fontWeight: 'bold' })}><Bold size={13} className="mx-auto" /></button></div>}<div className="text-[10px] text-ink-muted">对已选 {selectedIds.length} 项统一生效</div></div></PropertySection>}

      {singleShape && TEXT_TYPES.has(singleShape.type) && <PropertySection title="文本排版"><div className="space-y-1.5"><textarea aria-label="组件文字" value={singleShape.text} onFocus={pushHistory} onChange={(event) => updateShape(singleShape.id, { text: event.target.value })} rows={2} className="w-full resize-y rounded border border-surface-border px-2 py-1 text-xs outline-none focus:border-brand-400" /><div className="grid grid-cols-4 gap-1"><NumberField label="字号" value={singleShape.fontSize} min={8} max={96} onFocus={pushHistory} onChange={(fontSize) => updateShape(singleShape.id, { fontSize })} /><NumberField label="行距" value={singleShape.lineHeight ?? 1.3} min={0.8} max={3} step={0.1} onFocus={pushHistory} onChange={(lineHeight) => updateShape(singleShape.id, { lineHeight })} /><ColorField label="字" value={singleShape.textColor} onChange={(textColor) => updateSingle({ textColor })} />{singleShape.type === 'text' ? <ColorField label="底" value={singleShape.textBackground === 'none' ? '#ffffff' : singleShape.textBackground ?? '#ffffff'} onChange={(textBackground) => updateSingle({ textBackground })} /> : <button className={`mt-3 h-7 rounded border ${singleShape.fontWeight === 'bold' ? 'border-brand-500 bg-brand-50 text-brand-600' : 'border-surface-border'}`} onClick={() => updateSingle({ fontWeight: singleShape.fontWeight === 'bold' ? 'normal' : 'bold' })}><Bold size={13} className="mx-auto" /></button>}</div><div className="flex gap-1"><button className={`h-7 w-8 rounded border ${singleShape.fontWeight === 'bold' ? 'border-brand-500 bg-brand-50 text-brand-600' : 'border-surface-border'}`} onClick={() => updateSingle({ fontWeight: singleShape.fontWeight === 'bold' ? 'normal' : 'bold' })}><Bold size={13} className="mx-auto" /></button><div className="min-w-0 flex-1"><ChoiceRow value={singleShape.textAlign} options={[{ value: 'left', label: '左' }, { value: 'center', label: '中' }, { value: 'right', label: '右' }]} onChange={(textAlign) => updateSingle({ textAlign })} /></div></div><ChoiceRow value={singleShape.textDirection ?? 'horizontal'} options={[{ value: 'horizontal', label: '横排' }, { value: 'vertical', label: '竖排' }]} onChange={(textDirection) => updateSingle({ textDirection })} /><div className="grid grid-cols-2 gap-1"><ColorField label="描边" value={singleShape.textStroke && singleShape.textStroke !== 'none' ? singleShape.textStroke : '#000000'} onChange={(textStroke) => updateSingle({ textStroke })} /><NumberField label="描边宽" value={singleShape.textStrokeWidth ?? 0} min={0} max={12} onFocus={pushHistory} onChange={(textStrokeWidth) => updateSingle({ textStrokeWidth })} /></div>{singleShape.type === 'text' && <button className="h-7 w-full rounded border border-surface-border text-[11px] text-ink-muted" onClick={() => updateSingle({ textBackground: 'none' })}>文本背景设为透明</button>}</div></PropertySection>}

      {singleShape?.type === 'dialog' && <PropertySection title="对话气泡尾角"><div className="space-y-1.5"><ChoiceRow value={singleShape.dialogTailPosition ?? 'left'} options={[{ value: 'left', label: '左' }, { value: 'center', label: '中' }, { value: 'right', label: '右' }]} onChange={(dialogTailPosition) => updateSingle({ dialogTailPosition })} /><NumberField label="尾角大小" value={singleShape.dialogTailSize ?? 20} min={8} max={60} onFocus={pushHistory} onChange={(dialogTailSize) => updateShape(singleShape.id, { dialogTailSize })} /></div></PropertySection>}

      {singleShape?.type === 'checkbox' && <PropertySection title="复选框"><div className="space-y-1.5"><label className="flex h-7 items-center justify-center gap-1 rounded border border-surface-border text-[11px]"><input type="checkbox" checked={singleShape.checked !== false} onChange={(event) => updateSingle({ checked: event.target.checked })} />勾选状态</label></div></PropertySection>}

      {singleShape?.type === 'slider' && <PropertySection title="滑块"><div className="space-y-1.5"><div className="flex items-center justify-between text-[10px] text-ink-muted"><span>滑块位置</span><span>{Math.round((singleShape.progressValue ?? 50))}%</span></div><input aria-label="滑块位置" type="range" min="0" max="100" value={singleShape.progressValue ?? 50} onFocus={pushHistory} onChange={(event) => updateShape(singleShape.id, { progressValue: Number(event.target.value) })} className="w-full accent-brand-600" /></div></PropertySection>}

      {singleShape && (singleShape.type === 'progress' || singleShape.type === 'healthbar') && <PropertySection title="进度条"><div className="space-y-1.5"><div className="grid grid-cols-3 gap-1"><NumberField label="进度 %" value={singleShape.progressValue ?? 65} min={0} max={100} onFocus={pushHistory} onChange={(progressValue) => updateShape(singleShape.id, { progressValue: Math.max(0, Math.min(100, progressValue)) })} /><ColorField label="进度色" value={singleShape.progressColor ?? '#3b82f6'} onChange={(progressColor) => updateSingle({ progressColor })} /><ColorField label="背景" value={singleShape.fill === 'none' ? '#e2e8f0' : singleShape.fill} onChange={(fill) => updateSingle({ fill })} /></div><input aria-label="进度" type="range" min="0" max="100" value={singleShape.progressValue ?? 65} onFocus={pushHistory} onChange={(event) => updateShape(singleShape.id, { progressValue: Number(event.target.value) })} className="w-full accent-brand-600" /><ChoiceRow value={singleShape.progressStyle ?? 'solid'} options={[{ value: 'solid', label: '纯色' }, { value: 'striped', label: '条纹' }, { value: 'segmented', label: '分段' }]} onChange={(progressStyle) => updateSingle({ progressStyle })} /></div></PropertySection>}

      {singleShape && isArrowShape(singleShape) && <PropertySection title="连线"><div className="space-y-1.5"><input aria-label="线条文字" value={singleShape.text} onFocus={pushHistory} onChange={(event) => updateSingle({ text: event.target.value })} placeholder="线条文字(可选; 画布上双击线条可增删转折点)" className="h-7 w-full rounded border border-surface-border px-2 text-xs outline-none focus:border-brand-400" /><ChoiceRow value={singleShape.lineStyle} options={[{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }]} onChange={(lineStyle) => updateSingle({ lineStyle })} /><div className="grid grid-cols-2 gap-1"><label className="flex h-7 items-center justify-center gap-1 rounded border border-surface-border text-[11px]"><input type="checkbox" checked={singleShape.startArrow} onChange={(event) => updateSingle({ startArrow: event.target.checked })} />起点箭头</label><label className="flex h-7 items-center justify-center gap-1 rounded border border-surface-border text-[11px]"><input type="checkbox" checked={singleShape.endArrow} onChange={(event) => updateSingle({ endArrow: event.target.checked })} />终点箭头</label></div></div></PropertySection>}

      {singleShape && isImageShape(singleShape) && <PropertySection title="图片"><button className="h-7 w-full rounded border border-surface-border text-[11px]" onClick={() => { pushHistory(); updateShape(singleShape.id, { h: singleShape.w / Math.max(0.01, singleShape.aspectRatio) }) }}>按原始比例校正</button></PropertySection>}

      {singleShape && <PropertySection title="链接"><div className="space-y-1.5"><input aria-label="链接地址" value={singleShape.link?.url ?? ''} onFocus={pushHistory} onChange={(event) => updateSingle({ link: event.target.value.trim() ? { kind: 'url', url: event.target.value.trim(), label: singleShape.text || singleShape.name } : undefined })} placeholder="https://... 点击跳转" className="h-7 w-full rounded border border-surface-border px-2 text-xs outline-none focus:border-brand-400" /><div className="flex items-center gap-1 text-[10px] text-ink-muted"><Link2 size={10} />{singleShape.link?.url ? '已设置链接（分享页点击可跳转）' : '未设置链接'}</div></div></PropertySection>}

      {singleShape?.type === 'icon' && <PropertySection title="图标样式"><select aria-label="图标样式" value={singleShape.iconName ?? 'arrow-solid'} onFocus={pushHistory} onChange={(event) => updateSingle({ iconName: event.target.value })} className="h-7 w-full rounded border border-surface-border px-1 text-xs outline-none focus:border-brand-400">{ICON_NAMES.map((iconName) => (<option key={iconName} value={iconName}>{ICON_LABELS[iconName] ?? iconName}</option>))}</select></PropertySection>}

      {singleShape && GEO_RATIO_DEFAULTS[singleShape.type] && (() => {
        const def = GEO_RATIO_DEFAULTS[singleShape.type]
        if (!def || !singleShape) return null
        const currentValue = typeof singleShape.innerScale === 'number' && singleShape.innerScale > 0 && singleShape.innerScale < 1 ? Math.min(singleShape.innerScale, def.max) : def.fallback
        return <PropertySection title="几何比例"><div className="space-y-1"><div className="flex items-center justify-between text-[10px] text-ink-muted"><span>{def.label}</span><span>{Math.round(currentValue * 100)}%</span></div><input aria-label={def.label} type="range" min="0.05" max={def.max} step="0.01" value={currentValue} onFocus={pushHistory} onChange={(event) => updateShape(singleShape.id, { innerScale: Number(event.target.value) })} className="w-full accent-brand-600" /><div className="text-[10px] text-ink-muted">调整图形几何(十字臂宽/星形内角/块箭头粗细等), 往右越粗越大</div></div></PropertySection>
      })()}

      {singleShape && <PropertySection title="角标"><div className="space-y-1.5"><ChoiceRow value={singleShape.badgeType ?? 'none'} options={[{ value: 'none', label: '无' }, { value: 'ribbon', label: '绶带' }, { value: 'seal', label: '圆章' }]} onChange={(badgeType) => updateSingle({ badgeType })} />{singleShape.badgeType === 'ribbon' && <input aria-label="角标文字" value={singleShape.badgeText ?? ''} onFocus={pushHistory} onChange={(event) => updateSingle({ badgeText: event.target.value })} placeholder="角标文字 如 伴侣" className="h-7 w-full rounded border border-surface-border px-2 text-xs outline-none focus:border-brand-400" />}{singleShape.badgeType && singleShape.badgeType !== 'none' && <ColorField label="角标色" value={toHexColor(singleShape.badgeColor ?? '#8b1a1a')} onChange={(badgeColor) => updateSingle({ badgeColor })} />}</div></PropertySection>}{singleShape && <PropertySection title="策划案"><textarea aria-label="策划案" value={singleShape.description ?? ''} onFocus={pushHistory} onChange={(event) => updateSingle({ description: event.target.value })} rows={10} placeholder="在这里输入策划案内容，支持换行" className="w-full resize-y rounded border border-surface-border px-2 py-1.5 text-xs leading-5 outline-none focus:border-brand-400" /><div className="mt-1 text-[10px] text-ink-muted">内容会随文档自动保存</div></PropertySection>}
    </div>}
  </aside>
}
