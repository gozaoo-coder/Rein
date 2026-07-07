<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(defineProps<{
  burned?: number
  goal?: number
}>(), {
  burned: 0,
  goal: 600,
})

const progress = computed(() => Math.min((props.burned / props.goal) * 100, 100))
</script>

<template>
  <div class="calories-card">
    <div class="card-header">
      <span class="card-label">卡路里</span>
      <span class="card-unit">千卡</span>
    </div>
    <div class="card-value-row">
      <span class="stat-value">{{ burned }}</span>
      <span class="goal-text">/ {{ goal }}</span>
    </div>
    <div class="bar-track">
      <div class="bar-fill" :style="{ width: progress + '%' }" />
    </div>
  </div>
</template>

<style scoped>
.calories-card {
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

.card-unit {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.card-value-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1;
}

.goal-text {
  font-size: 14px;
  color: var(--color-text-tertiary);
}

.bar-track {
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--warning-500);
  transition: width 0.6s ease;
}
</style>
