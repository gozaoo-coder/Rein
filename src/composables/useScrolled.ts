import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/**
 * 元素是否已滚离顶部（滚动位置 > threshold）。
 *
 * 两种壳的滚动容器不一样：移动端滚文档（window / html），桌面工作台滚 .desk-main。
 * 挂载时沿父链找最近的滚动祖先（overflow-y: auto|scroll），找不到就退回 window——
 * 页面把标题压成 fixed 就会在桌面壳里跑到导航轨与信息栏底下，所以这里用 sticky
 * 贴容器顶，探测也必须跟着容器的实际身份走，不能写死 window。
 *
 * 读值走 rAF 合并：滚动事件一帧可以来好几次，只有一帧一次的读值才有意义。
 */
export function useScrolled(el: Ref<HTMLElement | null>, threshold = 4): Ref<boolean> {
  const scrolled = ref(false)
  let target: HTMLElement | Window = window
  let bound = false
  let raf = 0

  function read(): void {
    raf = 0
    const top = target === window ? window.scrollY : (target as HTMLElement).scrollTop
    const next = top > threshold
    if (next !== scrolled.value) scrolled.value = next
  }

  function onScroll(): void {
    if (!raf) raf = requestAnimationFrame(read)
  }

  function resolveScroller(): HTMLElement | Window {
    let node = el.value?.parentElement ?? null
    while (node) {
      const { overflowY } = getComputedStyle(node)
      if (overflowY === 'auto' || overflowY === 'scroll') return node
      node = node.parentElement
    }
    return window
  }

  function bind(): void {
    const next = resolveScroller()
    // 初值也是 window：不能只比对象，否则「解析结果就是 window」会一次都不挂监听
    if (bound && next === target) return
    if (bound) target.removeEventListener('scroll', onScroll)
    target = next
    target.addEventListener('scroll', onScroll, { passive: true })
    bound = true
    read()
  }

  // 壳可能换（桌面三窗格 ⇄ 移动窄栏），换完滚动容器就不是同一个了
  watch(() => el.value, bind)
  onMounted(bind)
  onBeforeUnmount(() => {
    target.removeEventListener('scroll', onScroll)
    if (raf) cancelAnimationFrame(raf)
  })

  return scrolled
}
