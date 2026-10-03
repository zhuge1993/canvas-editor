import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useEditorStore } from '@/store/useEditorStore'
import { getDocument, saveDocument } from '@/utils/storage'
import { AuthRequestError, getSharedProject, saveSharedProject, type ProjectAccess } from '@/services/auth'
import { constrainCameraToWorkspace, createEmptyCanvasDocument, createShape, type ImageShape, type Shape } from '@/canvas/types'
import { logError, logOperation } from '@/utils/logger'
import { canvasDraftKey, parseCanvasDraft, writeCanvasDraft, clearSavedCanvasDraft } from '@/utils/canvasDraft'
import TopMenu from '@/components/editor/TopMenu'
import LeftToolbar from '@/components/editor/LeftToolbar'
import RightPanel from '@/components/editor/RightPanel'
import StatusBar from '@/components/editor/StatusBar'
import FindReplaceDialog from '@/components/editor/FindReplaceDialog'
import CanvasEngine from '@/canvas/CanvasEngine'
import CanvasErrorBoundary from '@/canvas/CanvasErrorBoundary'

export default function EditorPage() {
  const { docId: routeDocId, shareToken } = useParams<{ docId: string; shareToken: string }>()
  const navigate = useNavigate()
  const autoSaveTimer = useRef<number>(0)
  const savedContentRef = useRef('')
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null)
  const [project, setProject] = useState<ProjectAccess | null>(null)
  const [sharePassword, setSharePassword] = useState('')
  const [loadError, setLoadError] = useState('')
  const [showFindReplace, setShowFindReplace] = useState(false)

  const docId = shareToken ? project?.id : routeDocId
  const readOnly = Boolean(shareToken && project?.permission !== 'edit')
  const canEdit = Boolean(docId && (!shareToken || project?.permission === 'edit'))

  const shapes = useCanvasStore((s) => s.shapes)
  const order = useCanvasStore((s) => s.order)
  const groups = useCanvasStore((s) => s.groups)
  const workspace = useCanvasStore((s) => s.workspace)
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const activeTool = useCanvasStore((s) => s.activeTool)
  const camera = useCanvasStore((s) => s.camera)
  const setCamera = useCanvasStore((s) => s.setCamera)
  const setTool = useCanvasStore((s) => s.setTool)
  const addShape = useCanvasStore((s) => s.addShape)
  const addShapes = useCanvasStore((s) => s.addShapes)
  const loadDocument = useCanvasStore((s) => s.loadDocument)
  const getSnapshot = useCanvasStore((s) => s.getSnapshot)
  const setDocumentTitle = useEditorStore((s) => s.setDocumentTitle)
  const documentTitle = useEditorStore((s) => s.documentTitle)
  const setSaveStatus = useEditorStore((s) => s.setSaveStatus)
  const saveStatus = useEditorStore((s) => s.saveStatus)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 })
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const updateSize = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight })
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])
  const viewportWorldWidth = Math.max(1, viewportSize.width / camera.zoom)
  const viewportWorldHeight = Math.max(1, viewportSize.height / camera.zoom)
  const horizontalScrollMax = Math.max(0, workspace.w - viewportWorldWidth)
  const verticalScrollMax = Math.max(0, workspace.h - viewportWorldHeight)
  const scrollX = Math.min(
    horizontalScrollMax,
    Math.max(0, -camera.x / camera.zoom - workspace.x),
  )
  const scrollY = Math.min(
    verticalScrollMax,
    Math.max(0, -camera.y / camera.zoom - workspace.y),
  )
  function setHorizontalScroll(rawValue: string) {
    const value = Math.min(horizontalScrollMax, Math.max(0, Number(rawValue) || 0))
    setCamera(
      constrainCameraToWorkspace(
        { ...camera, x: -(workspace.x + value) * camera.zoom },
        workspace,
        viewportSize.width,
        viewportSize.height,
      ),
    )
  }

  function setVerticalScroll(rawValue: string) {
    const value = Math.min(verticalScrollMax, Math.max(0, Number(rawValue) || 0))
    setCamera(
      constrainCameraToWorkspace(
        { ...camera, y: -(workspace.y + value) * camera.zoom },
        workspace,
        viewportSize.width,
        viewportSize.height,
      ),
    )
  }


  useEffect(() => {
    const next = constrainCameraToWorkspace(camera, workspace, viewportSize.width, viewportSize.height)
    if (next.x !== camera.x || next.y !== camera.y || next.zoom !== camera.zoom) setCamera(next)
  }, [camera, setCamera, viewportSize.height, viewportSize.width, workspace])

  /** 加载项目，并在切换时隔离上一张画布的状态。 */
  useEffect(() => {
    let cancelled = false
    clearTimeout(autoSaveTimer.current)
    setLoadedDocId(null)
    setProject(null)
    setSharePassword('')
    setLoadError('')
    savedContentRef.current = ''
    setDocumentTitle('未命名画布')
    loadDocument(createEmptyCanvasDocument())
    setCamera({ x: 0, y: 0, zoom: 1 })
    setTool('select')

    const load = shareToken
      ? (async () => {
          let password = ''
          while (true) {
            try {
              const shared = await getSharedProject(shareToken, password || undefined)
              if (!cancelled) setSharePassword(password)
              return shared
            } catch (error) {
              if (!(error instanceof AuthRequestError) || error.status !== 401) throw error
              const entered = window.prompt(password ? '分享密码错误，请重新输入：' : '此分享链接需要密码：')
              if (entered === null) throw new Error('已取消输入分享密码')
              password = entered.trim()
              if (!password) continue
            }
          }
        })()
      : routeDocId ? getDocument(routeDocId) : Promise.resolve(undefined)

    void load.then((loaded) => {
      if (cancelled) return
      if (!loaded) {
        setLoadError('项目不存在或无访问权限')
        setSaveStatus('error')
        return
      }
      const document = loaded as ProjectAccess
      let content: unknown = createEmptyCanvasDocument()
      if (document.content) {
        try { content = JSON.parse(document.content) } catch (error) { logError('project.parse_failed', error, { docId: document.id }) }
      }
      // 本地草稿恢复：服务端保存失败时，若本地有更新的草稿则提示恢复
      const draftKey = canvasDraftKey(document.id)
      let draft: string | null = null
      try { draft = localStorage.getItem(draftKey) } catch { /* ignore */ }
      if (draft && routeDocId) {
        try {
          const draftDoc = parseCanvasDraft(draft)
          const serverSavedAt = document.updatedAt ?? 0
          if (draftDoc?.content && (draftDoc.updatedAt === undefined || draftDoc.updatedAt > serverSavedAt)) {
            const draftCanvas = JSON.parse(draftDoc.content)
            if (window.confirm('检测到本地有比服务器更新的草稿，是否恢复？（未保存的修改）')) {
              content = draftCanvas
              setLoadError('')
            } else {
              localStorage.removeItem(draftKey)
            }
          } else if (draftDoc) {
            localStorage.removeItem(draftKey)
          }
        } catch { /* 草稿损坏则忽略 */ }
      }
      setProject(document)
      setDocumentTitle(document.title)
      loadDocument(content)
      savedContentRef.current = JSON.stringify(content)
      setLoadedDocId(document.id)
      setSaveStatus('saved')
      logOperation('project.loaded', 'Loaded project', { docId: document.id, permission: document.permission ?? 'owner' })
    }).catch((error) => {
      if (!cancelled) {
        setLoadError(error instanceof Error ? error.message : '项目加载失败')
        setSaveStatus('error')
        logError('project.load_failed', error, { docId: routeDocId, shareToken })
      }
    })

    return () => { cancelled = true }
  }, [loadDocument, routeDocId, setCamera, setDocumentTitle, setSaveStatus, setTool, shareToken])

  const saveCurrentDocument = useCallback(async () => {
    if (!docId || loadedDocId !== docId || !canEdit) return false
    const content = JSON.stringify(getSnapshot())
    setSaveStatus('saving')
    try {
      const payload = {
        id: docId,
        title: documentTitle.trim() || '未命名画布',
        content,
        createdAt: project?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }
      if (shareToken) await saveSharedProject(shareToken, payload, sharePassword || undefined)
      else await saveDocument(payload)
      setProject(current => current ? { ...current, title: payload.title, content, updatedAt: payload.updatedAt } : current)
      savedContentRef.current = content
      try { clearSavedCanvasDraft(localStorage, docId, content) } catch { /* Save is durable even when browser storage is unavailable. */ }
      setSaveStatus(JSON.stringify(getSnapshot()) === content ? 'saved' : 'unsaved')
      logOperation('project.saved', 'Saved project', { docId, shared: Boolean(shareToken) })
      return true
    } catch (error) {
      setSaveStatus('error')
      const message = error instanceof Error ? error.message : String(error)
      // 明确提示保存失败原因（图片过大/网络中断等）
      if (message.includes('413') || message.includes('25 MiB')) {
        setLoadError('保存失败：文档体积过大（含大图或过多元素），请尝试缩小图片后再保存')
      } else if (message.includes('401') || message.includes('Login required')) {
        setLoadError('保存失败：登录已失效，请刷新页面重新登录')
      } else {
        setLoadError(`保存失败：${message}`)
      }
      logError('project.save_failed', error, { docId, shared: Boolean(shareToken) })
      return false
    }
  }, [canEdit, docId, documentTitle, getSnapshot, loadedDocId, project?.createdAt, setSaveStatus, sharePassword, shareToken])

  const returnToProjectList = useCallback(async () => {
    clearTimeout(autoSaveTimer.current)
    if (canEdit && docId && loadedDocId === docId && !(await saveCurrentDocument())) return
    navigate(shareToken ? '/' : '/')
  }, [canEdit, docId, loadedDocId, navigate, saveCurrentDocument, shareToken])

  /** 自动保存 */
  useEffect(() => {
    if (!canEdit || !docId || loadedDocId !== docId) return
    const content = JSON.stringify(getSnapshot())
    if (content === savedContentRef.current) {
      setSaveStatus('saved')
      return
    }
    setSaveStatus('unsaved')
    clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = window.setTimeout(() => {
      // 保存前先写本地草稿（防服务端保存失败丢数据）
      try { writeCanvasDraft(localStorage, docId, content) } catch { /* Preserve existing drafts when storage is full. */ }
      void saveCurrentDocument()
    }, 500)
    return () => clearTimeout(autoSaveTimer.current)
  }, [canEdit, docId, documentTitle, getSnapshot, groups, loadedDocId, order, saveCurrentDocument, setSaveStatus, shapes])

  // 离开页面时提示未保存；刷新/关闭前再强存一次到 localStorage
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saveStatus !== 'unsaved') return
      event.preventDefault()
      // 尝试保存草稿
      try {
        const content = JSON.stringify(getSnapshot())
        if (docId) writeCanvasDraft(localStorage, docId, content)
      } catch { /* ignore */ }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [docId, getSnapshot, saveStatus])

  /** Ctrl+F */
  useEffect(() => {
    if (readOnly) return
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault()
        setShowFindReplace(value => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [readOnly])

  /** 思维导图快捷键 */
  useEffect(() => {
    if (readOnly) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' && event.key !== 'Enter') return
      const activeElement = document.activeElement as HTMLElement | null
      if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) return
      if (selectedIds.length !== 1) return
      const shape = shapes[selectedIds[0]!]
      if (!shape || event.key !== 'Tab') return
      event.preventDefault()
      event.stopPropagation()
      const child = createShape('rectangle', shape.x + shape.w + 60, shape.y + 20, 160, 48)
      child.text = '子节点'
      child.fill = '#dcfce7'
      addShape(child)
      useCanvasStore.getState().select([child.id])
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [addShape, readOnly, selectedIds, shapes])

  /** 拖放图形库 */
  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    if (readOnly) return
    // 图片文件拖放：直接插入（复用粘贴的图片压缩逻辑）
    const imageFile = Array.from(event.dataTransfer.files).find((f) => f.type.startsWith('image/'))
    if (imageFile) {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const world = {
        x: (event.clientX - rect.left - camera.x) / camera.zoom,
        y: (event.clientY - rect.top - camera.y) / camera.zoom,
      }
      void (async () => {
        const { prepareImageSrc } = await import('@/utils/image')
        const prepared = await prepareImageSrc(imageFile, undefined, shareToken, sharePassword || undefined)
        const shape = createShape('image', world.x - prepared.width / 2, world.y - prepared.height / 2, prepared.width, prepared.height) as ImageShape
        shape.src = prepared.src
        shape.aspectRatio = prepared.width / Math.max(1, prepared.height)
        shape.name = imageFile.name || '拖入图片'
        addShape(shape)
        useCanvasStore.getState().select([shape.id])
        logOperation('image.dropped', 'Dropped image file', { id: shape.id, size: imageFile.size, external: prepared.external })
      })()
      return
    }
    const libraryData = event.dataTransfer.getData('application/flowboard-shape')
    const templateData = event.dataTransfer.getData('application/flowboard-shape-template-insert')
    if (!libraryData && !templateData) return
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const world = {
      x: (event.clientX - rect.left - camera.x) / camera.zoom,
      y: (event.clientY - rect.top - camera.y) / camera.zoom,
    }
    try {
      let shape: Shape
      if (templateData) {
        const source = JSON.parse(templateData) as Shape
        shape = {
          ...structuredClone(source),
          id: createShape(source.type, 0, 0).id,
          x: world.x - source.w / 2,
          y: world.y - source.h / 2,
          groupId: undefined,
        }
      } else {
        const item = JSON.parse(libraryData) as {
          name: string
          type: Shape['type']
          w: number
          h: number
          text?: string
          style?: Partial<Shape>
        }
        const created = createShape(item.type, world.x - item.w / 2, world.y - item.h / 2, item.w, item.h)
        shape = {
          ...created,
          ...structuredClone(item.style ?? {}),
          id: created.id,
          type: item.type,
          x: world.x - item.w / 2,
          y: world.y - item.h / 2,
          w: item.w,
          h: item.h,
          name: item.name,
        }
        if (item.text !== undefined) shape.text = item.text
      }
      addShape(shape)
      useCanvasStore.getState().select([shape.id])
      logOperation('library.inserted', 'Inserted library component', { type: shape.type, name: shape.name, method: 'drag' })
    } catch (error) {
      logError('library.drop_failed', error)
    }
  }

  /** 表格工具 */
  useEffect(() => {
    if (readOnly || activeTool !== 'table') return
    const allShapes = Object.values(shapes)
    const cx =
      allShapes.length > 0
        ? (Math.min(...allShapes.map((shape) => shape.x)) +
            Math.max(...allShapes.map((shape) => shape.x + shape.w))) /
          2
        : 200
    const cy =
      allShapes.length > 0
        ? (Math.min(...allShapes.map((shape) => shape.y)) +
            Math.max(...allShapes.map((shape) => shape.y + shape.h))) /
          2
        : 200
    const rows = 3
    const cols = 3
    const cellW = 80
    const cellH = 32
    const startX = cx - (cols * cellW) / 2
    const startY = cy - (rows * cellH) / 2
    const cells: Shape[] = []

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < cols; column++) {
        const shape = createShape(
          'rectangle',
          startX + column * cellW,
          startY + row * cellH,
          cellW,
          cellH,
        )
        shape.text = row === 0 ? `列 ${column + 1}` : `单元格 ${row},${column + 1}`
        shape.fill = row === 0 ? '#eff6ff' : '#ffffff'
        shape.stroke = '#cbd5e1'
        shape.strokeWidth = 1
        shape.cornerRadius = 0
        cells.push(shape)
      }
    }
    addShapes(cells)
    useCanvasStore.getState().select(cells.map((cell) => cell.id))
    setTool('select')
    logOperation('table.created', 'Created table', { rows, cols })
  }, [activeTool, addShapes, setTool, shapes])

  return (
    <div className="relative flex h-full flex-col">
      {loadError && <div className="absolute inset-x-0 top-0 z-30 border-b border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-700">{loadError}</div>}
      <TopMenu
        onSave={saveCurrentDocument}
        onBack={returnToProjectList}
        saveDisabled={!canEdit || !docId || loadedDocId !== docId}
        readOnly={readOnly}
        docId={docId}
        getContent={() => JSON.stringify(getSnapshot())}
        onRestoreVersion={() => {
          // 版本恢复后重新加载文档内容
          if (routeDocId) void getDocument(routeDocId).then((loaded) => {
            if (!loaded) return
            try {
              const content = JSON.parse(loaded.content || '{}')
              loadDocument(content)
              savedContentRef.current = loaded.content || ''
              setSaveStatus('saved')
            } catch (error) { logError('project.restore_failed', error, { docId: routeDocId }) }
          })
        }}
      />
      <div className="flex-1 flex overflow-hidden">
        {!readOnly && <LeftToolbar />}
        <div ref={viewportRef} className="relative flex-1 overflow-hidden" onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
          <CanvasErrorBoundary>
            <CanvasEngine readOnly={readOnly} assetShareToken={shareToken} assetSharePassword={sharePassword || undefined} />
          </CanvasErrorBoundary>
          <div className="canvas-scrollbar-shell pointer-events-auto absolute bottom-1 left-2 right-4 h-4 px-1">
            <input aria-label="画布水平滚动" type="range" min="0" max={horizontalScrollMax} step="any" value={scrollX} disabled={horizontalScrollMax <= 0} onChange={(event) => setHorizontalScroll(event.currentTarget.value)} className="canvas-scrollbar h-full w-full" />
          </div>
          <div className="canvas-scrollbar-shell pointer-events-auto absolute bottom-5 right-1 top-2 w-4 py-1">
            <input aria-label="画布垂直滚动" type="range" min="0" max={verticalScrollMax} step="any" value={scrollY} disabled={verticalScrollMax <= 0} onChange={(event) => setVerticalScroll(event.currentTarget.value)} className="canvas-scrollbar canvas-scrollbar-vertical h-full w-full" />
          </div>
          {showFindReplace && !readOnly && <FindReplaceDialog onClose={() => setShowFindReplace(false)} />}
        </div>
        {!readOnly && <RightPanel />}
      </div>
      <StatusBar />
    </div>
  )
}
