/**
 * 会话级图片注册表：让模型可以按坐标放大查看图片细节（view_image_detail 工具）。
 *
 * 设计：
 * - 每张可放大图片登记为 ZoomEntry。放大条目不持有自己的压缩结果，而是
 *   **共享根图的位图解码器 + 记录本条目视图在根位图坐标中的区域 rect**：
 *   任意一层放大都换算回根位图坐标后直接裁切原图，压缩结果（JPEG 视图）
 *   只作为「发给模型看的一帧」，绝不作为下一层放大的数据源，无代际损失；
 * - 根位图按需惰性解码并用 LRU 缓存（防多图爆内存）；
 * - 坐标永远基于「模型当前看到的那张图」的左上角像素，可递归放大；
 * - 条目 id 由消息 id 派生（跨重启/裁剪后历史重建保持稳定），
 *   发送时的图片清单文本（imgNote）随消息持久化，模型据此引用 id。
 * - 跨重启后原始字节不存在，根图退化为持久化的发送视图 JPEG（精度 =
 *   发送上限），放大条目通过 zoomRect 恢复「裁根图」语义，不降代。
 */

import { cropBitmapToJpeg, decodeBitmap, DEFAULT_IMAGE_EDGE } from '@/utils/image'

/** 原始位图解码上限：超过则先降采样（12MP 手机照片直接解码即可，超大图防爆内存） */
const MAX_BITMAP = 4096
/** 递归放大层数上限 */
export const MAX_DEPTH = 3
/** 放大区域在根位图中至少要有的边长（像素）；低于即认为已到分辨率极限 */
export const MIN_REGION_PX = 64
/** 位图缓存上限（LRU） */
const CACHE_MAX = 6
/** 保留注册表的会话数 */
const CHAT_KEEP = 3

/** 发给模型 / 放大输出的视图最长边（像素）。可在模型配置里按模型覆盖，
 * 发送消息前由 store 调 setViewEdgeCap 同步；放大输出用同一上限。 */
let viewEdgeCap = DEFAULT_IMAGE_EDGE

export function setViewEdgeCap(edge: number): void {
  viewEdgeCap = Number.isFinite(edge) && edge >= 320 ? Math.round(edge) : DEFAULT_IMAGE_EDGE
}

export function getViewEdgeCap(): number {
  return viewEdgeCap
}

/** 本条目视图在源位图（根图）坐标中的区域；根图条目为 null（整图） */
export interface ZoomRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ZoomEntry {
  /** 稳定 id：img-<messageId>-<k>（发送图）或 img-<messageId>-<k>z<n>（放大图） */
  id: string
  /** 给模型/用户看的说明：'附图' / '文档《x》第3页' / 'img-… 的放大(x,y,w,h)' */
  label: string
  /** 缩放链深度（0 = 原始图） */
  depth: number
  /** 模型所见视图尺寸（坐标空间的宽高） */
  viewW: number
  viewH: number
  /** 根位图惰性解码器：放大条目与根图条目共享同一 resolve */
  resolve: () => Promise<ImageBitmap>
  /** 视图在根位图坐标中的区域；null = 整图 */
  rect: ZoomRect | null
}

const byChat = new Map<string, Map<string, ZoomEntry>>()
/** 根位图缓存：键 = 根图解码器（同一根图的放大条目共享同一 resolve 引用），
 * 因此一份根位图只解码/占内存一次；LRU 逐出时 close。 */
const bitmaps = new Map<() => Promise<ImageBitmap>, ImageBitmap>()
let activeChatId = ''

export function setActiveChat(chatId: string): void {
  activeChatId = chatId
  if (!byChat.has(chatId)) byChat.set(chatId, new Map())
  // 只保留最近 CHAT_KEEP 个会话的注册表
  while (byChat.size > CHAT_KEEP) {
    const oldest = byChat.keys().next().value
    if (oldest === undefined || oldest === chatId) break
    dropChat(oldest)
  }
}

export function resetChat(chatId: string): void {
  dropChat(chatId)
  if (chatId === activeChatId) byChat.set(chatId, new Map())
}

function dropChat(chatId: string): void {
  const regs = byChat.get(chatId)
  if (!regs) return
  for (const resolve of new Set([...regs.values()].map((e) => e.resolve))) {
    const bm = bitmaps.get(resolve)
    bitmaps.delete(resolve)
    bm?.close()
  }
  byChat.delete(chatId)
}

/** 注册一张可放大图片；viewW/viewH 必须是「模型实际看到的图」的尺寸 */
export function registerImage(
  chatId: string,
  opts: {
    id: string
    label: string
    depth?: number
    viewW: number
    viewH: number
    resolve: () => Promise<ImageBitmap>
    rect?: ZoomRect | null
  },
): void {
  let regs = byChat.get(chatId)
  if (!regs) {
    regs = new Map()
    byChat.set(chatId, regs)
  }
  regs.set(opts.id, {
    id: opts.id,
    label: opts.label,
    depth: opts.depth ?? 0,
    viewW: opts.viewW,
    viewH: opts.viewH,
    resolve: opts.resolve,
    rect: opts.rect ?? null,
  })
}

/** 该消息的图片是否已注册（幂等重入判断） */
export function hasImage(chatId: string, id: string): boolean {
  return byChat.get(chatId)?.has(id) ?? false
}

/** 读取已注册条目（历史重建放大条目时共享根图 resolve 用） */
export function getEntry(chatId: string, id: string): ZoomEntry | null {
  return byChat.get(chatId)?.get(id) ?? null
}

/** 给模型看的图片清单条目："img-xx（视图 1024×768，附图）" */
export function describeEntry(e: ZoomEntry): string {
  return `${e.id}（视图 ${e.viewW}×${e.viewH}，${e.label}）`
}

async function resolveCached(e: ZoomEntry): Promise<ImageBitmap> {
  const hit = bitmaps.get(e.resolve)
  if (hit) {
    // LRU 触碰：删了重插到末尾
    bitmaps.delete(e.resolve)
    bitmaps.set(e.resolve, hit)
    return hit
  }
  const bm = await e.resolve()
  bitmaps.set(e.resolve, bm)
  while (bitmaps.size > CACHE_MAX) {
    const oldest = bitmaps.keys().next().value
    if (oldest === undefined) break
    const evicted = bitmaps.get(oldest)
    bitmaps.delete(oldest)
    evicted?.close()
  }
  return bm
}

/* ---------- view_image_detail 工具实现 ---------- */

export interface ZoomArgs {
  imageId: string
  x: number
  y: number
  /** 区域宽（视图像素）；h 缺省 = w（正方形） */
  w: number
  h?: number
}

export interface ZoomResult {
  text: string
  imageBase64: string
  mime: string
  /** 新放大图的注册 id 与视图尺寸（供 UI 持久化，历史重建时恢复） */
  id: string
  viewW: number
  viewH: number
  depth: number
  /** 新条目在根位图坐标中的区域（持久化后跨重启恢复裁根图语义） */
  rect: ZoomRect
}

/**
 * 放大指定图片的局部区域。坐标基于该图当前视图的左上角（像素），
 * 边界自动钳制到图像内；区域过小 / 层数超限 / id 不存在时抛中文 Error。
 * 裁切永远发生在根位图（原图）上，与放大层数无关。
 */
export async function zoomImage(args: ZoomArgs): Promise<ZoomResult> {
  const regs = byChat.get(activeChatId)
  const entry = regs?.get(args.imageId)
  if (!entry) {
    const ids = regs ? [...regs.values()].map(describeEntry).join('；') : '（无）'
    throw new Error(`找不到图片 ${args.imageId}。当前可放大：${ids}`)
  }
  if (entry.depth >= MAX_DEPTH) {
    throw new Error(`放大层数已达上限（${MAX_DEPTH} 层），请基于现有放大图回答`)
  }
  const { x, y, w, h } = args
  for (const [k, v] of [['x', x], ['y', y]] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`参数 ${k} 必须为非负数（像素坐标，原点为 0），收到「${String(v)}」`)
    }
  }
  for (const [k, v] of [['w', w], ['h', h]] as const) {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      throw new Error(`参数 ${k} 必须为正数，收到「${String(v)}」`)
    }
  }
  if (x >= entry.viewW || y >= entry.viewH) {
    throw new Error(
      `起点 (${x}, ${y}) 超出图片范围（视图 ${entry.viewW}×${entry.viewH}），x 应 < ${entry.viewW}、y 应 < ${entry.viewH}`,
    )
  }

  const bitmap = await resolveCached(entry)
  // 视图坐标 → 根位图坐标（rect 定义本条目视图对应的根图区域）
  const base = entry.rect ?? { x: 0, y: 0, w: bitmap.width, h: bitmap.height }
  const kx = base.w / entry.viewW
  const ky = base.h / entry.viewH
  const sx = base.x + x * kx
  const sy = base.y + y * ky
  const rx = Math.max(0, Math.min(sx, bitmap.width - 1))
  const ry = Math.max(0, Math.min(sy, bitmap.height - 1))
  const rw = Math.max(1, Math.min(sx + w * kx, bitmap.width) - rx)
  const rh = Math.max(1, Math.min(sy + (h ?? w) * ky, bitmap.height) - ry)
  if (Math.min(rw, rh) < MIN_REGION_PX) {
    throw new Error(
      `放大区域过小（原图中仅 ${Math.round(rw)}×${Math.round(rh)} 像素），已接近原图分辨率极限，无法继续放大`,
    )
  }

  const out = await cropBitmapToJpeg(bitmap, rx, ry, rw, rh, viewEdgeCap, 0.9)
  // 防覆盖：对同一张图第二次放大时让新条目 id 带序号，旧引用保持有效
  let childId = `${entry.id}z${entry.depth + 1}`
  for (let n = 2; regs!.has(childId); n++) childId = `${entry.id}z${entry.depth + 1}-${n}`
  const rect: ZoomRect = { x: rx, y: ry, w: rw, h: rh }
  registerImage(activeChatId, {
    id: childId,
    label: `${entry.id} 的放大区域 (${Math.round(rx)}, ${Math.round(ry)}, ${Math.round(rw)}, ${Math.round(rh)})`,
    depth: entry.depth + 1,
    viewW: out.width,
    viewH: out.height,
    resolve: entry.resolve,
    rect,
  })

  const text =
    `已放大：${childId} = ${entry.id} 的区域 (${Math.round(rx)}, ${Math.round(ry)}, ${Math.round(rw)}, ${Math.round(rh)})（原图坐标），输出 ${out.width}×${out.height}。` +
    `区域过界部分已自动裁剪到图像边界内。` +
    (entry.depth + 1 < MAX_DEPTH
      ? `如仍看不清，可用 view_image_detail 对 ${childId} 继续放大（还可放大 ${MAX_DEPTH - entry.depth - 1} 次）。`
      : `已达最大放大层数。`)
  return {
    text,
    imageBase64: out.base64,
    mime: 'image/jpeg',
    id: childId,
    viewW: out.width,
    viewH: out.height,
    depth: entry.depth + 1,
    rect,
  }
}

/** 从发送/历史消息注册图片的便利封装：原始字节 → 惰性位图 + ≤上限视图；返回注册条目 */
export function registerSourceImage(
  chatId: string,
  opts: {
    id: string
    label: string
    source: Blob | string
    viewW: number
    viewH: number
    depth?: number
    /** 视图在源位图坐标中的区域（历史重建放大条目时传入）；缺省 = 整图 */
    rect?: ZoomRect | null
  },
): ZoomEntry {
  registerImage(chatId, {
    id: opts.id,
    label: opts.label,
    depth: opts.depth,
    viewW: opts.viewW,
    viewH: opts.viewH,
    resolve: () => decodeBitmap(opts.source, MAX_BITMAP),
    rect: opts.rect ?? null,
  })
  return byChat.get(chatId)!.get(opts.id)!
}
