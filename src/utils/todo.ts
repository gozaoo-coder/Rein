import type { Todo } from '@/types'

/**
 * 紧急程度排序（主页「待办」卡、全部待办页共用）：
 * 未完成优先 → 重要程度降序 → 时间越早越急 → 无时间靠后 → 新建靠前。
 */
export function cmpUrgency(a: Todo, b: Todo): number {
  const ad = a.status === 'done' ? 1 : 0
  const bd = b.status === 'done' ? 1 : 0
  if (ad !== bd) return ad - bd
  if (a.priority !== b.priority) return b.priority - a.priority
  const adate = a.date ?? '9999-99-99'
  const bdate = b.date ?? '9999-99-99'
  if (adate !== bdate) return adate < bdate ? -1 : 1
  const am = a.startMin ?? 1440
  const bm = b.startMin ?? 1440
  if (am !== bm) return am - bm
  return b.id - a.id
}
