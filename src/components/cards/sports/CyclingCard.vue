<script setup lang="ts">
withDefaults(defineProps<{
  distance?: number
  speed?: number
  time?: string
}>(), {
  distance: 0,
  speed: 0,
  time: "0:00",
})
</script>

<template>
  <div class="cycling-card">
    <div class="card-header">
      <span class="card-label">骑行</span>
      <i class="bi bi-bicycle" style="font-size:16px"></i>
    </div>
    <div class="card-stats">
      <div class="stat-item">
        <span class="stat-value">{{ distance }}</span>
        <span class="stat-unit">公里</span>
      </div>
      <div class="stat-divider" />
      <div class="stat-item small">
        <span class="stat-label">时速</span>
        <span class="stat-value">{{ speed }}</span>
      </div>
    </div>
    <div class="card-footer">
      <span class="time-text">{{ time }}</span>
    </div>
  </div>
</template>

<style scoped>
.cycling-card {
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
  color: var(--color-text-secondary);
}

.card-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.card-stats {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
}

.stat-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.stat-item.small {
  flex-direction: column;
  gap: 2px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1;
}

.stat-unit {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.stat-label {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.stat-divider {
  width: 1px;
  height: 24px;
  background: var(--color-divider);
}

.card-footer {
  display: flex;
  align-items: center;
}

.time-text {
  font-size: 12px;
  color: var(--color-text-tertiary);
}
</style>
