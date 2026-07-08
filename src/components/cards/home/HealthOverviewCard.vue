<script setup lang="ts">
/**
 * HealthOverviewCard — 健康概览卡（沉浸光感）
 *
 * 2x2: 3 个可配置半环 + 指标行
 * 4x2: 同上 + BMI 详情行
 */
import { computed } from "vue";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useTodoStore } from "@/stores/todoStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import SemiRingProgress from "@/components/charts/SemiRingProgress.vue";
import { resolveRings, ringDisplayText } from "@/data/ringDataResolver";
import { BMI_CATEGORY_LABEL, classifyBmi } from "@/types/health";
import { RING_DATA_LABEL } from "@/types/card";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
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

const bmi = computed(() => health.currentBmi);
const bmiCategory = computed(() => (bmi.value ? classifyBmi(bmi.value) : null));
const isWide = computed(() => props.size === "4x2");
</script>

<template>
  <div
    class="home-card clean-card health-card"
    :class="`home-card--${size}`"
    @click="emit('click')"
  >
    <div class="card-head">
      <span class="title-icon title-icon--warm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z" />
        </svg>
      </span>
      <span class="card-title">健康概览</span>
    </div>

    <div class="ring-wrap">
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

    <div v-if="isWide && bmi" class="bmi-row">
      <div class="bmi-left">
        <span class="bmi-label">BMI</span>
        <span class="bmi-num">{{ bmi.toFixed(1) }}</span>
      </div>
      <span class="bmi-badge" :class="`bmi-badge--${bmiCategory}`">
        {{ bmiCategory ? BMI_CATEGORY_LABEL[bmiCategory] : "" }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.health-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  text-align: left;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive);
}
.health-card:active { transform: scale(0.98); }
.health-card:hover { box-shadow: var(--shadow-card-hover); }

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  color: #fff;
}
.title-icon--warm { background: var(--color-warm); }

.card-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.ring-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

.ring-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
}

.ring-metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-md);
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
  color: var(--color-text-tertiary);
}

.metric-value {
  display: flex;
  align-items: baseline;
  gap: 2px;
  font-size: var(--text-sm);
}
.metric-value .num {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.metric-value .sep {
  color: var(--color-text-tertiary);
}
.metric-value .goal {
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}

.bmi-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.bmi-left {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.bmi-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.bmi-num {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.bmi-badge {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
}
.bmi-badge--normal { background: var(--success-50); color: var(--success-600); }
.bmi-badge--underweight { background: var(--warning-50); color: var(--warning-600); }
.bmi-badge--overweight { background: var(--warning-50); color: var(--warning-600); }
.bmi-badge--obese { background: var(--danger-50); color: var(--danger-600); }
</style>
