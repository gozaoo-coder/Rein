/** 图片工具：Canvas 缩放压缩（缩略图 / 识别前降采样）。 */

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
