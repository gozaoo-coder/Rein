<script setup lang="ts">
/**
 * RecentWorkoutCard — 最近运动卡
 *
 * 2x2: 7 日柱图 + 最近 1 条记录
 * 4x2: 7 日柱图 + 最近 3 条 + footer 统计
 */
import { computed } from "vue";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import BarChartThin from "@/components/charts/BarChartThin.vue";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useWorkoutStatsStore();

const isWide = computed(() => props.size === "4x2");

const recent = computed(() =>
  [...store.records]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, isWide.value ? 3 : 1),
);

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
  <div
    class="home-card clean-card wo-card"
    :class="`home-card--${size}`"
    @click="emit('click')"
  >
    <div class="card-head">
      <span class="title-icon title-icon--warm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="15" cy="5" r="2" />
          <path d="M10 21l2-6 3 2 3-5-3-1-3 3-3-1-3 5z" />
        </svg>
      </span>
      <span class="card-title">最近运动</span>
      <span v-if="hasData" class="head-sub">连续 {{ store.streakDays }} 天</span>
    </div>

    <div v-if="hasData" class="chart">
      <BarChartThin
        :data="weekMinutes"
        :labels="weekLabels"
        :height="isWide ? 48 : 36"
        color="var(--color-warm)"
        :ticks="[0, 3, 6]"
      />
    </div>

    <div v-if="recent.length" class="record-list">
      <div v-for="r in recent" :key="r.id" class="record-row">
        <div class="record-main">
          <div class="record-name">{{ r.courseName }}</div>
          <div class="record-meta">
            <span>{{ fmtDate(r.startedAt) }}</span>
            <span class="dot">·</span>
            <span>{{ fmtDuration(r.durationSec) }}</span>
            <span class="dot">·</span>
            <span>{{ Math.round(r.caloriesBurned) }}kcal</span>
          </div>
        </div>
        <span class="badge" :class="r.finished ? 'badge--done' : 'badge--partial'">
          {{ r.finished ? "完成" : "中断" }}
        </span>
      </div>
    </div>

    <div v-else class="empty">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="15" cy="5" r="2" />
        <path d="M10 21l2-6 3 2 3-5-3-1-3 3-3-1-3 5z" />
      </svg>
      <div class="empty-text">暂无训练记录</div>
    </div>

    <div v-if="isWide && hasData" class="footer">
      <div class="stat">
        <div class="stat-num">{{ store.totalSessions }}</div>
        <div class="stat-label">总训练</div>
      </div>
      <div class="stat-divider" />
      <div class="stat">
        <div class="stat-num">{{ totalMinutes }}</div>
        <div class="stat-label">分钟</div>
      </div>
      <div class="stat-divider" />
      <div class="stat">
        <div class="stat-num">{{ Math.round(store.totalCalories) }}</div>
        <div class="stat-label">千卡</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wo-card {
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
.wo-card:active { transform: scale(0.98); }
.wo-card:hover { box-shadow: var(--shadow-card-hover); }

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
  background: var(--color-warm);
}

.card-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
  flex: 1;
  min-width: 0;
}

.head-sub {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.chart {
  padding: var(--space-1) 0;
}

.record-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-height: 0;
}

.record-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-100);
}

.record-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.record-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  flex-wrap: wrap;
}

.dot { color: var(--color-text-tertiary); }

.badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
}
.badge--done { background: var(--success-50); color: var(--success-600); }
.badge--partial { background: var(--warning-50); color: var(--warning-600); }

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
}
.empty-text { font-size: var(--text-sm); }

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-divider);
}

.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-num {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
}

.stat-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.stat-divider {
  width: 1px;
  align-self: stretch;
  background: var(--color-divider);
}
</style>
