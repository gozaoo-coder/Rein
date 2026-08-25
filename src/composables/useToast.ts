/** 轻量全局 Toast：模块级单例，App.vue 中挂载 <ToastHost/> 展示。 */

import { reactive } from 'vue'

export interface ToastItem {
  id: number
  text: string
}

const toasts = reactive<ToastItem[]>([])
let seq = 0

export function useToast() {
  function toast(text: string): void {
    const id = ++seq
    toasts.push({ id, text })
    setTimeout(() => {
      const i = toasts.findIndex((t) => t.id === id)
      if (i !== -1) toasts.splice(i, 1)
    }, 2000)
  }
  return { toasts, toast }
}
