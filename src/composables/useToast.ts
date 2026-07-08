/**
 * useToast — 轻量全局提示系统
 * 用于在网络错误、配置错误等场景向用户显示短暂气泡提示。
 */
import { ref } from "vue";

export interface ToastItem {
  id: number;
  type: "error" | "warning" | "info" | "success";
  message: string;
  duration: number;
}

const toasts = ref<ToastItem[]>([]);
let nextId = 1;

function push(type: ToastItem["type"], message: string, duration = 4000): number {
  const id = nextId++;
  toasts.value.push({ id, type, message, duration });
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }
  return id;
}

export function dismiss(id: number): void {
  const idx = toasts.value.findIndex((t) => t.id === id);
  if (idx >= 0) toasts.value.splice(idx, 1);
}

export function useToast() {
  return {
    toasts,
    error: (msg: string, dur?: number) => push("error", msg, dur),
    warning: (msg: string, dur?: number) => push("warning", msg, dur),
    info: (msg: string, dur?: number) => push("info", msg, dur),
    success: (msg: string, dur?: number) => push("success", msg, dur),
    dismiss,
  };
}
