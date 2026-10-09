import { onBeforeUnmount } from 'vue'

/**
 * 触屏长按手势：按住不动 LONG_PRESS_MS 毫秒即触发 onFire（行组件拿它弹上下文菜单），
 * 位移超过 MOVE_SLOP 算滚动/拖拽，抬手取消。桌面（细指针）不启用这套语义。
 *
 * **幽灵点击**：长按触发时菜单已经弹出（面板锚定在这一行，指尖底下就是面板的第一项），
 * 而手指抬起时浏览器还会按 touch 序列合成一次 click —— 它不再落在行上，而是落在
 * 菜单身上，把第一项（「多选」）顺手激活。所以触发时要吞掉接下来这一次 click
 * （once + 400ms 自清理，与 system/rubberScroll 的松手吞咽同一手法）。
 */
export function useLongPress(opts: {
  /** 触屏语义是否生效（由 hover / pointer 能力决定，接外接鼠标的平板要能切回桌面语义） */
  isTouch: () => boolean
  /** 长按触发：传锚点元素（触屏没有坐标，菜单锚定到行本身） */
  onFire: (anchor: HTMLElement) => void
}) {
  const LONG_PRESS_MS = 460
  /** 长按期间手指允许的抖动：超过就算滚动/拖拽，取消手势 */
  const MOVE_SLOP = 12
  /** 松手后合成 click 的存活窗口（与 rubberScroll 的 CLICK_SWALLOW_MS 同档） */
  const GHOST_CLICK_MS = 400

  let lpTimer: number | null = null
  let lpX = 0
  let lpY = 0
  /** 长按已触发：随后的 click 要被吃掉，否则会顺手把条目也选中/打开 */
  let lpFired = false

  onBeforeUnmount(() => {
    if (lpTimer !== null) window.clearTimeout(lpTimer)
    lpTimer = null
  })

  /** 吞掉下一次 click：捕获阶段 once，窗口内没等到就自行退场 */
  function swallowGhostClick(): void {
    const swallow = (ev: Event): void => {
      ev.preventDefault()
      ev.stopPropagation()
    }
    document.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), GHOST_CLICK_MS)
  }

  function down(ev: PointerEvent): void {
    if (!opts.isTouch() || ev.pointerType === 'mouse') return
    // 元素在定时器外先取：事件对象派发完后 currentTarget 会归零
    const el = ev.currentTarget as HTMLElement | null
    lpFired = false
    lpX = ev.clientX
    lpY = ev.clientY
    lpTimer = window.setTimeout(() => {
      lpTimer = null
      lpFired = true
      swallowGhostClick()
      try {
        navigator.vibrate?.(8)
      } catch {
        /* 设备不支持则无感 */
      }
      if (el) opts.onFire(el)
    }, LONG_PRESS_MS)
  }

  function move(ev: PointerEvent): void {
    if (lpTimer === null) return
    if (Math.abs(ev.clientX - lpX) > MOVE_SLOP || Math.abs(ev.clientY - lpY) > MOVE_SLOP) {
      window.clearTimeout(lpTimer)
      lpTimer = null
    }
  }

  function cancel(): void {
    if (lpTimer !== null) {
      window.clearTimeout(lpTimer)
      lpTimer = null
    }
  }

  /** 行的 click 入口：长按已触发时这一次 click 是长按的收尾，不能再触发选中/打开 */
  function click(ev: MouseEvent, onActivate: (ev: MouseEvent) => void): void {
    if (lpFired) {
      lpFired = false
      return
    }
    onActivate(ev)
  }

  return { down, move, cancel, click }
}
