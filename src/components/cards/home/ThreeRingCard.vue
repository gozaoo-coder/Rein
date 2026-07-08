<script setup lang="ts">
/**
 * ThreeRingCard — 三环数据独立卡片（无边框模式）
 *
 * 4x2 宽卡片，左环右指标的横向布局
 * 点击打开环数据源配置面板
 */
import { computed } from "vue";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useTodoStore } from "@/stores/todoStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import SemiRingProgress from "@/components/charts/SemiRingProgress.vue";
import { resolveRings, ringDisplayText } from "@/data/ringDataResolver";
import { RING_DATA_LABEL } from "@/types/card";
import type { CardSize } from "@/types/card";

defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const layoutStore = useCardLayoutStore();
const health = useHealthDataStore();
const todo = useTodoStore();
const stats = useWorkoutStatsStore();

const stores = { health, todo, stats };

const ringConfigs = computed(() => resolveRings(layoutStore.rings, stores));

const ringMetas = computed(() =>
  layoutStore.rings.map((src) => ({
    source: src,
    label: RING_DATA_LABEL[src],
    text: ringDisplayText(src, stores),
  })),
);
</script>

<template>
  <div
    class="three-ring-card"
    @click="emit('click')"
  >
    <div class="ring-visual">
      <SemiRingProgress :rings="ringConfigs" />
    </div>
    <div class="ring-metrics">
      <div v-for="(m, i) in ringMetas" :key="i" class="ring-metric">
        <div class="metric-row">
          <span class="ring-dot" :style="{ background: ringConfigs[i]?.color }" />
          <span class="metric-label">{{ m.label }}</span>
        </div>
        <div class="metric-value">
          <span class="num">{{ m.text.value }}</span>
          <span class="sep">/</span>
          <span class="goal">{{ m.text.goal }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.three-ring-card {
  display: flex;
  flex-direction: row;
  align-items: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  cursor: pointer;
  padding: var(--space-3) var(--space-4);
  gap: var(--space-4);
  background: transparent;
  border-radius: var(--radius-lg);
  transition: background var(--dur-fast) var(--ease-immersive);
}
.three-ring-card:active {
  background: var(--bg-100);
}

.ring-visual {
  flex: 0 0 45%;
  max-width: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ring-metrics {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ring-metric {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.metric-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ring-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.metric-label {
  font-size: 11px;
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
  letter-spacing: 0.02em;
}

.metric-value {
  display: flex;
  align-items: baseline;
  gap: 3px;
  padding-left: 14px;
}
.metric-value .num {
  font-size: 20px;
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.metric-value .sep {
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  font-weight: var(--fw-light);
}
.metric-value .goal {
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
}
</style>
