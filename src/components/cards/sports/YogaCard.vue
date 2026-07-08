<script setup lang="ts">
withDefaults(defineProps<{
  duration?: number
  calories?: number
}>(), {
  duration: 0,
  calories: 0,
})
</script>

<template>
  <div class="yoga-card">
    <div class="card-header">
      <span class="card-label">瑜伽</span>
      <i class="bi bi-universal-access" style="font-size:16px"></i>
    </div>
    <div class="card-body">
      <div class="stat-main">
        <span class="stat-value">{{ duration }}</span>
        <span class="stat-unit">分钟</span>
      </div>
    </div>
    <div class="card-footer">
      <span class="calorie-text">{{ calories }} 千卡</span>
    </div>
  </div>
</template>

<style scoped>
.yoga-card {
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

.card-body {
  flex: 1;
  display: flex;
  align-items: center;
}

.stat-main {
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

.stat-unit {
  font-size: 13px;
  color: var(--color-text-tertiary);
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
