/**
 * HEIF/HEIC 容器识别 + 软件解码兜底。
 *
 * iPhone 的默认格式是 HEIC：Chromium 家族（含 WebView2 与 Android System WebView）
 * 一律没有 HEVC 解码器，于是 `<img>` 与 `createImageBitmap` 双双失败 —— 表现形式是
 * 「图片解码失败」或直接整条消息发不出去。
 *
 * 正常路径是让**系统**帮我们解码（见 `services/mediaService.ts`），这一坨只在
 * 原生路径不可用时才被 **动态 import**：浏览器开发模式（mock 后端）与缺 HEIF
 * 解码器的 Windows 都靠它兜底。2MB 的 wasm 分包不进主包，也不会被无谓下载。
 */

/** ftyp 里那些需要 HEVC 解码器的品牌（avif 是另一个故事：浏览器大多原生支持） */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i += 1) s += String.fromCharCode(bytes[i]!)
  return s
}

/**
 * 按魔数判断是不是 HEIF：第 5 个字节起是 `ftyp`，其后 4 字节是主品牌。
 * **不信任 MIME**：Windows 上 .heic 的 File.type 常常是空串，Android 图库选出来
 * 又可能是 `image/heic` 之外的各种写法，只有容器里的字节是稳的。
 */
export function isHeifBytes(head: Uint8Array): boolean {
  if (head.length < 12) return false
  if (ascii(head, 4, 8) !== 'ftyp') return false
  return HEIF_BRANDS.has(ascii(head, 8, 12))
}

/** 只取前 12 个字节判断，避免为一次判断把整张图读进内存 */
export async function isHeifBlob(source: Blob): Promise<boolean> {
  return isHeifBytes(new Uint8Array(await source.slice(0, 12).arrayBuffer()))
}

/* ---------- 软件解码（按需加载） ---------- */

interface HeifImage {
  get_width(): number
  get_height(): number
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    cb: (data: unknown) => void,
  ): void
}

interface HeifDecoder {
  HeifDecoder: new () => { decode(buffer: ArrayBufferLike): HeifImage[] }
}

let pending: Promise<HeifDecoder> | null = null

function loadDecoder(): Promise<HeifDecoder> {
  pending ??= (async () => {
    const mod = (await import('libheif-js/libheif-wasm/libheif-bundle.mjs')) as {
      default?: (opts?: Record<string, unknown>) => Promise<unknown>
    }
    if (typeof mod.default !== 'function') throw new Error('HEIF 解码器加载失败')
    return (await mod.default({})) as HeifDecoder
  })()
  return pending
}

/**
 * HEIF → JPEG Blob（软件解码，最长边压到 maxEdge 内）。
 * 一次解码通常要几百毫秒到几秒（1200 万像素的 HEVC 纯 CPU 解），调用方应给足提示。
 */
export async function decodeHeifToJpeg(
  bytes: Uint8Array,
  maxEdge: number,
  quality = 0.9,
): Promise<Blob> {
  const libheif = await loadDecoder()
  const images = new libheif.HeifDecoder().decode(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
  const image = images?.[0]
  if (!image) throw new Error('这个 HEIF 文件里没有可用的图像')

  const width = image.get_width()
  const height = image.get_height()
  const rgba = new Uint8ClampedArray(width * height * 4)
  await new Promise<void>((resolve, reject) => {
    image.display({ data: rgba, width, height }, (data) => {
      if (data) resolve()
      else reject(new Error('HEIF 解码失败（解码器没能输出像素）'))
    })
  })

  const scale = Math.min(1, maxEdge / Math.max(width, height))
  // ImageData 不能直接喂给 drawImage（类型与实际支持都不认），先转位图
  const bitmap = await createImageBitmap(new ImageData(rgba, width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 上下文创建失败')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  )
  if (!blob) throw new Error('JPEG 编码失败')
  return blob
}
