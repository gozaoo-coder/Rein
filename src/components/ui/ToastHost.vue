<script setup lang="ts">
/**
 * ToastHost — 全局提示气泡容器
 * 挂载在 App 根节点，从 useToast 单例读取消息列表。
 * 入场/退场动画由 useAnime（anime.js v4）驱动，替代原 CSS keyframes。
 */
import { ref, watch } from "vue";
import { useToast } from "@/composables/useToast";
import { useAnime } from "@/composables/useAnime";

const { toasts, dismiss } = useToast();
// 全局单例，不传 rootRef（使用 document）
const { enter, exit, reduced } = useAnime();

const icons: Record<string, string> = {
  error: "x-circle-fill",
  warning: "exclamation-triangle-fill",
  info: "info-circle-fill",
  success: "check-circle-fill",
};

/** 收集每个 toast 元素：id → el */
const toastEls = ref<Map<number, HTMLElement>>(new Map());
/** 正在退场的 toast id，防止重复触发 */
const exiting = new Set<number>();
/** 已入场过的 toast id，避免重复播放 enter */
const knownIds = new Set<number>();

function bindToastRef(id: number): (el: unknown) => void {
  return (el: unknown) => {
    if (el instanceof HTMLElement) {
      toastEls.value.set(id, el);
    } else {
      toastEls.value.delete(id);
    }
  };
}

/** 新 toast 入场：useAnime.enter 的 fadeUp variant 只设置目标值（from 取当前），
 *  故先手动设置起点 opacity:0 / translateY:12px，再调用 enter 播放 12→0。 */
function playEnter(el: HTMLElement): void {
  if (reduced.value) return;
  el.style.opacity = "0";
  el.style.transform = "translateY(12px)";
  enter(el, "fadeUp", { springName: "smooth", duration: 240 });
}

/** 点击 dismiss：先播放 fade 退场，Promise 完成后再从 store 真正移除。 */
async function handleDismiss(id: number): Promise<void> {
  if (exiting.has(id)) return;
  exiting.add(id);
  const el = toastEls.value.get(id);
  if (el && !reduced.value) {
    await exit(el, "fade", { duration: 200 });
  }
  exiting.delete(id);
  dismiss(id);
}

// 监听 toasts 长度变化：为新出现的 toast 播放入场动画，并清理已移除 toast 的状态。
watch(
  () => toasts.value.length,
  () => {
    for (const t of toasts.value) {
      if (knownIds.has(t.id)) continue;
      knownIds.add(t.id);
      const el = toastEls.value.get(t.id);
      if (el) playEnter(el);
    }
    const currentIds = new Set(toasts.value.map((t) => t.id));
    for (const id of [...knownIds]) {
      if (!currentIds.has(id)) knownIds.delete(id);
    }
  },
  { flush: "post", immediate: true },
);
</script>

<template>
  <div class="toast-host">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="toast"
      :class="t.type"
      :ref="bindToastRef(t.id)"
      @click="handleDismiss(t.id)"
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
</style>
