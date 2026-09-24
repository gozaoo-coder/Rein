import { onBeforeUnmount, onMounted, type Ref } from 'vue'

import { motionRich } from '@/system/motion'

/**
 * 按压定向光晕（丰富档专用）：把**触点位置**写进 `--gx` / `--gy`，由 CSS 在背景里
 * 画一圈跟着手指的高光 —— 苹果说的「在触摸点产生环境折射」的那一半。
 *
 * 只做位置，不做显隐：显隐交给 `:active`（CSS）。理由是苹果对这条反馈的要求是
 * **即时**，而 `:active` 是 pointer-down 当帧生效的；反过来让 JS 去管开关，
 * 就会多一段"等一个事件回来才亮"的延迟，读起来像卡了一下。
 *
 * 为什么要挂监听在容器上、而不是每个按钮自己绑：命中区元素动辄几十个（Dock 页签、
 * 分段控件的每一段），一个容器一份监听、按 selector 就近匹配，事件总数与元素数无关。
 * 捕获阶段监听也顺带绕开按钮自己 stopPropagation 的可能。
 *
 * 坐标落在**被点亮的那一个元素**上（不是容器）：CSS 的 background-position 是相对
 * 元素自己那一格算的，写在容器上会让每一格的光晕都跑到左边去。
 *
 * 读值走 rAF 合并：pointermove 一帧可以来好几次，只有一帧一次才算得准。
 */
export function usePressGlow(root: Ref<HTMLElement | null>, selector: string): void {
  let raf = 0
  let lit: HTMLElement | null = null
  let last: PointerEvent | null = null

  function paint(): void {
    raf = 0
    const e = last
    const t = lit
    if (!e || !t) return
    const r = t.getBoundingClientRect()
    t.style.setProperty('--gx', `${(e.clientX - r.left).toFixed(1)}px`)
    t.style.setProperty('--gy', `${(e.clientY - r.top).toFixed(1)}px`)
  }

  function onDown(e: PointerEvent): void {
    if (!motionRich.value) return
    const target = e.target
    if (!(target instanceof Element)) return
    const t = target.closest<HTMLElement>(selector)
    if (!t) return
    lit = t
    last = e
    if (!raf) raf = requestAnimationFrame(paint)
  }

  /** 手指在按住的元素里滑动时，光晕跟着走；滑出这一格就散掉 ——
   *  不跨格抢，否则按住横向拖会把整排按钮依次点亮。 */
  function onMove(e: PointerEvent): void {
    const t = lit
    if (!t) return
    const target = e.target
    if (target instanceof Node && !t.contains(target)) {
      release()
      return
    }
    last = e
    if (!raf) raf = requestAnimationFrame(paint)
  }

  function release(): void {
    lit = null
    last = null
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  function bind(on: boolean): void {
    const el = root.value
    if (!el) return
    if (on) {
      el.addEventListener('pointerdown', onDown, true)
      el.addEventListener('pointermove', onMove, true)
      el.addEventListener('pointerup', release, true)
      el.addEventListener('pointercancel', release, true)
      el.addEventListener('pointerleave', release, true)
    } else {
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('pointermove', onMove, true)
      el.removeEventListener('pointerup', release, true)
      el.removeEventListener('pointercancel', release, true)
      el.removeEventListener('pointerleave', release, true)
    }
  }

  onMounted(() => bind(true))

  onBeforeUnmount(() => {
    bind(false)
    release()
  })
}