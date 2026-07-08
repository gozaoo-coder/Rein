<script setup lang="ts">
/**
 * FoodRecordCard — 饮食记录卡
 *
 * 1x1: 大卡数 + kcal
 * 2x1: 卡路里 + 3 营养素迷你条
 * 2x2: 卡路里大数 + 3 营养素行 + 最近 3 条饮食记录
 */
import { computed } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useHealthDataStore();

const calories = computed(() => store.todayCalories);
const carbs = computed(() => store.todayCarbs);
const protein = computed(() => store.todayProtein);
const fat = computed(() => store.todayFat);

const CAL_GOAL = 2000;
const CARB_GOAL = 250;
const PROTEIN_GOAL = 60;
const FAT_GOAL = 70;

const macros = computed(() => [
  { label: "碳水", value: carbs.value, goal: CARB_GOAL, color: "var(--icon-orange)" },
  { label: "蛋白", value: protein.value, goal: PROTEIN_GOAL, color: "var(--icon-blue)" },
  { label: "脂肪", value: fat.value, goal: FAT_GOAL, color: "var(--warning-500)" },
]);

const recentFoods = computed(() =>
  [...store.todayFoodRecords]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 3),
);

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
</script>

<template>
  <div
    class="home-card clean-card food-card"
    :class="`home-card--${size}`"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--success">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 11h18l-2 9a2 2 0 0 1-2 1.7H7a2 2 0 0 1-2-1.7L3 11zM7 11V8a5 5 0 0 1 10 0v3" />
        </svg>
      </span>
      <span class="card-title">饮食记录</span>
    </div>

    <!-- 1x1 -->
    <div v-if="size === '1x1'" class="mini">
      <div class="mini-num">{{ calories }}</div>
      <div class="mini-label">kcal</div>
    </div>

    <!-- 2x1 -->
    <div v-else-if="size === '2x1'" class="body-2x1">
      <div class="cal-row">
        <span class="cal-num">{{ calories }}</span>
        <span class="cal-unit">kcal</span>
        <span class="cal-goal">/ {{ CAL_GOAL }}</span>
      </div>
      <div class="macro-mini-list">
        <div v-for="m in macros" :key="m.label" class="macro-mini">
          <div class="macro-mini-head">
            <span class="macro-mini-label">{{ m.label }}</span>
            <span class="macro-mini-val">{{ m.value }}g</span>
          </div>
          <div class="mini-track">
            <div class="mini-fill" :style="{ width: Math.min(m.value / m.goal, 1) * 100 + '%', background: m.color }" />
          </div>
        </div>
      </div>
    </div>

    <!-- 2x2 -->
    <div v-else class="body-2x2">
      <div class="cal-big-row">
        <div class="cal-big-text">
          <span class="cal-big-num">{{ calories }}</span>
          <span class="cal-big-unit">kcal</span>
        </div>
        <span class="cal-big-goal">目标 {{ CAL_GOAL }} kcal</span>
      </div>

      <div class="macro-rows">
        <div v-for="m in macros" :key="m.label" class="macro-row">
          <span class="macro-dot" :style="{ background: m.color }" />
          <span class="macro-label">{{ m.label }}</span>
          <div class="macro-track">
            <div class="macro-fill" :style="{ width: Math.min(m.value / m.goal, 1) * 100 + '%', background: m.color }" />
          </div>
          <span class="macro-val">{{ m.value }}g</span>
        </div>
      </div>

      <div v-if="recentFoods.length" class="food-list">
        <div v-for="r in recentFoods" :key="r.id" class="food-item">
          <div class="food-main">
            <div class="food-name">{{ r.foodName }}</div>
            <div class="food-meta">{{ fmtTime(r.timestamp) }} · {{ r.grams }}g</div>
          </div>
          <span class="food-kcal">{{ r.calories }}kcal</span>
        </div>
      </div>
      <div v-else class="empty">今日暂无饮食记录</div>
    </div>
  </div>
</template>

<style scoped>
.food-card {
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
.food-card:active { transform: scale(0.98); }
.food-card:hover { box-shadow: var(--shadow-card-hover); }

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
  background: var(--success-500);
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}
.mini-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--success-500);
  line-height: 1;
}
.mini-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.body-2x1 {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.cal-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.cal-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--success-500);
  line-height: 1;
}
.cal-unit {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
.cal-goal {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-left: auto;
}

.macro-mini-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-height: 0;
}
.macro-mini-head {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-xs);
  margin-bottom: 2px;
}
.macro-mini-label { color: var(--color-text-tertiary); }
.macro-mini-val { color: var(--color-text-secondary); font-weight: var(--fw-medium); }
.mini-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}
.mini-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-immersive);
}

.body-2x2 {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.cal-big-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.cal-big-text {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.cal-big-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--success-500);
  line-height: 1;
}
.cal-big-unit {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
.cal-big-goal {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.macro-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.macro-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.macro-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}
.macro-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  width: 32px;
  flex-shrink: 0;
}
.macro-track {
  flex: 1;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}
.macro-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-immersive);
}
.macro-val {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
  width: 40px;
  text-align: right;
  flex-shrink: 0;
}

.food-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-height: 0;
}
.food-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.food-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.food-name {
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: var(--fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.food-meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.food-kcal {
  font-size: var(--text-sm);
  color: var(--success-600);
  font-weight: var(--fw-semibold);
  flex-shrink: 0;
}
.empty {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-2);
}
</style>
