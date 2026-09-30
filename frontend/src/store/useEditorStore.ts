import { create } from 'zustand'
import type { SaveStatus, ZoomState, CanvasPosition, ToolType } from '@/types'

interface EditorState {
  selectedShapeIds: string[]
  setSelectedShapeIds: (ids: string[]) => void
  zoom: ZoomState
  setZoomLevel: (level: number) => void
  cursorPosition: CanvasPosition
  setCursorPosition: (pos: CanvasPosition) => void
  saveStatus: SaveStatus
  setSaveStatus: (status: SaveStatus) => void
  canvasBackground: string
  setCanvasBackground: (color: string) => void
  leftPanelCollapsed: boolean
  toggleLeftPanel: () => void
  rightPanelCollapsed: boolean
  toggleRightPanel: () => void
  documentTitle: string
  setDocumentTitle: (title: string) => void
  activeTool: ToolType
  setActiveTool: (tool: ToolType) => void
  theme: 'light' | 'dark'
  toggleTheme: () => void
}

const THEME_KEY = 'flowboard.theme.v1'
function loadTheme(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export const useEditorStore = create<EditorState>((set) => ({
  selectedShapeIds: [],
  setSelectedShapeIds: (ids) => set({ selectedShapeIds: ids }),
  zoom: { level: 1, min: 0.1, max: 4 },
  setZoomLevel: (level) => set((state) => ({ zoom: { ...state.zoom, level: Math.round(level * 100) / 100 } })),
  cursorPosition: { x: 0, y: 0 },
  setCursorPosition: (pos) => set({ cursorPosition: pos }),
  saveStatus: 'saved',
  setSaveStatus: (status) => set({ saveStatus: status }),
  canvasBackground: '#f6f7f9',
  setCanvasBackground: (color) => set({ canvasBackground: color }),
  leftPanelCollapsed: false,
  toggleLeftPanel: () => set((state) => ({ leftPanelCollapsed: !state.leftPanelCollapsed })),
  rightPanelCollapsed: false,
  toggleRightPanel: () => set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed })),
  documentTitle: '未命名画布',
  setDocumentTitle: (title) => set({ documentTitle: title }),
  activeTool: 'select',
  setActiveTool: (tool) => set({ activeTool: tool }),
  theme: loadTheme(),
  toggleTheme: () => set((state) => {
    const next = state.theme === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(THEME_KEY, next) } catch { /* ignore */ }
    return { theme: next }
  }),
}))