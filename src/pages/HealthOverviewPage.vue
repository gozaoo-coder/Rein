<script setup lang="ts">
/**
 * HealthOverviewPage — 健康数据概览二级页
 *
 * - 汇总今日健康数据（饮水/饮食/BMI/运动）
 * - 快捷入口到各健康子页
 * - 最近 7 天饮水/卡路里迷你图
 */
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { BMI_CATEGORY_LABEL, classifyBmi } from "@/types/health";

const router = useRouter();
const health = useHealthDataStore();
const stats = useWorkoutStatsStore();

onMounted(() => {
  health.load();
  stats.load();
});

const bmi = computed(() => health.currentBmi);
const bmiCategory = computed(() => (bmi.value ? classifyBmi(bmi.value) : null));

const todayWater = computed(() => health.todayWaterAmount);
const waterGoal = computed(() => health.waterGoalMl);
const waterPct = computed(() => Math.min(100, Math.round((todayWater.value / waterGoal.value) * 100)));

const todayCals = computed(() => health.todayCalories);
const calGoal = computed(() => health.dailyCalorieGoal);
const calPct = computed(() => Math.min(100, Math.round((todayCals.value / calGoal.value) * 100)));

const weekWorkoutMin = computed(() => Math.round(stats.weekDurationSec / 60));

function go(path: string) {
  router.push(path);
}

interface HealthEntry {
  id: string;
  icon: string;
  iconClass: string;
  name: string;
  value: string;
  sub: string;
  path: string;
  accent: string;
}

const entries = computed<HealthEntry[]>(() => [
  {
    id: "water",
    icon: "bi-droplet-fill",
    iconClass: "icon-circle--blue",
    name: "饮水",
    value: `${todayWater.value}ml`,
    sub: `目标 ${waterGoal.value}ml · ${waterPct.value}%`,
    path: "/health/water",
    accent: "var(--icon-blue)",
  },
  {
    id: "food",
    icon: "bi-apple",
    iconClass: "icon-circle--green",
    name: "饮食",
    value: `${Math.round(todayCals.value)}kcal`,
    sub: `目标 ${calGoal.value}kcal · ${calPct.value}%`,
    path: "/health/food",
    accent: "var(--success-500)",
  },
  {
    id: "bmi",
    icon: "bi-activity",
    iconClass: "icon-circle--warm",
    name: "身体数据",
    value: bmi.value ? bmi.value.toFixed(1) : "--",
    sub: bmiCategory.value ? BMI_CATEGORY_LABEL[bmiCategory.value] : "点击记录身高体重",
    path: "/health/bmi",
    accent: "var(--color-warm)",
  },
]);
</script>

<template>
  <div class="health-overview-page">
    <!-- 今日健康摘要 -->
    <section class="clean-card summary-card">
      <div class="summary-head">
        <h2 class="summary-title">今日健康</h2>
      </div>
      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-ring water-ring">
            <svg viewBox="0 0 36 36" class="ring-svg">
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--bg-200)" stroke-width="3" />
              <circle
                cx="18" cy="18" r="15.5" fill="none"
                stroke="var(--icon-blue)" stroke-width="3"
                stroke-linecap="round"
                :stroke-dasharray="`${waterPct * 0.97} 100`"
                transform="rotate(-90 18 18)"
              />
            </svg>
            <span class="ring-pct">{{ waterPct }}%</span>
          </div>
          <div class="summary-label">饮水</div>
        </div>
        <div class="summary-item">
          <div class="summary-ring cal-ring">
            <svg viewBox="0 0 36 36" class="ring-svg">
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--bg-200)" stroke-width="3" />
              <circle
                cx="18" cy="18" r="15.5" fill="none"
                stroke="var(--success-500)" stroke-width="3"
                stroke-linecap="round"
                :stroke-dasharray="`${calPct * 0.97} 100`"
                transform="rotate(-90 18 18)"
              />
            </svg>
            <span class="ring-pct">{{ calPct }}%</span>
          </div>
          <div class="summary-label">饮食</div>
        </div>
        <div class="summary-item">
          <div class="summary-stat">
            <span class="stat-val">{{ weekWorkoutMin }}</span>
            <span class="stat-unit">min</span>
          </div>
          <div class="summary-label">本周运动</div>
        </div>
      </div>
    </section>

    <!-- 健康数据入口列表 -->
    <section class="entry-list">
      <button
        v-for="e in entries"
        :key="e.id"
        class="entry-row clean-card clean-card--interactive"
        @click="go(e.path)"
      >
        <div :class="['entry-icon', 'icon-circle', e.iconClass]">
          <i :class="['bi', e.icon]" :style="{ fontSize: e.id === 'bmi' ? '20px' : '22px' }"></i>
        </div>
        <div class="entry-main">
          <div class="entry-name">{{ e.name }}</div>
          <div class="entry-sub">{{ e.sub }}</div>
        </div>
        <div class="entry-right">
          <span class="entry-val" :style="{ color: e.accent }">{{ e.value }}</span>
          <i class="bi bi-chevron-right chevron" style="font-size:18px"></i>
        </div>
      </button>
    </section>
  </div>
</template>

<style scoped>
.health-overview-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-6);
}

.summary-card {
  padding: var(--space-5);
}
.summary-head { margin-bottom: var(--space-4); }
.summary-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}
.summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}
.summary-ring {
  position: relative;
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ring-svg {
  width: 100%;
  height: 100%;
}
.ring-pct {
  position: absolute;
  font-size: var(--text-xs);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.summary-stat {
  height: 64px;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 2px;
}
.stat-val {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1;
}
.stat-unit {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.summary-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}

.entry-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.entry-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border: none;
  text-align: left;
  width: 100%;
}
.entry-main { flex: 1; min-width: 0; }
.entry-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.entry-sub {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.entry-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.entry-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  font-variant-numeric: tabular-nums;
}
</style>
