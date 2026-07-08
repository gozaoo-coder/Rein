<script setup lang="ts">
/**
 * WaterPage — 饮水记录页
 *
 * - 今日进度环 + 快速记录按钮
 * - 周/月视图切换 + BarChartThin
 */
import { computed, onMounted, ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import BarChartThin from "@/components/charts/BarChartThin.vue";

const store = useHealthDataStore();

const GOAL = 2000;
const view = ref<"week" | "month">("week");
const weekStart = ref<Date>(startOfWeek(new Date()));
const viewMonth = ref<Date>(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

onMounted(() => {
  void store.load();
});

// ===== 工具 =====
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// ===== 今日 =====
const todayAmount = computed(() => store.todayWaterAmount);
const progress = computed(() => Math.min(todayAmount.value / GOAL, 1));
const C = 2 * Math.PI * 32;
const dashOffset = computed(() => C - progress.value * C);

// ===== 周数据 =====
const weekData = computed(() => {
  const out: { date: string; label: string; amount: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart.value, i);
    const k = dateKey(d);
    out.push({
      date: k,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      amount: store.waterByDate(k),
    });
  }
  return out;
});

const monthData = computed(() => {
  const days = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + 1, 0).getDate();
  const out: { date: string; label: string; amount: number }[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth(), i);
    const k = dateKey(d);
    out.push({
      date: k,
      label: String(i),
      amount: store.waterByDate(k),
    });
  }
  return out;
});

const chartData = computed(() =>
  view.value === "week"
    ? weekData.value.map((d) => d.amount)
    : monthData.value.map((d) => d.amount),
);
const chartLabels = computed(() =>
  view.value === "week"
    ? weekData.value.map((d) => d.label)
    : monthData.value.map((d) => d.label),
);

const avgAmount = computed(() => {
  const arr = view.value === "week" ? weekData.value : monthData.value;
  const sum = arr.reduce((s, d) => s + d.amount, 0);
  return arr.length > 0 ? Math.round(sum / arr.length) : 0;
});

const periodLabel = computed(() => {
  if (view.value === "week") {
    const end = addDays(weekStart.value, 6);
    return `${weekStart.value.getMonth() + 1}/${weekStart.value.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
  }
  return `${viewMonth.value.getFullYear()}年${viewMonth.value.getMonth() + 1}月`;
});

// ===== 快速记录 =====
const QUICK_AMOUNTS = [50, 100, 150, 200, 300, 500];
function quickAdd(amount: number) {
  store.addWater(amount);
}
function clearToday() {
  store.clearTodayWater();
}

// ===== 导航 =====
function prevPeriod() {
  if (view.value === "week") {
    weekStart.value = addDays(weekStart.value, -7);
  } else {
    viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() - 1, 1);
  }
}
function nextPeriod() {
  if (view.value === "week") {
    weekStart.value = addDays(weekStart.value, 7);
  } else {
    viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + 1, 1);
  }
}
</script>

<template>
  <div class="water-page">
    <h2 class="page-title">饮水记录</h2>

    <!-- 今日进度环 -->
    <div class="today-card clean-card">
      <div class="ring-wrap">
        <svg width="100" height="100" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="32" fill="none" stroke="var(--bg-200)" stroke-width="6" />
          <circle
            cx="40" cy="40" r="32" fill="none"
            stroke="#3da9ff" stroke-width="6"
            stroke-linecap="round"
            :stroke-dasharray="C"
            :stroke-dashoffset="dashOffset"
            :style="{
              transform: 'rotate(-90deg)',
              transformOrigin: '40px 40px',
              transition: 'stroke-dashoffset .4s var(--ease-immersive)',
            }"
          />
        </svg>
        <div class="ring-text">
          <span class="ring-num">{{ todayAmount }}</span>
          <span class="ring-goal">/{{ GOAL }}ml</span>
        </div>
      </div>
      <div class="quick-add">
        <button
          v-for="amt in QUICK_AMOUNTS"
          :key="amt"
          class="quick-btn"
          @click="quickAdd(amt)"
        >
          +{{ amt }}ml
        </button>
        <button class="quick-btn quick-btn--ghost" @click="clearToday">清空今日</button>
      </div>
    </div>

    <!-- 视图切换 -->
    <div class="view-tabs">
      <button
        class="tab-btn"
        :class="{ 'tab-btn--active': view === 'week' }"
        @click="view = 'week'"
      >
        周
      </button>
      <button
        class="tab-btn"
        :class="{ 'tab-btn--active': view === 'month' }"
        @click="view = 'month'"
      >
        月
      </button>
    </div>

    <!-- 周期导航 -->
    <div class="period-nav">
      <button class="nav-btn" @click="prevPeriod" aria-label="上一周期">
        <i class="bi bi-chevron-left" style="font-size:16px"></i>
      </button>
      <span class="period-label">{{ periodLabel }}</span>
      <button class="nav-btn" @click="nextPeriod" aria-label="下一周期">
        <i class="bi bi-chevron-right" style="font-size:16px"></i>
      </button>
    </div>

    <!-- 图表 -->
    <div class="chart-card clean-card">
      <div class="chart-header">
        <span class="chart-title">{{ view === "week" ? "本周" : "本月" }}饮水</span>
        <span class="chart-avg">日均 {{ avgAmount }}ml</span>
      </div>
      <BarChartThin
        :data="chartData"
        :labels="chartLabels"
        :height="100"
        color="#3da9ff"
        :show-y-axis="true"
        y-unit="ml"
      />
    </div>

    <!-- 历史记录 -->
    <div class="history-card clean-card">
      <h3 class="block-title">今日记录</h3>
      <div v-if="store.todayFoodRecords.length === 0 && store.waterRecords.filter(r => dateKey(new Date(r.timestamp)) === dateKey(new Date())).length === 0" class="empty">
        暂无饮水记录
      </div>
      <div class="history-list">
        <div
          v-for="rec in store.waterRecords.filter(r => dateKey(new Date(r.timestamp)) === dateKey(new Date())).slice().reverse()"
          :key="rec.id"
          class="history-item"
        >
          <div class="h-icon">
            <i class="bi bi-droplet-fill" style="font-size:16px;color:#3da9ff"></i>
          </div>
          <div class="h-info">
            <span class="h-amount">{{ rec.amount }}ml</span>
            <span class="h-time">{{ new Date(rec.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</span>
          </div>
          <button class="h-del" @click="store.removeWater(rec.id)" aria-label="删除">
            <i class="bi bi-trash3" style="font-size:14px"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.water-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
}

.page-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.today-card {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5);
}

.ring-wrap {
  position: relative;
  flex-shrink: 0;
  width: 100px;
  height: 100px;
}

.ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.ring-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}

.ring-goal {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.quick-add {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  flex: 1;
  justify-content: center;
}

.quick-btn {
  padding: 8px 14px;
  border-radius: var(--radius-full);
  border: none;
  background: #3da9ff;
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: transform 0.15s;
}

.quick-btn:active { transform: scale(0.94); }

.quick-btn--ghost {
  background: var(--bg-200);
  color: var(--color-text-secondary);
}

.view-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-100);
  border-radius: var(--radius-full);
  align-self: center;
}

.tab-btn {
  padding: 6px 24px;
  border-radius: var(--radius-full);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}

.tab-btn--active {
  background: var(--bg-50);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}

.period-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
}

.nav-btn {
  width: 32px;
  height: 32px;
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
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  min-width: 140px;
  text-align: center;
}

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

.chart-avg {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.history-card {
  padding: var(--space-4);
}

.block-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0 0 var(--space-3);
}

.empty {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-4);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.history-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.h-icon {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(61, 169, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.h-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.h-amount {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.h-time {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.h-del {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.h-del:active { color: var(--danger-500); }
</style>
