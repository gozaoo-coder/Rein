<script setup lang="ts">
withDefaults(defineProps<{
  distance?: number
  pace?: string
  calories?: number
}>(), {
  distance: 0,
  pace: "0'00\"",
  calories: 0,
})
</script>

<template>
  <div class="running-card">
    <div class="card-header">
      <span class="card-label">跑步</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="5" r="2" />
        <path d="M7 21l3-7 3 3 4-5-2-1-2.5 3-2.5-3-3 7z" />
      </svg>
    </div>
    <div class="card-stats">
      <div class="stat-item">
        <span class="stat-value">{{ distance }}</span>
        <span class="stat-unit">公里</span>
      </div>
      <div class="stat-divider" />
      <div class="stat-item small">
        <span class="stat-label">配速</span>
        <span class="stat-value">{{ pace }}</span>
      </div>
    </div>
    <div class="card-footer">
      <span class="calorie-text">{{ calories }} 千卡</span>
    </div>
  </div>
</template>

<style scoped>
.running-card {
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

.calorie-text {
  font-size: 12px;
  color: var(--color-text-tertiary);
}
</style>
