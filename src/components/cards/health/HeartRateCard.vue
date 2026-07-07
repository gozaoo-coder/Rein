<script setup lang="ts">
withDefaults(defineProps<{
  bpm?: number
  status?: "low" | "normal" | "high"
}>(), {
  bpm: 72,
  status: "normal",
})
</script>

<template>
  <div class="heart-rate-card">
    <div class="card-header">
      <span class="card-label">心率</span>
      <span class="status-badge" :class="status">{{ status === 'normal' ? '正常' : status === 'low' ? '偏低' : '偏高' }}</span>
    </div>
    <div class="card-body">
      <div class="pulse-dot" />
      <div class="bpm-display">
        <span class="bpm-value">{{ bpm }}</span>
        <span class="bpm-unit">BPM</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.heart-rate-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  height: 100%;
  box-sizing: border-box;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.status-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-full);
}

.status-badge.normal {
  background: var(--success-500);
  color: white;
}

.status-badge.low {
  background: var(--brand-500);
  color: white;
}

.status-badge.high {
  background: var(--danger-500);
  color: white;
}

.card-body {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
}

.pulse-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--danger-500);
  animation: pulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.5); opacity: 0.5; }
}

.bpm-display {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.bpm-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1;
}

.bpm-unit {
  font-size: 13px;
  color: var(--color-text-tertiary);
}
</style>
