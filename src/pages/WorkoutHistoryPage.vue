<script setup lang="ts">
/**
 * WorkoutHistoryPage — 运动历史（日/月/年）
 *
 * 路由：/workout/history
 * 数据源：workoutStatsStore（recordsForDate / monthAggregations / yearAggregations）
 * - 日：当日训练列表，点击进入详情 /workout/history/:id
 * - 月：当月各日聚合列表
 * - 年：12 月柱图（时长 + 卡路里）+ 趋势折线
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import BarChartThick from "@/components/charts/BarChartThick.vue";
import LineChart from "@/components/charts/LineChart.vue";
import type { WorkoutRecord } from "@/types/workout-stats";

type Tab = "day" | "month" | "year";

const router = useRouter();
const store = useWorkoutStatsStore();

const tab = ref<Tab>("day");

/* ===== 日期状态 ===== */
function todayKey(): string {
  return fmtDateKey(new Date());
}
function fmtDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseDateKey(k: string): Date {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

const selectedDay = ref(todayKey());
const selectedMonth = ref(todayKey().slice(0, 7));
const now = new Date();
const selectedYear = ref(now.getFullYear());

/* ===== 日视图 ===== */
const dayRecords = computed<WorkoutRecord[]>(() =>
  store.recordsForDate(selectedDay.value),
);

const daySummary = computed(() => {
  const rs = dayRecords.value;
  return {
    sessions: rs.length,
    durationSec: rs.reduce((s, r) => s + r.durationSec, 0),
    calories: rs.reduce((s, r) => s + r.caloriesBurned, 0),
    sets: rs.reduce((s, r) => s + r.completedSets, 0),
  };
});

function shiftDay(delta: number) {
  const d = parseDateKey(selectedDay.value);
  d.setDate(d.getDate() + delta);
  selectedDay.value = fmtDateKey(d);
}
function goToday() {
  selectedDay.value = todayKey();
}
const isToday = computed(() => selectedDay.value === todayKey());

/* ===== 月视图 ===== */
const monthAgg = computed(() => store.monthAggregations(selectedMonth.value));
const monthSummary = computed(() => {
  const rs = store.recordsForMonth(selectedMonth.value);
  return {
    sessions: rs.length,
    durationSec: rs.reduce((s, r) => s + r.durationSec, 0),
    calories: rs.reduce((s, r) => s + r.caloriesBurned, 0),
  };
});
function shiftMonth(delta: number) {
  const [y, m] = selectedMonth.value.split("-").map(Number);
  const d = new Date(y, (m ?? 1) - 1 + delta, 1);
  selectedMonth.value = fmtDateKey(d).slice(0, 7);
}

/* ===== 年视图 ===== */
const yearAgg = computed(() => store.yearAggregations(selectedYear.value));
const yearSummary = computed(() => {
  const inYear = store.records.filter(
    (r) => new Date(r.startedAt).getFullYear() === selectedYear.value,
  );
  return {
    sessions: inYear.length,
    durationSec: inYear.reduce((s, r) => s + r.durationSec, 0),
    calories: inYear.reduce((s, r) => s + r.caloriesBurned, 0),
  };
});
function shiftYear(delta: number) {
  selectedYear.value += delta;
}
const yearBars = computed(() =>
  yearAgg.value.map((m) => ({
    value: Math.round(m.durationSec / 60),
    label: m.yearMonth.slice(5),
  })),
);
const yearCalories = computed(() => yearAgg.value.map((m) => m.calories));
const yearMonths = computed(() =>
  yearAgg.value.map((m) => m.yearMonth.slice(5)),
);

/* ===== 导航 ===== */
function openDetail(id: string) {
  router.push(`/workout/history/${id}`);
}
function goBack() {
  router.back();
}

/* ===== 格式化 ===== */
function fmtDuration(sec: number): string {
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
function fmtMinutes(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h${r}`;
}
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${mi}`;
}
function fmtDayLabel(k: string): string {
  const d = parseDateKey(k);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

onMounted(async () => {
  await store.load();
  // 默认聚焦最近有记录的年/月
  if (store.yearsWithData.length > 0) {
    const lastYear = store.yearsWithData[0];
    selectedYear.value = lastYear;
    const ms = store.monthsWithData(lastYear);
    if (ms.length > 0) selectedMonth.value = ms[0];
  }
});
</script>

<template>
  <div class="history-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <i class="bi bi-chevron-left" style="font-size:22px"></i>
      </button>
      <h2 class="sub-title">运动历史</h2>
      <span class="rec-count">{{ store.records.length }}</span>
    </header>

    <!-- Tab 切换 -->
    <div class="seg">
      <button :class="{ active: tab === 'day' }" @click="tab = 'day'">日</button>
      <button :class="{ active: tab === 'month' }" @click="tab = 'month'">月</button>
      <button :class="{ active: tab === 'year' }" @click="tab = 'year'">年</button>
    </div>

    <!-- ===== 日视图 ===== -->
    <template v-if="tab === 'day'">
      <div class="date-nav">
        <button class="nav-btn" @click="shiftDay(-1)" aria-label="前一天">
          <i class="bi bi-chevron-left" style="font-size:18px"></i>
        </button>
        <div class="date-center">
          <div class="date-main">{{ selectedDay }}</div>
          <button v-if="!isToday" class="today-btn" @click="goToday">今天</button>
        </div>
        <button class="nav-btn" @click="shiftDay(1)" aria-label="后一天">
          <i class="bi bi-chevron-right" style="font-size:18px"></i>
        </button>
      </div>

      <section class="clean-card summary-card">
        <div class="sum-cell">
          <div class="sum-val">{{ daySummary.sessions }}</div>
          <div class="sum-lbl">次</div>
        </div>
        <div class="sum-div" />
        <div class="sum-cell">
          <div class="sum-val">{{ fmtMinutes(daySummary.durationSec) }}</div>
          <div class="sum-lbl">分钟</div>
        </div>
        <div class="sum-div" />
        <div class="sum-cell">
          <div class="sum-val">{{ Math.round(daySummary.calories) }}</div>
          <div class="sum-lbl">千卡</div>
        </div>
        <div class="sum-div" />
        <div class="sum-cell">
          <div class="sum-val">{{ daySummary.sets }}</div>
          <div class="sum-lbl">组</div>
        </div>
      </section>

      <section v-if="dayRecords.length" class="rec-list">
        <button
          v-for="r in dayRecords"
          :key="r.id"
          class="rec-row clean-card clean-card--interactive"
          @click="openDetail(r.id)"
        >
          <div class="rec-main">
            <div class="rec-name">{{ r.courseName }}</div>
            <div class="rec-meta">
              <span>{{ fmtTime(r.startedAt) }}</span>
              <span class="dot">·</span>
              <span>{{ fmtDuration(r.durationSec) }}</span>
              <span class="dot">·</span>
              <span>{{ Math.round(r.caloriesBurned) }}kcal</span>
              <span class="dot">·</span>
              <span>{{ r.completedSets }}/{{ r.totalSets }}组</span>
              <span class="dot">·</span>
              <span :class="r.finished ? 'rec-done' : 'rec-partial'">
                {{ r.finished ? '完成' : '中断' }}
              </span>
            </div>
          </div>
          <i class="bi bi-chevron-right chevron" style="font-size:18px"></i>
        </button>
      </section>
      <div v-else class="empty">
        <i class="bi bi-calendar-x" style="font-size:32px"></i>
        <p>当日无训练记录</p>
      </div>
    </template>

    <!-- ===== 月视图 ===== */
    <template v-else-if="tab === 'month'">
      <div class="date-nav">
        <button class="nav-btn" @click="shiftMonth(-1)" aria-label="上一月">
          <i class="bi bi-chevron-left" style="font-size:18px"></i>
        </button>
        <div class="date-center">
          <div class="date-main">{{ selectedMonth }}</div>
        </div>
        <button class="nav-btn" @click="shiftMonth(1)" aria-label="下一月">
          <i class="bi bi-chevron-right" style="font-size:18px"></i>
        </button>
      </div>

      <section class="clean-card summary-card">
        <div class="sum-cell">
          <div class="sum-val">{{ monthSummary.sessions }}</div>
          <div class="sum-lbl">次</div>
        </div>
        <div class="sum-div" />
        <div class="sum-cell">
          <div class="sum-val">{{ fmtMinutes(monthSummary.durationSec) }}</div>
          <div class="sum-lbl">分钟</div>
        </div>
        <div class="sum-div" />
        <div class="sum-cell">
          <div class="sum-val">{{ Math.round(monthSummary.calories) }}</div>
          <div class="sum-lbl">千卡</div>
        </div>
      </section>

      <section v-if="monthAgg.length" class="month-list">
        <div v-for="d in monthAgg" :key="d.date" class="clean-card month-row">
          <div class="mr-left">
            <div class="mr-day">{{ fmtDayLabel(d.date) }}</div>
            <div class="mr-sess">{{ d.sessions }} 次</div>
          </div>
          <div class="mr-right">
            <div class="mr-dur">{{ fmtMinutes(d.durationSec) }} <span>分</span></div>
            <div class="mr-cal">{{ Math.round(d.calories) }} <span>kcal</span></div>
          </div>
        </div>
      </section>
      <div v-else class="empty">
        <i class="bi bi-calendar-x" style="font-size:32px"></i>
        <p>该月无训练记录</p>
      </div>
    </template>

    <!-- ===== 年视图 ===== -->
    <template v-else>
      <div class="date-nav">
        <button class="nav-btn" @click="shiftYear(-1)" aria-label="上一年">
          <i class="bi bi-chevron-left" style="font-size:18px"></i>
        </button>
        <div class="date-center">
          <div class="date-main">{{ selectedYear }} 年</div>
        </div>
        <button class="nav-btn" @click="shiftYear(1)" aria-label="下一年">
          <i class="bi bi-chevron-right" style="font-size:18px"></i>
        </button>
      </div>

      <section class="clean-card summary-card">
        <div class="sum-cell">
          <div class="sum-val">{{ yearSummary.sessions }}</div>
          <div class="sum-lbl">次</div>
        </div>
        <div class="sum-div" />
        <div class="sum-cell">
          <div class="sum-val">{{ fmtMinutes(yearSummary.durationSec) }}</div>
          <div class="sum-lbl">分钟</div>
        </div>
        <div class="sum-div" />
        <div class="sum-cell">
          <div class="sum-val">{{ Math.round(yearSummary.calories) }}</div>
          <div class="sum-lbl">千卡</div>
        </div>
      </section>

      <section class="clean-card chart-card">
        <div class="chart-head">
          <h3 class="chart-title">月度时长（分钟）</h3>
        </div>
        <BarChartThick
          :data="yearBars"
          :height="80"
          :bar-radius="4"
          :gap-ratio="0.4"
          color="var(--color-warm)"
          show-y-axis
          y-unit="m"
        />
      </section>

      <section class="clean-card chart-card">
        <div class="chart-head">
          <h3 class="chart-title">卡路里趋势</h3>
        </div>
        <LineChart
          :data="yearCalories"
          :labels="yearMonths"
          :ticks="[0, 3, 6, 9, 11]"
          :height="80"
          color="var(--color-primary)"
          :show-dots="false"
          show-x-axis
        />
      </section>
    </template>
  </div>
</template>

<style scoped>
.history-page {
  padding: var(--space-2) 0 var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sub-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-1);
}
.back-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.sub-title {
  flex: 1;
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.rec-count {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  background: var(--bg-200);
  padding: 2px 10px;
  border-radius: var(--radius-full);
}

.seg {
  display: flex;
  background: var(--bg-200);
  border-radius: var(--radius-full);
  padding: 3px;
  gap: 2px;
}
.seg button {
  flex: 1;
  padding: 7px 0;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-immersive);
}
.seg button.active {
  background: var(--bg-50);
  color: var(--color-text);
  font-weight: var(--fw-semibold);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.date-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 0 var(--space-1);
}
.nav-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.nav-btn:active {
  transform: scale(0.92);
}
.date-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.date-main {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
.today-btn {
  border: none;
  background: transparent;
  color: var(--color-warm);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  padding: 0;
}

.summary-card {
  display: flex;
  align-items: center;
  padding: var(--space-4) var(--space-3);
}
.sum-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.sum-val {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--warm-500);
  font-variant-numeric: tabular-nums;
}
.sum-lbl {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.sum-div {
  width: 1px;
  height: 28px;
  background: var(--color-divider);
}

.rec-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.rec-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: none;
  text-align: left;
}
.rec-main { flex: 1; min-width: 0; }
.rec-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rec-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.rec-meta .dot { color: var(--color-text-tertiary); }
.rec-done { color: var(--color-success); font-weight: var(--fw-medium); }
.rec-partial { color: var(--color-warning); font-weight: var(--fw-medium); }
.chevron { color: var(--color-text-tertiary); }

.month-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.month-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
}
.mr-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mr-day {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.mr-sess {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.mr-right {
  display: flex;
  gap: var(--space-4);
  align-items: baseline;
}
.mr-dur {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--warm-500);
  font-variant-numeric: tabular-nums;
}
.mr-dur span, .mr-cal span {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
}
.mr-cal {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.chart-card {
  padding: var(--space-4);
}
.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}
.chart-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-12) 0;
  color: var(--color-text-tertiary);
}
.empty p {
  font-size: var(--text-sm);
  margin: 0;
}
</style>
