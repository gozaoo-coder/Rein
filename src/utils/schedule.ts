/** 日程空档计算 · 画布拖拽落位与智能排程共用 */

import type { Todo } from '@/types'

export interface Interval {
  start: number
  end: number
  title?: string
}

/** 某天已占用时段（有时长的待办；duration 缺省按 30 分钟估） */
export function busyIntervals(todos: Todo[], date: string): Interval[] {
  return todos
    .filter((t) => t.date === date && t.startMin != null && t.status !== 'done')
    .map((t) => ({
      start: t.startMin!,
      end: t.startMin! + (t.durationMin ?? 30),
      title: t.title,
    }))
    .sort((a, b) => a.start - b.start)
}

/** [fromMin, untilMin) 内的空闲档（与 busy 求补集） */
export function freeGaps(busy: Interval[], fromMin: number, untilMin: number): Interval[] {
  const gaps: Interval[] = []
  let cursor = Math.max(0, fromMin)
  for (const b of busy) {
    if (b.end <= cursor) continue
    if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, untilMin) })
    cursor = Math.max(cursor, b.end)
    if (cursor >= untilMin) break
  }
  if (cursor < untilMin) gaps.push({ start: cursor, end: untilMin })
  return gaps.filter((g) => g.end - g.start >= 5)
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

/** 两个时段之间预留的缓冲（分钟） */
export const SCHEDULE_BUFFER = 5
