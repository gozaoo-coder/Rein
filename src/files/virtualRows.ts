/**
 * 行式虚拟滚动（只渲染可视窗口）。
 *
 * 与项目里 VirtualTimeline 的时间轴虚拟化同源，但这里要处理**高度不一的行**
 * （分组标题行比条目行矮）：所以走前缀和 + 二分查找，而不是「下标 × 行高」。
 *
 * 大目录不卡的两个前提都在这里：只挂可见行的 DOM；滚动事件里只做一次
 * 二分 + 一次数组切片，不触发任何布局读取（读 `scrollTop`/`clientHeight`
 * 都在滚动回调里一次性取完）。
 */

import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from 'vue'

export interface VRow<T> {
  /** 稳定行键（用条目 id / 分组键，不能用下标 —— 排序一变就会串行） */
  key: string
  /** 行高（px）。同一行的类型固定，所以高度可预算。 */
  h: number
  data: T
}

export interface VisibleRow<T> {
  row: VRow<T>
  /** 该行在内容坐标系里的 top */
  top: number
  index: number
}

export interface VirtualRowsApi<T> {
  host: Ref<HTMLElement | null>
  totalPx: ComputedRef<number>
  visible: ComputedRef<VisibleRow<T>[]>
  /** 内容顶部到首个可见行的偏移（用一个撑高的占位元素实现） */
  padTop: ComputedRef<number>
  /** 视口高度内的行数（键盘 PageUp/PageDown 用） */
  pageSize: ComputedRef<number>
  onScroll(): void
  /** 把某一行滚进视口（焦点/选中变化时调用） */
  scrollToKey(key: string, align?: 'auto' | 'center'): void
  /** 按下标滚进视口（键盘导航用） */
  scrollToIndex(index: number, align?: 'auto' | 'center'): void
  /** 重置到顶部（换目录时调用） */
  reset(): void
  /** 组件把滚动容器绑上来（挂监听；卸载时自动清理） */
  attach(el: HTMLElement | null): void
  detach(): void
}

export function useVirtualRows<T>(
  rows: Ref<VRow<T>[]>,
  opts: { overscan?: number } = {},
): VirtualRowsApi<T> {
  const overscan = opts.overscan ?? 4
  const host = ref<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const viewH = ref(0)

  /** 行顶偏移的前缀和；末尾一项即总高 */
  const offsets = computed(() => {
    const out = new Array<number>(rows.value.length + 1)
    out[0] = 0
    for (let i = 0; i < rows.value.length; i++) out[i + 1] = out[i] + rows.value[i].h
    return out
  })

  const totalPx = computed(() => offsets.value[rows.value.length] ?? 0)

  /** 第一个 bottom > scrollTop 的行（二分行顶偏移） */
  function firstVisible(): number {
    const off = offsets.value
    let lo = 0
    let hi = rows.value.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (off[mid + 1] <= scrollTop.value) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const window_ = computed(() => {
    const n = rows.value.length
    if (!n) return { start: 0, end: 0 }
    const start = Math.max(0, firstVisible() - overscan)
    const bottom = scrollTop.value + Math.max(viewH.value, 1) + overscan * 48
    let end = start
    const off = offsets.value
    while (end < n && off[end] < bottom) end += 1
    return { start, end: Math.max(end, Math.min(n, start + 1)) }
  })

  const visible = computed<VisibleRow<T>[]>(() => {
    const { start, end } = window_.value
    const off = offsets.value
    const out: VisibleRow<T>[] = []
    for (let i = start; i < end; i++) out.push({ row: rows.value[i], top: off[i], index: i })
    return out
  })

  const padTop = computed(() => offsets.value[window_.value.start] ?? 0)
  const pageSize = computed(() => Math.max(1, Math.floor(Math.max(viewH.value, 1) / 48)))

  function measure(): void {
    const el = host.value
    if (!el) return
    viewH.value = el.clientHeight
    scrollTop.value = el.scrollTop
  }

  function onScroll(): void {
    measure()
  }

  function scrollToIndex(index: number, align: 'auto' | 'center' = 'auto'): void {
    const el = host.value
    if (!el) return
    const i = Math.max(0, Math.min(rows.value.length - 1, index))
    if (!rows.value.length) return
    const off = offsets.value
    const top = off[i]
    const bottom = off[i + 1]
    const h = viewH.value || el.clientHeight
    if (align === 'center') {
      el.scrollTop = Math.max(0, top - (h - (bottom - top)) / 2)
    } else if (top < el.scrollTop) {
      el.scrollTop = top
    } else if (bottom > el.scrollTop + h) {
      el.scrollTop = bottom - h
    }
    measure()
  }

  function scrollToKey(key: string, align: 'auto' | 'center' = 'auto'): void {
    const i = rows.value.findIndex((r) => r.key === key)
    if (i < 0) return
    scrollToIndex(i, align)
  }

  function reset(): void {
    const el = host.value
    if (el) el.scrollTop = 0
    measure()
  }

  let ro: ResizeObserver | null = null
  /** 组件把 host 绑上后调用（attach 里挂监听，卸载时自动清理） */
  function attach(el: HTMLElement | null): void {
    if (host.value === el) return
    detach()
    host.value = el
    if (!el) return
    el.addEventListener('scroll', onScroll, { passive: true })
    ro = new ResizeObserver(() => measure())
    ro.observe(el)
    measure()
  }

  function detach(): void {
    host.value?.removeEventListener('scroll', onScroll)
    ro?.disconnect()
    ro = null
  }

  onBeforeUnmount(detach)

  return {
    host,
    totalPx,
    visible,
    padTop,
    pageSize,
    onScroll,
    scrollToKey,
    scrollToIndex,
    reset,
    attach,
    detach,
  }
}
