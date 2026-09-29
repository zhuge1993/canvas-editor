/** 编辑器全局状态类型 */

/** 当前选中的工具类型 */
export type ToolType =
  | 'select'
  | 'hand'
  | 'rectangle'
  | 'square'
  | 'circle'
  | 'ellipse'
  | 'diamond'
  | 'line'
  | 'arrow'
  | 'text'
  | 'draw'
  | 'note'
  | 'table'


/** 缩放信息 */
export interface ZoomState {
  level: number
  min: number
  max: number
}

/** 鼠标画布坐标 */
export interface CanvasPosition {
  x: number
  y: number
}

/** 保存状态 */
export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

/** 图形库分类 */
export type ShapeCategory = 'basic' | 'flowchart' | 'uml' | 'network'

/** 图形库条目 */
export interface ShapeLibraryItem {
  id: string
  name: string
  category: ShapeCategory
  keywords: string[]
  /** 自研画布图形类型标识 */
  shapeType: string
  icon: string
}

/** 文档元信息 */
export interface DocumentMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  thumbnail?: string
}

/** 对齐方式 */
export type AlignType = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

/** 分布方式 */
export type DistributeType = 'horizontal' | 'vertical'

/** 导出格式 */
export type ExportFormat = 'png' | 'jpg' | 'svg' | 'pdf' | 'fboard'

/** 导出配置 */
export interface ExportConfig {
  format: ExportFormat
  dpi: 72 | 150 | 300
  background: 'transparent' | 'white'
  range: 'all' | 'selection'
}
