<script setup lang="ts">
/**
 * BodyFatCurveCard — 体脂曲线卡
 *
 * 2x1: 当前体脂率 + 较上次差值（compact）
 * 2x2 / 4x2: 折线图（近 60 天）+ 当前值 + delta
 */
import { computed } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import LineChart from "@/components/charts/LineChart.vue";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useHealthDataStore();

const currentFat = computed<number | undefined>(
  () => store.latestBodyMetrics?.bodyFatPercent,
);

const fatText = computed(() =>
  currentFat.value != null ? currentFat.value.toFixed(1) : "--",
);

// ===== 近 60 天趋势 =====
const DAY_MS = 86400000;

const trend = computed(() => {
  const now = Date.now();
  const since = now - 60 * DAY_MS;
  const items = store.bodyMetrics
    .filter((r) => r.bodyFatPercent != null && r.timestamp >= since)
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  return items;
});

const chartData = computed(() =>
  trend.value.map((r) => r.bodyFatPercent as number),
);
const chartLabels = computed(() =>
  trend.value.map((r) => {
    const d = new Date(r.timestamp);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }),
);

const chartRange = computed(() => {
  const arr = chartData.value;
  if (arr.length === 0) return { yMin: undefined, yMax: undefined };
  if (arr.length === 1) {
    const v = arr[0];
    return { yMin: v - 2, yMax: v + 2 };
  }
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  return { yMin: min - 1, yMax: max + 1 };
});

const chartHeight = computed(() => (props.size === "4x2" ? 90 : 56));

const hasData = computed(() => chartData.value.length > 0);

// 最新与上一条差值
const latestDelta = computed<{ dir: "up" | "down"; abs: string } | null>(() => {
  const arr = trend.value;
  if (arr.length < 2) return null;
  const cur = arr[arr.length - 1].bodyFatPercent;
  const prev = arr[arr.length - 2].bodyFatPercent;
  if (cur == null || prev == null) return null;
  const d = cur - prev;
  if (Math.abs(d) < 0.05) return null;
  return {
    dir: d > 0 ? "up" : "down",
    abs: Math.abs(d).toFixed(1),
  };
});

const isCompact = computed(() => props.size === "2x1");
</script>

<template>
  <div
    class="home-card clean-card bf-card"
    :class="[`home-card--${size}`, { 'is-compact': isCompact }]"
    @click="emit('click')"
  >
    <!-- 2x1：当前体脂 + 标签 -->
    <div v-if="size === '2x1'" class="body-2x1">
      <div class="left-block">
        <div class="sub-label">当前体脂率</div>
        <div class="fat-main">
          <span class="fat-num">{{ fatText }}</span>
          <span class="fat-unit">%</span>
        </div>
        <span
          v-if="latestDelta"
          class="delta"
          :class="latestDelta.dir === 'up' ? 'delta--up' : 'delta--down'"
        >
          <i
            :class="latestDelta.dir === 'up' ? 'bi bi-arrow-up' : 'bi bi-arrow-down'"
            style="font-size:10px"
          ></i>
          {{ latestDelta.abs }}%
        </span>
      </div>
      <span class="title-icon title-icon--purple">
        <i class="bi bi-graph-up-arrow" style="font-size:14px"></i>
      </span>
    </div>

    <!-- 2x2 / 4x2：标题 + 折线图 -->
    <template v-else>
      <div class="card-head">
        <span class="title-icon title-icon--purple">
          <i class="bi bi-graph-up-arrow" style="font-size:12px"></i>
        </span>
        <span class="card-title">体脂率</span>
      </div>

      <div class="fat-now-row">
        <div class="fat-main">
          <span class="fat-num fat-num--md">{{ fatText }}</span>
          <span class="fat-unit">%</span>
        </div>
        <span
          v-if="latestDelta"
          class="delta"
          :class="latestDelta.dir === 'up' ? 'delta--up' : 'delta--down'"
        >
          <i
            :class="latestDelta.dir === 'up' ? 'bi bi-arrow-up' : 'bi bi-arrow-down'"
            style="font-size:10px"
          ></i>
          {{ latestDelta.abs }}%
        </span>
      </div>

      <div v-if="hasData" class="chart-wrap" :style="{ height: chartHeight + 'px' }">
        <LineChart
          :data="chartData"
          :labels="chartLabels"
          :color="'var(--icon-purple)'"
          :show-area="true"
          :show-dots="true"
          :show-x-axis="true"
          :y-min="chartRange.yMin"
          :y-max="chartRange.yMax"
          :height="chartHeight"
          :stroke-width="2"
          :smooth="true"
        />
      </div>
      <div v-else class="empty">无数据</div>
    </template>
  </div>
</template>

<style scoped>
.bf-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  text-align: left;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive);
}
.bf-card:active { transform: scale(0.98); }
.bf-card:hover { box-shadow: var(--shadow-card-hover); }

.bf-card.is-compact {
  padding: var(--space-2) var(--space-3);
  gap: var(--space-1);
}

/* ===== 2x1 ===== */
.body-2x1 {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 0;
}

.left-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.sub-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.fat-main {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.fat-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--icon-purple);
  line-height: 1;
}

.fat-num--md {
  font-size: var(--text-xl);
}

.fat-unit {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}

/* ===== 2x2 / 4x2 ===== */
.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  color: #fff;
  background: var(--icon-purple);
}

.card-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
  flex: 1;
  min-width: 0;
}

.fat-now-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.delta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
}
.delta--up { background: rgba(239, 68, 68, 0.12); color: var(--danger-500); }
.delta--down { background: rgba(45, 177, 92, 0.12); color: var(--success-600); }

.chart-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}
.chart-wrap :deep(.line-chart-wrap) {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.chart-wrap :deep(.line-chart-svg) {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}
</style>
