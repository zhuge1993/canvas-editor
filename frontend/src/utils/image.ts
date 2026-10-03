/** 图片压缩与资源外置工具。
 *
 *  处理链路：原图 → canvas 缩放压缩（默认 480px 边长，优先 WebP）→ 上传到服务端
 *  `/api/assets` 换取内容寻址 URL（`/api/assets/<sha1>.webp`）→ 写入 shape.src。
 *
 *  为什么外置：base64 内嵌会让单个文档膨胀到 MB 级（实测某文档 7.87MB 中 99.3% 是图片），
 *  导致保存/打开/列表接口都要搬运整份图片数据。外置后文档只保留几十字节的 URL，
 *  图片走浏览器强缓存（immutable），二次访问零传输。
 *
 *  兼容：服务端不可用（离线/未启动）时自动回退为内嵌 dataURL，功能不受影响。
 */

const MAX_SIDE = 480
const UPLOAD_TIMEOUT_MS = 20000
const WEBP_QUALITY = 0.8

export interface CompressedImage {
  dataUrl: string
  width: number
  height: number
  originalSize: number
}

/** 压缩 + 外置的结果，可直接写入 ImageShape.src */
export interface PreparedImage {
  /** 最终写入 shape.src 的值：外置 URL 优先，回退内嵌 dataURL */
  src: string
  /** 是否成功外置（false 表示回退为内嵌） */
  external: boolean
  width: number
  height: number
  originalSize: number
  /** 写入文档的字节数（外置时约等于 URL 长度） */
  storedBytes: number
}

/** 把图片文件缩放压缩为 dataURL（优先 WebP，可显著减小体积且支持透明）。 */
export async function compressImageFile(file: File, maxSide = MAX_SIDE): Promise<CompressedImage> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const reader = new FileReader()
  reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Image data could not be read')))
  reader.onerror = () => reject(reader.error ?? new Error('Image read failed'))
  reader.readAsDataURL(file)
  const src = await promise

  const dimensions = Promise.withResolvers<{ width: number; height: number }>()
  const image = new Image()
  image.onload = () => dimensions.resolve({ width: image.naturalWidth, height: image.naturalHeight })
  image.onerror = () => dimensions.reject(new Error('Image dimensions could not be read'))
  image.src = src
  const { width, height } = await dimensions.promise

  const scale = Math.min(1, maxSide / Math.max(width, height))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  let dataUrl = src
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, targetWidth, targetHeight)
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight)
    dataUrl = encodeCanvas(canvas, file.type)
  }

  return { dataUrl, width: targetWidth, height: targetHeight, originalSize: file.size }
}

/** 编码画布：优先 WebP（体积比 PNG/JPEG 再降 25-70%），不支持时回退到原格式。 */
function encodeCanvas(canvas: HTMLCanvasElement, sourceType: string): string {
  const webp = canvas.toDataURL('image/webp', WEBP_QUALITY)
  if (webp.startsWith('data:image/webp')) return webp
  const hasAlpha = sourceType === 'image/png' || sourceType === 'image/webp' || sourceType === 'image/gif'
  return hasAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.82)
}

/** 上传 dataURL 到服务端资源库，返回可长期引用的内容寻址 URL；失败返回 null。 */
export async function uploadImageAsset(dataUrl: string, shareToken?: string, sharePassword?: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
    const response = await fetch('/api/assets', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(shareToken ? { 'X-FlowBoard-Share-Token': shareToken } : {}),
        ...(sharePassword ? { 'X-FlowBoard-Share-Password': sharePassword } : {}),
      },
      body: JSON.stringify({ dataUrl }),
      signal: controller.signal,
    })
    window.clearTimeout(timer)
    if (!response.ok) return null
    const payload = await response.json() as { url?: string }
    return typeof payload.url === 'string' && payload.url ? payload.url : null
  } catch {
    // 离线 / 服务端不可用 / 超时：回退内嵌，保证图片仍能插入画布
    return null
  }
}

/** 压缩 + 外置一步到位：供粘贴、拖拽等所有图片入口使用。 */
export async function prepareImageSrc(file: File, maxSide = MAX_SIDE, shareToken?: string, sharePassword?: string): Promise<PreparedImage> {
  const compressed = await compressImageFile(file, maxSide)
  const url = await uploadImageAsset(compressed.dataUrl, shareToken, sharePassword)
  const src = url ?? compressed.dataUrl
  return {
    src,
    external: url !== null,
    width: compressed.width,
    height: compressed.height,
    originalSize: compressed.originalSize,
    storedBytes: url !== null ? url.length : Math.round(compressed.dataUrl.length * 0.75),
  }
}

/** 判断 src 是否为服务端外置资源 */
export function isExternalAsset(src: string): boolean {
  return src.startsWith('/api/assets/')
}

/** 把外置资源取回并转为 dataURL（用于导出需要自包含的文件）。 */
export async function assetToDataUrl(src: string): Promise<string | null> {
  if (!src || src.startsWith('data:')) return src || null
  try {
    const response = await fetch(src, { credentials: 'same-origin' })
    if (!response.ok) return null
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('read failed')))
      reader.onerror = () => reject(reader.error ?? new Error('read failed'))
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * 把任意对象里所有外置资源引用内嵌为 dataURL，用于导出「自包含」文件
 * （.fboard 源文件、SVG 等需要脱离服务器也能打开的场景）。
 * 取不到的引用保持原样，不阻断导出。
 */
export async function inlineExternalAssets<T>(value: T): Promise<T> {
  let json = JSON.stringify(value)
  const urls = [...new Set(json.match(/\/api\/assets\/[a-zA-Z0-9._-]+/g) ?? [])]
  if (urls.length === 0) return value
  const pairs = await Promise.all(urls.map(async url => [url, await assetToDataUrl(url)] as const))
  for (const [url, dataUrl] of pairs) {
    if (dataUrl) json = json.split(url).join(dataUrl)
  }
  return JSON.parse(json) as T
}
