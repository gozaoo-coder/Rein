/** 图片工具：Canvas 缩放压缩（缩略图 / 识别前降采样）+ 位图解码裁剪（放大镜用）。 */

import { isTauri } from '@/services/transport'
import { mediaService } from '@/services/mediaService'
import { decodeHeifToJpeg, isHeifBlob } from '@/utils/heif'

/** 发给模型的图片最长边默认上限：覆盖主流视觉模型的输入分辨率
 * （GPT-4o 2048 分块、Claude 1568、Gemini/GLM 等均在此内），provider 端还会按需再缩。
 * 各视觉模型上限不一，可在模型配置里按模型覆盖（ai_models.image_max_edge）。 */
export const DEFAULT_IMAGE_EDGE = 2048

/** 选图框的 accept：除了 `image/*` 还要**显式**列出 HEIF —— Windows/Chrome 的 file input
 *  并不把 heic 算进 `image/*`，漏了这两项，iPhone 拍的原图在系统选择器里就是灰的。 */
export const IMAGE_ACCEPT = 'image/*,.heic,.heif,image/heic,image/heif'

/** HEIF 一律先解到这个边长：一次选中往往要连着过几道工序（发送视图 / 缩略图 /
 *  放大镜），统一按这个上限转一次，后续各道由 canvas 自己缩 —— 这也是 heifCache
 *  敢按「源 Blob」复用结果的前提（缓存里的图永远够精细）。 */
const HEIF_EDGE = 4096

/** HEIF 转码结果按源 Blob 缓存，避免同一张 HEIC 被重复解码 */
const heifCache = new WeakMap<Blob, Promise<Blob>>()

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

/**
 * 等比缩放并转 JPEG，返回不含 data: 前缀的 base64。
 * 原始图片小于 maxSize 时不放大（scale 上限 1）。
 */
export async function resizeImageAsJpeg(
  dataUrl: string,
  maxSize: number,
  quality = 0.8,
): Promise<string> {
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 上下文创建失败')
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', quality).split(',')[1]
}

/* ---------- 位图级工具（图片放大镜 / 高分辨率保留） ---------- */

/**
 * HEIF/HEIC → JPEG：先请**系统**解码（Android 的 BitmapFactory / Windows 的 WIC，
 * 快、省内存，也不需要额外下载解码器），原生这条路走不通时才退到内置的软件解码器。
 *
 * 原生失败会打一条 console 日志并静默降级：用户在 Tauri 里看到的是「转码稍慢」，
 * 在浏览器开发模式里则是纯粹的软解（mock 后端没有原生解码能力）。
 */
async function transcodeHeif(source: Blob): Promise<Blob> {
  if (isTauri) {
    try {
      const bytes = new Uint8Array(await source.arrayBuffer())
      const out = await mediaService.decodeHeif(bytesToBase64(bytes), HEIF_EDGE, 90)
      return base64ToBlob(out.jpegBase64, 'image/jpeg')
    } catch (e) {
      console.warn('[image] 原生 HEIF 解码不可用，退到内置解码器', e)
    }
  }
  return await decodeHeifToJpeg(new Uint8Array(await source.arrayBuffer()), HEIF_EDGE)
}

/** HEIF 转码入口：同一张图的结果按源 Blob 复用（一次选中会被多道工序反复取用） */
async function heifToJpeg(source: Blob): Promise<Blob> {
  const cached = heifCache.get(source)
  if (cached) return cached
  const task = transcodeHeif(source)
  heifCache.set(source, task)
  return task
}

/**
 * 解码为位图；最长边超过 maxDim 时等比降采样（保留细节上限，防超大图爆内存）。
 *
 * HEIF/HEIC 在这里被就地转码：WebView 一律没有 HEVC 解码器，
 * 直接丢给 `createImageBitmap` 只会拿到一个「解码失败」。
 */
export async function decodeBitmap(source: Blob | string, maxDim = 4096): Promise<ImageBitmap> {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source
  const prepared = (await isHeifBlob(blob)) ? await heifToJpeg(blob) : blob
  let bm: ImageBitmap
  try {
    bm = await createImageBitmap(prepared)
  } catch {
    // 兜底：部分 WebView 对特殊编码的 createImageBitmap 会失败，走 Image 元素解码
    const url = URL.createObjectURL(prepared)
    try {
      const img = await loadImage(url)
      bm = await createImageBitmap(img)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  const long = Math.max(bm.width, bm.height)
  if (long <= maxDim) return bm
  const scale = maxDim / long
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bm.width * scale)
  canvas.height = Math.round(bm.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 上下文创建失败')
  ctx.drawImage(bm, 0, 0, canvas.width, canvas.height)
  bm.close()
  return createImageBitmap(canvas)
}

/** 位图 → JPEG base64（无 data: 前缀），返回实际输出尺寸 */
export async function bitmapToJpeg(
  source: ImageBitmap | HTMLCanvasElement,
  maxDim: number,
  quality = 0.85,
): Promise<{ base64: string; width: number; height: number }> {
  const w = source.width
  const h = source.height
  const scale = Math.min(1, maxDim / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 上下文创建失败')
  ctx.drawImage(source, 0, 0, cw, ch)
  return { base64: canvas.toDataURL('image/jpeg', quality).split(',')[1]!, width: cw, height: ch }
}

/** 从位图裁剪区域并压到 maxDim 内（放大镜核心：按原图坐标取局部） */
export async function cropBitmapToJpeg(
  bitmap: ImageBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  maxDim = 1024,
  quality = 0.85,
): Promise<{ base64: string; width: number; height: number }> {
  const x = Math.max(0, Math.min(sx, bitmap.width - 1))
  const y = Math.max(0, Math.min(sy, bitmap.height - 1))
  const w = Math.max(1, Math.min(sw, bitmap.width - x))
  const h = Math.max(1, Math.min(sh, bitmap.height - y))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 上下文创建失败')
  ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h)
  return bitmapToJpeg(canvas, maxDim, quality)
}

/* ---------- 文件 → JPEG（含 HEIF 转码） ---------- */

/** 任意图片文件 → JPEG base64：统一入口，替代「先转 dataURL 再 resize」的老写法 ——
 *  那条路在 HEIC 上第一步就断了（dataURL 只能描述 MIME，解不了 HEVC）。 */
export async function fileToJpegBase64(
  source: Blob,
  maxSize: number,
  quality = 0.85,
): Promise<string> {
  const bm = await decodeBitmap(source)
  try {
    return (await bitmapToJpeg(bm, maxSize, quality)).base64
  } finally {
    bm.close()
  }
}

/** 扩展名 → MIME：Windows 上 .heic 的 `File.type` 常常是空串，只有它能兜住 */
const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

/** 这张图到底算什么 MIME：优先信浏览器报的 type，为空则按扩展名猜 */
export function imageTypeOf(file: File): string {
  if (file.type) return file.type
  const ext = /(\.[a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? ''
}

/* ---------- base64 ---------- */

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(out)
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return new Blob([out], { type: mime })
}
