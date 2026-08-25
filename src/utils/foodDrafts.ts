/** 食物解析草稿箱：localStorage 持久化的前端工作区数据（不进业务库）。
 * 一份草稿 = 一次识别的完整快照（小缩略图 + 条目），供稍后改重量再写入饮食。 */

import type { ParsedFoodItem } from '@/types'

export interface FoodDraft {
  id: string
  createdAt: string
  /** 240px 缩略图（base64 无前缀）；文字解析无图时缺省 */
  thumbBase64?: string
  items: ParsedFoodItem[]
}

const KEY = 'rein.foodDrafts.v1'
/** 上限保护 localStorage 配额：超出丢弃最旧 */
const MAX_DRAFTS = 30

function read(): FoodDraft[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed.filter(isDraft) as FoodDraft[]) : []
  } catch {
    return []
  }
}

function isDraft(d: unknown): d is FoodDraft {
  const o = d as FoodDraft | null
  return (
    typeof o === 'object' && o !== null && typeof o.id === 'string' && Array.isArray(o.items)
  )
}

function write(drafts: FoodDraft[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts.slice(0, MAX_DRAFTS)))
  } catch {
    /* 配额满等写入失败：草稿属可丢数据，静默保留在内存态 */
  }
}

let seq = 0

export function listFoodDrafts(): FoodDraft[] {
  return read()
}

/** 新建草稿（置顶），返回带 id/createdAt 的完整对象 */
export function saveFoodDraft(d: { thumbBase64?: string; items: ParsedFoodItem[] }): FoodDraft {
  const draft: FoodDraft = {
    id: `fd${Date.now().toString(36)}${++seq}`,
    createdAt: new Date().toISOString(),
    thumbBase64: d.thumbBase64,
    items: d.items,
  }
  write([draft, ...read()])
  return draft
}

/** 覆盖草稿条目（编辑重量 / 删行后同步） */
export function updateFoodDraftItems(id: string, items: ParsedFoodItem[]): void {
  write(read().map((d) => (d.id === id ? { ...d, items } : d)))
}

export function removeFoodDraft(id: string): void {
  write(read().filter((d) => d.id !== id))
}
