/**
 * 框选（橡皮筋）。
 *
 * 只在**细指针**（鼠标）上启用：触屏拖拽要留给滚动，抢过来做选择会让人以为页面卡住。
 *
 * 命中判定读的是**DOM 矩形**而不是自己算行位置：虚拟滚动下只有可见行存在，
 * 而框选能碰到的也只可能是可见行 —— 所以「可见行 ∩ 方框」既准确又便宜。
 * 每行带 `data-item-id`（FileRow/FileTile 都写了），命中后直接拿稳定 id 去选。
 */

import { ref, type Ref } from 'vue'

export interface BandRect {
  /** 内容坐标系（已加回滚动偏移），画在 .scroll 里跟着内容走 */
  left: number
  top: number
  width: number
  height: number
}

export interface MarqueeApi {
  /** 正在拖出的方框（null = 没在框选） */
  rect: Ref<BandRect | null>
  /** 按下：target 落在行上就忽略（那是点选手势） */
  start(ev: PointerEvent, host: HTMLElement | null, onDone: (ids: string[], additive: boolean) => void, onEmptyClick: () => void): void
}

export function useMarquee(): MarqueeApi {
  const rect = ref<BandRect | null>(null)

  function start(
    ev: PointerEvent,
    host: HTMLElement | null,
    onDone: (ids: string[], additive: boolean) => void,
    onEmptyClick: () => void,
  ): void {
    // 触屏 / 手写笔不启用；落在行或交互控件上也不启用
    if (!host || ev.pointerType !== 'mouse' || ev.button !== 0) return
    const target = ev.target as HTMLElement | null
    if (target?.closest('[role="option"]') || target?.closest('button') || target?.closest('input')) return

    const additive = ev.ctrlKey || ev.metaKey
    const scrollTop = host.scrollTop
    const hostRect = host.getBoundingClientRect()
    const startX = ev.clientX - hostRect.left + host.scrollLeft
    const startY = ev.clientY - hostRect.top + scrollTop
    let moved = false

    const move = (e: PointerEvent): void => {
      const x = e.clientX - hostRect.left + host.scrollLeft
      const y = e.clientY - hostRect.top + host.scrollTop
      if (!moved && Math.abs(x - startX) < 4 && Math.abs(y - startY) < 4) return
      moved = true
      rect.value = {
        left: Math.min(startX, x),
        top: Math.min(startY, y),
        width: Math.abs(x - startX),
        height: Math.abs(y - startY),
      }
      // 边拖边选：让用户看到「哪些会被选中」，而不是松手才知道
      onDone(hitTest(host, rect.value, scrollTop), additive)
    }

    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const band = rect.value
      rect.value = null
      if (!moved) {
        // 空白处单击 = 取消选择（与真实文件管理器一致）
        if (!additive) onEmptyClick()
        return
      }
      if (band) onDone(hitTest(host, band, scrollTop), additive)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    ev.preventDefault()
  }

  return { rect, start }
}

/** 方框命中的条目 id。矩形都换算到**内容坐标**（加上当时的 scrollTop）再比。 */
function hitTest(host: HTMLElement, band: BandRect, scrollTop: number): string[] {
  const hostRect = host.getBoundingClientRect()
  const out: string[] = []
  for (const el of host.querySelectorAll<HTMLElement>('[role="option"][data-item-id]')) {
    const r = el.getBoundingClientRect()
    const top = r.top - hostRect.top + scrollTop
    const left = r.left - hostRect.left + host.scrollLeft
    const overlap =
      left < band.left + band.width &&
      left + r.width > band.left &&
      top < band.top + band.height &&
      top + r.height > band.top
    if (overlap) {
      const id = el.dataset.itemId
      if (id) out.push(id)
    }
  }
  return out
}
