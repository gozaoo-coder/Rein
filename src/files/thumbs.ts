/**
 * 缩略图：异步生成 + 内存缓存 + 失败兜底。
 *
 * 为什么不在后端做缩略图：Rust 侧没有图像解码器（加 `image` crate 会给四端交叉编译
 * 添一个纯 Rust 依赖，代价换来的只是网格预览）。这里走 WebView 自带解码：
 * 取一次本体 data URL（后端已有 16 MB 内联上限）→ `createImageBitmap` → canvas 缩到
 * 小尺寸 → 缓存成小 JPEG。**绝不同步生成**，也绝不并发打满：
 * 滚动时只对进入视口的条目排队，离开视口的请求直接丢弃。
 *
 * 缓存是纯内存的会话级 LRU（120 条）。真正的解码结果落盘缓存要等后端有解码器，
 * 这里先把「不卡、不重复解码、失败有占位」三件事做对。
 */

import { kbService } from '@/services/kbService'
import type { FileItem } from './types'

/** 只对图片生成缩略图；其他类型直接用图标 */
const THUMB_KINDS = new Set(['image'])
/** 源文件超过这个体积就不做缩略图（解码 20MB 的图只为显示 96px 不值得） */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024
/** 同时在解码的图片数（超过只会让滚动变卡，不会更快） */
const MAX_ACTIVE = 2

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()
const CACHE_MAX = 120

let active = 0
const waiters: (() => void)[] = []

function cachePut(key: string, value: string | null): void {
  cache.set(key, value)
  // Map 的迭代顺序 = 插入顺序：删最旧的一条即可（够用的 LRU）
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function acquire(): Promise<void> {
  if (active < MAX_ACTIVE) {
    active += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active += 1
      resolve()
    })
  })
}

function release(): void {
  active -= 1
  const next = waiters.shift()
  if (next) next()
}

/** 缓存键：路径 + 修改时间。改过内容就换一张，不会显示旧图。 */
export function thumbKey(item: FileItem): string {
  return `${item.id}@${item.modifiedAt ?? 0}`
}

/** 同步取已缓存的缩略图（虚拟滚动重渲染时先画旧的，避免闪白）。
 *  键必须带尺寸档：`loadThumb` 按 `键#maxEdge` 存，漏掉后缀就永远命中不到。 */
export function cachedThumb(item: FileItem, maxEdge = 96): string | null {
  return cache.get(`${thumbKey(item)}#${maxEdge}`) ?? null
}

/** 该条目已缓存的**任意尺寸档**缩略图（拖出到系统只关心「有没有现成字节」） */
export function cachedThumbAny(item: FileItem): string | null {
  const prefix = `${thumbKey(item)}#`
  for (const [k, v] of cache) {
    if (k.startsWith(prefix) && v) return v
  }
  return null
}

/** 这个条目「值得」生成缩略图吗（不可行进不了队列） */
export function thumbEligible(item: FileItem): boolean {
  if (item.isDir || !THUMB_KINDS.has(item.kind)) return false
  if (item.docId === undefined) return false
  if ((item.size ?? 0) > MAX_SOURCE_BYTES) return false
  return true
}

async function decode(dataUrl: string, maxEdge: number): Promise<string | null> {
  // WebView 里 `createImageBitmap(Blob)` 在后台线程解码，比 <img> + canvas 稳定
  const blob = await (await fetch(dataUrl)).blob()
  const bmp = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', 0.72)
  } finally {
    bmp.close()
  }
}

/**
 * 取一个条目的缩略图。命中缓存直接返回；失败**缓存 null**（同一张破图不会反复重试）。
 * `maxEdge` 变了会各存一份 —— 网格换尺寸档时不必重新解码源图，但也不该复用错尺寸。
 */
export async function loadThumb(item: FileItem, maxEdge = 96): Promise<string | null> {
  if (!thumbEligible(item)) return null
  const key = `${thumbKey(item)}#${maxEdge}`
  if (cache.has(key)) return cache.get(key) ?? null
  const running = inflight.get(key)
  if (running) return running

  const job = (async () => {
    await acquire()
    try {
      const media = await kbService.mediaGet(item.docId!, 'image')
      if (!media.dataUrl) return null
      return await decode(media.dataUrl, maxEdge)
    } catch {
      return null
    } finally {
      release()
    }
  })()

  inflight.set(key, job)
  try {
    const out = await job
    cachePut(key, out)
    return out
  } finally {
    inflight.delete(key)
  }
}
