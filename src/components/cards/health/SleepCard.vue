<script setup lang="ts">
withDefaults(defineProps<{
  hours?: number
  quality?: "poor" | "fair" | "good" | "excellent"
}>(), {
  hours: 0,
  quality: "good",
})

const qualityMap: Record<string, string> = {
  poor: "差",
  fair: "一般",
  good: "良好",
  excellent: "优秀",
}
</script>

<template>
  <div class="sleep-card">
    <div class="card-header">
      <span class="card-label">睡眠</span>
      <i class="bi bi-moon-stars-fill moon-icon" style="font-size:16px"></i>
    </div>
    <div class="card-body">
      <span class="hours-value">{{ hours }}</span>
      <span class="hours-unit">小时</span>
    </div>
    <div class="quality-row">
      <div class="quality-dots">
        <span class="dot" :class="{ active: ['fair','good','excellent'].includes(quality) }" />
        <span class="dot" :class="{ active: ['good','excellent'].includes(quality) }" />
        <span class="dot" :class="{ active: quality === 'excellent' }" />
      </div>
      <span class="quality-text">{{ qualityMap[quality] }}</span>
    </div>
  </div>
</template>

<style scoped>
.sleep-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
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

.moon-icon {
  color: var(--brand-400);
}

.card-body {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.hours-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1;
}

.hours-unit {
  font-size: 13px;
  color: var(--color-text-tertiary);
}

.quality-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.quality-dots {
  display: flex;
  gap: 4px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-300);
  transition: background 0.3s ease;
}

.dot.active {
  background: var(--brand-500);
}

.quality-text {
  font-size: 12px;
  color: var(--color-text-tertiary);
}
</style>
