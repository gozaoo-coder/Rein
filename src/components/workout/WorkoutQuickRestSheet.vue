<script setup lang="ts">
/**
 * WorkoutQuickRestSheet — 小休息预设选择面板
 * 30s / 60s / 90s / 120s / 150s 五档预设
 */
import { QUICK_REST_PRESETS } from "@/types/workout";

defineEmits<{
  (e: "select", seconds: number): void;
  (e: "close"): void;
}>();

const PRESET_LABELS: Record<number, string> = {
  30: "30秒",
  60: "1分钟",
  90: "1.5分钟",
  120: "2分钟",
  150: "2.5分钟",
};

const PRESET_HINT: Record<number, string> = {
  30: "短暂喘息",
  60: "标准休息",
  90: "充分恢复",
  120: "深度休息",
  150: "完全恢复",
};
</script>

<template>
  <div class="qr-mask" @click.self="$emit('close')">
    <div class="qr-sheet clean-card">
      <div class="qr-handle" />
      <h3 class="qr-title">小休息一会</h3>
      <p class="qr-sub">选择休息时长，计时结束后自动恢复训练</p>

      <div class="qr-grid">
        <button
          v-for="s in QUICK_REST_PRESETS"
          :key="s"
          class="qr-preset"
          @click="$emit('select', s)"
        >
          <div class="qr-preset-time">{{ PRESET_LABELS[s] }}</div>
          <div class="qr-preset-hint">{{ PRESET_HINT[s] }}</div>
        </button>
      </div>

      <button class="qr-cancel" @click="$emit('close')">取消</button>
    </div>
  </div>
</template>

<style scoped>
.qr-mask {
  position: fixed;
  inset: 0;
  z-index: 320;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  animation: qr-fade 0.2s ease;
}
@keyframes qr-fade { from { opacity: 0 } to { opacity: 1 } }

.qr-sheet {
  width: 100%;
  max-width: 480px;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-3) var(--space-5) calc(env(safe-area-inset-bottom, 0px) + var(--space-5));
  background: rgba(255, 255, 255, 0.96);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  animation: qr-slide 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes qr-slide {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

.qr-handle {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--color-divider);
  margin: 0 auto var(--space-3);
}

.qr-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  text-align: center;
  margin: 0;
}
.qr-sub {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
  margin: 4px 0 var(--space-4);
}

.qr-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
@media (max-width: 380px) {
  .qr-grid { grid-template-columns: repeat(3, 1fr); }
}

.qr-preset {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--space-3) var(--space-2);
  background: rgba(124, 108, 247, 0.08);
  border: 1px solid rgba(124, 108, 247, 0.15);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
}
.qr-preset:active {
  transform: scale(0.94);
  background: rgba(124, 108, 247, 0.18);
}
.qr-preset-time {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: #7c6cf7;
}
.qr-preset-hint {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.qr-cancel {
  width: 100%;
  padding: var(--space-3);
  background: var(--bg-200);
  color: var(--color-text-secondary);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.qr-cancel:active { opacity: 0.7; }
</style>
