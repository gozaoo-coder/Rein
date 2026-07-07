<script setup lang="ts">
withDefaults(defineProps<{
  data?: { day: string; value: number }[]
}>(), {
  data: () => [],
})
</script>

<template>
  <div class="weekly-summary-card">
    <div class="card-header">
      <span class="card-label">本周活动</span>
      <span class="card-sub">7天概览</span>
    </div>
    <div class="chart-area">
      <div class="bar-chart">
        <div v-for="item in data" :key="item.day" class="bar-col">
          <div class="bar-track">
            <div
              class="bar-fill"
              :style="{ height: item.value + '%' }"
            />
          </div>
          <span class="bar-label">{{ item.day }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.weekly-summary-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
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
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.card-sub {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.chart-area {
  flex: 1;
  display: flex;
  align-items: flex-end;
}

.bar-chart {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  width: 100%;
  height: 100%;
  padding-bottom: var(--space-5);
  box-sizing: border-box;
}

.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  height: 100%;
  justify-content: flex-end;
}

.bar-track {
  width: 100%;
  max-width: 32px;
  height: 100%;
  border-radius: var(--radius-sm);
  background: var(--bg-200);
  overflow: hidden;
  position: relative;
}

.bar-fill {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  border-radius: var(--radius-sm);
  background: var(--brand-500);
  transition: height 0.6s ease;
}

.bar-label {
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
