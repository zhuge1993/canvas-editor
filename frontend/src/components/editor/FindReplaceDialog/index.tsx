/**
 * =============================================================
 * FindReplaceDialog —— 查找和替换对话框
 * =============================================================
 * 职责:
 *   在所有组件的文本(shape.text)中查找, 支持上一个/下一个跳转、
 *   跳转后把目标居中到视口、替换当前、全部替换。
 * Props:
 *   - onClose: 关闭对话框(Esc 键或右上角关闭按钮触发)
 * 依赖:
 *   - useCanvasStore: select / setCamera / replaceText
 *   - 画布元素通过 canvas[data-flowboard-canvas] 定位
 * 快捷键: Enter = 下一个, Shift+Enter = 上一个, Esc = 关闭
 * 区域划分(文件内搜 "====="):
 *   ① 结果匹配与当前索引修正 (results / useEffect)
 *   ② 跳转与居中 (centerShape / goToResult)
 *   ③ 替换 (replaceCurrent / replaceAll)
 *   ④ 对话框 UI (JSX)
 * =============================================================
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import type { Shape } from '@/canvas/types'

interface FindReplaceDialogProps {
  onClose: () => void
}

export default function FindReplaceDialog({ onClose }: FindReplaceDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [currentIndex, setCurrentIndex] = useState(0)

  const shapes = useCanvasStore((state) => state.shapes)
  const select = useCanvasStore((state) => state.select)
  const setCamera = useCanvasStore((state) => state.setCamera)
  const replaceText = useCanvasStore((state) => state.replaceText)

  /* ===== ① 结果匹配: 在所有 shape.text 中查找 query ===== */
  const results = useMemo(
    () => query ? Object.values(shapes).filter((shape) => shape.text.includes(query)) : [],
    [query, shapes],
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (results.length === 0) setCurrentIndex(0)
    else if (currentIndex >= results.length) setCurrentIndex(results.length - 1)
  }, [currentIndex, results.length])

  /* ===== ② 跳转与居中: 选中目标并把相机移到画布中心 ===== */
  function centerShape(shape: Shape) {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (!canvas) return
    const zoom = useCanvasStore.getState().camera.zoom
    setCamera({
      x: canvas.clientWidth / 2 - (shape.x + shape.w / 2) * zoom,
      y: canvas.clientHeight / 2 - (shape.y + shape.h / 2) * zoom,
    })
  }

  function goToResult(index: number) {
    if (results.length === 0) return
    const nextIndex = (index + results.length) % results.length
    const shape = results[nextIndex]
    if (!shape) return
    setCurrentIndex(nextIndex)
    select([shape.id])
    centerShape(shape)
  }

  /* ===== ③ 替换: 调 store.replaceText ===== */
  function replaceCurrent() {
    const shape = results[currentIndex]
    if (!shape) return
    replaceText(query, replacement, [shape.id])
  }

  function replaceAll() {
    replaceText(query, replacement)
  }

  return (
    <div
      role="dialog"
      aria-label="查找和替换"
      className="absolute right-3 top-3 z-20 w-80 rounded-md border border-surface-border bg-surface p-3 shadow-float"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
        else if (event.key === 'Enter') {
          event.preventDefault()
          goToResult(currentIndex + (event.shiftKey ? -1 : 1))
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">查找和替换</span>
        <button className="tool-btn !h-7 !w-7" title="关闭" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setCurrentIndex(0)
            }}
            placeholder="查找文本"
            className="min-w-0 flex-1 rounded-md border border-surface-border px-2 py-1.5 text-sm outline-none focus:border-brand-400"
          />
          <span className="w-12 text-center text-xs text-ink-muted">
            {results.length === 0 ? '0 / 0' : `${currentIndex + 1} / ${results.length}`}
          </span>
          <button className="tool-btn !h-8 !w-8" title="上一个" disabled={results.length === 0} onClick={() => goToResult(currentIndex - 1)}>
            <ChevronUp size={15} />
          </button>
          <button className="tool-btn !h-8 !w-8" title="下一个" disabled={results.length === 0} onClick={() => goToResult(currentIndex + 1)}>
            <ChevronDown size={15} />
          </button>
        </div>

        <input
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
          placeholder="替换为"
          className="w-full rounded-md border border-surface-border px-2 py-1.5 text-sm outline-none focus:border-brand-400"
        />

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost text-xs" disabled={results.length === 0} onClick={replaceCurrent}>
            <Replace size={14} />替换
          </button>
          <button className="btn-primary text-xs" disabled={results.length === 0} onClick={replaceAll}>
            全部替换
          </button>
        </div>
      </div>
    </div>
  )
}
