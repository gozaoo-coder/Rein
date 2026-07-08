<script setup lang="ts">
/**
 * PairRequestHost — 全局配对请求弹窗宿主
 *
 * 挂载在 App.vue 顶层，监听 usePairRequest 的 current 状态，
 * 用 BottomSheet 弹出配对请求，避免依赖 SyncPage 打开。
 */
import { computed } from "vue";
import BottomSheet from "@/components/ui/BottomSheet.vue";
import { usePairRequest } from "@/composables/usePairRequest";

const { current, responding, respond, close } = usePairRequest();

const visible = computed({
  get: () => current.value !== null,
  set: (v: boolean) => {
    if (!v) close();
  },
});

function truncate(s: string, head = 8, tail = 4): string {
  if (!s) return "--";
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
</script>

<template>
  <BottomSheet
    v-model:visible="visible"
    :visible="visible"
    title="配对请求"
    :detents="['medium']"
    default-detent="medium"
    @close="close"
  >
    <div v-if="current" class="pair-host">
      <div class="pair-icon">
        <i class="bi bi-phone" />
      </div>
      <div class="pair-name">{{ current.from_name }}</div>
      <div class="pair-id">{{ truncate(current.from_id) }}</div>
      <div class="pair-meta" v-if="current.from_ip">
        {{ current.from_ip }}:{{ current.from_port }}
      </div>
      <div class="pair-hint">请求与你的设备配对同步</div>
      <div class="pair-actions">
        <button
          class="pair-btn ghost"
          :disabled="responding"
          @click="respond(false)"
        >
          拒绝
        </button>
        <button
          class="pair-btn primary"
          :disabled="responding"
          @click="respond(true)"
        >
          接受
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.pair-host {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0 var(--space-2);
  text-align: center;
}
.pair-icon {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-full);
  background: var(--color-warm-50, var(--bg-200));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-warm);
  font-size: 32px;
  margin-bottom: var(--space-2);
}
.pair-name {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.pair-id {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.pair-meta {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.pair-hint {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin-top: var(--space-1);
  margin-bottom: var(--space-3);
}
.pair-actions {
  display: flex;
  gap: var(--space-3);
  width: 100%;
  margin-top: var(--space-2);
}
.pair-btn {
  flex: 1;
  padding: var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-immersive);
}
.pair-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pair-btn.ghost {
  background: var(--bg-200);
  color: var(--color-text);
}
.pair-btn.primary {
  background: var(--color-warm);
  color: #fff;
}
</style>
