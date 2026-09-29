/**
 * =============================================================
 * LeftToolbar —— 左侧面板(工具 + 常用组件 + 组件库 + 结构树)
 * =============================================================
 * 面板结构(自上而下):
 *   ① 绘图工具网格(TOOLS 数组: 选择/手型/矩形/正方形/圆形/椭圆/菱形/
 *      直线/箭头/文本/手绘/便签/表格, 快捷键见各项 label)
 *   ② 常用组件区(从画布把组件拖进来收藏; 点击插入画布中心;
 *      数据持久化 localStorage: flowboard.favorite-components.v1)
 *   ③ 组件库(SHAPE_LIBRARY 数据渲染, 点击插入 / 拖到画布)
 *   ④ 结构树(StructurePanel 组件, 见 StructurePanel/index.tsx)
 *   另: 右缘可拖拽改面板宽度, 组件库上方分隔条可拖拽改库高度
 *   (均持久化 localStorage, key 见下方常量区)
 *
 * ★★★ 组件库数据源: SHAPE_LIBRARY(本文件 TOOLS 数组下方)★★★
 * 这是手动增删改组件的唯一入口。结构 Record<分类名, LibraryItem[]>,
 * 当前 8 个分类: 按钮与导航 / 面板与弹窗 / HUD 与状态 / 表单与提示 / 基础图形 / 线条与装饰 / 绶带角标 / 箭头图标。
 * LibraryItem 字段说明:
 *   - id: 唯一标识(全库保持唯一, 建议 g- 前缀)
 *   - name: 显示名(也是插入后的默认组件名)
 *   - type: 图形类型, 必须是 @/canvas/types 里 ShapeType 已有的类型
 *          (新增类型需同步修改 canvas/types.ts 与 canvas/renderer.ts)
 *   - icon: 预留字段(图标名)
 *   - keywords: 搜索关键词数组
 *   - w / h: 插入后的默认宽高
 *   - text: 默认文字(可选)
 *   - style: 默认样式覆盖(fill / stroke / textColor / cornerRadius / fontWeight 等)
 * 增加组件 = 在对应分类数组里加一个对象; 增加分类 = 给 SHAPE_LIBRARY 加一个 key;
 * 删除组件 = 删掉对应对象; 修改组件 = 改它的 style / w / h / text 等字段。
 *
 * 区域划分(文件内搜 "====="):
 *   ① localStorage key 与读取函数
 *   ② TOOLS 绘图工具列表
 *   ③ SHAPE_LIBRARY 组件库数据(8 个分类)
 *   ④ ShapeThumbnail / GroupThumbnail 预览缩略图(canvas 绘制)
 *   ⑤ createLibraryShape 由库项创建 Shape
 *   ⑥ LeftToolbar 主组件(收藏收集 / 插入 / 缩放面板 / JSX)
 * =============================================================
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  GripVertical,
  Plus,
  Circle,
  Diamond,
  Hand,
  Minus,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  Pen,
  RectangleHorizontal,
  Square,
  StickyNote,
  Table2,
  Trash2,
  Type,
} from 'lucide-react'
import { collectShapeDescendants, createShape, genId, type Shape, type ShapeGroup, type ShapeType, type Tool } from '@/canvas/types'
import { render as renderCanvas } from '@/canvas/renderer'
import { cloneGroupTemplate, type GroupTemplate } from '@/utils/groupTemplate'
import { logOperation } from '@/utils/logger'
import StructurePanel from '@/components/editor/StructurePanel'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useEditorStore } from '@/store/useEditorStore'

interface ToolDefinition {
  type: Tool
  icon: typeof Square
  label: string
}

export interface LibraryItem {
  id: string
  name: string
  type: ShapeType
  icon: string
  keywords: string[]
  w: number
  h: number
  text?: string
  style?: Partial<Shape>
}

type FavoriteTemplate =
  | { id: string; kind: 'shape'; shape: Shape }
  | { id: string; kind: 'group'; group: GroupTemplate }
type FavoriteSource =
  | { kind: 'shape'; shape: Shape }
  | { kind: 'group'; group: GroupTemplate }



const FAVORITES_KEY = 'flowboard.favorite-components.v1'
const PANEL_WIDTH_KEY = 'flowboard.left-panel-width.v1'
const LIBRARY_ITEM_SIZE_KEY = 'flowboard.library-item-size.v1'
const DEFAULT_LIBRARY_ITEM_SIZE = 84
const MIN_LIBRARY_ITEM_SIZE = 52
const MAX_LIBRARY_ITEM_SIZE = 196
const LIBRARY_HEIGHT_KEY = 'flowboard.library-height.v1'
const DEFAULT_LIBRARY_HEIGHT = 220
const MIN_LIBRARY_HEIGHT = 96
const MAX_LIBRARY_HEIGHT = 640
const LIBRARY_ITEM_SIZE_STEP = 12
const FAVORITE_ITEM_SIZE_KEY = 'flowboard.favorite-item-size.v1'
const DEFAULT_FAVORITE_ITEM_SIZE = 84
const MIN_FAVORITE_ITEM_SIZE = 52
const MAX_FAVORITE_ITEM_SIZE = 196
const FAVORITE_ITEM_SIZE_STEP = 12
const DEFAULT_PANEL_WIDTH = 256
const MIN_PANEL_WIDTH = 220
const MAX_PANEL_WIDTH = 480

function loadPanelWidth() {
  const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(stored) && stored >= MIN_PANEL_WIDTH && stored <= MAX_PANEL_WIDTH
    ? stored
    : DEFAULT_PANEL_WIDTH
}

function loadLibraryHeight() {
  const stored = Number(localStorage.getItem(LIBRARY_HEIGHT_KEY))
  return Number.isFinite(stored) && stored >= MIN_LIBRARY_HEIGHT && stored <= MAX_LIBRARY_HEIGHT
    ? stored
    : DEFAULT_LIBRARY_HEIGHT
}

function loadLibraryItemSize() {
  const stored = Number(localStorage.getItem(LIBRARY_ITEM_SIZE_KEY))
  return Number.isFinite(stored) && stored >= MIN_LIBRARY_ITEM_SIZE && stored <= MAX_LIBRARY_ITEM_SIZE
    ? stored
    : DEFAULT_LIBRARY_ITEM_SIZE
}

function loadFavoriteItemSize() {
  const stored = Number(localStorage.getItem(FAVORITE_ITEM_SIZE_KEY))
  return Number.isFinite(stored) && stored >= MIN_FAVORITE_ITEM_SIZE && stored <= MAX_FAVORITE_ITEM_SIZE
    ? stored
    : DEFAULT_FAVORITE_ITEM_SIZE
}

function loadFavorites(): FavoriteTemplate[] {
  try {
    const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]') as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object' || !('id' in item)) return []
      if ('kind' in item && item.kind === 'group' && 'group' in item) return [item as FavoriteTemplate]
      if ('kind' in item && item.kind === 'shape' && 'shape' in item) return [item as FavoriteTemplate]
      if ('shape' in item) return [{ id: String(item.id), kind: 'shape' as const, shape: item.shape as Shape }]
      return []
    })
  } catch {
    return []
  }
}

/* ===== ② TOOLS 绘图工具列表(增删工具改这里, icon 来自 lucide-react) ===== */
const TOOLS: ToolDefinition[] = [
  { type: 'select', icon: MousePointer2, label: '选择 (V)' },
  { type: 'hand', icon: Hand, label: '手型 (H)' },
  { type: 'rectangle', icon: RectangleHorizontal, label: '矩形 (R)' },
  { type: 'square', icon: Square, label: '正方形 (S)' },
  { type: 'circle', icon: Circle, label: '圆形 (C)' },
  { type: 'ellipse', icon: Circle, label: '椭圆 (O)' },
  { type: 'diamond', icon: Diamond, label: '菱形 (D)' },
  { type: 'line', icon: Minus, label: '直线 (L)' },
  { type: 'arrow', icon: ArrowUpRight, label: '关联箭头 (A)' },
  { type: 'text', icon: Type, label: '文本 (T)' },
  { type: 'draw', icon: Pen, label: '手绘 (P)' },
  { type: 'note', icon: StickyNote, label: '便签 (N)' },
  { type: 'table', icon: Table2, label: '表格' },
]

/* ===== ③ SHAPE_LIBRARY ★组件库数据源★ 手动增删改组件唯一入口, 字段说明见文件头 ===== */
/*
 * ★ 组件库 增删改查 速查 ★
 * 增加组件: 复制下面任意一个 { ... } 条目, 粘到对应分类数组里, 修改 id(必须全库唯一) / name / w / h / text / style
 * 删除组件: 删掉整个 { ... } 对象(连同结尾的逗号一起删)
 * 修改组件: 直接改字段值, 每个字段的含义见该行的行尾注释
 * 新增分类: 在 SHAPE_LIBRARY 里加一行 `新分类名: [ ...组件条目 ],`
 * 注意: type 只能是 canvas/types.ts ShapeType 里已有的类型; 改完在 frontend 目录跑 `npx tsc -b` 验证
 */
const SHAPE_LIBRARY: Record<string, LibraryItem[]> = {                                        // ★组件库数据★ 结构: Record<分类名, 组件条目[]>
  // ── 分类: 按钮与导航 ──
  按钮与导航: [                                                                                    // ── 分类: 按钮与导航(在下方数组里增删改组件) ──
    {                                                                                         // ── 组件: 主按钮 ──
      id: 'g-button-primary',                                                                 // 唯一标识(全库不能重复,增改组件必改)
      name: '主按钮',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'button',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'button',                                                                         // 预留图标字段(当前未使用)
      keywords: ['按钮', '开始', '主操作'],                                                          // 搜索关键词数组(用于组件检索)
      w: 160,                                                                                 // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      text: '开始游戏',                                                                           // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#2563eb',                                                                      // 填充颜色('none'=不填充)
        stroke: '#1d4ed8',                                                                    // 边框颜色
        textColor: '#ffffff',                                                                 // 文字颜色
        fontWeight: 'bold',                                                                   // 字重(bold=粗体 / normal=常规)
        cornerRadius: 8,                                                                      // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 主按钮 ──
    {                                                                                         // ── 组件: 次按钮 ──
      id: 'g-button-secondary',                                                               // 唯一标识(全库不能重复,增改组件必改)
      name: '次按钮',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'button',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'button',                                                                         // 预留图标字段(当前未使用)
      keywords: ['按钮', '取消', '次要'],                                                           // 搜索关键词数组(用于组件检索)
      w: 140,                                                                                 // 默认宽度(px)
      h: 42,                                                                                  // 默认高度(px)
      text: '取消',                                                                             // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#ffffff',                                                                      // 填充颜色('none'=不填充)
        stroke: '#64748b',                                                                    // 边框颜色
        textColor: '#334155',                                                                 // 文字颜色
        fontWeight: 'normal',                                                                 // 字重(bold=粗体 / normal=常规)
        cornerRadius: 6,                                                                      // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 次按钮 ──
    {                                                                                         // ── 组件: 危险按钮 ──
      id: 'g-button-danger',                                                                  // 唯一标识(全库不能重复,增改组件必改)
      name: '危险按钮',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'button',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'button',                                                                         // 预留图标字段(当前未使用)
      keywords: ['删除', '危险'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 140,                                                                                 // 默认宽度(px)
      h: 42,                                                                                  // 默认高度(px)
      text: '删除',                                                                             // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#dc2626',                                                                      // 填充颜色('none'=不填充)
        stroke: '#b91c1c',                                                                    // 边框颜色
        textColor: '#ffffff',                                                                 // 文字颜色
        fontWeight: 'bold',                                                                   // 字重(bold=粗体 / normal=常规)
        cornerRadius: 6,                                                                      // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 危险按钮 ──
    {                                                                                         // ── 组件: 普通标签 ──
      id: 'g-tab',                                                                            // 唯一标识(全库不能重复,增改组件必改)
      name: '普通标签',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'button',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'button',                                                                         // 预留图标字段(当前未使用)
      keywords: ['标签', 'tab', '导航'],                                                          // 搜索关键词数组(用于组件检索)
      w: 112,                                                                                 // 默认宽度(px)
      h: 36,                                                                                  // 默认高度(px)
      text: '其他页面',                                                                           // 默认文字内容(无此行的组件不带文字)
      style: { fill: '#e2e8f0', stroke: '#cbd5e1', textColor: '#475569', cornerRadius: 4 },   // 字段
    },                                                                                        // ── 组件结束: 普通标签 ──
    {                                                                                         // ── 组件: 徽章 ──
      id: 'g-badge',                                                                          // 唯一标识(全库不能重复,增改组件必改)
      name: '徽章',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'button',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'button',                                                                         // 预留图标字段(当前未使用)
      keywords: ['徽章', '状态', '标签'],                                                           // 搜索关键词数组(用于组件检索)
      w: 76,                                                                                  // 默认宽度(px)
      h: 28,                                                                                  // 默认高度(px)
      text: '新消息',                                                                            // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#f97316',                                                                      // 填充颜色('none'=不填充)
        stroke: '#ea580c',                                                                    // 边框颜色
        textColor: '#ffffff',                                                                 // 文字颜色
        fontSize: 12,                                                                         // 字号
        cornerRadius: 14,                                                                     // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 徽章 ──
  ],                                                                                          // ── 分类结束: 按钮与导航 ──
  // ── 分类: 面板与弹窗 ──
  面板与弹窗: [                                                                                    // ── 分类: 面板与弹窗(在下方数组里增删改组件) ──
    {                                                                                         // ── 组件: 深色面板 ──
      id: 'g-panel-dark',                                                                     // 唯一标识(全库不能重复,增改组件必改)
      name: '深色面板',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'panel',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'panel',                                                                          // 预留图标字段(当前未使用)
      keywords: ['面板', '窗口', '游戏'],                                                           // 搜索关键词数组(用于组件检索)
      w: 320,                                                                                 // 默认宽度(px)
      h: 220,                                                                                 // 默认高度(px)
      text: '游戏菜单',                                                                           // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        stroke: '#374151',                                                                    // 边框颜色
        textColor: '#f9fafb',                                                                 // 文字颜色
        cornerRadius: 8,                                                                      // 圆角半径
        shadowBlur: 14,                                                                       // 阴影模糊半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 深色面板 ──
    {                                                                                         // ── 组件: 浅色面板 ──
      id: 'g-panel-light',                                                                    // 唯一标识(全库不能重复,增改组件必改)
      name: '浅色面板',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'panel',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'panel',                                                                          // 预留图标字段(当前未使用)
      keywords: ['面板', '窗口'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 300,                                                                                 // 默认宽度(px)
      h: 180,                                                                                 // 默认高度(px)
      text: '设置',                                                                             // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#ffffff',                                                                      // 填充颜色('none'=不填充)
        stroke: '#cbd5e1',                                                                    // 边框颜色
        textColor: '#1e293b',                                                                 // 文字颜色
        cornerRadius: 4,                                                                      // 圆角半径
        shadowBlur: 8,                                                                        // 阴影模糊半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 浅色面板 ──
    {                                                                                         // ── 组件: 角色气泡 ──
      id: 'g-dialog-left',                                                                    // 唯一标识(全库不能重复,增改组件必改)
      name: '角色气泡',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'dialog',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'dialog',                                                                         // 预留图标字段(当前未使用)
      keywords: ['对话', '气泡', '剧情'],                                                           // 搜索关键词数组(用于组件检索)
      w: 360,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      text: '角色对话内容',                                                                         // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#ffffff',                                                                      // 填充颜色('none'=不填充)
        stroke: '#475569',                                                                    // 边框颜色
        textColor: '#1e293b',                                                                 // 文字颜色
        dialogTailPosition: 'left',                                                           // 气泡尾角位置(left / center / right)
        dialogTailSize: 22,                                                                   // 气泡尾角大小
        cornerRadius: 10,                                                                     // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 角色气泡 ──
    {                                                                                         // ── 组件: 居中气泡 ──
      id: 'g-dialog-center',                                                                  // 唯一标识(全库不能重复,增改组件必改)
      name: '居中气泡',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'dialog',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'dialog',                                                                         // 预留图标字段(当前未使用)
      keywords: ['对话', '气泡'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 360,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      text: '提示内容',                                                                           // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#eff6ff',                                                                      // 填充颜色('none'=不填充)
        stroke: '#3b82f6',                                                                    // 边框颜色
        textColor: '#1e3a8a',                                                                 // 文字颜色
        dialogTailPosition: 'center',                                                         // 气泡尾角位置(left / center / right)
        dialogTailSize: 18,                                                                   // 气泡尾角大小
        cornerRadius: 8,                                                                      // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 居中气泡 ──
    {                                                                                         // ── 组件: 提示气泡 ──
      id: 'g-tooltip',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: '提示气泡',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'dialog',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'dialog',                                                                         // 预留图标字段(当前未使用)
      keywords: ['提示', 'tooltip', '说明'],                                                      // 搜索关键词数组(用于组件检索)
      w: 220,                                                                                 // 默认宽度(px)
      h: 76,                                                                                  // 默认高度(px)
      text: '悬浮提示',                                                                           // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#1e293b',                                                                      // 填充颜色('none'=不填充)
        stroke: '#0f172a',                                                                    // 边框颜色
        textColor: '#ffffff',                                                                 // 文字颜色
        fontSize: 13,                                                                         // 字号
        dialogTailPosition: 'right',                                                          // 气泡尾角位置(left / center / right)
        dialogTailSize: 14,                                                                   // 气泡尾角大小
        cornerRadius: 6,                                                                      // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 提示气泡 ──
    {                                                                                         // ── 组件: 蓝色便签 ──
      id: 'g-note-blue',                                                                      // 唯一标识(全库不能重复,增改组件必改)
      name: '蓝色便签',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'note',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'note',                                                                           // 预留图标字段(当前未使用)
      keywords: ['便签', '备注'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 160,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      text: '重要备注',                                                                           // 默认文字内容(无此行的组件不带文字)
      style: { fill: '#dbeafe', stroke: '#60a5fa', textColor: '#1e3a8a', cornerRadius: 2 },   // 字段
    },                                                                                        // ── 组件结束: 蓝色便签 ──
  ],                                                                                          // ── 分类结束: 面板与弹窗 ──
  // ── 分类: HUD 与状态 ──
  'HUD 与状态': [                                                                                // ── 分类: HUD 与状态(在下方数组里增删改组件) ──
    {                                                                                         // ── 组件: 生命条 ──
      id: 'g-health',                                                                         // 唯一标识(全库不能重复,增改组件必改)
      name: '生命条',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'healthbar',                                                                      // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'health',                                                                         // 预留图标字段(当前未使用)
      keywords: ['血条', '生命', 'hp'],                                                           // 搜索关键词数组(用于组件检索)
      w: 240,                                                                                 // 默认宽度(px)
      h: 28,                                                                                  // 默认高度(px)
      text: 'HP 80 / 100',                                                                    // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#fee2e2',                                                                      // 填充颜色('none'=不填充)
        stroke: '#ef4444',                                                                    // 边框颜色
        progressValue: 80,                                                                    // 进度条数值(0~100)
        progressColor: '#22c55e',                                                             // 进度条颜色
        progressStyle: 'solid',                                                               // 进度条样式(solid纯色 / striped条纹 / segmented分段)
        cornerRadius: 10,                                                                     // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 生命条 ──
    {                                                                                         // ── 组件: 魔法条 ──
      id: 'g-mana',                                                                           // 唯一标识(全库不能重复,增改组件必改)
      name: '魔法条',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'progress',                                                                       // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'progress',                                                                       // 预留图标字段(当前未使用)
      keywords: ['魔法', 'mana', '蓝条'],                                                         // 搜索关键词数组(用于组件检索)
      w: 240,                                                                                 // 默认宽度(px)
      h: 24,                                                                                  // 默认高度(px)
      text: 'MP 65 / 100',                                                                    // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#dbeafe',                                                                      // 填充颜色('none'=不填充)
        stroke: '#60a5fa',                                                                    // 边框颜色
        progressValue: 65,                                                                    // 进度条数值(0~100)
        progressColor: '#2563eb',                                                             // 进度条颜色
        progressStyle: 'solid',                                                               // 进度条样式(solid纯色 / striped条纹 / segmented分段)
        cornerRadius: 8,                                                                      // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 魔法条 ──
    {                                                                                         // ── 组件: 经验条 ──
      id: 'g-exp',                                                                            // 唯一标识(全库不能重复,增改组件必改)
      name: '经验条',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'progress',                                                                       // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'progress',                                                                       // 预留图标字段(当前未使用)
      keywords: ['经验', 'exp', '升级'],                                                          // 搜索关键词数组(用于组件检索)
      w: 280,                                                                                 // 默认宽度(px)
      h: 18,                                                                                  // 默认高度(px)
      text: '经验 42%',                                                                         // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#fef3c7',                                                                      // 填充颜色('none'=不填充)
        stroke: '#f59e0b',                                                                    // 边框颜色
        progressValue: 42,                                                                    // 进度条数值(0~100)
        progressColor: '#f59e0b',                                                             // 进度条颜色
        progressStyle: 'segmented',                                                           // 进度条样式(solid纯色 / striped条纹 / segmented分段)
        cornerRadius: 6,                                                                      // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 经验条 ──
    {                                                                                         // ── 组件: 加载进度 ──
      id: 'g-loading',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: '加载进度',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'progress',                                                                       // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'progress',                                                                       // 预留图标字段(当前未使用)
      keywords: ['加载', '进度'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 260,                                                                                 // 默认宽度(px)
      h: 20,                                                                                  // 默认高度(px)
      text: '正在加载 72%',                                                                       // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#e2e8f0',                                                                      // 填充颜色('none'=不填充)
        stroke: '#94a3b8',                                                                    // 边框颜色
        progressValue: 72,                                                                    // 进度条数值(0~100)
        progressColor: '#8b5cf6',                                                             // 进度条颜色
        progressStyle: 'striped',                                                             // 进度条样式(solid纯色 / striped条纹 / segmented分段)
        cornerRadius: 10,                                                                     // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 加载进度 ──
    {                                                                                         // ── 组件: 小地图 ──
      id: 'g-minimap',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: '小地图',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'minimap',                                                                        // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'minimap',                                                                        // 预留图标字段(当前未使用)
      keywords: ['地图', 'map'],                                                                // 搜索关键词数组(用于组件检索)
      w: 180,                                                                                 // 默认宽度(px)
      h: 180,                                                                                 // 默认高度(px)
      style: { cornerRadius: 4 },                                                             // 字段
    },                                                                                        // ── 组件结束: 小地图 ──
    {                                                                                         // ── 组件: 背包栏 ──
      id: 'g-slot',                                                                           // 唯一标识(全库不能重复,增改组件必改)
      name: '背包栏',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'inventory-slot',                                                                 // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'slot',                                                                           // 预留图标字段(当前未使用)
      keywords: ['背包', '物品', '格子'],                                                           // 搜索关键词数组(用于组件检索)
      w: 64,                                                                                  // 默认宽度(px)
      h: 64,                                                                                  // 默认高度(px)
      text: '1',                                                                              // 默认文字内容(无此行的组件不带文字)
      style: { fill: '#1f2937', stroke: '#9ca3af', textColor: '#ffffff', cornerRadius: 4 },   // 字段
    },                                                                                        // ── 组件结束: 背包栏 ──
    {                                                                                         // ── 组件: 货币显示 ──
      id: 'g-currency',                                                                       // 唯一标识(全库不能重复,增改组件必改)
      name: '货币显示',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'button',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'button',                                                                         // 预留图标字段(当前未使用)
      keywords: ['金币', '货币', '资源'],                                                           // 搜索关键词数组(用于组件检索)
      w: 150,                                                                                 // 默认宽度(px)
      h: 36,                                                                                  // 默认高度(px)
      text: '金币 9,999',                                                                       // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#fef3c7',                                                                      // 填充颜色('none'=不填充)
        stroke: '#f59e0b',                                                                    // 边框颜色
        textColor: '#92400e',                                                                 // 文字颜色
        fontWeight: 'bold',                                                                   // 字重(bold=粗体 / normal=常规)
        cornerRadius: 18,                                                                     // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 货币显示 ──
  ],                                                                                          // ── 分类结束: HUD 与状态 ──
  // ── 分类: 表单与提示 ──
  表单与提示: [                                                                                    // ── 分类: 表单与提示(在下方数组里增删改组件) ──
    {                                                                                         // ── 组件: 输入框 ──
      id: 'g-input',                                                                          // 唯一标识(全库不能重复,增改组件必改)
      name: '输入框',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'input',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'input',                                                                          // 预留图标字段(当前未使用)
      keywords: ['输入', '文本框', '表单'],                                                          // 搜索关键词数组(用于组件检索)
      w: 220,                                                                                 // 默认宽度(px)
      h: 44,                                                                                  // 默认高度(px)
      text: '请输入内容',                                                                          // 默认文字内容(无此行的组件不带文字)
    },                                                                                        // ── 组件结束: 输入框 ──
    {                                                                                         // ── 组件: 搜索框 ──
      id: 'g-search',                                                                         // 唯一标识(全库不能重复,增改组件必改)
      name: '搜索框',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'input',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'input',                                                                          // 预留图标字段(当前未使用)
      keywords: ['搜索', '输入'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 240,                                                                                 // 默认宽度(px)
      h: 40,                                                                                  // 默认高度(px)
      text: '搜索内容',                                                                           // 默认文字内容(无此行的组件不带文字)
      style: { fill: '#f8fafc', stroke: '#94a3b8', textColor: '#64748b', cornerRadius: 20 },  // 字段
    },                                                                                        // ── 组件结束: 搜索框 ──
    {                                                                                         // ── 组件: 复选框 ──
      id: 'g-checkbox',                                                                       // 唯一标识(全库不能重复,增改组件必改)
      name: '复选框',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'checkbox',                                                                       // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'checkbox',                                                                       // 预留图标字段(当前未使用)
      keywords: ['开关', '选项', '勾选'],                                                           // 搜索关键词数组(用于组件检索)
      w: 140,                                                                                 // 默认宽度(px)
      h: 32,                                                                                  // 默认高度(px)
      text: '启用设置',                                                                           // 默认文字内容(无此行的组件不带文字)
    },                                                                                        // ── 组件结束: 复选框 ──
    {                                                                                         // ── 组件: 设置滑块 ──
      id: 'g-slider',                                                                         // 唯一标识(全库不能重复,增改组件必改)
      name: '设置滑块',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'slider',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'slider',                                                                         // 预留图标字段(当前未使用)
      keywords: ['滑块', '音量', '设置'],                                                           // 搜索关键词数组(用于组件检索)
      w: 200,                                                                                 // 默认宽度(px)
      h: 28,                                                                                  // 默认高度(px)
      text: '50%',                                                                            // 默认文字内容(无此行的组件不带文字)
    },                                                                                        // ── 组件结束: 设置滑块 ──
    {                                                                                         // ── 组件: 确认提示 ──
      id: 'g-confirm',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: '确认提示',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'dialog',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'dialog',                                                                         // 预留图标字段(当前未使用)
      keywords: ['确认', '提示', '弹窗'],                                                           // 搜索关键词数组(用于组件检索)
      w: 300,                                                                                 // 默认宽度(px)
      h: 110,                                                                                 // 默认高度(px)
      text: '确定要继续吗？',                                                                        // 默认文字内容(无此行的组件不带文字)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#fff7ed',                                                                      // 填充颜色('none'=不填充)
        stroke: '#f97316',                                                                    // 边框颜色
        textColor: '#9a3412',                                                                 // 文字颜色
        dialogTailPosition: 'right',                                                          // 气泡尾角位置(left / center / right)
        dialogTailSize: 16,                                                                   // 气泡尾角大小
        cornerRadius: 8,                                                                      // 圆角半径
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 确认提示 ──
    {                                                                                         // ── 组件: 信息提示 ──
      id: 'g-info',                                                                           // 唯一标识(全库不能重复,增改组件必改)
      name: '信息提示',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'note',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'note',                                                                           // 预留图标字段(当前未使用)
      keywords: ['信息', '提示', '说明'],                                                           // 搜索关键词数组(用于组件检索)
      w: 240,                                                                                 // 默认宽度(px)
      h: 80,                                                                                  // 默认高度(px)
      text: '这是一条提示信息',                                                                       // 默认文字内容(无此行的组件不带文字)
      style: { fill: '#ecfeff', stroke: '#06b6d4', textColor: '#155e75', cornerRadius: 6 },   // 字段
    },                                                                                        // ── 组件结束: 信息提示 ──
  ],                                                                                          // ── 分类结束: 表单与提示 ──
  // ── 分类: 基础图形 ──
  基础图形: [                                                                                     // ── 分类: 基础图形(在下方数组里增删改组件) ──
    {                                                                                         // ── 组件: 矩形 ──
      id: 'b-rect',                                                                           // 唯一标识(全库不能重复,增改组件必改)
      name: '矩形',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'rectangle',                                                                      // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'rect',                                                                           // 预留图标字段(当前未使用)
      keywords: ['矩形'],                                                                       // 搜索关键词数组(用于组件检索)
      w: 120,                                                                                 // 默认宽度(px)
      h: 72,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 矩形 ──
    {                                                                                         // ── 组件: 圆形 ──
      id: 'b-circle',                                                                         // 唯一标识(全库不能重复,增改组件必改)
      name: '圆形',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'circle',                                                                         // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'circle',                                                                         // 预留图标字段(当前未使用)
      keywords: ['圆'],                                                                        // 搜索关键词数组(用于组件检索)
      w: 96,                                                                                  // 默认宽度(px)
      h: 96,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 圆形 ──
    {                                                                                         // ── 组件: 椭圆 ──
      id: 'b-ellipse',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: '椭圆',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'ellipse',                                                                        // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'ellipse',                                                                        // 预留图标字段(当前未使用)
      keywords: ['椭圆'],                                                                       // 搜索关键词数组(用于组件检索)
      w: 140,                                                                                 // 默认宽度(px)
      h: 84,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 椭圆 ──
    {                                                                                         // ── 组件: 菱形 ──
      id: 'b-diamond',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: '菱形',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'diamond',                                                                        // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'diamond',                                                                        // 预留图标字段(当前未使用)
      keywords: ['菱形'],                                                                       // 搜索关键词数组(用于组件检索)
      w: 110,                                                                                 // 默认宽度(px)
      h: 90,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 菱形 ──
    {                                                                                         // ── 组件: 三角形 ──
      id: 'b-triangle',                                                                       // 唯一标识(全库不能重复,增改组件必改)
      name: '三角形',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'triangle',                                                                       // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'triangle',                                                                       // 预留图标字段(当前未使用)
      keywords: ['三角'],                                                                       // 搜索关键词数组(用于组件检索)
      w: 110,                                                                                 // 默认宽度(px)
      h: 90,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 三角形 ──
    {                                                                                         // ── 组件: 五角星 ──
      id: 'b-star',                                                                           // 唯一标识(全库不能重复,增改组件必改)
      name: '五角星',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'star',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'star',                                                                           // 预留图标字段(当前未使用)
      keywords: ['星'],                                                                        // 搜索关键词数组(用于组件检索)
      w: 100,                                                                                 // 默认宽度(px)
      h: 100,                                                                                 // 默认高度(px)
    },                                                                                        // ── 组件结束: 五角星 ──
    {                                                                                         // ── 组件: 五边形 ──
      id: 'b-pentagon',                                                                       // 唯一标识(全库不能重复,增改组件必改)
      name: '五边形',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'pentagon',                                                                       // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'pentagon',                                                                       // 预留图标字段(当前未使用)
      keywords: ['五边形'],                                                                      // 搜索关键词数组(用于组件检索)
      w: 110,                                                                                 // 默认宽度(px)
      h: 100,                                                                                 // 默认高度(px)
    },                                                                                        // ── 组件结束: 五边形 ──
    {                                                                                         // ── 组件: 六边形 ──
      id: 'b-hexagon',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: '六边形',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'hexagon',                                                                        // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'hexagon',                                                                        // 预留图标字段(当前未使用)
      keywords: ['六边形'],                                                                      // 搜索关键词数组(用于组件检索)
      w: 130,                                                                                 // 默认宽度(px)
      h: 96,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 六边形 ──
    {                                                                                         // ── 组件: 平行四边形 ──
      id: 'b-parallelogram',                                                                  // 唯一标识(全库不能重复,增改组件必改)
      name: '平行四边形',                                                                          // 显示名(插入画布后的默认组件名)
      type: 'parallelogram',                                                                  // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'parallelogram',                                                                  // 预留图标字段(当前未使用)
      keywords: ['平行四边形'],                                                                    // 搜索关键词数组(用于组件检索)
      w: 140,                                                                                 // 默认宽度(px)
      h: 80,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 平行四边形 ──
    {                                                                                         // ── 组件: 梯形 ──
      id: 'b-trapezoid',                                                                      // 唯一标识(全库不能重复,增改组件必改)
      name: '梯形',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'trapezoid',                                                                      // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'trapezoid',                                                                      // 预留图标字段(当前未使用)
      keywords: ['梯形'],                                                                       // 搜索关键词数组(用于组件检索)
      w: 130,                                                                                 // 默认宽度(px)
      h: 80,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 梯形 ──
    {                                                                                         // ── 组件: 十字形 ──
      id: 'b-cross',                                                                          // 唯一标识(全库不能重复,增改组件必改)
      name: '十字形',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'cross',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'cross',                                                                          // 预留图标字段(当前未使用)
      keywords: ['十字', '加号'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 100,                                                                                 // 默认宽度(px)
      h: 100,                                                                                 // 默认高度(px)
    },                                                                                        // ── 组件结束: 十字形 ──
    {                                                                                         // ── 组件: 心形 ──
      id: 'b-heart',                                                                          // 唯一标识(全库不能重复,增改组件必改)
      name: '心形',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'heart',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'heart',                                                                          // 预留图标字段(当前未使用)
      keywords: ['心形'],                                                                       // 搜索关键词数组(用于组件检索)
      w: 110,                                                                                 // 默认宽度(px)
      h: 96,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 心形 ──
    {                                                                                         // ── 组件: 云形 ──
      id: 'b-cloud',                                                                          // 唯一标识(全库不能重复,增改组件必改)
      name: '云形',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'cloud',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'cloud',                                                                          // 预留图标字段(当前未使用)
      keywords: ['云', '气泡'],                                                                  // 搜索关键词数组(用于组件检索)
      w: 150,                                                                                 // 默认宽度(px)
      h: 90,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 云形 ──
    {                                                                                         // ── 组件: 块箭头 ──
      id: 'b-block-arrow',                                                                    // 唯一标识(全库不能重复,增改组件必改)
      name: '块箭头',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'block-arrow',                                                                    // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'block-arrow',                                                                    // 预留图标字段(当前未使用)
      keywords: ['块箭头', '方向'],                                                                // 搜索关键词数组(用于组件检索)
      w: 150,                                                                                 // 默认宽度(px)
      h: 80,                                                                                  // 默认高度(px)
    },                                                                                        // ── 组件结束: 块箭头 ──
    {                                                                                         // ── 组件: 便签 ──
      id: 'b-note',                                                                           // 唯一标识(全库不能重复,增改组件必改)
      name: '便签',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'note',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'note',                                                                           // 预留图标字段(当前未使用)
      keywords: ['便签'],                                                                       // 搜索关键词数组(用于组件检索)
      w: 160,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
    },                                                                                        // ── 组件结束: 便签 ──
  ],                                                                                          // ── 分类结束: 基础图形 ──
  // ── 分类: 线条与装饰 ──
  线条与装饰: [                                                                                    // ── 分类: 线条与装饰(在下方数组里增删改组件) ──
    {                                                                                         // ── 组件: 横线 ──
      id: 'g-line-solid',                                                                     // 唯一标识(全库不能重复,增改组件必改)
      name: '横线',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'line',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'line',                                                                           // 预留图标字段(当前未使用)
      keywords: ['线', '横线', '分割线'],                                                           // 搜索关键词数组(用于组件检索)
      w: 200,                                                                                 // 默认宽度(px)
      h: 10,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#334155',                                                                    // 边框/线条颜色
        strokeWidth: 2,                                                                       // 边框/线条宽度
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 横线 ──
    {                                                                                         // ── 组件: 粗分割线 ──
      id: 'g-line-thick',                                                                     // 唯一标识(全库不能重复,增改组件必改)
      name: '粗分割线',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'line',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'line',                                                                           // 预留图标字段(当前未使用)
      keywords: ['线', '粗线', '分割线'],                                                           // 搜索关键词数组(用于组件检索)
      w: 200,                                                                                 // 默认宽度(px)
      h: 10,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#0f172a',                                                                    // 边框/线条颜色
        strokeWidth: 6,                                                                       // 边框/线条宽度
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 粗分割线 ──
    {                                                                                         // ── 组件: 虚线 ──
      id: 'g-line-dashed',                                                                    // 唯一标识(全库不能重复,增改组件必改)
      name: '虚线',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'line',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'line',                                                                           // 预留图标字段(当前未使用)
      keywords: ['线', '虚线'],                                                                  // 搜索关键词数组(用于组件检索)
      w: 200,                                                                                 // 默认宽度(px)
      h: 10,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#64748b',                                                                    // 边框/线条颜色
        strokeWidth: 2,                                                                       // 边框/线条宽度
        lineStyle: 'dashed',                                                                  // 线型(solid实线 / dashed虚线 / dotted点线)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 虚线 ──
    {                                                                                         // ── 组件: 点线 ──
      id: 'g-line-dotted',                                                                    // 唯一标识(全库不能重复,增改组件必改)
      name: '点线',                                                                             // 显示名(插入画布后的默认组件名)
      type: 'line',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'line',                                                                           // 预留图标字段(当前未使用)
      keywords: ['线', '点线'],                                                                  // 搜索关键词数组(用于组件检索)
      w: 200,                                                                                 // 默认宽度(px)
      h: 10,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#64748b',                                                                    // 边框/线条颜色
        strokeWidth: 2,                                                                       // 边框/线条宽度
        lineStyle: 'dotted',                                                                  // 线型(solid实线 / dashed虚线 / dotted点线)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 点线 ──
    {                                                                                         // ── 组件: 双头箭头 ──
      id: 'g-arrow-double',                                                                   // 唯一标识(全库不能重复,增改组件必改)
      name: '双头箭头',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'arrow',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'arrow',                                                                          // 预留图标字段(当前未使用)
      keywords: ['箭头', '双头', '关联'],                                                           // 搜索关键词数组(用于组件检索)
      w: 200,                                                                                 // 默认宽度(px)
      h: 40,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#334155',                                                                    // 边框/线条颜色
        strokeWidth: 2,                                                                       // 边框/线条宽度
        startArrow: true,                                                                     // 起点箭头(true=显示)
        endArrow: true,                                                                       // 终点箭头(true=显示)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 双头箭头 ──
    {                                                                                         // ── 组件: 单头直线箭头 ──
      id: 'g-arrow-line',                                                                     // 唯一标识(全库不能重复,增改组件必改)
      name: '单头直线箭头',                                                                         // 显示名(插入画布后的默认组件名)
      type: 'arrow',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'arrow',                                                                          // 预留图标字段(当前未使用)
      keywords: ['箭头', '直线', '单头'],                                                           // 搜索关键词数组(用于组件检索)
      w: 200,                                                                                 // 默认宽度(px)
      h: 40,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#334155',                                                                    // 边框/线条颜色
        strokeWidth: 2,                                                                       // 边框/线条宽度
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 单头直线箭头 ──
    {                                                                                         // ── 组件: 直角折线箭头(横竖) ──
      id: 'g-arrow-elbow-hv',                                                                 // 唯一标识(全库不能重复,增改组件必改)
      name: '直角折线箭头(横竖)',                                                                     // 显示名(插入画布后的默认组件名)
      type: 'arrow',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'arrow',                                                                          // 预留图标字段(当前未使用)
      keywords: ['箭头', '折线', '直角', '拐弯'],                                                     // 搜索关键词数组(用于组件检索)
      w: 160,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#334155',                                                                    // 边框/线条颜色
        strokeWidth: 2,                                                                       // 边框/线条宽度
        points: [[0, 0], [160, 0], [160, 120]],                                               // 折线转折点([x,y]数组,相对组件左上角;仅 arrow 类型用)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 直角折线箭头(横竖) ──
    {                                                                                         // ── 组件: 直角折线箭头(竖横) ──
      id: 'g-arrow-elbow-vh',                                                                 // 唯一标识(全库不能重复,增改组件必改)
      name: '直角折线箭头(竖横)',                                                                     // 显示名(插入画布后的默认组件名)
      type: 'arrow',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'arrow',                                                                          // 预留图标字段(当前未使用)
      keywords: ['箭头', '折线', '直角', '拐弯'],                                                     // 搜索关键词数组(用于组件检索)
      w: 160,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#334155',                                                                    // 边框/线条颜色
        strokeWidth: 2,                                                                       // 边框/线条宽度
        points: [[0, 0], [0, 120], [160, 120]],                                               // 折线转折点([x,y]数组,相对组件左上角;仅 arrow 类型用)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 直角折线箭头(竖横) ──
    {                                                                                         // ── 组件: S形折线箭头 ──
      id: 'g-arrow-s',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: 'S形折线箭头',                                                                         // 显示名(插入画布后的默认组件名)
      type: 'arrow',                                                                          // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'arrow',                                                                          // 预留图标字段(当前未使用)
      keywords: ['箭头', '折线', 'S形'],                                                           // 搜索关键词数组(用于组件检索)
      w: 200,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        stroke: '#334155',                                                                    // 边框/线条颜色
        strokeWidth: 2,                                                                       // 边框/线条宽度
        points: [[0, 0], [100, 0], [100, 120], [200, 120]],                                   // 折线转折点([x,y]数组,相对组件左上角;仅 arrow 类型用)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: S形折线箭头 ──
  ],                                                                                          // ── 分类结束: 线条与装饰 ──
  // ── 分类: 绶带角标 ──
  绶带角标: [                                                                                     // ── 分类: 绶带角标(在下方数组里增删改组件) ──
    {                                                                                         // ── 组件: 伴侣绶带 ──
      id: 'g-ribbon-partner',                                                                 // 唯一标识(全库不能重复,增改组件必改)
      name: '伴侣绶带',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'rectangle',                                                                      // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'rectangle',                                                                      // 预留图标字段(当前未使用)
      keywords: ['绶带', '角标', '伴侣'],                                                           // 搜索关键词数组(用于组件检索)
      w: 120,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: 'none',                                                                         // 填充颜色('none'=不填充)
        stroke: 'none',                                                                       // 边框/线条颜色
        badgeType: 'ribbon',                                                                  // 角标类型(ribbon=绶带 / seal=圆章)
        badgeText: '伴侣',                                                                      // 角标文字内容
        badgeColor: '#8b1a1a',                                                                // 角标颜色
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 伴侣绶带 ──
    {                                                                                         // ── 组件: 稀有绶带 ──
      id: 'g-ribbon-rare',                                                                    // 唯一标识(全库不能重复,增改组件必改)
      name: '稀有绶带',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'rectangle',                                                                      // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'rectangle',                                                                      // 预留图标字段(当前未使用)
      keywords: ['绶带', '角标', '稀有'],                                                           // 搜索关键词数组(用于组件检索)
      w: 120,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: 'none',                                                                         // 填充颜色('none'=不填充)
        stroke: 'none',                                                                       // 边框/线条颜色
        badgeType: 'ribbon',                                                                  // 角标类型(ribbon=绶带 / seal=圆章)
        badgeText: '稀有',                                                                      // 角标文字内容
        badgeColor: '#5b21b6',                                                                // 角标颜色
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 稀有绶带 ──
    {                                                                                         // ── 组件: 充值圆章 ──
      id: 'g-seal-recharge',                                                                  // 唯一标识(全库不能重复,增改组件必改)
      name: '充值圆章',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'rectangle',                                                                      // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'rectangle',                                                                      // 预留图标字段(当前未使用)
      keywords: ['圆章', '角标', '充值', '徽章'],                                                     // 搜索关键词数组(用于组件检索)
      w: 120,                                                                                 // 默认宽度(px)
      h: 120,                                                                                 // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: 'none',                                                                         // 填充颜色('none'=不填充)
        stroke: 'none',                                                                       // 边框/线条颜色
        badgeType: 'seal',                                                                    // 角标类型(ribbon=绶带 / seal=圆章)
        badgeText: '充值',                                                                      // 角标文字内容
        badgeColor: '#d9a441',                                                                // 角标颜色
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 充值圆章 ──
  ],                                                                                          // ── 分类结束: 绶带角标 ──
  // ── 分类: 箭头图标 ──
  箭头图标: [                                                                                     // ── 分类: 箭头图标(在下方数组里增删改组件) ──
    {                                                                                         // ── 组件: 圆形播放 ──
      id: 'g-icon-play',                                                                      // 唯一标识(全库不能重复,增改组件必改)
      name: '圆形播放',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['播放', '按钮', '圆形'],                                                           // 搜索关键词数组(用于组件检索)
      w: 48,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'play-circle',                                                              // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 圆形播放 ──
    {                                                                                         // ── 组件: 实心箭头 ──
      id: 'g-icon-arrow',                                                                     // 唯一标识(全库不能重复,增改组件必改)
      name: '实心箭头',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['箭头', '实心'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 56,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'arrow-solid',                                                              // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 实心箭头 ──
    {                                                                                         // ── 组件: 左箭头 ──
      id: 'g-icon-left',                                                                      // 唯一标识(全库不能重复,增改组件必改)
      name: '左箭头',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['箭头', '左'],                                                                  // 搜索关键词数组(用于组件检索)
      w: 56,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'arrow-left',                                                               // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 左箭头 ──
    {                                                                                         // ── 组件: 下箭头 ──
      id: 'g-icon-down',                                                                      // 唯一标识(全库不能重复,增改组件必改)
      name: '下箭头',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['箭头', '下'],                                                                  // 搜索关键词数组(用于组件检索)
      w: 48,                                                                                  // 默认宽度(px)
      h: 56,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'arrow-down',                                                               // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 下箭头 ──
    {                                                                                         // ── 组件: 上箭头 ──
      id: 'g-icon-up',                                                                        // 唯一标识(全库不能重复,增改组件必改)
      name: '上箭头',                                                                            // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['箭头', '上'],                                                                  // 搜索关键词数组(用于组件检索)
      w: 48,                                                                                  // 默认宽度(px)
      h: 56,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'arrow-up',                                                                 // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 上箭头 ──
    {                                                                                         // ── 组件: 双V箭头 ──
      id: 'g-icon-chevron',                                                                   // 唯一标识(全库不能重复,增改组件必改)
      name: '双V箭头',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['箭头', '双V', '前进'],                                                           // 搜索关键词数组(用于组件检索)
      w: 56,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'chevron-double',                                                           // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 双V箭头 ──
    {                                                                                         // ── 组件: 弯曲箭头 ──
      id: 'g-icon-curved',                                                                    // 唯一标识(全库不能重复,增改组件必改)
      name: '弯曲箭头',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['箭头', '弯曲', '手绘'],                                                           // 搜索关键词数组(用于组件检索)
      w: 56,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'arrow-curved',                                                             // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 弯曲箭头 ──
    {                                                                                         // ── 组件: 循环箭头 ──
      id: 'g-icon-refresh',                                                                   // 唯一标识(全库不能重复,增改组件必改)
      name: '循环箭头',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['循环', '刷新', '重置'],                                                           // 搜索关键词数组(用于组件检索)
      w: 48,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'refresh',                                                                  // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 循环箭头 ──
    {                                                                                         // ── 组件: 四向箭头 ──
      id: 'g-icon-fourway',                                                                   // 唯一标识(全库不能重复,增改组件必改)
      name: '四向箭头',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['四向', '移动', '方向'],                                                           // 搜索关键词数组(用于组件检索)
      w: 48,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'four-way',                                                                 // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 四向箭头 ──
    {                                                                                         // ── 组件: 左右箭头 ──
      id: 'g-icon-leftright',                                                                 // 唯一标识(全库不能重复,增改组件必改)
      name: '左右箭头',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['左右', '切换'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 56,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'left-right',                                                               // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 左右箭头 ──
    {                                                                                         // ── 组件: 条纹箭头 ──
      id: 'g-icon-striped',                                                                   // 唯一标识(全库不能重复,增改组件必改)
      name: '条纹箭头',                                                                           // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['条纹', '箭头', '速度'],                                                           // 搜索关键词数组(用于组件检索)
      w: 56,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'striped-arrow',                                                            // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 条纹箭头 ──
    {                                                                                         // ── 组件: 双头实心箭头 ──
      id: 'g-icon-double',                                                                    // 唯一标识(全库不能重复,增改组件必改)
      name: '双头实心箭头',                                                                         // 显示名(插入画布后的默认组件名)
      type: 'icon',                                                                           // 图形类型(须为 canvas/types.ts ShapeType 已有值)
      icon: 'icon',                                                                           // 预留图标字段(当前未使用)
      keywords: ['双头', '箭头'],                                                                 // 搜索关键词数组(用于组件检索)
      w: 56,                                                                                  // 默认宽度(px)
      h: 48,                                                                                  // 默认高度(px)
      style: {                                                                                // 默认样式覆盖(内部字段逐行见注释; 不需要可整段删除)
        fill: '#111827',                                                                      // 填充颜色('none'=不填充)
        iconName: 'arrow-double',                                                             // 图标名称(canvas/renderer.ts ICON_NAMES 里的值)
      },                                                                                      // 默认样式结束
    },                                                                                        // ── 组件结束: 双头实心箭头 ──
  ],                                                                                          // ── 分类结束: 箭头图标 ──
}                                                                                             // ── SHAPE_LIBRARY 结束(共 8 个分类, 63 个组件) ──

/* ===== ④ 预览缩略图: ShapeThumbnail(单组件) / GroupThumbnail(分组), 用 renderer 画到小 canvas ===== */

function ShapeThumbnail({ shape, height = 40 }: { shape: Shape; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function draw() {
      if (!canvas) return
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const pixelRatio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(height * pixelRatio)
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      const padding = 5
      const zoom = Math.min(
        (width - padding * 2) / Math.max(1, shape.w),
        (height - padding * 2) / Math.max(1, shape.h),
      )
      const preview = { ...shape, x: 0, y: 0, groupId: undefined }
      renderCanvas(
        context,
        [preview],
        [],
        {
          x: (width - shape.w * zoom) / 2,
          y: (height - shape.h * zoom) / 2,
          zoom,
        },
        false,
        width,
        height,
      )
    }

    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()
    return () => observer.disconnect()
  }, [shape])

  return <canvas ref={canvasRef} className="w-full rounded-sm" style={{ height }} aria-hidden="true" />
}

function GroupThumbnail({ shapes, height = 40 }: { shapes: Shape[]; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function draw() {
      if (!canvas) return
      const width = Math.max(1, canvas.clientWidth)
      const innerHeight = Math.max(1, canvas.clientHeight)
      const pixelRatio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(innerHeight * pixelRatio)
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      if (shapes.length === 0) return
      const minX = Math.min(...shapes.map((shape) => shape.x))
      const minY = Math.min(...shapes.map((shape) => shape.y))
      const maxX = Math.max(...shapes.map((shape) => shape.x + shape.w))
      const maxY = Math.max(...shapes.map((shape) => shape.y + shape.h))
      const boundsW = Math.max(1, maxX - minX)
      const boundsH = Math.max(1, maxY - minY)
      const padding = 5
      const zoom = Math.min((width - padding * 2) / boundsW, (innerHeight - padding * 2) / boundsH)
      renderCanvas(
        context,
        shapes,
        [],
        {
          x: (width - boundsW * zoom) / 2 - minX * zoom,
          y: (innerHeight - boundsH * zoom) / 2 - minY * zoom,
          zoom,
        },
        false,
        width,
        innerHeight,
      )
    }

    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()
    return () => observer.disconnect()
  }, [shapes])

  return <canvas ref={canvasRef} className="w-full rounded-sm" style={{ height }} aria-hidden="true" />
}

/* ===== ⑤ createLibraryShape: 由库项创建 Shape 实例(应用 style / text / name) ===== */
/** 把拖入常用组件区的画布组件收集为分组模板: 完整覆盖的分组保留原结构, 零散组件包进一个新分组, 保证整组收藏不丢件。 */
function buildFavoriteGroupTemplate(draggedShapes: Shape[]): GroupTemplate | null {
  const { groups, shapes } = useCanvasStore.getState()
  const draggedIds = draggedShapes.map((shape) => shape.id).filter((id) => Boolean(shapes[id]))
  const draggedSet = new Set(draggedIds)
  if (draggedSet.size === 0) return null
  const relevantGroupIds = new Set<string>()
  for (const id of draggedSet) {
    let groupId = shapes[id]!.groupId
    while (groupId && groups[groupId]) {
      relevantGroupIds.add(groupId)
      groupId = groups[groupId]!.parentId
    }
  }
  const isFullyDragged = (groupId: string) => {
    const descendants = collectShapeDescendants(groupId, groups)
    return descendants.length > 0 && descendants.every((descendantId) => draggedSet.has(descendantId))
  }
  const rootGroupIds = [...relevantGroupIds].filter((groupId) => {
    if (!isFullyDragged(groupId)) return false
    const parentId = groups[groupId]!.parentId
    return !parentId || !relevantGroupIds.has(parentId) || !isFullyDragged(parentId)
  })
  if (rootGroupIds.length === 0 && draggedSet.size === 1) return null
  const templateGroups: ShapeGroup[] = []
  const templateShapes: Shape[] = []
  const seenGroups = new Set<string>()
  const seenShapes = new Set<string>()
  const visit = (groupId: string) => {
    if (seenGroups.has(groupId)) return
    const group = groups[groupId]
    if (!group) return
    seenGroups.add(groupId)
    templateGroups.push(structuredClone(group))
    for (const childId of group.childIds) {
      if (groups[childId]) visit(childId)
      else if (shapes[childId] && draggedSet.has(childId) && !seenShapes.has(childId)) {
        seenShapes.add(childId)
        templateShapes.push(structuredClone(shapes[childId]!))
      }
    }
  }
  for (const rootId of rootGroupIds) visit(rootId)
  const coveredIds = new Set(templateShapes.map((shape) => shape.id))
  const looseIds = draggedIds.filter((id) => !coveredIds.has(id))
  if (looseIds.length === 0) return { rootGroupIds, groups: templateGroups, shapes: templateShapes }
  const wrapperId = genId('g')
  templateGroups.push({ id: wrapperId, name: '分组', childIds: [...looseIds, ...rootGroupIds], collapsed: false, visible: true, locked: false })
  for (const rootId of rootGroupIds) {
    const index = templateGroups.findIndex((group) => group.id === rootId)
    if (index >= 0) templateGroups[index] = { ...templateGroups[index]!, parentId: wrapperId }
  }
  for (const id of looseIds) {
    const shape = shapes[id]
    if (shape) templateShapes.push({ ...structuredClone(shape), groupId: wrapperId })
  }
  return { rootGroupIds: [wrapperId], groups: templateGroups, shapes: templateShapes }
}

function createLibraryShape(item: LibraryItem, x: number, y: number): Shape {
  const created = createShape(item.type, x - item.w / 2, y - item.h / 2, item.w, item.h)
  const styled = { ...created, ...structuredClone(item.style ?? {}) } as Shape
  styled.id = created.id
  styled.type = item.type
  styled.x = x - item.w / 2
  styled.y = y - item.h / 2
  styled.w = item.w
  styled.h = item.h
  styled.name = item.name
  if (item.text !== undefined) styled.text = item.text
  return styled
}

/* ===== ⑥ LeftToolbar 主组件 ===== */
export default function LeftToolbar() {
  const favoriteZoneRef = useRef<HTMLDivElement>(null)
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setTool = useCanvasStore((state) => state.setTool)
  const addShape = useCanvasStore((state) => state.addShape)
  const insertGraph = useCanvasStore((state) => state.insertGraph)
  const select = useCanvasStore((state) => state.select)
  const camera = useCanvasStore((state) => state.camera)
  const collapsed = useEditorStore((state) => state.leftPanelCollapsed)
  const togglePanel = useEditorStore((state) => state.toggleLeftPanel)
  const [favorites, setFavorites] = useState<FavoriteTemplate[]>(loadFavorites)
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth)
  const [favoriteDropState, setFavoriteDropState] = useState<'idle' | 'over' | 'saved'>('idle')
  const [savedFavoriteName, setSavedFavoriteName] = useState('')
  const [libraryItemSize, setLibraryItemSize] = useState(loadLibraryItemSize)
  const [favoriteItemSize, setFavoriteItemSize] = useState(loadFavoriteItemSize)
  const [libraryHeight, setLibraryHeight] = useState(loadLibraryHeight)
  const [librarySearch, setLibrarySearch] = useState('')
  const libraryItems = useMemo(() => Object.values(SHAPE_LIBRARY).flat(), [])
  const filteredLibraryItems = useMemo(() => {
    const query = librarySearch.trim().toLowerCase()
    if (!query) return libraryItems
    return libraryItems.filter((item) =>
      item.name.toLowerCase().includes(query) || item.keywords.some((keyword) => keyword.toLowerCase().includes(query)),
    )
  }, [libraryItems, librarySearch])

  /* ===== 收藏收集: saveFavorite 存模板; 下方 useEffect 监听画布拖入事件 ===== */
  const saveFavorite = useCallback(
    (source: FavoriteSource) => {
      const template: FavoriteTemplate = source.kind === 'shape'
        ? {
            id: genId('favorite'),
            kind: 'shape',
            shape: { ...structuredClone(source.shape), groupId: undefined },
          }
        : { id: genId('favorite'), kind: 'group', group: structuredClone(source.group) }
      persistFavorites([...favorites, template])
      const name = template.kind === 'shape'
        ? template.shape.name
        : template.group.groups.find((group) => template.group.rootGroupIds.includes(group.id))?.name ?? '分组'
      setSavedFavoriteName(name)
      setFavoriteDropState('saved')
      window.setTimeout(() => setFavoriteDropState('idle'), 1200)
      logOperation('favorite.saved', 'Saved favorite component', {
        templateId: template.id,
        kind: template.kind,
      })
    },
    [favorites],
  )
  useEffect(() => {
    function isInsideZone(clientX: number, clientY: number) {
      const zone = favoriteZoneRef.current
      if (!zone) return false
      const rect = zone.getBoundingClientRect()
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    }
    function onCanvasDragMove(event: Event) {
      const detail = (event as CustomEvent<{ clientX: number; clientY: number }>).detail
      setFavoriteDropState(isInsideZone(detail.clientX, detail.clientY) ? 'over' : 'idle')
    }
    function onCanvasDragEnd(event: Event) {
      const detail = (event as CustomEvent<{ clientX: number; clientY: number; shapes: Shape[] }>).detail
      if (!isInsideZone(detail.clientX, detail.clientY) || detail.shapes.length === 0) {
        setFavoriteDropState('idle')
        return
      }
      // 拖入覆盖整个分组(含嵌套分组)时按分组模板收藏, 保留全部组件; 其余情况按单组件收藏。
      const groupTemplate = buildFavoriteGroupTemplate(detail.shapes)
      if (groupTemplate) saveFavorite({ kind: 'group', group: groupTemplate })
      else saveFavorite({ kind: 'shape', shape: detail.shapes[0]! })
      window.dispatchEvent(new CustomEvent('flowboard:canvas-drag-restore', { detail: { shapes: detail.shapes } }))
    }
    window.addEventListener('flowboard:canvas-drag-move', onCanvasDragMove)
    window.addEventListener('flowboard:canvas-drag-end', onCanvasDragEnd)
    return () => {
      window.removeEventListener('flowboard:canvas-drag-move', onCanvasDragMove)
      window.removeEventListener('flowboard:canvas-drag-end', onCanvasDragEnd)
    }
  }, [saveFavorite])

  function persistFavorites(next: FavoriteTemplate[]) {
    setFavorites(next)
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next))
  }

  function insertFavorite(template: FavoriteTemplate) {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (!canvas) return
    const centerX = (canvas.clientWidth / 2 - camera.x) / camera.zoom
    const centerY = (canvas.clientHeight / 2 - camera.y) / camera.zoom
    if (template.kind === 'group') {
      const clone = cloneGroupTemplate(template.group, centerX, centerY)
      insertGraph(clone.shapes, clone.groups, clone.rootGroupIds)
      logOperation('favorite.inserted', 'Inserted favorite group', { templateId: template.id })
      return
    }
    const source = structuredClone(template.shape)
    const shape = { ...source, id: genId(), x: centerX - source.w / 2, y: centerY - source.h / 2, groupId: undefined }
    addShape(shape)
    select([shape.id])
    logOperation('favorite.inserted', 'Inserted favorite component', { templateId: template.id, type: shape.type })
  }


  function readFavoriteDrop(event: React.DragEvent) {
    const custom = event.dataTransfer.getData('application/flowboard-shape-template')
    if (custom) return custom
    const plain = event.dataTransfer.getData('text/plain')
    return plain.startsWith('flowboard-template:') ? plain.slice('flowboard-template:'.length) : ''
  }

  function insertLibraryItem(item: LibraryItem) {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flowboard-canvas]')
    if (!canvas) return
    const centerX = (canvas.clientWidth / 2 - camera.x) / camera.zoom
    const centerY = (canvas.clientHeight / 2 - camera.y) / camera.zoom
    const shape = createLibraryShape(item, centerX, centerY)
    addShape(shape)
    select([shape.id])
    logOperation('library.inserted', 'Inserted library component', {
      itemId: item.id,
      type: item.type,
      method: 'click',
    })
  }

  function beginLibraryResize(event: React.PointerEvent) {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = libraryHeight
    let currentHeight = startHeight
    const maxHeight = Math.max(MIN_LIBRARY_HEIGHT + 40, Math.round(window.innerHeight * 0.7))

    function resize(moveEvent: PointerEvent) {
      currentHeight = Math.min(maxHeight, Math.max(MIN_LIBRARY_HEIGHT, startHeight + moveEvent.clientY - startY))
      setLibraryHeight(currentHeight)
    }

    function finish() {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finish)
      localStorage.setItem(LIBRARY_HEIGHT_KEY, String(currentHeight))
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finish)
  }

  function beginResize(event: React.PointerEvent) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panelWidth
    let currentWidth = startWidth

    function resize(moveEvent: PointerEvent) {
      currentWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidth + moveEvent.clientX - startX))
      setPanelWidth(currentWidth)
    }

    function finish() {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finish)
      localStorage.setItem(PANEL_WIDTH_KEY, String(currentWidth))
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finish)
  }

  function resizeLibraryItems(direction: -1 | 1) {
    const next = Math.min(
      MAX_LIBRARY_ITEM_SIZE,
      Math.max(MIN_LIBRARY_ITEM_SIZE, libraryItemSize + direction * LIBRARY_ITEM_SIZE_STEP),
    )
    setLibraryItemSize(next)
    localStorage.setItem(LIBRARY_ITEM_SIZE_KEY, String(next))
  }

  function resizeFavoriteItems(direction: -1 | 1) {
    const next = Math.min(
      MAX_FAVORITE_ITEM_SIZE,
      Math.max(MIN_FAVORITE_ITEM_SIZE, favoriteItemSize + direction * FAVORITE_ITEM_SIZE_STEP),
    )
    setFavoriteItemSize(next)
    localStorage.setItem(FAVORITE_ITEM_SIZE_KEY, String(next))
  }

  /* ===== 折叠态: 面板收起时只显示一个展开按钮 ===== */
  if (collapsed) {
    return (
      <div className="flex h-full w-10 shrink-0 flex-col items-center border-r border-surface-border bg-surface py-2">
        <button className="tool-btn" onClick={togglePanel} title="展开">
          <PanelLeftOpen size={16} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-surface-border bg-surface select-none"
      style={{ width: panelWidth }}
    >
      <div className="flex items-center justify-between border-b border-surface-border px-3 py-2">
        <span className="text-xs font-medium uppercase text-ink-muted">工具</span>
        <button className="tool-btn !h-6 !w-6" onClick={togglePanel} title="折叠">
          <PanelLeftClose size={14} />
        </button>
      </div>
      <div
        className="grid gap-1 border-b border-surface-border p-2"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(32px, 1fr))' }}
      >
        {TOOLS.map(({ type, icon: Icon, label }) => (
          <button
            key={type}
            className={`tool-btn !h-8 !w-full ${activeTool === type ? 'active' : ''}`}
            title={label}
            onClick={() => setTool(type)}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>

      {/* ===== ② 常用组件区: 拖入收藏 / 点击插入 / 右键删除 ===== */}
      <div
        ref={favoriteZoneRef}
        data-flowboard-favorite-zone=""
        className={`border-b px-2 py-1.5 transition-colors duration-150 ${favoriteDropState === 'over' ? 'border-brand-400 bg-brand-50' : favoriteDropState === 'saved' ? 'border-green-400 bg-green-50' : 'border-surface-border'}`}
        onDragEnter={(event) => {
          event.preventDefault()
          setFavoriteDropState('over')
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setFavoriteDropState('over')
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setFavoriteDropState('idle')
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const groupPayload = event.dataTransfer.getData('application/flowboard-group-template')
          const shapePayload = readFavoriteDrop(event)
          try {
            if (groupPayload) saveFavorite({ kind: 'group', group: JSON.parse(groupPayload) as GroupTemplate })
            else if (shapePayload) saveFavorite({ kind: 'shape', shape: JSON.parse(shapePayload) as Shape })
            else setFavoriteDropState('idle')
          } catch {
            setFavoriteDropState('idle')
          }
        }}
      >
        <div className="mb-1 flex items-center gap-1">
          <span className="min-w-0 flex-1 text-[11px] font-medium text-ink-muted">常用组件</span>
          <button
            type="button"
            className="tool-btn !h-7 !w-7 shrink-0"
            title="缩小常用组件"
            disabled={favoriteItemSize <= MIN_FAVORITE_ITEM_SIZE}
            onClick={() => resizeFavoriteItems(-1)}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="tool-btn !h-7 !w-7 shrink-0"
            title="放大常用组件"
            disabled={favoriteItemSize >= MAX_FAVORITE_ITEM_SIZE}
            onClick={() => resizeFavoriteItems(1)}
          >
            <Plus size={14} />
          </button>
          <span
            className={`text-[10px] ${favoriteDropState === 'over' ? 'font-medium text-brand-600' : favoriteDropState === 'saved' ? 'font-medium text-green-700' : 'text-ink-muted'}`}
          >
            {favoriteDropState === 'over'
              ? '松开保存'
              : favoriteDropState === 'saved'
                ? `已保存 ${savedFavoriteName}`
                : '从画布拖入收藏'}
          </span>
        </div>
        {favorites.length === 0 ? (
          <div
            className={`rounded border border-dashed px-2 py-2 text-center text-[10px] transition-transform duration-150 ${favoriteDropState === 'over' ? 'scale-[1.02] border-brand-400 text-brand-600' : 'border-surface-border text-ink-muted'}`}
          >
            拖入已调整好的组件
          </div>
        ) : (
          <div
            className="grid gap-1 overflow-y-auto"
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${favoriteItemSize}px, 1fr))`,
              maxHeight: Math.max(112, Math.round(favoriteItemSize * 1.6)),
            }}
          >
            {favorites.map((template) => {
              const label = template.kind === 'shape'
                ? template.shape.name
                : template.group.groups.find((group) => template.group.rootGroupIds.includes(group.id))?.name ?? '分组'
              const previewShape = template.kind === 'shape' ? template.shape : null
              return (
                <div key={template.id} className="group relative">
                  <button
                    draggable
                    onDragStart={(event) => {
                      const payload = JSON.stringify(template)
                      event.dataTransfer.setData('application/flowboard-favorite-template', payload)
                      event.dataTransfer.setData('text/plain', `flowboard-favorite:${payload}`)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => insertFavorite(template)}
                    title={`${label}：点击插入或拖到画布`}
                    className="flex w-full items-center justify-center rounded border border-surface-border p-1 hover:border-brand-300 hover:bg-brand-50"
                    style={{ height: Math.max(36, Math.round(favoriteItemSize * 0.65)) }}
                  >
                    {template.kind === 'group'
                      ? <GroupThumbnail shapes={template.group.shapes} height={Math.max(28, Math.round(favoriteItemSize * 0.55))} />
                      : previewShape
                        ? <ShapeThumbnail shape={previewShape} height={Math.max(28, Math.round(favoriteItemSize * 0.55))} />
                        : <span className="text-[10px] text-ink-muted">组</span>}
                  </button>
                  <button
                    title="删除常用组件"
                    onClick={() => persistFavorites(favorites.filter((item) => item.id !== template.id))}
                    className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-white text-red-500 shadow group-hover:flex"
                  >
                    <Trash2 size={9} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {/* ===== ③ 组件库: 渲染 SHAPE_LIBRARY, 点击插入或拖到画布 ===== */}
      <div className="flex shrink-0 flex-col overflow-hidden" style={{ height: libraryHeight }}>
        <div className="flex items-center gap-1 px-3 py-2">
          <span className="min-w-0 flex-1 text-[11px] font-medium text-ink-muted">组件库</span>
          <input
            aria-label="搜索组件"
            value={librarySearch}
            onChange={(event) => setLibrarySearch(event.target.value)}
            placeholder="搜索..."
            className="h-6 w-20 rounded border border-surface-border bg-surface-muted px-1.5 text-[10px] text-ink outline-none focus:border-brand-400"
          />
          <button
            type="button"
            className="tool-btn !h-7 !w-7 shrink-0"
            title="缩小组件预览"
            disabled={libraryItemSize <= MIN_LIBRARY_ITEM_SIZE}
            onClick={() => resizeLibraryItems(-1)}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="tool-btn !h-7 !w-7 shrink-0"
            title="放大组件预览"
            disabled={libraryItemSize >= MAX_LIBRARY_ITEM_SIZE}
            onClick={() => resizeLibraryItems(1)}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${libraryItemSize}px, 1fr))` }}
          >
            {filteredLibraryItems.map((item) => (
              <button
                key={item.id}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/flowboard-shape', JSON.stringify(item))
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => insertLibraryItem(item)}
                title={`${item.name}：点击插入或拖到画布`}
                className="flex w-full items-center justify-center rounded-md border border-transparent p-1 hover:border-brand-200 hover:bg-brand-50"
                style={{ height: Math.max(44, Math.round(libraryItemSize * 0.75)) }}
              >
                <ShapeThumbnail shape={createLibraryShape(item, 0, 0)} height={Math.max(36, Math.round(libraryItemSize * 0.65))} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-t border-surface-border bg-surface"
        onPointerDown={beginLibraryResize}
        title="拖拽调整组件库高度"
        aria-label="调整组件库高度"
      >
        <span className="h-0.5 w-8 rounded bg-transparent transition-colors group-hover:bg-brand-400" />
      </div>
      {/* ===== ④ 结构树(独立组件 StructurePanel) ===== */}
      <StructurePanel />
      <button
        className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize"
        onPointerDown={beginResize}
        title="拖拽调整工具栏宽度"
        aria-label="调整工具栏宽度"
      >
        <span className="absolute inset-y-0 left-1/2 w-px bg-transparent transition-colors group-hover:bg-brand-400" />
        <GripVertical
          size={12}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-transparent group-hover:text-brand-500"
        />
      </button>
    </div>
  )
}
