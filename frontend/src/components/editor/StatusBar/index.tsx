/**
 * =============================================================
 * StatusBar —— 编辑器底部状态栏
 * =============================================================
 * 职责:
 *   显示底部实时信息: 缩放比例 | 光标坐标 | 选中元素数 | 画布尺寸 | 网格开关。
 * 数据来源:
 *   - useEditorStore: zoom(缩放) / cursorPosition(光标坐标)
 *   - useCanvasStore: selectedIds(选中) / gridVisible(网格) / workspace(画布尺寸)
 * 手动修改指南:
 *   - 增加状态项: 在 JSX 左侧 flex 容器里加一个 <span>…</span> 即可。
 *   - 高度样式来自 h-statusbar 类(tailwind 配置 / index.css)。
 * =============================================================
 */
import { useCanvasStore } from '@/store/useCanvasStore'
import { useEditorStore } from '@/store/useEditorStore'

export default function StatusBar() {
  const zoom = useEditorStore((s) => s.zoom)
  const cursor = useEditorStore((s) => s.cursorPosition)
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const gridVisible = useCanvasStore((s) => s.gridVisible)
  const workspace = useCanvasStore((s) => s.workspace)
  const pastLength = useCanvasStore((s) => s.past.length)
  const futureLength = useCanvasStore((s) => s.future.length)

  return (
    <footer className="h-statusbar flex items-center justify-between px-3 bg-surface border-t border-surface-border text-[11px] text-ink-muted select-none">
      <div className="flex items-center gap-4">
        <span>缩放: <span className="text-ink">{Math.round(zoom.level * 100)}%</span></span>
        <span>坐标: <span className="text-ink">({cursor.x}, {cursor.y})</span></span>
        <span>选中: <span className="text-ink">{selectedIds.length}</span> 个元素</span>
        <span>画布: <span className="text-ink">{Math.round(workspace.w)} × {Math.round(workspace.h)}</span></span>
      </div>
      <div className="flex items-center gap-4">
        <span>可撤销: <span className="text-ink">{pastLength}</span></span>
        <span>可重做: <span className="text-ink">{futureLength}</span></span>
        <span>构建: <span className="text-ink">{__BUILD_TIME__}</span></span>
        <span>{gridVisible ? '网格开启' : '网格关闭'}</span>
      </div>
    </footer>
  )
}