<script setup lang="ts">
/**
 * ThreeRingCard — 三环数据独立卡片（无边框模式）
 *
 * 4x2 宽卡片，无背景/边框/阴影，直接在页面上显示三环进度
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
    :class="`three-ring--${size}`"
    @click="emit('click')"
  >
    <div class="ring-visual">
      <SemiRingProgress :rings="ringConfigs" />
    </div>
    <div class="ring-metrics">
      <div v-for="(m, i) in ringMetas" :key="i" class="ring-metric">
        <div class="metric-head">
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  cursor: pointer;
  padding: var(--space-3) var(--space-2);
  gap: var(--space-2);
  background: transparent;
  border-radius: var(--radius-lg);
  transition: background var(--dur-fast) var(--ease-immersive);
}
.three-ring-card:active {
  background: var(--bg-100);
}

.ring-visual {
  width: 100%;
  max-width: 280px;
  flex-shrink: 0;
}

.ring-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
  width: 100%;
  max-width: 320px;
}

.ring-metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--space-1) var(--space-2);
}

.metric-head {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ring-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
}

.metric-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.metric-value {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.metric-value .num {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
}
.metric-value .sep {
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}
.metric-value .goal {
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}
</style>
