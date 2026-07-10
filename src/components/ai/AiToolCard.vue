<script setup lang="ts">
/**
 * AiToolCard — 渲染 AI 工具调用结果为精美卡片。
 * 复用 SportsPage 的 course-card-body 视觉语言 + 健康页统计卡风格。
 */
import { computed, ref } from "vue";
import type { ToolResult } from "@/types/ai";
import BottomSheet from "@/components/ui/BottomSheet.vue";
import type { Course } from "@/types/course";
import type { Exercise } from "@/types/exercise";
import type { WorkoutStats } from "@/types/workout-stats";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
} from "@/types/course";
import {
  MUSCLE_GROUP_LABEL,
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_DIFFICULTY_LABEL,
} from "@/types/exercise";

const props = defineProps<{ result: ToolResult; compact?: boolean }>();

const cardType = computed(() => props.result.card ?? "raw");
const data = computed(() => props.result.cardData);
const ok = computed(() => props.result.ok);

const course = computed(() => (data.value as Course | undefined) ?? null);
const courseList = computed(() => (Array.isArray(data.value) ? (data.value as Course[]) : []));
const exercise = computed(() => (data.value as Exercise | undefined) ?? null);
const exerciseList = computed(() => (Array.isArray(data.value) ? (data.value as Exercise[]) : []));
const stats = computed(() => (data.value as WorkoutStats | undefined) ?? null);

interface WorkoutCardData {
  planName: string;
  planLevel?: string;
  totalSteps: number;
  currentStepIndex: number;
  currentSetInStep: number;
  totalElapsedSeconds: number;
  totalSets: number;
  completedSets: number;
  step: {
    title: string;
    phase: string;
    equipment?: string;
    muscleGroup?: string;
    weight?: number;
    cautions?: string;
    guide?: string;
    sets?: number;
    restBetweenSets?: number;
    timer?: number;
  };
}
const workoutData = computed(() => data.value as WorkoutCardData | undefined);
interface BodyMetricsCardData {
  heightCm?: number;
  weightKg?: number;
  bodyFatPercent?: number;
  bmi?: number;
  timestamp?: number;
}
const bodyData = computed(() => data.value as BodyMetricsCardData | undefined);

const toolLabel: Record<string, string> = {
  "course_list": "查询课程",
  "course_get": "课程详情",
  "course_create": "创建课程",
  "course_update": "更新课程",
  "course_delete": "删除课程",
  "exercise_list": "查询动作",
  "exercise_create": "创建动作",
  "exercise_update": "更新动作",
  "exercise_delete": "删除动作",
  "stats_get": "运动统计",
  "todo_list": "查询待办",
  "todo_create": "创建待办",
  "todo_update": "更新待办",
  "todo_delete": "删除待办",
  "todo_toggle_done": "切换完成",
  "water_add": "记录饮水",
  "water_today": "今日饮水",
  "food_record_add": "记录饮食",
  "food_today": "今日饮食",
  "food_db_list": "查询食品库",
  "food_db_create": "新增食品",
  "food_db_update": "更新食品",
  "food_db_delete": "删除食品",
  "body_metrics_record": "记录体征",
};
const actionLabel = computed(() => toolLabel[props.result.name] ?? props.result.name);

// ===== 新卡片数据 computed =====
interface TodoCardData { items: any[]; date: string }
interface WaterCardData { amount: number; total: number; goal: number }
interface FoodRecordCardData {
  record?: any;
  records?: any[];
  todayTotals: { calories: number; carbs: number; protein: number; fat: number };
}
interface FoodDbCardData { items: any[] }

const todoData = computed(() => data.value as TodoCardData | undefined);
const waterData = computed(() => data.value as WaterCardData | undefined);
const foodRecData = computed(() => data.value as FoodRecordCardData | undefined);
const foodDbData = computed(() => data.value as FoodDbCardData | undefined);

const waterPct = computed(() => {
  if (!waterData.value) return 0;
  return Math.min((waterData.value.total / waterData.value.goal) * 100, 100);
});

// ===== 详情 BottomSheet =====
const showDetail = ref(false);
const detailJson = computed(() =>
  data.value == null ? "{}" : JSON.stringify(data.value, null, 2),
);
</script>

<template>
  <div
    class="tool-card"
    :class="{ 'is-error': !ok, 'is-compact': compact }"
    role="button"
    tabindex="0"
    @click="showDetail = true"
    @keydown.enter="showDetail = true"
  >
    <div class="tool-head">
      <div class="tool-badge" :class="ok ? 'ok' : 'err'">
        <i v-if="ok" class="bi bi-check-lg" style="font-size:12px"></i>
        <i v-else class="bi bi-x-lg" style="font-size:12px"></i>
      </div>
      <span class="tool-action">{{ actionLabel }}</span>
      <span class="tool-summary">{{ result.summary }}</span>
    </div>

    <!-- 单个课程卡（复用 course-card-body 视觉） -->
    <div v-if="cardType === 'course' && course" class="course-card-body">
      <div class="course-name">{{ course.name }}</div>
      <div class="course-meta">
        <span>{{ CATEGORY_LABEL[course.category] }}</span>
        <span class="dot">·</span>
        <span>{{ course.estimatedMinutes }}min</span>
        <span class="dot">·</span>
        <span>{{ course.estimatedCalories }}kcal</span>
        <span class="dot">·</span>
        <span>{{ course.steps.length }}组</span>
      </div>
      <div v-if="course.description" class="course-desc">{{ course.description }}</div>
      <div class="course-actions">
        <span class="course-diff" :data-diff="course.difficulty">{{ DIFFICULTY_LABEL[course.difficulty] }}</span>
        <span v-if="course.pinned" class="course-pin">★ 置顶</span>
      </div>
    </div>

    <!-- 课程列表 -->
    <div v-else-if="cardType === 'course-list' && courseList.length" class="list-wrap">
      <div v-for="c in courseList.slice(0, 6)" :key="c.id" class="course-card-body mini">
        <div class="course-name">{{ c.name }}</div>
        <div class="course-meta">
          <span>{{ CATEGORY_LABEL[c.category] }}</span>
          <span class="dot">·</span>
          <span>{{ c.estimatedMinutes }}min</span>
          <span class="dot">·</span>
          <span>{{ c.estimatedCalories }}kcal</span>
        </div>
      </div>
      <div v-if="courseList.length > 6" class="list-more">共 {{ courseList.length }} 个课程</div>
    </div>

    <!-- 单个动作卡 -->
    <div v-else-if="cardType === 'exercise' && exercise" class="ex-card-body">
      <div class="ex-name">{{ exercise.name }}</div>
      <div class="ex-meta">
        <span>{{ EXERCISE_CATEGORY_LABEL[exercise.category] }}</span>
        <span class="dot">·</span>
        <span>{{ MUSCLE_GROUP_LABEL[exercise.muscleGroup] }}</span>
        <span class="dot">·</span>
        <span>{{ EXERCISE_DIFFICULTY_LABEL[exercise.difficulty] }}</span>
      </div>
      <div v-if="exercise.equipment" class="ex-equip">器械：{{ exercise.equipment }}</div>
      <div v-if="exercise.description" class="ex-desc">{{ exercise.description }}</div>
    </div>

    <!-- 动作列表 -->
    <div v-else-if="cardType === 'exercise-list' && exerciseList.length" class="list-wrap">
      <div v-for="e in exerciseList.slice(0, 6)" :key="e.id" class="ex-card-body mini">
        <div class="ex-name">{{ e.name }}</div>
        <div class="ex-meta">
          <span>{{ MUSCLE_GROUP_LABEL[e.muscleGroup] }}</span>
          <span class="dot">·</span>
          <span>{{ EXERCISE_DIFFICULTY_LABEL[e.difficulty] }}</span>
        </div>
      </div>
      <div v-if="exerciseList.length > 6" class="list-more">共 {{ exerciseList.length }} 个动作</div>
    </div>

    <!-- 统计卡（复用健康页统计风格） -->
    <div v-else-if="cardType === 'stats' && stats" class="stats-card-body">
      <div class="stats-grid">
        <div class="stat-block">
          <div class="stat-num">{{ stats.totalSessions }}</div>
          <div class="stat-label">总训练</div>
        </div>
        <div class="stat-block">
          <div class="stat-num">{{ Math.round(stats.totalDurationSec / 60) }}</div>
          <div class="stat-label">分钟</div>
        </div>
        <div class="stat-block">
          <div class="stat-num">{{ Math.round(stats.totalCalories) }}</div>
          <div class="stat-label">千卡</div>
        </div>
        <div class="stat-block">
          <div class="stat-num">{{ stats.streakDays }}</div>
          <div class="stat-label">连续天</div>
        </div>
      </div>
      <!-- 近7天迷你柱状图 -->
      <div v-if="stats.last7Days.length" class="bars">
        <div
          v-for="d in stats.last7Days"
          :key="d.date"
          class="bar-col"
          :title="`${d.date}: ${d.sessions}次`"
        >
          <div class="bar" :style="{ height: `${Math.min(100, d.sessions * 25 + 4)}%` }" />
          <span class="bar-label">{{ d.date.slice(5) }}</span>
        </div>
      </div>
    </div>

    <!-- 待办卡 -->
    <div v-else-if="cardType === 'todo' && todoData" class="todo-card-body">
      <div class="todo-date">{{ todoData.date === "all" ? "全部待办" : todoData.date }}</div>
      <div v-if="!todoData.items.length" class="empty">暂无待办</div>
      <div v-for="t in todoData.items.slice(0, 6)" :key="t.id" class="todo-item">
        <span class="todo-cb" :class="{ 'is-done': t.done }">
          <i v-if="t.done" class="bi bi-check-lg" style="font-size:10px;color:#fff"></i>
        </span>
        <span class="todo-title" :class="{ 'is-done': t.done }">{{ t.title }}</span>
        <span class="todo-pri" :data-pri="t.priority">{{ t.priorityLabel }}</span>
      </div>
      <div v-if="todoData.items.length > 6" class="list-more">共 {{ todoData.items.length }} 条</div>
    </div>

    <!-- 饮水卡 -->
    <div v-else-if="cardType === 'water' && waterData" class="water-card-body">
      <div class="water-row">
        <svg width="56" height="56" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="32" fill="none" stroke="var(--bg-200)" stroke-width="6" />
          <circle
            cx="40" cy="40" r="32" fill="none"
            stroke="#3da9ff" stroke-width="6"
            stroke-linecap="round"
            :stroke-dasharray="2 * Math.PI * 32"
            :stroke-dashoffset="2 * Math.PI * 32 - (waterPct / 100) * 2 * Math.PI * 32"
            :style="{ transform: 'rotate(-90deg)', transformOrigin: '40px 40px' }"
          />
        </svg>
        <div class="water-meta">
          <div class="water-num">{{ waterData.total }}<span class="water-unit">ml</span></div>
          <div class="water-goal">目标 {{ waterData.goal }}ml</div>
        </div>
      </div>
    </div>

    <!-- 饮食记录卡 -->
    <div v-else-if="cardType === 'food-record' && foodRecData" class="food-rec-body">
      <div class="food-totals">
        <div class="ft-block ft-main">
          <span class="ft-num">{{ foodRecData.todayTotals.calories }}</span>
          <span class="ft-label">千卡</span>
        </div>
        <div class="ft-block">
          <span class="ft-num">{{ foodRecData.todayTotals.carbs }}g</span>
          <span class="ft-label">碳水</span>
        </div>
        <div class="ft-block">
          <span class="ft-num">{{ foodRecData.todayTotals.protein }}g</span>
          <span class="ft-label">蛋白</span>
        </div>
        <div class="ft-block">
          <span class="ft-num">{{ foodRecData.todayTotals.fat }}g</span>
          <span class="ft-label">脂肪</span>
        </div>
      </div>
      <div v-if="foodRecData.record" class="food-rec-item">
        <span class="fri-name">{{ foodRecData.record.foodName }}</span>
        <span class="fri-meta">{{ foodRecData.record.grams }}g · {{ foodRecData.record.calories }}千卡</span>
      </div>
      <div v-else-if="foodRecData.records && foodRecData.records.length" class="list-wrap">
        <div v-for="r in foodRecData.records.slice(0, 6)" :key="r.id" class="food-rec-item">
          <span class="fri-name">{{ r.foodName }}</span>
          <span class="fri-meta">{{ r.grams }}g · {{ r.calories }}千卡</span>
        </div>
        <div v-if="foodRecData.records.length > 6" class="list-more">共 {{ foodRecData.records.length }} 条</div>
      </div>
    </div>

    <!-- 食品库卡 -->
    <div v-else-if="cardType === 'food-db' && foodDbData" class="list-wrap">
      <div v-for="f in foodDbData.items.slice(0, 6)" :key="f.id" class="food-db-item">
        <div class="fdb-info">
          <div class="fdb-name">{{ f.name }}</div>
          <div class="fdb-meta">{{ f.category }} · {{ f.caloriesPer100g }}千卡/100g</div>
        </div>
        <div class="fdb-macros">
          <span>碳{{ f.carbsPer100g }}g</span>
          <span>蛋{{ f.proteinPer100g }}g</span>
          <span>脂{{ f.fatPer100g }}g</span>
        </div>
      </div>
      <div v-if="foodDbData.items.length > 6" class="list-more">共 {{ foodDbData.items.length }} 个</div>
    </div>

    <!-- 当前训练卡 -->
    <div v-else-if="cardType === 'workout' && workoutData" class="workout-card-body">
      <div class="wk-head">
        <span class="wk-plan">{{ workoutData.planName }}</span>
        <span class="wk-progress">{{ workoutData.currentStepIndex + 1 }}/{{ workoutData.totalSteps }} 步</span>
      </div>
      <div class="wk-step">
        <div class="wk-step-title">{{ workoutData.step.title }}</div>
        <div class="wk-step-meta">
          <span v-if="workoutData.step.phase">{{ workoutData.step.phase }}</span>
          <span v-if="workoutData.step.muscleGroup" class="dot">·</span>
          <span v-if="workoutData.step.muscleGroup">{{ workoutData.step.muscleGroup }}</span>
          <span v-if="workoutData.step.equipment" class="dot">·</span>
          <span v-if="workoutData.step.equipment">{{ workoutData.step.equipment }}</span>
          <span v-if="workoutData.step.weight" class="dot">·</span>
          <span v-if="workoutData.step.weight">{{ workoutData.step.weight }}kg</span>
        </div>
        <div class="wk-sets">
          组 {{ workoutData.currentSetInStep + 1 }}/{{ workoutData.step.sets ?? 1 }}
          · 已完成 {{ workoutData.completedSets }}/{{ workoutData.totalSets }}
          · {{ Math.floor(workoutData.totalElapsedSeconds / 60) }}min
        </div>
        <div v-if="workoutData.step.guide" class="wk-guide">{{ workoutData.step.guide }}</div>
        <div v-if="workoutData.step.cautions" class="wk-caution">
          <i class="bi bi-exclamation-triangle" style="font-size:11px"></i>
          <span>{{ workoutData.step.cautions }}</span>
        </div>
      </div>
    </div>

    <!-- 体征记录卡 -->
    <div v-else-if="cardType === 'body-metrics' && bodyData" class="body-card-body">
      <div class="body-grid">
        <div v-if="bodyData.heightCm != null" class="body-block">
          <span class="bd-num">{{ bodyData.heightCm }}</span>
          <span class="bd-label">cm</span>
        </div>
        <div v-if="bodyData.weightKg != null" class="body-block">
          <span class="bd-num">{{ bodyData.weightKg }}</span>
          <span class="bd-label">kg</span>
        </div>
        <div v-if="bodyData.bodyFatPercent != null" class="body-block">
          <span class="bd-num">{{ bodyData.bodyFatPercent }}</span>
          <span class="bd-label">%体脂</span>
        </div>
        <div v-if="bodyData.bmi != null" class="body-block">
          <span class="bd-num">{{ bodyData.bmi }}</span>
          <span class="bd-label">BMI</span>
        </div>
      </div>
    </div>

    <!-- raw / error -->
    <div v-else class="raw-body">
      <pre>{{ JSON.stringify(data, null, 2) }}</pre>
    </div>
  </div>

  <!-- 详情 BottomSheet：点击卡片查看完整工具结果 -->
  <BottomSheet
    :visible="showDetail"
    :title="actionLabel"
    @update:visible="showDetail = $event"
    @close="showDetail = false"
  >
    <div class="detail-wrap">
      <div v-if="result.summary" class="detail-summary">{{ result.summary }}</div>
      <div class="detail-label">完整数据</div>
      <pre class="detail-json">{{ detailJson }}</pre>
    </div>
  </BottomSheet>
</template>

<style scoped>
.tool-card {
  background: var(--card-bg);
  border-radius: var(--card-radius);
  box-shadow: var(--card-shadow);
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border-left: 3px solid var(--color-warm);
  max-height: 84px;
  overflow: hidden;
  cursor: pointer;
  transition: box-shadow 0.18s var(--ease-immersive), transform 0.18s var(--ease-immersive);
  animation: card-fade-in 0.35s var(--ease-immersive) both;
}
.tool-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}
.tool-card:focus-visible {
  outline: 2px solid var(--color-warm);
  outline-offset: 2px;
}
@keyframes card-fade-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
.tool-card.is-error {
  border-left-color: var(--color-danger);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.tool-badge {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
}
.tool-badge.ok { background: var(--color-success, #34c759); }
.tool-badge.err { background: var(--color-danger, #ff3b30); }
.tool-action {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-warm);
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  padding: 2px 8px;
  border-radius: var(--radius-full);
}
.tool-summary {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* 课程卡（复用 course-card-body 风格） */
.course-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}
.course-card-body.mini {
  padding: var(--space-2);
  background: var(--bg-50, rgba(0, 0, 0, 0.02));
  border-radius: var(--radius-md);
}
.course-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.course-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.course-meta .dot { color: var(--color-text-tertiary); }
.course-desc {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.course-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--space-1);
}
.course-diff {
  font-size: var(--text-xs);
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  background: var(--bg-200);
  color: var(--color-text-secondary);
}
.course-diff[data-diff="beginner"] { background: var(--success-50, #e8f8ee); color: var(--success-600, #1a7f37); }
.course-diff[data-diff="intermediate"] { background: var(--warning-50, #fff5e0); color: var(--warning-600, #b57800); }
.course-diff[data-diff="advanced"] { background: var(--danger-50, #ffe7e2); color: var(--danger-600, #c4180c); }
.course-pin {
  font-size: var(--text-xs);
  color: var(--color-warm);
  font-weight: var(--fw-medium);
}

/* 动作卡 */
.ex-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}
.ex-card-body.mini {
  padding: var(--space-2);
  background: var(--bg-50, rgba(0, 0, 0, 0.02));
  border-radius: var(--radius-md);
}
.ex-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.ex-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.ex-meta .dot { color: var(--color-text-tertiary); }
.ex-equip, .ex-desc {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

/* 列表包装 */
.list-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.list-more {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-1);
}

/* 统计卡 */
.stats-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.stat-block {
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
  color: var(--color-text-secondary);
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  height: 56px;
  padding: var(--space-2) 0 0;
  border-top: 1px solid var(--color-divider);
}
.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 100%;
  min-width: 0;
}
.bar {
  width: 100%;
  max-width: 16px;
  background: linear-gradient(180deg, var(--color-warm), var(--warm-300, #ffb340));
  border-radius: 4px 4px 2px 2px;
  min-height: 3px;
  transition: height var(--dur-fast) var(--ease-immersive);
}
.bar-label {
  font-size: 9px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
}

/* raw */
.raw-body {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  background: var(--bg-200);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  overflow-x: auto;
}
.raw-body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
}

/* ===== 待办卡 ===== */
.todo-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}
.todo-date {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}
.todo-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.todo-cb {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.6px solid var(--bg-400);
  display: flex;
  align-items: center;
  justify-content: center;
}
.todo-cb.is-done {
  background: var(--success-500);
  border-color: var(--success-500);
}
.todo-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.todo-title.is-done {
  color: var(--color-text-tertiary);
  text-decoration: line-through;
}
.todo-pri {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  font-weight: var(--fw-semibold);
  flex-shrink: 0;
}
.todo-pri[data-pri="high"] { background: rgba(232,64,38,0.12); color: var(--danger-500); }
.todo-pri[data-pri="normal"] { background: rgba(255,149,0,0.12); color: var(--color-warm); }
.todo-pri[data-pri="low"] { background: var(--bg-200); color: var(--color-text-tertiary); }

/* ===== 饮水卡 ===== */
.water-card-body {
  padding: var(--space-2) 0;
}
.water-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
}
.water-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.water-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.water-unit {
  font-size: var(--text-sm);
  font-weight: var(--fw-regular);
  color: var(--color-text-secondary);
  margin-left: 4px;
}
.water-goal {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

/* ===== 饮食记录卡 ===== */
.food-rec-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}
.food-totals {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.ft-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.ft-main { align-items: flex-start; }
.ft-num {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.ft-main .ft-num { font-size: var(--text-lg); }
.ft-label {
  font-size: 10px;
  color: var(--color-text-tertiary);
}
.food-rec-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.fri-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.fri-meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

/* ===== 食品库卡 ===== */
.food-db-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.fdb-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.fdb-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.fdb-meta {
  font-size: 10px;
  color: var(--color-text-tertiary);
}
.fdb-macros {
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

/* ===== 当前训练卡 ===== */
.workout-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}
.wk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.wk-plan {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.wk-progress {
  font-size: var(--text-xs);
  color: var(--color-warm);
  font-weight: var(--fw-semibold);
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  padding: 2px 8px;
  border-radius: var(--radius-full);
}
.wk-step {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.wk-step-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.wk-step-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.wk-step-meta .dot { color: var(--color-text-tertiary); }
.wk-sets {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.wk-guide {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  line-height: 1.5;
  margin-top: 2px;
}
.wk-caution {
  display: flex;
  gap: 4px;
  align-items: flex-start;
  font-size: var(--text-xs);
  color: var(--danger-600, #c4180c);
  background: var(--danger-50, #ffe7e2);
  padding: 4px 8px;
  border-radius: var(--radius-xs);
  margin-top: 4px;
}

/* ===== 体征记录卡 ===== */
.body-card-body {
  padding: var(--space-2) 0;
}
.body-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.body-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.bd-num {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.bd-label {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

/* ===== 紧凑模式（运动面板内联） ===== */
.tool-card.is-compact {
  padding: var(--space-2) var(--space-3);
  border-left-width: 2px;
}
.tool-card.is-compact .stats-grid,
.tool-card.is-compact .body-grid {
  grid-template-columns: repeat(2, 1fr);
}

/* ===== 详情 BottomSheet 内容 ===== */
.detail-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-2);
}
.detail-summary {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  line-height: 1.5;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.detail-label {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.detail-json {
  margin: 0;
  padding: var(--space-3);
  background: var(--bg-200);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  max-height: 60vh;
  overflow-y: auto;
}
</style>
