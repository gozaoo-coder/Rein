/** 轻量全局 Toast：模块级单例，App.vue 中挂载 <ToastHost/> 展示。 */

import { reactive } from 'vue'

/** 可选的交互动作（如「撤销」），渲染为 toast 内的按钮 */
export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastItem {
  id: number
  text: string
  action?: ToastAction
}

const toasts = reactive<ToastItem[]>([])
let seq = 0

export function useToast() {
  function toast(text: string, opts?: { action?: ToastAction; duration?: number }): void {
    const id = ++seq
    toasts.push({ id, text, action: opts?.action })
    // 带动作的 toast 停留更久，给手指留出点击时间
    const ms = opts?.duration ?? (opts?.action ? 5000 : 2000)
    setTimeout(() => {
      const i = toasts.findIndex((t) => t.id === id)
      if (i !== -1) toasts.splice(i, 1)
    }, ms)
  }
  return { toasts, toast }
}
