<script setup lang="ts">
/**
 * RecentWorkoutOverview — 首页"最近运动"总览卡
 *
 * 展示：
 *   - 7 日训练强度迷你柱图
 *   - 最近 3 次训练记录
 *   - 累计统计：总训练次数 / 总分钟 / 连续天数
 */
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import BarChartThin from "@/components/charts/BarChartThin.vue";

const router = useRouter();
const store = useWorkoutStatsStore();

const recent = computed(() =>
  [...store.records]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 3),
);

/** 7 日分钟数（用于柱图） */
const weekMinutes = computed(() =>
  store.stats.last7Days.map((d) => Math.round(d.durationSec / 60)),
);

const weekLabels = computed(() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const labels: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
  }
  return labels;
});

const totalMinutes = computed(() => Math.round(store.totalDurationSec / 60));
const hasData = computed(() => store.records.length > 0);

function goSports() {
  router.push("/sports");
}

function openRecord(id: string) {
  router.push(`/workout/history/${id}`);
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function fmtDuration(sec: number): string {
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
</script>

<template>
  <div class="recent-overview clean-card">
    <!-- Header -->
    <div class="ov-header">
      <div class="ov-title-wrap">
        <div class="icon-circle icon-circle--warm">
          <i class="bi bi-universal-access" style="font-size:18px"></i>
        </div>
        <div class="ov-title-text">
          <div class="ov-title">最近运动</div>
          <div class="ov-sub">
            <template v-if="hasData">连续 {{ store.streakDays }} 天 · 共 {{ store.totalSessions }} 次</template>
            <template v-else>开始你的第一次训练</template>
          </div>
        </div>
      </div>
      <button class="ov-more" @click="goSports" aria-label="查看更多">
        <i class="bi bi-chevron-right" style="font-size:18px"></i>
      </button>
    </div>

    <!-- 7-day mini chart -->
    <div v-if="hasData" class="ov-chart">
      <BarChartThin
        :data="weekMinutes"
        :labels="weekLabels"
        :height="40"
        color="var(--color-warm)"
        :ticks="[0, 3, 6]"
      />
    </div>

    <!-- Recent records list -->
    <div v-if="recent.length" class="ov-list">
      <button
        v-for="r in recent"
        :key="r.id"
        class="ov-row"
        @click="openRecord(r.id)"
      >
        <div class="ov-row-main">
          <div class="ov-row-name">{{ r.courseName }}</div>
          <div class="ov-row-meta">
            <span>{{ fmtDate(r.startedAt) }}</span>
            <span class="dot">·</span>
            <span>{{ fmtDuration(r.durationSec) }}</span>
            <span class="dot">·</span>
            <span>{{ Math.round(r.caloriesBurned) }}kcal</span>
          </div>
        </div>
        <span class="ov-badge" :class="r.finished ? 'ov-badge--done' : 'ov-badge--partial'">
          {{ r.finished ? '完成' : '中断' }}
        </span>
      </button>
    </div>

    <!-- Empty state -->
    <div v-else class="ov-empty">
      <i class="bi bi-universal-access" style="font-size:28px;color:var(--color-text-tertiary)"></i>
      <div class="ov-empty-text">暂无训练记录</div>
      <button class="ov-empty-btn" @click="goSports">去运动</button>
    </div>

    <!-- Footer stats -->
    <div v-if="hasData" class="ov-footer">
      <div class="ov-stat">
        <div class="ov-stat-num">{{ store.totalSessions }}</div>
        <div class="ov-stat-label">总训练</div>
      </div>
      <div class="ov-stat-divider" />
      <div class="ov-stat">
        <div class="ov-stat-num">{{ totalMinutes }}</div>
        <div class="ov-stat-label">分钟</div>
      </div>
      <div class="ov-stat-divider" />
      <div class="ov-stat">
        <div class="ov-stat-num">{{ Math.round(store.totalCalories) }}</div>
        <div class="ov-stat-label">千卡</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recent-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  width: 100%;
}

.ov-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.ov-title-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  flex: 1;
}

.ov-title-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ov-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.ov-sub {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-more {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-immersive);
}

.ov-more:active {
  background: var(--bg-300);
}

.ov-chart {
  padding: var(--space-2) 0;
}

.ov-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ov-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-100);
  border: none;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-immersive);
}

.ov-row:active {
  background: var(--bg-200);
}

.ov-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ov-row-name {
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-row-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  flex-wrap: wrap;
}

.dot {
  color: var(--color-text-tertiary);
}

.ov-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
}

.ov-badge--done {
  background: var(--success-50);
  color: var(--success-600);
}

.ov-badge--partial {
  background: var(--warning-50);
  color: var(--warning-600);
}

.ov-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--color-text-tertiary);
}

.ov-empty-text {
  font-size: var(--text-sm);
}

.ov-empty-btn {
  padding: 6px 18px;
  border-radius: var(--radius-full);
  border: none;
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  margin-top: var(--space-1);
  transition: transform var(--dur-fast) var(--ease-immersive);
}

.ov-empty-btn:active {
  transform: scale(0.95);
}

.ov-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-2) 0;
  border-top: 1px solid var(--color-divider);
}

.ov-stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.ov-stat-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
}

.ov-stat-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.ov-stat-divider {
  width: 1px;
  align-self: stretch;
  background: var(--color-divider);
}
</style>
