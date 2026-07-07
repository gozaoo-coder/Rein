<script setup lang="ts">
/**
 * HealthPage — Daily health overview.
 * Layout matches 华为健康 reference:
 *   1. Triple semi-ring hero (calories / steps / exercise)
 *   2. Daily summary card (calories / steps / exercise + activity count)
 *   3. 2x2 detail cards (sleep / heart rate / blood pressure / blood sugar)
 *
 * All mini-charts use reusable SVG components from @/components/charts.
 */
import SemiRingProgress from "@/components/charts/SemiRingProgress.vue";
import RangeChart, { type ChartZone } from "@/components/charts/RangeChart.vue";
import LevelIndicator, { type LevelSegment } from "@/components/charts/LevelIndicator.vue";
import { computed } from "vue";

const today = new Date();
const dateStr = computed(() => {
  const m = today.getMonth() + 1;
  const d = today.getDate();
  return `${m}月${d}日`;
});

/* ===== Health data (placeholder — will bind to store later) ===== */
const health = {
  calories: 229,
  caloriesGoal: 400,
  steps: 4247,
  stepsGoal: 9000,
  exerciseMin: 7,
  exerciseGoal: 30,
  activities: 6,
  sleepHours: 3,
  sleepMinutes: 54,
  sleepQuality: "有待提高",
  sleepQualityValue: 0.15,
  heartRate: 60,
  heartRateTime: "19:41",
};

function sleepDurationLabel() {
  const h = health.sleepHours;
  const m = health.sleepMinutes;
  return `${h}时${m}分`;
}

/* ===== Heart rate 24h data + zones (RangeChart) =====
 * Zones from bottom (resting) to top (peak), matching Huawei Health colors:
 *   休息 <100, 热身 100-120, 燃脂 120-140, 有氧 140-160, 极限 160-190
 */
const hrZones: ChartZone[] = [
  { from: 50,  to: 100, color: "#e8e0ff", label: "休息" },
  { from: 100, to: 120, color: "#c8d8ff", label: "热身" },
  { from: 120, to: 140, color: "#ffd0b0", label: "燃脂" },
  { from: 140, to: 160, color: "#ff9a78", label: "有氧" },
  { from: 160, to: 190, color: "#ff6a50", label: "极限" },
];

/* Deterministic 30-sample 24h heart rate pattern simulating day rhythm */
const hrData = computed(() => {
  const pattern = [
    0.12, 0.10, 0.08, 0.08, 0.10, 0.14, 0.20, 0.28,
    0.42, 0.60, 0.78, 0.55, 0.38, 0.26, 0.22, 0.28,
    0.50, 0.68, 0.82, 0.70, 0.52, 0.34, 0.24, 0.20,
    0.16, 0.14, 0.12, 0.10, 0.10, 0.12,
  ];
  return pattern.map((p) => Math.round(58 + p * 110));
});

/* ===== Sleep quality levels (LevelIndicator) ===== */
const sleepLevels: LevelSegment[] = [
  { color: "#f0a0a0", label: "有待提高" },
  { color: "#f0c880" },
  { color: "#b0d890" },
  { color: "#7cc07c", label: "优" },
];
</script>

<template>
  <div class="health-page">
    <!-- ===== Activity Rings Hero (reusable SemiRingProgress) ===== -->
    <div class="hero-section">
      <SemiRingProgress
        :calories="health.calories"
        :calories-goal="health.caloriesGoal"
        :steps="health.steps"
        :steps-goal="health.stepsGoal"
        :exercise-minutes="health.exerciseMin"
        :exercise-goal="health.exerciseGoal"
      />
    </div>

    <!-- ===== Daily Summary Card ===== -->
    <div class="summary-card clean-card">
      <div class="metrics-row">
        <div class="metric-item">
          <div class="metric-head">
            <svg class="metric-icon metric-icon--orange" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2c1 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4-1 4 3 5 3 1 0-2-2-4 0-6z" />
            </svg>
            <span class="metric-label">卡路里</span>
          </div>
          <div class="metric-value-row">
            <span class="metric-number">{{ health.calories }}</span>
            <span class="metric-goal">/{{ health.caloriesGoal }}千卡</span>
          </div>
        </div>

        <div class="metric-divider" />

        <div class="metric-item">
          <div class="metric-head">
            <svg class="metric-icon metric-icon--yellow" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span class="metric-label">步数</span>
          </div>
          <div class="metric-value-row">
            <span class="metric-number">{{ health.steps.toLocaleString() }}</span>
            <span class="metric-goal">/{{ health.stepsGoal.toLocaleString() }}步</span>
          </div>
        </div>

        <div class="metric-divider" />

        <div class="metric-item">
          <div class="metric-head">
            <svg class="metric-icon metric-icon--blue" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span class="metric-label">中高强度</span>
          </div>
          <div class="metric-value-row">
            <span class="metric-number">{{ health.exerciseMin }}</span>
            <span class="metric-goal">/{{ health.exerciseGoal }}分钟</span>
          </div>
        </div>
      </div>

      <hr class="divider summary-divider" />

      <div class="activity-row">
        <div class="activity-left">
          <svg class="activity-icon" width="20" height="20" viewBox="0 0 24 24" fill="#64BB5C">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-1a7 7 0 0 1 14 0v1" />
          </svg>
          <span class="activity-label">活动次数</span>
          <span class="activity-count">{{ health.activities }} 次</span>
        </div>
        <svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>
    </div>

    <!-- ===== Detail Cards 2x2 Grid ===== -->
    <div class="detail-grid">
      <!-- Sleep: LevelIndicator (equal segments + triangle pointer) -->
      <div class="detail-card clean-card clean-card--interactive">
        <div class="detail-icon-wrap icon-circle--purple icon-circle">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </div>
        <div class="detail-title">睡眠</div>
        <div class="detail-value">{{ sleepDurationLabel() }}</div>
        <div class="detail-sub">{{ dateStr }} 睡眠质量{{ health.sleepQuality }}</div>
        <div class="detail-chart">
          <LevelIndicator
            :segments="sleepLevels"
            :value="health.sleepQualityValue"
            :height="10"
            :gap="2"
          />
        </div>
      </div>

      <!-- Heart Rate: RangeChart (colored HR zones + 24h line) -->
      <div class="detail-card clean-card clean-card--interactive">
        <div class="detail-icon-wrap icon-circle--red icon-circle">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </div>
        <div class="detail-title">心率</div>
        <div class="detail-value">{{ health.heartRate }}<span class="detail-unit">次/分</span></div>
        <div class="detail-sub">{{ dateStr }} {{ health.heartRateTime }}</div>
        <div class="detail-chart">
          <RangeChart
            :data="hrData"
            :zones="hrZones"
            :x-labels="['00:00', '06:00', '12:00', '18:00', '24:00']"
            :height="52"
            color="#e84040"
            :stroke-width="1.6"
            :smooth="true"
          />
        </div>
      </div>

      <!-- Blood Pressure -->
      <div class="detail-card clean-card clean-card--interactive detail-card--row">
        <div class="detail-row">
          <div class="detail-icon-wrap icon-circle--blue icon-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
            </svg>
          </div>
          <div class="detail-text">
            <div class="detail-title detail-title--row">血压</div>
            <div class="detail-sub detail-sub--row">佩戴设备后测量</div>
          </div>
        </div>
        <svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>

      <!-- Blood Sugar -->
      <div class="detail-card clean-card clean-card--interactive detail-card--row">
        <div class="detail-row">
          <div class="detail-icon-wrap icon-circle--red icon-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
              <path d="M12 7v6M9 12h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none" />
            </svg>
          </div>
          <div class="detail-text">
            <div class="detail-title detail-title--row">血糖</div>
            <div class="detail-sub detail-sub--row">记录您的血糖数据</div>
          </div>
        </div>
        <svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
.health-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
}

/* ===== Hero Rings ===== */
.hero-section {
  padding: var(--space-2) var(--space-2) 0;
  display: flex;
  justify-content: center;
}

/* ===== Summary Card ===== */
.summary-card {
  padding: var(--space-5) var(--space-5) var(--space-4);
}

.metrics-row {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
}

.metric-item {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.metric-item:not(:last-child) {
  padding-right: var(--space-2);
}

.metric-divider {
  width: 1px;
  background: var(--color-divider);
  flex-shrink: 0;
  align-self: stretch;
  margin: 0 var(--space-1);
}

.metric-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.metric-icon {
  flex-shrink: 0;
}

.metric-icon--orange { color: var(--color-warm); }
.metric-icon--yellow { color: var(--ring-middle); }
.metric-icon--blue { color: var(--ring-inner); }

.metric-label {
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.metric-value-row {
  display: flex;
  align-items: baseline;
  gap: 2px;
  flex-wrap: wrap;
}

.metric-number {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.metric-goal {
  font-size: var(--text-base);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.summary-divider {
  margin: var(--space-4) 0 var(--space-3);
}

.activity-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-1) 0;
  color: var(--color-text-tertiary);
}

.activity-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text);
}

.chevron {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

.activity-icon {
  flex-shrink: 0;
}

.activity-label {
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  color: var(--color-text);
}

.activity-count {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

/* ===== Detail Cards Grid ===== */
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-auto-rows: 1fr;
  gap: var(--space-3);
}

.detail-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 180px;
  position: relative;
}

.detail-icon-wrap {
  margin-bottom: var(--space-1);
}

.detail-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.detail-value {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.detail-unit {
  font-size: var(--text-base);
  font-weight: var(--fw-regular);
  color: var(--color-text-secondary);
  margin-left: 2px;
}

.detail-sub {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  line-height: 1.3;
}

.detail-chart {
  margin-top: auto;
  width: 100%;
}

/* Row-style detail cards (BP / Blood Sugar) share same grid cell height */
.detail-card--row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.detail-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}

.detail-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.detail-title--row {
  font-size: var(--text-lg);
}

.detail-sub--row {
  font-size: var(--text-sm);
}
</style>
