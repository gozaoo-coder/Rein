<script setup lang="ts">
/**
 * WeightOverviewPage — 体重总览
 *
 * - 顶部当前体重 + BMI + 与目标体重差值
 * - 月视图 / 年视图切换
 * - 底部记体重按钮（BottomSheet 表单）
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useUserStore } from "@/stores/userStore";
import { useTopBar } from "@/composables/useTopBar";
import LineChart from "@/components/charts/LineChart.vue";
import BottomSheet from "@/components/ui/BottomSheet.vue";
import type { BodyMetricsRecord } from "@/types/health";

const router = useRouter();
const store = useHealthDataStore();
const userStore = useUserStore();
const { setActions, clearActions } = useTopBar();

onMounted(async () => {
  await Promise.all([store.load(), userStore.load()]);
  setActions([
    { id: "back", icon: "chevron-left", label: "返回", onClick: () => router.back() },
  ]);
});

onUnmounted(() => {
  clearActions();
});

// ===== 当前数据 =====
const currentWeight = computed<number | undefined>(
  () => (store.latestBodyMetrics?.weightKg ?? userStore.profile.weight) || undefined,
);
const weightText = computed(() =>
  currentWeight.value != null ? currentWeight.value.toFixed(1) : "--",
);
const currentBmi = computed(() => store.currentBmi);
const targetWeight = computed(() => userStore.profile.targetWeight || 0);
const targetDiff = computed<{ dir: "up" | "down"; abs: string } | null>(() => {
  if (currentWeight.value == null || targetWeight.value <= 0) return null;
  const d = currentWeight.value - targetWeight.value;
  return { dir: d >= 0 ? "up" : "down", abs: Math.abs(d).toFixed(1) };
});

// ===== 视图切换 =====
type ViewMode = "month" | "year";
const view = ref<ViewMode>("month");
const viewMonth = ref<Date>(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
const viewYear = ref<number>(new Date().getFullYear());

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mi}`;
}

// 全部带 weightKg 的记录按时间升序，附带与上一条的差值
const sortedWithDelta = computed<{ rec: BodyMetricsRecord; delta: number | null }[]>(() => {
  const arr = store.bodyMetrics
    .filter((r) => r.weightKg != null)
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  return arr.map((rec, i) => {
    if (i === 0) return { rec, delta: null };
    const prev = arr[i - 1].weightKg;
    if (prev == null) return { rec, delta: null };
    return { rec, delta: (rec.weightKg as number) - prev };
  });
});

// ===== 月视图 =====
const monthLabel = computed(
  () => `${viewMonth.value.getFullYear()}年${viewMonth.value.getMonth() + 1}月`,
);

// 当月每日最新体重
const monthDaily = computed<{ key: string; ts: number; weight: number }[]>(() => {
  const y = viewMonth.value.getFullYear();
  const m = viewMonth.value.getMonth();
  const byKey = new Map<string, { ts: number; weight: number }>();
  for (const r of store.bodyMetrics) {
    if (r.weightKg == null) continue;
    const d = new Date(r.timestamp);
    if (d.getFullYear() !== y || d.getMonth() !== m) continue;
    const k = dateKey(r.timestamp);
    const ex = byKey.get(k);
    if (!ex || r.timestamp > ex.ts) {
      byKey.set(k, { ts: r.timestamp, weight: r.weightKg });
    }
  }
  return [...byKey.entries()]
    .map(([key, v]) => ({ key, ts: v.ts, weight: v.weight }))
    .sort((a, b) => a.ts - b.ts);
});

const monthChartData = computed(() => monthDaily.value.map((d) => d.weight));
const monthChartLabels = computed(() =>
  monthDaily.value.map((d) => {
    const dd = new Date(d.ts);
    return `${dd.getMonth() + 1}/${dd.getDate()}`;
  }),
);

const monthChartRange = computed(() => {
  const arr = monthChartData.value;
  if (arr.length === 0) return { yMin: undefined, yMax: undefined };
  if (arr.length === 1) {
    const v = arr[0];
    return { yMin: v - 2, yMax: v + 2 };
  }
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  return { yMin: min - 1, yMax: max + 1 };
});

// 当月所有记录（含差值），按时间倒序
const monthList = computed(() => {
  const y = viewMonth.value.getFullYear();
  const m = viewMonth.value.getMonth();
  return sortedWithDelta.value
    .filter(({ rec }) => {
      const d = new Date(rec.timestamp);
      return d.getFullYear() === y && d.getMonth() === m;
    })
    .slice()
    .reverse();
});

// ===== 年视图 =====
const yearLabel = computed(() => `${viewYear.value}年`);

const monthlyAvg = computed<{ month: number; avg: number | null; count: number }[]>(() => {
  const y = viewYear.value;
  const out: { month: number; avg: number | null; count: number }[] = [];
  for (let mo = 0; mo < 12; mo++) {
    const vals: number[] = [];
    for (const r of store.bodyMetrics) {
      if (r.weightKg == null) continue;
      const d = new Date(r.timestamp);
      if (d.getFullYear() === y && d.getMonth() === mo) vals.push(r.weightKg);
    }
    if (vals.length > 0) {
      const avg = Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
      out.push({ month: mo, avg, count: vals.length });
    } else {
      out.push({ month: mo, avg: null, count: 0 });
    }
  }
  return out;
});

const yearChartData = computed(() => {
  const arr = monthlyAvg.value.filter((m) => m.avg != null) as { month: number; avg: number }[];
  return arr.map((m) => m.avg);
});
const yearChartLabels = computed(() => {
  const arr = monthlyAvg.value.filter((m) => m.avg != null);
  return arr.map((m) => `${m.month + 1}月`);
});
const yearChartRange = computed(() => {
  const arr = yearChartData.value;
  if (arr.length === 0) return { yMin: undefined, yMax: undefined };
  if (arr.length === 1) {
    const v = arr[0];
    return { yMin: v - 2, yMax: v + 2 };
  }
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  return { yMin: min - 1, yMax: max + 1 };
});

// ===== 导航 =====
function prevPeriod() {
  if (view.value === "month") {
    viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() - 1, 1);
  } else {
    viewYear.value -= 1;
  }
}
function nextPeriod() {
  if (view.value === "month") {
    viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + 1, 1);
  } else {
    viewYear.value += 1;
  }
}
function switchView(v: ViewMode) {
  view.value = v;
}

// ===== 记体重 Sheet =====
const showSheet = ref(false);
const weightInput = ref<string>("");
const PRESET_WEIGHTS = [50, 55, 60, 65, 70, 75, 80];

function openSheet() {
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

function deltaText(delta: number | null): string {
  if (delta == null || Math.abs(delta) < 0.05) return "—";
  const sign = delta > 0 ? "↑" : "↓";
  return `${sign} ${Math.abs(delta).toFixed(1)}kg`;
}
</script>

<template>
  <div class="weight-page">
    <h2 class="page-title">体重</h2>

    <!-- 当前体重大卡 -->
    <div class="current-card clean-card">
      <div class="current-main">
        <div class="current-num-block">
          <span class="current-num">{{ weightText }}</span>
          <span class="current-unit">kg</span>
        </div>
        <div class="current-label">当前体重</div>
      </div>
      <div class="current-side">
        <div class="side-row">
          <span class="side-label">BMI</span>
          <span class="side-val">{{ currentBmi != null ? currentBmi.toFixed(1) : "--" }}</span>
        </div>
        <div class="side-row">
          <span class="side-label">目标</span>
          <span class="side-val">{{ targetWeight > 0 ? targetWeight.toFixed(1) + "kg" : "--" }}</span>
        </div>
        <div v-if="targetDiff" class="side-row">
          <span class="side-label">差值</span>
          <span
            class="side-val"
            :class="targetDiff.dir === 'up' ? 'side-val--up' : 'side-val--down'"
          >
            {{ targetDiff.dir === "up" ? "+" : "-" }}{{ targetDiff.abs }}kg
          </span>
        </div>
      </div>
    </div>

    <!-- 视图切换 + 周期导航 -->
    <div class="period-bar clean-card">
      <div class="period-bar-top">
        <div class="view-switch">
          <button class="vs-btn" :class="{ active: view === 'month' }" @click="switchView('month')">月</button>
          <button class="vs-btn" :class="{ active: view === 'year' }" @click="switchView('year')">年</button>
        </div>
        <div class="period-nav">
          <button class="nav-btn" @click="prevPeriod" aria-label="上一周期">
            <i class="bi bi-chevron-left" style="font-size:14px"></i>
          </button>
          <span class="period-label">{{ view === "month" ? monthLabel : yearLabel }}</span>
          <button class="nav-btn" @click="nextPeriod" aria-label="下一周期">
            <i class="bi bi-chevron-right" style="font-size:14px"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- 图表卡 -->
    <div class="chart-card clean-card">
      <div class="chart-header">
        <span class="chart-title">{{ view === "month" ? "本月体重" : "月均体重" }}</span>
        <span v-if="view === 'month'" class="chart-sub">每日最新</span>
        <span v-else class="chart-sub">每月平均</span>
      </div>
      <div v-if="(view === 'month' ? monthChartData : yearChartData).length > 0" class="chart-wrap">
        <LineChart
          v-if="view === 'month'"
          :data="monthChartData"
          :labels="monthChartLabels"
          color="var(--color-warm)"
          :show-area="true"
          :show-dots="true"
          :show-x-axis="true"
          :y-min="monthChartRange.yMin"
          :y-max="monthChartRange.yMax"
          :height="120"
          :stroke-width="2"
          :smooth="true"
        />
        <LineChart
          v-else
          :data="yearChartData"
          :labels="yearChartLabels"
          color="var(--color-warm)"
          :show-area="true"
          :show-dots="true"
          :show-x-axis="true"
          :y-min="yearChartRange.yMin"
          :y-max="yearChartRange.yMax"
          :height="120"
          :stroke-width="2"
          :smooth="true"
        />
      </div>
      <div v-else class="empty">无数据</div>
    </div>

    <!-- 列表 -->
    <div class="history-card clean-card">
      <h3 class="block-title">
        {{ view === "month" ? "本月记录" : "月均记录" }}
      </h3>

      <div v-if="view === 'month'">
        <div v-if="monthList.length === 0" class="empty-inline">暂无记录</div>
        <div v-else class="history-list">
          <div v-for="item in monthList" :key="item.rec.id" class="history-item">
            <div class="h-date">{{ fmtDateTime(item.rec.timestamp) }}</div>
            <div class="h-metrics">
              <span class="h-weight">{{ item.rec.weightKg?.toFixed(1) }}kg</span>
              <span class="h-delta" :class="item.delta == null ? '' : (item.delta as number) > 0 ? 'h-delta--up' : 'h-delta--down'">
                {{ deltaText(item.delta) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-else>
        <div class="history-list">
          <div v-for="m in monthlyAvg" :key="m.month" class="history-item">
            <div class="h-date">{{ m.month + 1 }}月</div>
            <div class="h-metrics">
              <span class="h-weight">{{ m.avg != null ? m.avg.toFixed(1) + "kg" : "—" }}</span>
              <span class="h-count">{{ m.count > 0 ? `${m.count} 条` : "" }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部记体重按钮 -->
    <div class="bottom-bar">
      <button class="bottom-btn" @click="openSheet">
        <i class="bi bi-plus-lg" style="font-size:16px"></i>
        记体重
      </button>
    </div>

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
.weight-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: calc(88px + env(safe-area-inset-bottom, 0px));
}

.page-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

/* 当前体重大卡 */
.current-card {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5);
}

.current-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.current-num-block {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.current-num {
  font-size: 44px;
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1;
}

.current-unit {
  font-size: var(--text-md);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}

.current-label {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.current-side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: var(--space-3);
  border-left: 1px solid var(--color-divider);
}

.side-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 92px;
}

.side-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.side-val {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.side-val--up { color: var(--danger-500); }
.side-val--down { color: var(--success-600); }

/* 周期栏 */
.period-bar {
  padding: var(--space-3) var(--space-4);
}

.period-bar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.view-switch {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-200);
  border-radius: var(--radius-full);
}

.vs-btn {
  padding: 5px 16px;
  border-radius: var(--radius-full);
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.vs-btn.active {
  background: var(--bg-50);
  color: var(--color-text);
  box-shadow: var(--shadow-sm);
}

.period-nav {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.nav-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: var(--bg-100);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.period-label {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  min-width: 96px;
  text-align: center;
}

/* 图表卡 */
.chart-card {
  padding: var(--space-4);
}

.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.chart-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.chart-sub {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.chart-wrap {
  width: 100%;
}

.empty {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-4);
}

/* 列表 */
.history-card {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.block-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.empty-inline {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  padding: var(--space-2);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.h-date {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.h-metrics {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.h-weight {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.h-delta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.h-delta--up { color: var(--danger-500); }
.h-delta--down { color: var(--success-600); }

.h-count {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

/* 底部按钮 */
.bottom-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  padding: var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
  background: var(--material-ultra-thin-bg);
  -webkit-backdrop-filter: blur(var(--material-ultra-thin-blur)) var(--glass-blur-saturate);
  backdrop-filter: blur(var(--material-ultra-thin-blur)) var(--glass-blur-saturate);
}

.bottom-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 14px;
  border: none;
  border-radius: var(--radius-lg);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  cursor: pointer;
}
.bottom-btn:active { transform: scale(0.98); }

/* Sheet 表单 */
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
