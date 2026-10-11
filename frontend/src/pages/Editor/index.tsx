import { useCallback, useEffect, useRef, useState } from 'react'
import { Star, RefreshCw } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useEditorStore } from '@/store/useEditorStore'
import { addCanvasFavorite, getCanvasFavorites, getDocument, getFavoriteCanvas, saveDocument, StorageRequestError } from '@/utils/storage'
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
  const { docId: routeDocId, shareToken, favoriteId } = useParams<{ docId: string; shareToken: string; favoriteId: string }>()
  const navigate = useNavigate()
  const autoSaveTimer = useRef<number>(0)
  const savedContentRef = useRef('')
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null)
  const loadedDocumentRef = useRef<string | null>(null)
  const [project, setProject] = useState<ProjectAccess | null>(null)
  const [sharePassword, setSharePassword] = useState('')
  const [loadError, setLoadError] = useState('')
  const [showFindReplace, setShowFindReplace] = useState(false)
  const [favoriteSaved, setFavoriteSaved] = useState<string | null>(null), [favoriteBusy, setFavoriteBusy] = useState(false), [favoriteError, setFavoriteError] = useState('')
  const [remoteUpdate, setRemoteUpdate] = useState<ProjectAccess | null>(null), [syncError, setSyncError] = useState('')
  const remoteUpdateRef = useRef<ProjectAccess | null>(null)
  const sourceVersionRef = useRef({ content: '', title: '', updatedAt: 0 })
  const projectRef = useRef<ProjectAccess | null>(null)
  projectRef.current = project
  const routeIdentityRef = useRef('')
  routeIdentityRef.current = favoriteId || shareToken || routeDocId || ''

  const sharedView = Boolean(shareToken || favoriteId)
  const docId = sharedView ? project?.id : routeDocId
  const readOnly = Boolean(favoriteId || shareToken && project?.permission !== 'edit')
  const canEdit = Boolean(!favoriteId && docId && (!shareToken || project?.permission === 'edit'))

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

  const invalidateSharedAccess = useCallback((message: string) => {
    clearTimeout(autoSaveTimer.current)
    loadedDocumentRef.current = null
    setLoadedDocId(null)
    projectRef.current = null
    setProject(null)
    setSharePassword('')
    setFavoriteSaved(null)
    setFavoriteBusy(false)
    setRemoteUpdate(null)
    remoteUpdateRef.current = null
    sourceVersionRef.current = { content: '', title: '', updatedAt: 0 }
    savedContentRef.current = ''
    setDocumentTitle('共享画布不可用')
    loadDocument(createEmptyCanvasDocument())
    setSyncError('')
    setLoadError(message)
    setSaveStatus('error')
  }, [loadDocument, setDocumentTitle, setSaveStatus])

  const applySharedDocument = useCallback((document: ProjectAccess) => {
    const content: unknown = document.content ? JSON.parse(document.content) : createEmptyCanvasDocument()
    clearTimeout(autoSaveTimer.current)
    loadDocument(content)
    savedContentRef.current = JSON.stringify(getSnapshot())
    sourceVersionRef.current = { content: document.content, title: document.title, updatedAt: document.updatedAt }
    setProject(document)
    setDocumentTitle(document.title)
    loadedDocumentRef.current = document.id
    setLoadedDocId(document.id)
    remoteUpdateRef.current = null
    setRemoteUpdate(null)
    setLoadError('')
    setSyncError('')
    setSaveStatus('saved')
  }, [getSnapshot, loadDocument, setDocumentTitle, setSaveStatus])

  async function addFavorite() {
    if (!shareToken || !project || loadedDocId !== project.id) return
    const identity = routeIdentityRef.current
    const documentId = loadedDocumentRef.current
    const isCurrent = () => routeIdentityRef.current === identity && loadedDocumentRef.current === documentId
    setFavoriteBusy(true); setFavoriteError('')
    try { const favorite = await addCanvasFavorite(shareToken, sharePassword || undefined); if (isCurrent()) setFavoriteSaved(favorite.id) }
    catch (cause) {
      if (!isCurrent()) return
      if (cause instanceof StorageRequestError && cause.status === 401) { navigate(`/auth?mode=login&next=${encodeURIComponent(`/share/${shareToken}`)}`); return }
      setFavoriteError(cause instanceof Error ? cause.message : '收藏失败，请稍后重试')
    } finally { if (isCurrent()) setFavoriteBusy(false) }
  }

  /** 加载项目，并在切换时隔离上一张画布的状态。 */
  useEffect(() => {
    let cancelled = false
    clearTimeout(autoSaveTimer.current)
    loadedDocumentRef.current = null
    setLoadedDocId(null)
    projectRef.current = null
    setProject(null)
    setSharePassword('')
    setFavoriteSaved(null)
    setFavoriteBusy(false)
    setFavoriteError('')
    setRemoteUpdate(null)
    remoteUpdateRef.current = null
    sourceVersionRef.current = { content: '', title: '', updatedAt: 0 }
    setSyncError('')
    setLoadError('')
    savedContentRef.current = ''
    setDocumentTitle('未命名画布')
    loadDocument(createEmptyCanvasDocument())
    setCamera({ x: 0, y: 0, zoom: 1 })
    setTool('select')

    const load = favoriteId ? getFavoriteCanvas(favoriteId) : shareToken
      ? (async () => {
          let password = ''
          while (true) {
            try {
              const shared = await getSharedProject(shareToken, password || undefined)
              if (!cancelled) setSharePassword(password)
              return shared
            } catch (error) {
              if (cancelled) return undefined
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
      let restoredDraft = false
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
              restoredDraft = true
              setLoadError('')
            } else {
              localStorage.removeItem(draftKey)
            }
          } else if (draftDoc) {
            localStorage.removeItem(draftKey)
          }
        } catch { /* 草稿损坏则忽略 */ }
      }
      sourceVersionRef.current = { content: document.content, title: document.title, updatedAt: document.updatedAt }
      setProject(document)
      setDocumentTitle(document.title)
      loadDocument(content)
      savedContentRef.current = restoredDraft ? '' : JSON.stringify(getSnapshot())
      loadedDocumentRef.current = document.id
      setLoadedDocId(document.id)
      setSaveStatus(restoredDraft ? 'unsaved' : 'saved')
      logOperation('project.loaded', 'Loaded project', { docId: document.id, permission: document.permission ?? 'owner' })
    }).catch((error) => {
      if (!cancelled) {
        setLoadError(error instanceof Error ? error.message : '项目加载失败')
        setSaveStatus('error')
        logError('project.load_failed', error, { docId: routeDocId, shareToken })
      }
    })

    return () => { cancelled = true }
  }, [favoriteId, getSnapshot, loadDocument, routeDocId, setCamera, setDocumentTitle, setSaveStatus, setTool, shareToken])

  useEffect(() => {
    if (!shareToken) return
    let cancelled = false
    void getCanvasFavorites().then(items => { if (!cancelled) setFavoriteSaved(items.find(item => item.shareId === shareToken && item.status === 'active')?.id ?? null) }).catch(() => { /* Guests can still view and choose to log in when they add a favorite. */ })
    return () => { cancelled = true }
  }, [shareToken])

  /** 只读引用读取原画布；可编辑共享仅提示，避免覆盖尚未保存的修改。 */
  useEffect(() => {
    if (!sharedView || !project?.id || loadedDocId !== project.id) return
    let cancelled = false, unavailable = false
    let timer = 0
    async function refresh() {
      const requestedVersion = sourceVersionRef.current
      try {
        const latest = favoriteId ? await getFavoriteCanvas(favoriteId) : await getSharedProject(shareToken!, sharePassword || undefined, AbortSignal.timeout(10000))
        if (cancelled) return
        const current = projectRef.current
        if (!current || latest.id !== current.id) { unavailable = true; invalidateSharedAccess('共享画布已不可用，请重新打开分享链接。'); return }
        const known = sourceVersionRef.current
        if (known !== requestedVersion) return
        setSyncError('')
        if (!remoteUpdateRef.current && latest.content === known.content && latest.title === known.title && latest.permission === current.permission) {
          sourceVersionRef.current = { ...known, updatedAt: latest.updatedAt }
          return
        }
        if (shareToken && (latest.permission === 'edit' || current.permission === 'edit' || remoteUpdateRef.current)) {
          clearTimeout(autoSaveTimer.current)
          remoteUpdateRef.current = latest
          setRemoteUpdate(latest)
          if (current.permission !== latest.permission) setProject(previous => previous ? { ...previous, permission: latest.permission } : previous)
          setSaveStatus('unsaved')
        } else {
          applySharedDocument(latest)
        }
      } catch (cause) {
        if (cancelled) return
        if ((cause instanceof AuthRequestError || cause instanceof StorageRequestError) && [401, 403, 404, 410].includes(cause.status)) {
          unavailable = true
          invalidateSharedAccess('共享访问已失效，原分享可能已撤销、过期或更改密码。请重新验证分享链接。')
        } else {
          setSyncError('暂时无法同步作者的新版本，正在重试。')
        }
      } finally {
        if (!cancelled && !unavailable) timer = window.setTimeout(() => void refresh(), 5000)
      }
    }
    timer = window.setTimeout(() => void refresh(), 5000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [applySharedDocument, favoriteId, invalidateSharedAccess, loadedDocId, project?.id, setSaveStatus, sharePassword, shareToken, sharedView])

  async function loadLatestSharedVersion() {
    if (!remoteUpdate || !shareToken || saveStatus === 'saving') return
    const changed = JSON.stringify(getSnapshot()) !== savedContentRef.current || documentTitle !== sourceVersionRef.current.title
    if (changed && !window.confirm('加载作者的最新版本会放弃你当前未保存的修改，是否继续？')) return
    const identity = routeIdentityRef.current
    const currentDocumentId = loadedDocumentRef.current
    try {
      const latest = await getSharedProject(shareToken, sharePassword || undefined)
      if (routeIdentityRef.current === identity && loadedDocumentRef.current === currentDocumentId) applySharedDocument(latest)
    } catch (cause) {
      if (routeIdentityRef.current !== identity || loadedDocumentRef.current !== currentDocumentId) return
      if (cause instanceof AuthRequestError && [401, 403, 404, 410].includes(cause.status)) invalidateSharedAccess('共享访问已失效，请重新验证分享链接。')
      else setSyncError('最新版本加载失败，你当前的修改仍保留。')
    }
  }

  const saveCurrentDocument = useCallback(async () => {
    const identity = shareToken || routeDocId || ''
    if (!docId || loadedDocumentRef.current !== docId || !canEdit || remoteUpdateRef.current || routeIdentityRef.current !== identity) return false
    const content = JSON.stringify(getSnapshot())
    const sourceVersion = { ...sourceVersionRef.current }
    setSaveStatus('saving')
    try {
      const payload = {
        id: docId,
        title: documentTitle.trim() || '未命名画布',
        content,
        createdAt: project?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }
      let savedAt = payload.updatedAt
      if (shareToken) {
        const saved = await saveSharedProject(shareToken, { ...payload, expectedUpdatedAt: sourceVersion.updatedAt }, sharePassword || undefined)
        savedAt = saved.updatedAt ?? savedAt
      } else await saveDocument(payload)
      if (routeIdentityRef.current !== identity || loadedDocumentRef.current !== docId) return true
      setProject(current => current ? { ...current, title: payload.title, content, updatedAt: savedAt } : current)
      savedContentRef.current = content
      sourceVersionRef.current = { content, title: payload.title, updatedAt: savedAt }
      try { clearSavedCanvasDraft(localStorage, docId, content) } catch { /* Save is durable even when browser storage is unavailable. */ }
      setSaveStatus(JSON.stringify(getSnapshot()) === content ? 'saved' : 'unsaved')
      logOperation('project.saved', 'Saved project', { docId, shared: Boolean(shareToken) })
      return true
    } catch (error) {
      if (routeIdentityRef.current !== identity || loadedDocumentRef.current !== docId) return false
      if (shareToken && error instanceof AuthRequestError && error.status === 409) {
        clearTimeout(autoSaveTimer.current)
        remoteUpdateRef.current = projectRef.current
        setSaveStatus('unsaved')
        setSyncError('原画布已有新版本，当前修改已保留，自动保存暂停。')
        try {
          const latest = await getSharedProject(shareToken, sharePassword || undefined, AbortSignal.timeout(10000))
          if (routeIdentityRef.current !== identity || loadedDocumentRef.current !== docId) return false
          remoteUpdateRef.current = latest
          setRemoteUpdate(latest)
          setSyncError('')
        } catch (cause) {
          if (routeIdentityRef.current !== identity || loadedDocumentRef.current !== docId) return false
          if (cause instanceof AuthRequestError && [401, 403, 404, 410].includes(cause.status)) invalidateSharedAccess('共享访问已失效，请重新验证分享链接。')
        }
        return false
      }
      if (shareToken && error instanceof AuthRequestError && [401, 403, 404, 410].includes(error.status)) { invalidateSharedAccess('共享访问已失效，请重新验证分享链接。'); return false }
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
  }, [canEdit, docId, documentTitle, getSnapshot, invalidateSharedAccess, project?.createdAt, routeDocId, setSaveStatus, sharePassword, shareToken])

  const returnToProjectList = useCallback(async () => {
    const identity = routeIdentityRef.current
    clearTimeout(autoSaveTimer.current)
    if (canEdit && docId && loadedDocId === docId && !(await saveCurrentDocument())) return
    if (routeIdentityRef.current !== identity) return
    navigate('/')
  }, [canEdit, docId, loadedDocId, navigate, saveCurrentDocument, shareToken])

  /** 自动保存 */
  useEffect(() => {
    if (!canEdit || !docId || loadedDocId !== docId || remoteUpdateRef.current) return
    const content = JSON.stringify(getSnapshot())
    if (content === savedContentRef.current && documentTitle === sourceVersionRef.current.title) {
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
  }, [remoteUpdate, canEdit, docId, documentTitle, getSnapshot, groups, loadedDocId, order, saveCurrentDocument, setSaveStatus, shapes])

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
      {loadError && <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-700">{loadError}{sharedView && !loadedDocId && <button className="ml-3 underline" onClick={() => window.location.reload()}>重新验证</button>}</div>}
      {sharedView && project && loadedDocId === project.id && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-800"><span>{favoriteId ? '收藏的共享画布 · 只读引用，作者保存后约 5 秒更新' : readOnly ? '共享画布 · 只读，作者保存后约 5 秒更新' : '共享画布 · 可编辑'}</span>{shareToken && <div className="flex items-center gap-3"><button className="inline-flex items-center gap-1 rounded border border-blue-200 bg-white px-3 py-1" disabled={favoriteBusy || Boolean(favoriteSaved)} onClick={() => void addFavorite()}><Star size={14} />{favoriteBusy ? '正在收藏…' : favoriteSaved ? '已加入我的画布' : '加入我的画布'}</button>{favoriteSaved && <button className="underline" onClick={() => navigate(`/favorite/${encodeURIComponent(favoriteSaved)}`)}>查看我的收藏</button>}</div>}</div>}
      {favoriteError && <div role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">{favoriteError}</div>}
      {syncError && <div role="status" className="bg-amber-50 px-4 py-2 text-sm text-amber-800">{syncError}</div>}
      {remoteUpdate && <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800"><span>作者已保存新版本。当前修改已保留，自动保存暂停。</span><button className="inline-flex items-center gap-1 rounded border border-amber-300 px-3 py-1" disabled={saveStatus === 'saving'} onClick={() => void loadLatestSharedVersion()}><RefreshCw size={14} />加载最新版本</button></div>}
      <TopMenu
        onSave={saveCurrentDocument}
        onBack={returnToProjectList}
        saveDisabled={!canEdit || !docId || loadedDocId !== docId || Boolean(remoteUpdate)}
        readOnly={readOnly}
        docId={docId}
        getContent={() => JSON.stringify(getSnapshot())}
        onRestoreVersion={() => {
          if (!routeDocId) return
          const identity = routeIdentityRef.current
          const currentDocumentId = loadedDocumentRef.current
          clearTimeout(autoSaveTimer.current)
          void getDocument(routeDocId).then((loaded) => {
            if (!loaded || routeIdentityRef.current !== identity || loadedDocumentRef.current !== currentDocumentId) return
            applySharedDocument({ ...loaded, content: loaded.content ?? '', permission: loaded.permission ?? 'owner' })
          }).catch(error => {
            if (routeIdentityRef.current !== identity || loadedDocumentRef.current !== currentDocumentId) return
            setLoadError('恢复后的版本读取失败，请重新加载画布。')
            logError('project.restore_failed', error, { docId: routeDocId })
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
