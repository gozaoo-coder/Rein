<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(defineProps<{
  current?: number
  target?: number
}>(), {
  current: 0,
  target: 8,
})

const progress = computed(() => Math.min((props.current / props.target) * 100, 100))
</script>

<template>
  <div class="hydration-card">
    <div class="card-header">
      <span class="card-label">饮水</span>
      <i class="bi bi-droplet-fill water-icon" style="font-size:16px"></i>
    </div>
    <div class="card-body">
      <div class="glass-display">
        <span class="glass-value">{{ current }}</span>
        <span class="glass-target">/ {{ target }} 杯</span>
      </div>
    </div>
    <div class="bar-track">
      <div class="bar-fill" :style="{ width: progress + '%' }" />
    </div>
  </div>
</template>

<style scoped>
.hydration-card {
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

.water-icon {
  color: var(--brand-400);
}

.card-body {
  flex: 1;
  display: flex;
  align-items: center;
}

.glass-display {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.glass-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1;
}

.glass-target {
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
  background: var(--brand-500);
  transition: width 0.6s ease;
}
</style>
