<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import BarChartThin from "@/components/charts/BarChartThin.vue";
import { BottomSheet } from "@/components/ui";

const store = useHealthDataStore();

const GOAL = 2000;
type ViewMode = "week" | "month";
const view = ref<ViewMode>("week");
const selectedDate = ref<Date>(new Date());
const weekStart = ref<Date>(startOfWeek(new Date()));
const viewMonth = ref<Date>(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

const showAddSheet = ref(false);
const addAmount = ref(200);

onMounted(() => {
  void store.load();
});

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
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const todayAmount = computed(() => store.waterByDate(dateKey(selectedDate.value)));
const progress = computed(() => Math.min(todayAmount.value / GOAL, 1));
const C = 2 * Math.PI * 36;
const dashOffset = computed(() => C - progress.value * C);

const isToday = computed(() => isSameDay(selectedDate.value, new Date()));

const weekDays = computed(() => {
  const out: { date: Date; key: string; label: string; weekday: string; amount: number; selected: boolean }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart.value, i);
    const k = dateKey(d);
    out.push({
      date: d,
      key: k,
      label: String(d.getDate()),
      weekday: ["日", "一", "二", "三", "四", "五", "六"][d.getDay()],
      amount: store.waterByDate(k),
      selected: isSameDay(d, selectedDate.value),
    });
  }
  return out;
});

const monthDays = computed(() => {
  const year = viewMonth.value.getFullYear();
  const month = viewMonth.value.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const out: { date: Date | null; key: string; label: string; amount: number; selected: boolean; isToday: boolean }[] = [];
  for (let i = 0; i < firstDay; i++) {
    out.push({ date: null, key: `e${i}`, label: "", amount: 0, selected: false, isToday: false });
  }
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(year, month, i);
    const k = dateKey(d);
    out.push({
      date: d,
      key: k,
      label: String(i),
      amount: store.waterByDate(k),
      selected: isSameDay(d, selectedDate.value),
      isToday: isSameDay(d, today),
    });
  }
  return out;
});

const weekData = computed(() => weekDays.value.map((d) => ({ date: d.key, label: d.label, amount: d.amount })));
const monthData = computed(() =>
  monthDays.value.filter((d) => d.date).map((d) => ({ date: d.key, label: d.label, amount: d.amount })),
);

const chartData = computed(() =>
  view.value === "week" ? weekData.value.map((d) => d.amount) : monthData.value.map((d) => d.amount),
);
const chartLabels = computed(() =>
  view.value === "week" ? weekData.value.map((d) => d.label) : monthData.value.map((d) => d.label),
);

const avgAmount = computed(() => {
  const arr = view.value === "week" ? weekData.value : monthData.value;
  const sum = arr.reduce((s, d) => s + d.amount, 0);
  return arr.length > 0 ? Math.round(sum / arr.length) : 0;
});

const periodLabel = computed(() => {
  if (view.value === "week") {
    const end = addDays(weekStart.value, 6);
    return `${weekStart.value.getMonth() + 1}/${weekStart.value.getDate()}-${end.getMonth() + 1}/${end.getDate()}`;
  }
  return `${viewMonth.value.getFullYear()}年${viewMonth.value.getMonth() + 1}月`;
});

function selectDay(d: Date) {
  selectedDate.value = d;
}

function prevPeriod() {
  if (view.value === "week") {
    weekStart.value = addDays(weekStart.value, -7);
    selectedDate.value = addDays(weekStart.value, 0);
  } else {
    viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() - 1, 1);
  }
}
function nextPeriod() {
  if (view.value === "week") {
    weekStart.value = addDays(weekStart.value, 7);
    selectedDate.value = addDays(weekStart.value, 0);
  } else {
    viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + 1, 1);
  }
}

function switchView(v: ViewMode) {
  view.value = v;
  if (v === "week") {
    weekStart.value = startOfWeek(selectedDate.value);
  } else {
    viewMonth.value = new Date(selectedDate.value.getFullYear(), selectedDate.value.getMonth(), 1);
  }
}

const PRESET_AMOUNTS = [100, 200, 300, 500];

function openAddSheet() {
  addAmount.value = 200;
  showAddSheet.value = true;
}

function confirmAdd() {
  if (addAmount.value <= 0) return;
  store.addWater(addAmount.value);
  showAddSheet.value = false;
}

function onSliderInput(e: Event) {
  addAmount.value = Number((e.target as HTMLInputElement).value);
}

const sliderPercent = computed(() => Math.min(addAmount.value / 1000, 1) * 100);

const dayRecords = computed(() => {
  const k = dateKey(selectedDate.value);
  return store.waterRecords
    .filter((r) => dateKey(new Date(r.timestamp)) === k)
    .slice()
    .reverse();
});
</script>

<template>
  <div class="water-page">
    <h2 class="page-title">饮水记录</h2>

    <div class="today-card clean-card">
      <div class="ring-wrap">
        <svg width="120" height="120" viewBox="0 0 88 88">
          <circle cx="44" cy="44" r="36" fill="none" stroke="var(--bg-200)" stroke-width="7" />
          <circle
            cx="44" cy="44" r="36" fill="none"
            stroke="#3da9ff" stroke-width="7"
            stroke-linecap="round"
            :stroke-dasharray="C"
            :stroke-dashoffset="dashOffset"
            :style="{
              transform: 'rotate(-90deg)',
              transformOrigin: '44px 44px',
              transition: 'stroke-dashoffset .4s var(--ease-immersive)',
            }"
          />
        </svg>
        <div class="ring-text">
          <span class="ring-num">{{ todayAmount }}</span>
          <span class="ring-goal">/{{ GOAL }}ml</span>
          <span v-if="!isToday" class="ring-date">{{ selectedDate.getMonth() + 1 }}/{{ selectedDate.getDate() }}</span>
        </div>
      </div>
      <div class="today-info">
        <div class="today-label">{{ isToday ? "今日饮水" : "当日饮水" }}</div>
        <div class="today-percent">{{ Math.round(progress * 100) }}%</div>
        <div class="today-tip" v-if="progress >= 1">达标! 💧</div>
        <div class="today-tip" v-else>还差 {{ GOAL - todayAmount }}ml</div>
        <button v-if="isToday" class="add-water-btn" @click="openAddSheet">
          <i class="bi bi-plus-lg" style="font-size:16px"></i>
          记水
        </button>
      </div>
    </div>

    <div class="period-bar clean-card">
      <div class="period-bar-top">
        <div class="view-switch">
          <button class="vs-btn" :class="{ active: view === 'week' }" @click="switchView('week')">周</button>
          <button class="vs-btn" :class="{ active: view === 'month' }" @click="switchView('month')">月</button>
        </div>
        <div class="period-nav">
          <button class="nav-btn" @click="prevPeriod" aria-label="上一周期">
            <i class="bi bi-chevron-left" style="font-size:14px"></i>
          </button>
          <span class="period-label">{{ periodLabel }}</span>
          <button class="nav-btn" @click="nextPeriod" aria-label="下一周期">
            <i class="bi bi-chevron-right" style="font-size:14px"></i>
          </button>
        </div>
      </div>

      <div v-if="view === 'week'" class="week-strip">
        <button
          v-for="d in weekDays"
          :key="d.key"
          class="day-chip"
          :class="{ 'is-selected': d.selected, 'is-today': isSameDay(d.date, new Date()) }"
          @click="selectDay(d.date)"
        >
          <span class="dw">{{ d.weekday }}</span>
          <span class="dd">{{ d.label }}</span>
          <span class="d-bar" :style="{ height: Math.min(d.amount / GOAL * 28, 28) + 'px', background: d.amount >= GOAL ? '#64bb5c' : '#3da9ff' }" />
        </button>
      </div>

      <div v-else class="month-grid">
        <div class="mg-head">
          <span v-for="w in ['日','一','二','三','四','五','六']" :key="w" class="mgh">{{ w }}</span>
        </div>
        <div class="mg-body">
          <button
            v-for="d in monthDays"
            :key="d.key"
            class="mg-cell"
            :class="{ 'is-empty': !d.date, 'is-selected': d.selected, 'is-today': d.isToday }"
            :disabled="!d.date"
            @click="d.date && selectDay(d.date)"
          >
            <template v-if="d.date">
              <span class="mg-num">{{ d.label }}</span>
              <span v-if="d.amount > 0" class="mg-dot" :style="{ opacity: 0.3 + Math.min(d.amount / GOAL, 1) * 0.7 }" />
            </template>
          </button>
        </div>
      </div>
    </div>

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

    <div class="history-card clean-card">
      <h3 class="block-title">{{ isToday ? "今日" : `${selectedDate.getMonth() + 1}/${selectedDate.getDate()}` }}记录</h3>
      <div v-if="dayRecords.length === 0" class="empty">暂无饮水记录</div>
      <div class="history-list">
        <div v-for="rec in dayRecords" :key="rec.id" class="history-item">
          <div class="h-icon">
            <i class="bi bi-droplet-fill" style="font-size:14px;color:#3da9ff"></i>
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

    <BottomSheet
      v-model:visible="showAddSheet"
      title="记一次饮水"
      :detents="['medium']"
      default-detent="medium"
    >
      <div class="add-body">
        <div class="amount-display">
          <span class="amount-num">{{ addAmount }}</span>
          <span class="amount-unit">ml</span>
        </div>

        <div class="preset-row">
          <button
            v-for="a in PRESET_AMOUNTS"
            :key="a"
            class="preset-btn"
            :class="{ active: addAmount === a }"
            @click="addAmount = a"
          >
            {{ a }}ml
          </button>
        </div>

        <div class="slider-wrap">
          <input
            type="range"
            min="0"
            max="1000"
            step="10"
            :value="addAmount"
            class="water-slider"
            @input="onSliderInput"
          />
          <div class="slider-scale">
            <span>0</span><span>250</span><span>500</span><span>750</span><span>1000ml</span>
          </div>
        </div>

        <div class="cup-visual">
          <div class="cup-fill" :style="{ height: sliderPercent + '%' }">
            <div class="cup-wave" />
          </div>
        </div>

        <button class="confirm-btn" @click="confirmAdd" :disabled="addAmount <= 0">
          记 {{ addAmount }}ml
        </button>
      </div>
    </BottomSheet>
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
  width: 120px;
  height: 120px;
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
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}

.ring-goal {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.ring-date {
  font-size: 10px;
  color: #3da9ff;
  margin-top: 2px;
}

.today-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.today-label {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.today-percent {
  font-size: var(--text-3xl);
  font-weight: var(--fw-bold);
  color: #3da9ff;
  line-height: 1.1;
}

.today-tip {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.add-water-btn {
  margin-top: var(--space-2);
  align-self: flex-start;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: var(--radius-full);
  border: none;
  background: #3da9ff;
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.add-water-btn:active { transform: scale(0.95); }

.period-bar {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
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
  min-width: 90px;
  text-align: center;
}

.week-strip {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.day-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s;
}

.day-chip.is-selected {
  background: rgba(61, 169, 255, 0.12);
}

.day-chip.is-selected .dd {
  color: #3da9ff;
  font-weight: var(--fw-bold);
}

.day-chip.is-today .dd {
  color: var(--color-warm);
}

.dw {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.dd {
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  color: var(--color-text);
}

.d-bar {
  width: 6px;
  border-radius: 3px;
  background: #3da9ff;
  min-height: 2px;
  transition: height 0.3s;
}

.month-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mg-head {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.mgh {
  text-align: center;
  font-size: 10px;
  color: var(--color-text-tertiary);
  padding: 2px 0;
}

.mg-body {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.mg-cell {
  aspect-ratio: 1;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  position: relative;
  padding: 0;
}

.mg-cell.is-empty { visibility: hidden; }

.mg-cell.is-selected {
  background: rgba(61, 169, 255, 0.15);
}

.mg-cell.is-selected .mg-num {
  color: #3da9ff;
  font-weight: var(--fw-bold);
}

.mg-cell.is-today .mg-num {
  color: var(--color-warm);
  font-weight: var(--fw-bold);
}

.mg-num {
  font-size: var(--text-sm);
  color: var(--color-text);
}

.mg-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #3da9ff;
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
  align-items: baseline;
  gap: var(--space-2);
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

/* Add water sheet */
.add-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) 0;
}

.amount-display {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.amount-num {
  font-size: 56px;
  font-weight: var(--fw-bold);
  color: #3da9ff;
  line-height: 1;
}

.amount-unit {
  font-size: var(--text-lg);
  color: var(--color-text-tertiary);
}

.preset-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: center;
}

.preset-btn {
  padding: 8px 16px;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.preset-btn.active {
  border-color: #3da9ff;
  background: rgba(61, 169, 255, 0.1);
  color: #3da9ff;
}

.slider-wrap {
  width: 100%;
  padding: 0 var(--space-2);
}

.water-slider {
  width: 100%;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: linear-gradient(to right, #3da9ff 0%, #3da9ff var(--slider-percent, 0)%, var(--bg-200) var(--slider-percent, 0)%, var(--bg-200) 100%);
  border-radius: var(--radius-full);
  outline: none;
}

.water-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid #3da9ff;
  box-shadow: var(--shadow-md);
  cursor: pointer;
}

.water-slider::-moz-range-thumb {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid #3da9ff;
  box-shadow: var(--shadow-md);
  cursor: pointer;
}

.slider-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.cup-visual {
  width: 80px;
  height: 100px;
  border: 2px solid #b3dfff;
  border-top: none;
  border-radius: 0 0 40px 40px;
  position: relative;
  overflow: hidden;
  background: var(--bg-100);
}

.cup-fill {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(180deg, #7dc8ff 0%, #3da9ff 100%);
  transition: height 0.2s;
  border-radius: 0 0 38px 38px;
  overflow: hidden;
}

.cup-wave {
  position: absolute;
  top: -6px;
  left: -10%;
  width: 120%;
  height: 12px;
  background: radial-gradient(ellipse at center, transparent 0%, transparent 50%, #7dc8ff 50%);
  background-size: 20px 12px;
  animation: wave 2s linear infinite;
}

@keyframes wave {
  from { transform: translateX(0); }
  to { transform: translateX(-20px); }
}

.confirm-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: var(--radius-lg);
  background: #3da9ff;
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  cursor: pointer;
  margin-top: var(--space-2);
}

.confirm-btn:active { transform: scale(0.98); }
.confirm-btn:disabled {
  background: var(--bg-300);
  cursor: not-allowed;
}
</style>
