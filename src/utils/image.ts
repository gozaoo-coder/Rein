/** 图片工具：Canvas 缩放压缩（缩略图 / 识别前降采样）+ 位图解码裁剪（放大镜用）。 */

/** 发给模型的图片最长边默认上限：覆盖主流视觉模型的输入分辨率
 * （GPT-4o 2048 分块、Claude 1568、Gemini/GLM 等均在此内），provider 端还会按需再缩。
 * 各视觉模型上限不一，可在模型配置里按模型覆盖（ai_models.image_max_edge）。 */
export const DEFAULT_IMAGE_EDGE = 2048

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

/** 解码为位图；最长边超过 maxDim 时等比降采样（保留细节上限，防超大图爆内存） */
export async function decodeBitmap(source: Blob | string, maxDim = 4096): Promise<ImageBitmap> {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source
  let bm: ImageBitmap
  try {
    bm = await createImageBitmap(blob)
  } catch {
    // 兜底：部分 WebView 对特殊编码的 createImageBitmap 会失败，走 Image 元素解码
    const url = URL.createObjectURL(blob)
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
