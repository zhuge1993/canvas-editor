/**
 * SVG 导出：把画布内容转成真矢量 SVG。
 * 基础图形（矩形/圆/椭圆/文本/线条/箭头）用真 SVG 元素；
 * 复杂形状降级为带样式的矩形框 + 文本。图片以 dataURL 嵌入。
 */
import type { ArrowShape, DrawShape, ImageShape, Shape } from '@/canvas/types'
import { isArrowShape, isDrawShape, isImageShape } from '@/canvas/types'
import { assetToDataUrl, isExternalAsset } from '@/utils/image'

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function colorOrNone(value: string, fallback: string): string {
  return value === 'none' ? 'none' : value || fallback
}

function shapeToSVG(shape: Shape, imageMap: Map<string, string>): string {
  const stroke = colorOrNone(shape.stroke, 'transparent')
  const fill = colorOrNone(shape.fill, 'transparent')
  const opacity = shape.opacity !== undefined && shape.opacity < 1 ? ` opacity="${shape.opacity}"` : ''
  const dash = shape.lineStyle === 'dashed' ? ' stroke-dasharray="8,5"' : shape.lineStyle === 'dotted' ? ' stroke-dasharray="2,4"' : ''
  const sw = shape.strokeWidth > 0 ? shape.strokeWidth : 1

  // 文本
  if (shape.type === 'text') {
    const lines = shape.text.split('\n')
    const lineHeight = shape.fontSize * (shape.lineHeight ?? 1.3)
    const anchor = shape.textAlign === 'left' ? 'start' : shape.textAlign === 'right' ? 'end' : 'middle'
    const x = shape.textAlign === 'left' ? shape.x : shape.textAlign === 'right' ? shape.x + shape.w : shape.x + shape.w / 2
    const textBg = shape.textBackground && shape.textBackground !== 'none'
      ? `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" fill="${shape.textBackground}"${opacity}/>`
      : ''
    const linesSvg = lines.map((line, i) =>
      `<tspan x="${x}" y="${shape.y + shape.fontSize + i * lineHeight}">${escapeXml(line)}</tspan>`
    ).join('')
    return `${textBg}<text x="${x}" y="${shape.y + shape.fontSize}" font-size="${shape.fontSize}" font-weight="${shape.fontWeight}" text-anchor="${anchor}" fill="${shape.textColor}"${opacity} font-family="system-ui,sans-serif">${linesSvg}</text>`
  }

  // 线条/箭头
  if (isArrowShape(shape)) {
    const arrow = shape as ArrowShape
    const points = arrow.points
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${shape.x + (p[0] ?? 0)},${shape.y + (p[1] ?? 0)}`).join(' ')
    const markerEnd = arrow.endArrow ? ' marker-end="url(#flowboard-arrow)"' : ''
    const markerStart = arrow.startArrow ? ' marker-start="url(#flowboard-arrow-rev)"' : ''
    const text = shape.text ? `<text x="${shape.x + shape.w / 2}" y="${shape.y - 6}" font-size="${shape.fontSize}" text-anchor="middle" fill="${shape.textColor}" font-family="system-ui,sans-serif">${escapeXml(shape.text)}</text>` : ''
    return `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash}${markerStart}${markerEnd}${opacity}/>${text}`
  }

  // 手绘
  if (isDrawShape(shape)) {
    const draw = shape as DrawShape
    const path = draw.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${shape.x + (p[0] ?? 0)},${shape.y + (p[1] ?? 0)}`).join(' ')
    return `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${sw}"${opacity}/>`
  }

  // 图片：外置资源需内嵌为 dataURL，否则导出的 SVG 脱离服务器后图片会丢失
  if (isImageShape(shape)) {
    const img = shape as ImageShape
    const href = imageMap.get(img.src) ?? img.src
    return `<image x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" href="${href}"${opacity}/>`
  }

  // 圆/椭圆
  if (shape.type === 'circle') {
    const r = shape.w / 2
    return `<circle cx="${shape.x + r}" cy="${shape.y + r}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${opacity}/>${shapeText(shape)}`
  }
  if (shape.type === 'ellipse') {
    return `<ellipse cx="${shape.x + shape.w / 2}" cy="${shape.y + shape.h / 2}" rx="${shape.w / 2}" ry="${shape.h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${opacity}/>${shapeText(shape)}`
  }

  // 菱形/三角形/多边形等（简化为多边形顶点）
  if (shape.type === 'diamond') {
    const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2
    const pts = `${cx},${shape.y} ${shape.x + shape.w},${cy} ${cx},${shape.y + shape.h} ${shape.x},${cy}`
    return `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${opacity}/>${shapeText(shape)}`
  }

  // 默认：矩形（含圆角）
  const rx = Math.min(shape.cornerRadius, shape.w / 2, shape.h / 2)
  return `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${opacity}/>${shapeText(shape)}`
}

function shapeText(shape: Shape): string {
  if (!shape.text) return ''
  const lines = shape.text.split('\n')
  const lineHeight = shape.fontSize * 1.3
  const totalHeight = lines.length * lineHeight
  const startY = shape.y + shape.h / 2 - (totalHeight - shape.fontSize) / 2 + shape.fontSize * 0.35
  const anchor = shape.textAlign === 'left' ? 'start' : shape.textAlign === 'right' ? 'end' : 'middle'
  const x = shape.textAlign === 'left' ? shape.x + 8 : shape.textAlign === 'right' ? shape.x + shape.w - 8 : shape.x + shape.w / 2
  return lines.map((line, i) =>
    `<text x="${x}" y="${startY + i * lineHeight}" font-size="${shape.fontSize}" font-weight="${shape.fontWeight}" text-anchor="${anchor}" fill="${shape.textColor}" font-family="system-ui,sans-serif">${escapeXml(line)}</text>`
  ).join('')
}

/** 计算所有形状的包围盒 */
export function computeShapesBounds(shapes: Shape[]): { x: number; y: number; w: number; h: number } | null {
  if (shapes.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const shape of shapes) {
    const radius = Math.sqrt(shape.w * shape.w + shape.h * shape.h) / 2
    const cx = shape.x + shape.w / 2
    const cy = shape.y + shape.h / 2
    minX = Math.min(minX, cx - radius)
    minY = Math.min(minY, cy - radius)
    maxX = Math.max(maxX, cx + radius)
    maxY = Math.max(maxY, cy + radius)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 收集需要内嵌的外置图片：src → dataURL */
async function inlineImageSources(shapes: Shape[]): Promise<Map<string, string>> {
  const sources = [...new Set(shapes.filter(isImageShape).map(shape => (shape as ImageShape).src).filter(src => Boolean(src) && isExternalAsset(src)))]
  const map = new Map<string, string>()
  await Promise.all(sources.map(async src => {
    const dataUrl = await assetToDataUrl(src)
    if (dataUrl) map.set(src, dataUrl)
  }))
  return map
}

/** 导出为真矢量 SVG（外置图片自动内嵌，保证文件自包含） */
export async function exportShapesToSVG(shapes: Shape[], padding = 32): Promise<string> {
  const imageMap = await inlineImageSources(shapes)
  const bounds = computeShapesBounds(shapes)
  if (!bounds) return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"/>'
  const width = bounds.w + padding * 2
  const height = bounds.h + padding * 2
  const offsetX = -bounds.x + padding
  const offsetY = -bounds.y + padding
  const defs = `<defs>
    <marker id="flowboard-arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="currentColor"/></marker>
    <marker id="flowboard-arrow-rev" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M9,0 L9,6 L0,3 z" fill="currentColor"/></marker>
  </defs>`
  const body = shapes.filter(s => s.visible).map(shape => shapeToSVG(shape, imageMap)).join('\n    ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}">
  ${defs}
  <rect width="${Math.ceil(width)}" height="${Math.ceil(height)}" fill="#ffffff"/>
  <g transform="translate(${offsetX},${offsetY})">
    ${body}
  </g>
</svg>`
}
