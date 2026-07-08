<script setup lang="ts">
withDefaults(defineProps<{
  totalSets?: number
  totalReps?: number
}>(), {
  totalSets: 0,
  totalReps: 0,
})
</script>

<template>
  <div class="strength-card">
    <div class="card-header">
      <span class="card-label">力量训练</span>
      <i class="bi bi-bullseye" style="font-size:16px"></i>
    </div>
    <div class="card-stats">
      <div class="stat-item">
        <span class="stat-value">{{ totalSets }}</span>
        <span class="stat-unit">组</span>
      </div>
      <div class="stat-divider" />
      <div class="stat-item">
        <span class="stat-value">{{ totalReps }}</span>
        <span class="stat-unit">次</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strength-card {
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
  gap: var(--space-4);
  flex: 1;
}

.stat-item {
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

.stat-divider {
  width: 1px;
  height: 28px;
  background: var(--color-divider);
}
</style>
