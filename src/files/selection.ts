/**
 * 选择模型。
 *
 * 要点：**选择按稳定 id 存，不按索引**。刷新、排序、过滤、切换视图之后，
 * 只要条目还在，选择就还在（`prune` 只丢掉真的消失的那些）——
 * 这是「操作完成后刷新目录，但保留选择/滚动/焦点」的前提。
 *
 * 用 Set 存成员（插入顺序稳定，且判存在 O(1)），需要按显示顺序处理时
 * 用显示顺序的数组去过滤（`list()`）——粘贴、批量删除的顺序因此可预期。
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { FileItem } from './types'

export interface SelectionApi {
  /** 选中集合（按 id；插入顺序 = 选择顺序） */
  ids: Ref<Set<string>>
  count: ComputedRef<number>
  focusedId: Ref<string | null>
  has(id: string): boolean
  isFocused(id: string): boolean
  /** 按**显示顺序**取选中项（批量操作与读屏顺序都要它） */
  list(order: FileItem[]): FileItem[]
  /** 单击：Shift = 范围、Ctrl/Cmd = 切换、无修饰 = 单选 */
  click(item: FileItem, order: FileItem[], mods: { shift: boolean; toggle: boolean }): void
  selectOnly(item: FileItem): void
  toggle(item: FileItem): void
  selectAll(order: FileItem[]): void
  invert(order: FileItem[]): void
  clear(): void
  /** 键盘移动焦点：返回新的焦点项（供滚动到可见） */
  moveFocus(order: FileItem[], delta: number, extend: boolean): FileItem | null
  /** 跳到首/末（Home/End） */
  focusEdge(order: FileItem[], last: boolean, extend: boolean): FileItem | null
  /** 焦点移到某个索引（PageUp/PageDown 用） */
  focusIndex(order: FileItem[], index: number, extend: boolean): FileItem | null
  /** 刷新后保留仍然存在的选择；返回是否发生了变化 */
  prune(order: FileItem[]): void
  /** 框选：`additive` = 在原有选择上叠加（Ctrl 拖框），否则替换 */
  setMany(ids: string[], additive: boolean): void
}

export function useSelection(): SelectionApi {
  const ids = ref<Set<string>>(new Set())
  const focusedId = ref<string | null>(null)
  /** Shift 范围选择的锚点 */
  let anchorId: string | null = null

  const count = computed(() => ids.value.size)

  function set(next: Iterable<string>): void {
    // 整体替换而不是就地增删：Set 的响应式追踪在多个 Vue 版本里行为不一致，
    // 替换引用是唯一稳的写法（选择集通常几十个，代价可忽略）。
    ids.value = new Set(next)
  }

  function has(id: string): boolean {
    return ids.value.has(id)
  }

  function indexOf(order: FileItem[], id: string | null): number {
    if (!id) return -1
    return order.findIndex((i) => i.id === id)
  }

  function click(item: FileItem, order: FileItem[], mods: { shift: boolean; toggle: boolean }): void {
    if (mods.shift && anchorId) {
      const a = indexOf(order, anchorId)
      const b = indexOf(order, item.id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        set(order.slice(lo, hi + 1).map((i) => i.id))
        focusedId.value = item.id
        return
      }
    }
    if (mods.toggle) {
      const next = new Set(ids.value)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      set(next)
      anchorId = item.id
      focusedId.value = item.id
      return
    }
    set([item.id])
    anchorId = item.id
    focusedId.value = item.id
  }

  function selectOnly(item: FileItem): void {
    set([item.id])
    anchorId = item.id
    focusedId.value = item.id
  }

  function toggle(item: FileItem): void {
    const next = new Set(ids.value)
    if (next.has(item.id)) next.delete(item.id)
    else next.add(item.id)
    set(next)
    anchorId = item.id
    focusedId.value = item.id
  }

  function selectAll(order: FileItem[]): void {
    set(order.map((i) => i.id))
  }

  function invert(order: FileItem[]): void {
    set(order.filter((i) => !ids.value.has(i.id)).map((i) => i.id))
  }

  function clear(): void {
    set([])
    anchorId = null
  }

  /** 焦点重新落到范围内（键盘操作后一定要能看见焦点） */
  function focusAt(order: FileItem[], index: number, extend: boolean): FileItem | null {
    if (!order.length) return null
    const i = Math.max(0, Math.min(order.length - 1, index))
    const item = order[i]
    focusedId.value = item.id
    if (extend && anchorId) {
      const a = indexOf(order, anchorId)
      if (a >= 0) {
        const [lo, hi] = a < i ? [a, i] : [i, a]
        set(order.slice(lo, hi + 1).map((x) => x.id))
        return item
      }
    }
    if (!extend) {
      set([item.id])
      anchorId = item.id
    }
    return item
  }

  function moveFocus(order: FileItem[], delta: number, extend: boolean): FileItem | null {
    const cur = indexOf(order, focusedId.value)
    // 还没有焦点：从选择集的第一个开始，或从头开始
    if (cur < 0) return focusAt(order, delta > 0 ? 0 : order.length - 1, false)
    return focusAt(order, cur + delta, extend)
  }

  function focusEdge(order: FileItem[], last: boolean, extend: boolean): FileItem | null {
    return focusAt(order, last ? order.length - 1 : 0, extend)
  }

  function focusIndex(order: FileItem[], index: number, extend: boolean): FileItem | null {
    return focusAt(order, index, extend)
  }

  function prune(order: FileItem[]): void {
    const alive = new Set(order.map((i) => i.id))
    const next = [...ids.value].filter((id) => alive.has(id))
    if (next.length !== ids.value.size) set(next)
    if (focusedId.value && !alive.has(focusedId.value)) focusedId.value = null
    if (anchorId && !alive.has(anchorId)) anchorId = null
  }

  function setMany(next: string[], additive: boolean): void {
    if (additive) {
      set([...ids.value, ...next])
      return
    }
    set(next)
  }

  return {
    ids,
    count,
    focusedId,
    has,
    isFocused: (id: string) => focusedId.value === id,
    list: (order: FileItem[]) => order.filter((i) => ids.value.has(i.id)),
    click,
    selectOnly,
    toggle,
    selectAll,
    invert,
    clear,
    moveFocus,
    focusEdge,
    focusIndex,
    prune,
    setMany,
  }
}
