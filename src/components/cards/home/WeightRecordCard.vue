<script setup lang="ts">
/**
 * WeightRecordCard — 体重卡
 *
 * 2x1: 当前体重 + 记体重按钮（打开 BottomSheet）
 * 2x2 / 4x2: 折线图（近 60 天）+ 记体重入口
 */
import { computed, ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useUserStore } from "@/stores/userStore";
import LineChart from "@/components/charts/LineChart.vue";
import BottomSheet from "@/components/ui/BottomSheet.vue";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useHealthDataStore();
const userStore = useUserStore();

const currentWeight = computed<number | undefined>(
  () => (store.latestBodyMetrics?.weightKg ?? userStore.profile.weight) || undefined,
);

const weightText = computed(() =>
  currentWeight.value != null ? currentWeight.value.toFixed(1) : "--",
);

// ===== 近 60 天趋势 =====
const DAY_MS = 86400000;

const trend = computed(() => {
  const now = Date.now();
  const since = now - 60 * DAY_MS;
  const items = store.bodyMetrics
    .filter((r) => r.weightKg != null && r.timestamp >= since)
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  return items;
});

const chartData = computed(() =>
  trend.value.map((r) => r.weightKg as number),
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
  const cur = arr[arr.length - 1].weightKg;
  const prev = arr[arr.length - 2].weightKg;
  if (cur == null || prev == null) return null;
  const d = cur - prev;
  if (Math.abs(d) < 0.05) return null;
  return {
    dir: d > 0 ? "up" : "down",
    abs: Math.abs(d).toFixed(1),
  };
});

// ===== 记体重 BottomSheet =====
const showSheet = ref(false);
const weightInput = ref<string>("");

const PRESET_WEIGHTS = [50, 55, 60, 65, 70, 75, 80];

function openSheet(e: Event) {
  e.stopPropagation();
  weightInput.value =
    currentWeight.value != null ? currentWeight.value.toFixed(1) : "";
  showSheet.value = true;
}

function setPreset(v: number) {
  weightInput.value = String(v);
}

function confirmRecord() {
  const kg = Number(weightInput.value);
  if (!weightInput.value || Number.isNaN(kg) || kg <= 0) return;
  store.addBodyMetrics({ weightKg: kg });
  showSheet.value = false;
}

const isCompact = computed(() => props.size === "2x1");
</script>

<template>
  <div
    class="home-card clean-card weight-card"
    :class="[`home-card--${size}`, { 'is-compact': isCompact }]"
    @click="emit('click')"
  >
    <!-- 2x1：当前体重 + 记体重按钮 -->
    <div v-if="size === '2x1'" class="body-2x1">
      <div class="left-block">
        <div class="sub-label">当前体重</div>
        <div class="weight-main">
          <span class="weight-num">{{ weightText }}</span>
          <span class="weight-unit">kg</span>
        </div>
      </div>
      <button class="record-btn" @click="openSheet" aria-label="记体重">
        <i class="bi bi-plus-lg" style="font-size:14px"></i>
        <span class="record-btn-text">记体重</span>
      </button>
    </div>

    <!-- 2x2 / 4x2：标题 + 折线图 -->
    <template v-else>
      <div class="card-head">
        <span class="title-icon title-icon--purple">
          <i class="bi bi-speedometer2" style="font-size:12px"></i>
        </span>
        <span class="card-title">体重</span>
        <button class="head-add" @click="openSheet" aria-label="记体重">
          <i class="bi bi-plus-lg" style="font-size:12px"></i>
        </button>
      </div>

      <div class="weight-now-row">
        <div class="weight-main">
          <span class="weight-num weight-num--md">{{ weightText }}</span>
          <span class="weight-unit">kg</span>
        </div>
        <span v-if="latestDelta" class="delta" :class="latestDelta.dir === 'up' ? 'delta--up' : 'delta--down'">
          <i :class="latestDelta.dir === 'up' ? 'bi bi-arrow-up' : 'bi bi-arrow-down'" style="font-size:10px"></i>
          {{ latestDelta.abs }}kg
        </span>
      </div>

      <div v-if="hasData" class="chart-wrap">
        <LineChart
          :data="chartData"
          :labels="chartLabels"
          :color="'var(--color-warm)'"
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

    <!-- 记体重 BottomSheet -->
    <BottomSheet
      v-model:visible="showSheet"
      title="记体重"
      :detents="['medium']"
      default-detent="medium"
    >
      <div class="sheet-body">
        <div class="input-wrap">
          <input
            v-model="weightInput"
            type="number"
            step="0.1"
            min="0"
            inputmode="decimal"
            placeholder="如 65.0"
            class="weight-input"
          />
          <span class="input-unit">kg</span>
        </div>

        <div class="preset-row">
          <button
            v-for="w in PRESET_WEIGHTS"
            :key="w"
            class="preset-btn"
            :class="{ active: weightInput === String(w) }"
            @click="setPreset(w)"
          >
            {{ w }}
          </button>
        </div>

        <button
          class="confirm-btn"
          :disabled="!weightInput || Number.isNaN(Number(weightInput)) || Number(weightInput) <= 0"
          @click="confirmRecord"
        >
          记录
        </button>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.weight-card {
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
.weight-card:active { transform: scale(0.98); }
.weight-card:hover { box-shadow: var(--shadow-card-hover); }

.weight-card.is-compact {
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

.weight-main {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.weight-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1;
}

.weight-num--md {
  font-size: var(--text-xl);
}

.weight-unit {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}

.record-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 7px 14px;
  border-radius: var(--radius-full);
  border: none;
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.record-btn:active { transform: scale(0.95); }
.record-btn-text { line-height: 1; }

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

.head-add {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: var(--bg-100);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.head-add:active { transform: scale(0.9); }

.weight-now-row {
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
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

/* ===== BottomSheet 表单 ===== */
.sheet-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-2) 0;
}

.input-wrap {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 10px 14px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: var(--bg-100);
}
.input-wrap:focus-within {
  border-color: var(--color-warm);
  background: var(--bg-50);
}

.weight-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  -moz-appearance: textfield;
}
.weight-input::-webkit-outer-spin-button,
.weight-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.input-unit {
  font-size: var(--text-md);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}

.preset-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: center;
}

.preset-btn {
  padding: 8px 14px;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.preset-btn.active {
  border-color: var(--color-warm);
  background: rgba(255, 138, 0, 0.1);
  color: var(--color-warm);
}

.confirm-btn {
  padding: 14px;
  border: none;
  border-radius: var(--radius-lg);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  cursor: pointer;
}
.confirm-btn:active { transform: scale(0.98); }
.confirm-btn:disabled {
  background: var(--bg-300);
  cursor: not-allowed;
}
</style>
