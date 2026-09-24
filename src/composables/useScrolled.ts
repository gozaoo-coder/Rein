import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/**
 * 滚动位置的两种读法（页头用）：
 *   useScrolled        —— 是否已滚离顶部（阈值之上为 true）
 *   useScrollCollapsed —— 是否处于「向下滚、收起」相（苹果的滚动边缘效应：
 *                         下滚时导航元素缩一档专注内容，上滚立刻还原）
 *
 * 两种壳的滚动容器不一样：移动端滚文档（window / html），桌面工作台滚 .desk-main。
 * 挂载时沿父链找最近的滚动祖先（overflow-y: auto|scroll），找不到就退回 window——
 * 页面把标题压成 fixed 就会在桌面壳里跑到导航轨与信息栏底下，所以这里用 sticky
 * 贴容器顶，探测也必须跟着容器的实际身份走，不能写死 window。
 *
 * 读值走 rAF 合并：滚动事件一帧可以来好几次，只有一帧一次的读值才有意义。
 */

type Scroller = HTMLElement | Window

/**
 * 绑定元素所在的滚动容器，并在**每次**解析结果变化时回调 onBind（含首帧）——
 * 壳可能换（桌面三窗格 ⇄ 移动窄栏），换完滚动容器就不是同一个了，
 * 调用方要借这次回调重新取一次初值。
 */
function bindScroller(
  el: Ref<HTMLElement | null>,
  onScroll: () => void,
  onBind: (target: Scroller) => void,
): () => void {
  let target: Scroller = window
  let bound = false

  function handler(): void {
    onScroll()
  }

  function resolve(): Scroller {
    let node = el.value?.parentElement ?? null
    while (node) {
      const { overflowY } = getComputedStyle(node)
      if (overflowY === 'auto' || overflowY === 'scroll') return node
      node = node.parentElement
    }
    return window
  }

  function bind(): void {
    const next = resolve()
    // 初值也是 window：不能只比对象，否则「解析结果就是 window」会一次都不挂监听
    if (bound && next === target) return
    if (bound) target.removeEventListener('scroll', handler)
    target = next
    target.addEventListener('scroll', handler, { passive: true })
    bound = true
    onBind(next)
  }

  watch(() => el.value, bind)
  onMounted(bind)

  return () => {
    if (bound) target.removeEventListener('scroll', handler)
  }
}

function scrollTopOf(target: Scroller): number {
  return target === window ? window.scrollY : (target as HTMLElement).scrollTop
}

export function useScrolled(el: Ref<HTMLElement | null>, threshold = 4): Ref<boolean> {
  const scrolled = ref(false)
  let target: Scroller = window
  let raf = 0

  function read(): void {
    raf = 0
    const next = scrollTopOf(target) > threshold
    if (next !== scrolled.value) scrolled.value = next
  }

  const unbind = bindScroller(
    el,
    () => {
      if (!raf) raf = requestAnimationFrame(read)
    },
    (t) => {
      target = t
      read()
    },
  )

  onBeforeUnmount(() => {
    unbind()
    if (raf) cancelAnimationFrame(raf)
  })

  return scrolled
}

/**
 * 「向下滚 → 收起；向上滚 → 还原」。
 *
 * 为什么判定的是**方向**而不是位置：苹果这条效应的语义就是方向 —— 手指往下推、
 * 内容往上走，导航让位给内容；往回带一下，导航立刻回来（不必一路滚回顶部）。
 * 位置只能表达"滚了多远"，表达不了"用户此刻是想看更多内容还是想找回导航"。
 *
 * 到顶（≤ threshold）一律还原：否则停在页面顶部还收着标题，读起来像卡住了。
 */
export function useScrollCollapsed(el: Ref<HTMLElement | null>, threshold = 4): Ref<boolean> {
  const collapsed = ref(false)
  let target: Scroller = window
  let raf = 0
  let lastTop = 0
  let primed = false

  function readAt(top: number): void {
    // 首帧只记位置：挂载时页面可能已经在半途（桌面壳刷新、从二级页返回），
    // 那一帧不该被判成「用户正在向下滚」
    if (!primed) {
      primed = true
      lastTop = top
      return
    }
    if (top <= threshold) collapsed.value = false
    else if (top > lastTop) collapsed.value = true
    else if (top < lastTop) collapsed.value = false
    lastTop = top
  }

  function read(): void {
    raf = 0
    readAt(scrollTopOf(target))
  }

  const unbind = bindScroller(
    el,
    () => {
      if (!raf) raf = requestAnimationFrame(read)
    },
    (t) => {
      target = t
      primed = false
      readAt(scrollTopOf(t))
    },
  )

  onBeforeUnmount(() => {
    unbind()
    if (raf) cancelAnimationFrame(raf)
  })

  return collapsed
}
