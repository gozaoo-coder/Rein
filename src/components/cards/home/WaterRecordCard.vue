<script setup lang="ts">
/**
 * WaterRecordCard — 饮水记录卡
 *
 * 1x1: 圆环 + 毫升数
 * 2x1: 进度条 + X/2000ml + 快加按钮 (+200ml)
 * 2x2: 进度条 + 4 个快加按钮 (100/200/300/500ml) + 今日记录列表
 */
import { computed } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useHealthDataStore();

const GOAL = 2000;
const amount = computed(() => store.todayWaterAmount);
const progress = computed(() => Math.min(amount.value / GOAL, 1));

function dateKeyFromTs(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayKey(): string {
  return dateKeyFromTs(Date.now());
}

const todayRecords = computed(() =>
  store.waterRecords
    .filter((r) => dateKeyFromTs(r.timestamp) === todayKey())
    .sort((a, b) => b.timestamp - a.timestamp),
);

const quickAdds = [100, 200, 300, 500];

function add(ml: number, e: Event) {
  e.stopPropagation();
  store.addWater(ml);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const C = 2 * Math.PI * 16;
const dashOffset = computed(() => C - progress.value * C);
const quickList2x1 = computed(() => [200]);
</script>

<template>
  <div
    class="home-card clean-card water-card"
    :class="`home-card--${size}`"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--blue">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
        </svg>
      </span>
      <span class="card-title">饮水记录</span>
    </div>

    <!-- 1x1 -->
    <div v-if="size === '1x1'" class="mini">
      <div class="ring">
        <svg width="64" height="64" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="16" fill="none" stroke="var(--bg-200)" stroke-width="4" />
          <circle
            cx="20" cy="20" r="16" fill="none"
            stroke="var(--icon-blue)" stroke-width="4"
            stroke-linecap="round"
            :stroke-dasharray="C"
            :stroke-dashoffset="dashOffset"
            :style="{
              transform: 'rotate(-90deg)',
              transformOrigin: '20px 20px',
              transition: 'stroke-dashoffset .4s var(--ease-immersive)',
            }"
          />
          <text x="20" y="20" text-anchor="middle" font-size="8" font-weight="700" fill="var(--color-text)">
            {{ amount }}
          </text>
          <text x="20" y="27" text-anchor="middle" font-size="4" fill="var(--color-text-tertiary)">ml</text>
        </svg>
      </div>
    </div>

    <!-- 2x1 / 2x2 -->
    <template v-else>
      <div class="amount-row">
        <div class="amount-text">
          <span class="amount-num">{{ amount }}</span>
          <span class="amount-goal">/ {{ GOAL }}ml</span>
        </div>
        <span class="pct">{{ Math.round(progress * 100) }}%</span>
      </div>

      <div class="bar-track">
        <div class="bar-fill" :style="{ width: progress * 100 + '%' }" />
      </div>

      <div class="quick-row">
        <button
          v-for="ml in (size === '2x1' ? quickList2x1 : quickAdds)"
          :key="ml"
          class="quick-btn"
          @click="add(ml, $event)"
        >
          +{{ ml }}ml
        </button>
      </div>

      <div v-if="size === '2x2'" class="record-list">
        <div v-if="todayRecords.length === 0" class="empty">今日暂无记录</div>
        <div v-for="r in todayRecords.slice(0, 4)" :key="r.id" class="record-item">
          <span class="record-time">{{ fmtTime(r.timestamp) }}</span>
          <span class="record-amount">+{{ r.amount }}ml</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.water-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
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
.water-card:active { transform: scale(0.98); }
.water-card:hover { box-shadow: var(--shadow-card-hover); }

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
  background: var(--icon-blue);
}

.card-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.mini {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ring { flex-shrink: 0; }

.amount-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.amount-text {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.amount-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.amount-goal {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}
.pct {
  font-size: var(--text-xs);
  color: var(--icon-blue);
  font-weight: var(--fw-semibold);
}

.bar-track {
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: linear-gradient(90deg, var(--icon-blue), #6fc7ff);
  transition: width 0.4s var(--ease-immersive);
}

.quick-row {
  display: flex;
  gap: var(--space-2);
}

.quick-btn {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: var(--radius-full);
  background: var(--bg-100);
  color: var(--icon-blue);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  border: 1px solid var(--bg-200);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-immersive);
}
.quick-btn:active {
  background: var(--bg-200);
}

.record-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-height: 0;
  overflow: hidden;
}
.record-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-1) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}
.record-time {
  color: var(--color-text-tertiary);
}
.record-amount {
  color: var(--icon-blue);
  font-weight: var(--fw-semibold);
}
.empty {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-2);
}
</style>
