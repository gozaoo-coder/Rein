<script setup lang="ts">
/**
 * ToastHost — 全局提示气泡容器
 * 挂载在 App 根节点，从 useToast 单例读取消息列表。
 */
import { useToast } from "@/composables/useToast";

const { toasts, dismiss } = useToast();

const icons: Record<string, string> = {
  error: "x-circle-fill",
  warning: "exclamation-triangle-fill",
  info: "info-circle-fill",
  success: "check-circle-fill",
};
</script>

<template>
  <div class="toast-host">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="toast"
      :class="t.type"
      @click="dismiss(t.id)"
    >
      <i :class="['bi', `bi-${icons[t.type]}`]" style="font-size:16px"></i>
      <span class="toast-msg">{{ t.message }}</span>
    </div>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + var(--space-3, 12px));
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  pointer-events: none;
  max-width: calc(100vw - 32px);
}
.toast {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: var(--radius-full, 999px);
  background: var(--card-bg, rgba(255, 255, 255, 0.95));
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  backdrop-filter: blur(24px) saturate(180%);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  font-size: var(--text-sm, 14px);
  font-weight: var(--fw-medium, 500);
  color: var(--color-text, #1d1d1f);
  pointer-events: auto;
  cursor: pointer;
  animation: toast-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
  word-break: break-word;
  max-width: 100%;
}
.toast.error {
  background: var(--danger-50, #ffe7e2);
  color: var(--danger-700, #a3170a);
  border: 1px solid var(--danger-200, #ffb4a8);
}
.toast.warning {
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  color: var(--color-warm, #ff9500);
  border: 1px solid var(--warm-200, #ffd9b3);
}
.toast.info {
  background: var(--bg-100, rgba(0, 0, 0, 0.04));
  color: var(--color-text, #1d1d1f);
}
.toast.success {
  background: rgba(52, 199, 89, 0.12);
  color: #1a7d34;
  border: 1px solid rgba(52, 199, 89, 0.3);
}
.toast-msg {
  flex: 1;
  line-height: 1.4;
}
@keyframes toast-in {
  from { opacity: 0; transform: translateY(-12px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
