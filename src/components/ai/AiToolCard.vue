<script setup lang="ts">
/**
 * AiToolCard — 渲染 AI 工具调用结果为 HarmonyOS 风格卡片。
 * 卡片点击跳转相关页面；右上角 ⓘ 按钮打开结构化详情 BottomSheet。
 * max-height 84px，溢出隐藏；列表最多展示 3 条。
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { ToolResult } from "@/types/ai";
import BottomSheet from "@/components/ui/BottomSheet.vue";
import type { Course } from "@/types/course";
import type { Exercise } from "@/types/exercise";
import type { WorkoutStats, WorkoutRecord } from "@/types/workout-stats";
import type { NutritionTarget, DietGoal, ActivityLevel, FoodItem } from "@/types/health";
import { ACTIVITY_LEVEL_LABEL } from "@/types/health";
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

const router = useRouter();

const cardType = computed(() => props.result.card ?? "raw");
const data = computed(() => props.result.cardData);
const ok = computed(() => props.result.ok);

// ===== Per-card typed interfaces (cardData stays unknown in types/ai.ts) =====
interface WorkoutStepCard {
  title: string;
  phase: string;
  equipment?: string;
  muscleGroup?: string;
  weight?: string;
  cautions?: string;
  guide?: string;
  sets?: number;
  restBetweenSets?: number;
  timer?: number;
}
interface WorkoutCardData {
  planName: string;
  planLevel?: string;
  totalSteps: number;
  currentStepIndex: number;
  currentSetInStep: number;
  inSetRest?: boolean;
  inQuickRest?: boolean;
  stepSecondsRemaining?: number;
  totalElapsedSeconds: number;
  totalSets: number;
  completedSets: number;
  step: WorkoutStepCard;
}
interface BodyMetricsRecord {
  id?: string;
  heightCm?: number;
  weightKg?: number;
  bodyFatPercent?: number;
  bmi?: number;
  timestamp?: number;
}
interface BodyMetricsCardData {
  record?: BodyMetricsRecord;
  records?: BodyMetricsRecord[];
}
interface TodoSummary {
  id: string;
  title: string;
  note?: string;
  kind?: string;
  dueDate?: string;
  dueTime?: string;
  startTime?: string;
  endTime?: string;
  priority: string;
  priorityLabel: string;
  urgent?: boolean;
  done: boolean;
  subtasks?: { title: string; done: boolean }[];
}
interface TodoCardData {
  items: TodoSummary[];
  date: string;
}
interface WaterCardData {
  amount: number;
  total: number;
  goal?: number;
}
interface FoodRecord {
  id: string;
  foodName: string;
  grams: number;
  calories: number;
  carbs?: number;
  protein?: number;
  fat?: number;
}
interface FoodTotals {
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
}
interface FoodRecordCardData {
  record?: FoodRecord;
  records?: FoodRecord[];
  todayTotals: FoodTotals;
}
interface FoodDbCardData {
  items: FoodItem[];
}
interface WorkoutHistoryCardData {
  records?: WorkoutRecord[];
  record?: WorkoutRecord;
}
interface NutritionCardData {
  target: NutritionTarget;
  waterGoalMl: number;
  dietGoal: DietGoal;
  activityLevel: ActivityLevel;
}

// ===== Typed data computeds =====
const course = computed(() => (data.value as Course | undefined) ?? null);
const courseList = computed(() => (Array.isArray(data.value) ? (data.value as Course[]) : []));
const exercise = computed(() => (data.value as Exercise | undefined) ?? null);
const exerciseList = computed(() => (Array.isArray(data.value) ? (data.value as Exercise[]) : []));
const stats = computed(() => (data.value as WorkoutStats | undefined) ?? null);
const workoutData = computed(() => data.value as WorkoutCardData | undefined);
const bodyData = computed(() => data.value as BodyMetricsCardData | undefined);
const todoData = computed(() => data.value as TodoCardData | undefined);
const waterData = computed(() => data.value as WaterCardData | undefined);
const foodRecData = computed(() => data.value as FoodRecordCardData | undefined);
const foodDbData = computed(() => data.value as FoodDbCardData | undefined);
const workoutHistoryData = computed(() => data.value as WorkoutHistoryCardData | undefined);
const nutritionData = computed(() => data.value as NutritionCardData | undefined);

// Single body record (from {record} or {records[0]})
const bodyRecord = computed<BodyMetricsRecord | null>(() => {
  const d = bodyData.value;
  if (!d) return null;
  if (d.record) return d.record;
  if (Array.isArray(d.records) && d.records.length) return d.records[0];
  return null;
});
const bodyHistory = computed<BodyMetricsRecord[]>(() => bodyData.value?.records ?? []);

// ===== Tool label map =====
const toolLabel: Record<string, string> = {
  course_list: "查询课程",
  course_get: "课程详情",
  course_create: "创建课程",
  course_update: "更新课程",
  course_delete: "删除课程",
  exercise_list: "查询动作",
  exercise_create: "创建动作",
  exercise_update: "更新动作",
  exercise_delete: "删除动作",
  stats_get: "运动统计",
  todo_list: "查询待办",
  todo_create: "创建待办",
  todo_update: "更新待办",
  todo_delete: "删除待办",
  todo_toggle_done: "切换完成",
  water_add: "记录饮水",
  water_today: "今日饮水",
  food_record_add: "记录饮食",
  food_today: "今日饮食",
  food_db_list: "查询食品库",
  food_db_create: "新增食品",
  food_db_update: "更新食品",
  food_db_delete: "删除食品",
  body_metrics_record: "记录体征",
  workout_records_list: "运动记录列表",
  workout_record_detail: "运动记录详情",
  nutrition_target_get: "每日营养目标",
  body_metrics_history: "体征历史",
  workout_current_get: "当前训练",
  workout_step_skip: "跳过步骤",
  workout_step_adjust_temp: "临时调整",
  workout_course_adjust_permanent: "永久调整",
  app_config_get: "应用配置",
  app_config_update: "更新配置",
  web_search: "网页搜索",
  web_fetch: "抓取网页",
};
const actionLabel = computed(() => toolLabel[props.result.name] ?? props.result.name);

// ===== Water ring =====
const WATER_GOAL_FALLBACK = 2000;
const waterGoal = computed(() => waterData.value?.goal ?? WATER_GOAL_FALLBACK);
const waterPct = computed(() => {
  if (!waterData.value) return 0;
  return Math.min((waterData.value.total / waterGoal.value) * 100, 100);
});
const waterRingR = 18;
const waterRingC = 2 * Math.PI * waterRingR;

// ===== Food macros mini bars =====
const macroBars = computed(() => {
  const t = foodRecData.value?.todayTotals;
  if (!t) return [];
  // rough goals: carbs 250g / protein 60g / fat 70g
  const goalC = 250, goalP = 60, goalF = 70;
  return [
    { label: "碳水", val: t.carbs, goal: goalC, color: "var(--warm-500)" },
    { label: "蛋白", val: t.protein, goal: goalP, color: "var(--brand-500)" },
    { label: "脂肪", val: t.fat, goal: goalF, color: "var(--warning-500)" },
  ];
});

// ===== Nutrition macros grid =====
const DIET_GOAL_LABEL: Record<DietGoal, string> = {
  lose: "减脂",
  maintain: "维持",
  gain: "增肌",
};

// ===== Workout phase color =====
const phaseColor = (phase: string): string => {
  switch (phase) {
    case "warmup": return "var(--warm-500)";
    case "main": return "var(--brand-500)";
    case "stretch": return "var(--accent-500)";
    case "rest": return "var(--text-400)";
    default: return "var(--text-400)";
  }
};

// ===== Date format helpers =====
function formatDateShort(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ===== Navigation =====
const navTarget = computed<string | null>(() => {
  switch (cardType.value) {
    case "course":
      return course.value ? `/sports/courses/${course.value.id}` : "/sports/courses";
    case "course-list":
      return "/sports/courses";
    case "exercise":
      return exercise.value ? `/sports/exercises/${exercise.value.id}` : "/sports/exercises";
    case "exercise-list":
      return "/sports/exercises";
    case "stats":
      return "/sports";
    case "todo":
    case "todo-list":
      return "/todo";
    case "water":
      return "/health/water";
    case "food-record":
      return "/health/food";
    case "food-db":
      return "/health/food-db";
    case "workout":
      return "/workout";
    case "body-metrics":
      return "/health/bmi";
    case "workout-history":
      if (workoutHistoryData.value?.record) {
        return `/workout/history/${workoutHistoryData.value.record.id}`;
      }
      return "/workout/history";
    case "nutrition":
      return "/health/food";
    default:
      return null;
  }
});

function onCardClick() {
  const t = navTarget.value;
  if (t) router.push(t);
}

function go(e: Event, path: string) {
  e.stopPropagation();
  router.push(path);
}

// ===== Detail BottomSheet =====
const showDetail = ref(false);
function openDetail(e: Event) {
  e.stopPropagation();
  showDetail.value = true;
}

// ===== Raw fallback formatted key-value =====
function formatVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function rawEntries(d: unknown): Array<[string, string]> {
  if (d && typeof d === "object" && !Array.isArray(d)) {
    return Object.entries(d as Record<string, unknown>).map(([k, v]) => [k, formatVal(v)]);
  }
  return [["data", formatVal(d)]];
}
const rawCardEntries = computed(() => rawEntries(data.value).slice(0, 3));

// ===== Stats 7-day max for bar scaling =====
const stats7Max = computed(() => {
  if (!stats.value?.last7Days?.length) return 1;
  return Math.max(1, ...stats.value.last7Days.map((d) => d.sessions));
});
</script>

<template>
  <div
    class="tool-card"
    :class="{ 'is-error': !ok, 'is-compact': compact }"
    role="button"
    tabindex="0"
    @click="onCardClick"
    @keydown.enter="onCardClick"
  >
    <div class="tool-head">
      <div class="tool-badge" :class="ok ? 'ok' : 'err'">
        <i v-if="ok" class="bi bi-check-lg"></i>
        <i v-else class="bi bi-x-lg"></i>
      </div>
      <span class="tool-action">{{ actionLabel }}</span>
      <span class="tool-summary">{{ result.summary }}</span>
      <button
        class="info-btn"
        :aria-label="`${actionLabel} 详情`"
        @click="openDetail"
      >
        <i class="bi bi-info-circle"></i>
      </button>
    </div>

    <div class="tool-body">
      <!-- 课程卡 -->
      <div v-if="cardType === 'course' && course" class="course-card">
        <div class="course-name">{{ course.name }}</div>
        <div class="course-meta">
          <span class="diff-badge" :data-diff="course.difficulty">{{ DIFFICULTY_LABEL[course.difficulty] }}</span>
          <span class="dot">·</span>
          <span>{{ CATEGORY_LABEL[course.category] }}</span>
          <span class="dot">·</span>
          <span>{{ course.estimatedMinutes }}min</span>
          <span class="dot">·</span>
          <span>{{ course.estimatedCalories }}kcal</span>
          <span class="dot">·</span>
          <span>{{ course.steps.length }}步</span>
        </div>
      </div>

      <!-- 课程列表 -->
      <div v-else-if="cardType === 'course-list' && courseList.length" class="list-card">
        <div
          v-for="c in courseList.slice(0, 3)"
          :key="c.id"
          class="list-row"
          @click="go($event, `/sports/courses/${c.id}`)"
        >
          <span class="row-name">{{ c.name }}</span>
          <span class="row-tag" :data-diff="c.difficulty">{{ DIFFICULTY_LABEL[c.difficulty] }}</span>
          <span class="row-meta">{{ CATEGORY_LABEL[c.category] }}</span>
        </div>
        <div v-if="courseList.length > 3" class="list-more">共 {{ courseList.length }} 个 · 查看全部</div>
      </div>

      <!-- 动作卡 -->
      <div v-else-if="cardType === 'exercise' && exercise" class="exercise-card">
        <div class="ex-name">{{ exercise.name }}</div>
        <div class="ex-meta">
          <span>{{ MUSCLE_GROUP_LABEL[exercise.muscleGroup] }}</span>
          <span class="dot">·</span>
          <span>{{ EXERCISE_DIFFICULTY_LABEL[exercise.difficulty] }}</span>
          <span v-if="exercise.equipment" class="dot">·</span>
          <span v-if="exercise.equipment">{{ exercise.equipment }}</span>
        </div>
        <div v-if="exercise.executionDetails" class="ex-detail">{{ exercise.executionDetails }}</div>
      </div>

      <!-- 动作列表 -->
      <div v-else-if="cardType === 'exercise-list' && exerciseList.length" class="list-card">
        <div
          v-for="e in exerciseList.slice(0, 3)"
          :key="e.id"
          class="list-row"
          @click="go($event, `/sports/exercises/${e.id}`)"
        >
          <span class="row-name">{{ e.name }}</span>
          <span class="row-meta">{{ MUSCLE_GROUP_LABEL[e.muscleGroup] }}</span>
        </div>
        <div v-if="exerciseList.length > 3" class="list-more">共 {{ exerciseList.length }} 个 · 查看全部</div>
      </div>

      <!-- 统计卡 -->
      <div v-else-if="cardType === 'stats' && stats" class="stats-card">
        <div class="stats-grid">
          <div class="stat-block">
            <div class="stat-num">{{ stats.totalSessions }}</div>
            <div class="stat-label">次</div>
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
            <div class="stat-label">连续</div>
          </div>
        </div>
      </div>

      <!-- 待办卡 -->
      <div v-else-if="(cardType === 'todo' || cardType === 'todo-list') && todoData" class="todo-card">
        <div v-if="!todoData.items.length" class="empty">暂无待办</div>
        <template v-else>
          <div
            v-for="t in todoData.items.slice(0, 3)"
            :key="t.id"
            class="todo-item"
            @click="go($event, '/todo')"
          >
            <span class="todo-cb" :class="{ 'is-done': t.done }">
              <i v-if="t.done" class="bi bi-check-lg"></i>
            </span>
            <span class="todo-title" :class="{ 'is-done': t.done }">{{ t.title }}</span>
            <span class="todo-pri" :data-pri="t.priority">{{ t.priorityLabel }}</span>
          </div>
          <div v-if="todoData.items.length > 3" class="list-more">共 {{ todoData.items.length }} 条</div>
        </template>
      </div>

      <!-- 饮水卡 -->
      <div v-else-if="cardType === 'water' && waterData" class="water-card">
        <svg class="water-ring" width="44" height="44" viewBox="0 0 44 44">
          <circle cx="22" cy="22" :r="waterRingR" fill="none" stroke="var(--bg-200)" stroke-width="4" />
          <circle
            cx="22" cy="22" :r="waterRingR" fill="none"
            stroke="var(--ring-inner)" stroke-width="4"
            stroke-linecap="round"
            :stroke-dasharray="waterRingC"
            :stroke-dashoffset="waterRingC - (waterPct / 100) * waterRingC"
            :style="{ transform: 'rotate(-90deg)', transformOrigin: '22px 22px' }"
          />
        </svg>
        <div class="water-meta">
          <div class="water-num">{{ waterData.total }}<span class="water-unit">ml</span></div>
          <div class="water-goal">目标 {{ waterGoal }}ml · {{ Math.round(waterPct) }}%</div>
        </div>
      </div>

      <!-- 饮食记录卡 -->
      <div v-else-if="cardType === 'food-record' && foodRecData" class="food-rec-card">
        <div class="fr-top">
          <div class="fr-cal">
            <span class="fr-cal-num">{{ foodRecData.todayTotals.calories }}</span>
            <span class="fr-cal-unit">千卡</span>
          </div>
          <div class="fr-macros">
            <div v-for="m in macroBars" :key="m.label" class="macro-mini">
              <div class="macro-track">
                <div class="macro-fill" :style="{ width: `${Math.min(100, (m.val / m.goal) * 100)}%`, background: m.color }" />
              </div>
              <span class="macro-label">{{ m.label }} {{ m.val }}g</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 食品库卡 -->
      <div v-else-if="cardType === 'food-db' && foodDbData" class="list-card">
        <div
          v-for="f in foodDbData.items.slice(0, 3)"
          :key="f.id"
          class="list-row"
          @click="go($event, '/health/food-db')"
        >
          <span class="row-name">{{ f.name }}</span>
          <span class="health-dot" :data-score="f.healthScore" />
          <span class="row-meta">{{ f.caloriesPer100g }}kcal/100g</span>
        </div>
        <div v-if="foodDbData.items.length > 3" class="list-more">共 {{ foodDbData.items.length }} 个 · 查看全部</div>
      </div>

      <!-- 当前训练卡 -->
      <div v-else-if="cardType === 'workout' && workoutData" class="workout-card">
        <div class="wk-head">
          <span class="wk-plan">{{ workoutData.planName }}</span>
          <span class="wk-phase" :style="{ background: phaseColor(workoutData.step.phase) }">
            {{ workoutData.currentStepIndex + 1 }}/{{ workoutData.totalSteps }}
          </span>
        </div>
        <div class="wk-step">
          <span class="wk-step-title">{{ workoutData.step.title }}</span>
          <span class="wk-sets">
            组 {{ workoutData.currentSetInStep + 1 }}/{{ workoutData.step.sets ?? 1 }}
            · {{ Math.floor(workoutData.totalElapsedSeconds / 60) }}min
            <span v-if="workoutData.stepSecondsRemaining != null"> · {{ formatTime(workoutData.stepSecondsRemaining) }}</span>
          </span>
        </div>
      </div>

      <!-- 体征记录卡 -->
      <div v-else-if="cardType === 'body-metrics' && bodyRecord" class="body-card">
        <div class="body-grid">
          <div v-if="bodyRecord.heightCm != null" class="body-block">
            <span class="bd-num">{{ bodyRecord.heightCm }}</span>
            <span class="bd-label">cm</span>
          </div>
          <div v-if="bodyRecord.weightKg != null" class="body-block">
            <span class="bd-num">{{ bodyRecord.weightKg }}</span>
            <span class="bd-label">kg</span>
          </div>
          <div v-if="bodyRecord.bodyFatPercent != null" class="body-block">
            <span class="bd-num">{{ bodyRecord.bodyFatPercent }}</span>
            <span class="bd-label">%体脂</span>
          </div>
          <div v-if="bodyRecord.bmi != null" class="body-block">
            <span class="bd-num">{{ bodyRecord.bmi.toFixed(1) }}</span>
            <span class="bd-label">BMI</span>
          </div>
        </div>
      </div>

      <!-- 运动历史卡 -->
      <div v-else-if="cardType === 'workout-history' && workoutHistoryData" class="list-card">
        <div
          v-if="workoutHistoryData.record"
          class="list-row"
          @click="go($event, `/workout/history/${workoutHistoryData.record.id}`)"
        >
          <span class="row-name">{{ workoutHistoryData.record.courseName }}</span>
          <span class="row-meta">{{ formatDateShort(workoutHistoryData.record.startedAt) }} · {{ Math.round(workoutHistoryData.record.durationSec / 60) }}min · {{ workoutHistoryData.record.caloriesBurned }}kcal</span>
        </div>
        <template v-else-if="workoutHistoryData.records && workoutHistoryData.records.length">
          <div
            v-for="r in workoutHistoryData.records.slice(0, 3)"
            :key="r.id"
            class="list-row"
            @click="go($event, `/workout/history/${r.id}`)"
          >
            <span class="row-name">{{ r.courseName }}</span>
            <span class="row-meta">{{ formatDateShort(r.startedAt) }} · {{ Math.round(r.durationSec / 60) }}min · {{ r.caloriesBurned }}kcal</span>
          </div>
          <div v-if="workoutHistoryData.records.length > 3" class="list-more">共 {{ workoutHistoryData.records.length }} 条 · 查看全部</div>
        </template>
      </div>

      <!-- 营养目标卡 -->
      <div v-else-if="cardType === 'nutrition' && nutritionData" class="nutrition-card">
        <div class="nt-main">
          <span class="nt-cal">{{ nutritionData.target.calories }}</span>
          <span class="nt-cal-unit">千卡/日</span>
          <span class="nt-goal-tag">{{ DIET_GOAL_LABEL[nutritionData.dietGoal] }}</span>
        </div>
        <div class="nt-macros">
          <span>碳 {{ nutritionData.target.carbs }}g</span>
          <span class="dot">·</span>
          <span>蛋 {{ nutritionData.target.protein }}g</span>
          <span class="dot">·</span>
          <span>脂 {{ nutritionData.target.fat }}g</span>
          <span class="dot">·</span>
          <span>水 {{ nutritionData.waterGoalMl }}ml</span>
        </div>
      </div>

      <!-- raw fallback：结构化键值 -->
      <div v-else class="raw-card">
        <div v-for="([k, v]) in rawCardEntries" :key="k" class="kv-row">
          <span class="kv-key">{{ k }}</span>
          <span class="kv-val">{{ v }}</span>
        </div>
        <div v-if="!rawCardEntries.length" class="empty">无数据</div>
      </div>
    </div>

    <!-- 详情 BottomSheet：结构化展示完整数据 -->
    <BottomSheet
      :visible="showDetail"
      :title="actionLabel"
      :default-detent="'large'"
      @update:visible="showDetail = $event"
      @close="showDetail = false"
    >
      <div class="detail-wrap">
        <div v-if="result.summary" class="detail-summary">{{ result.summary }}</div>

        <!-- 课程详情 -->
        <template v-if="cardType === 'course' && course">
          <div class="d-section">
            <div class="d-title">{{ course.name }}</div>
            <div class="d-tags">
              <span class="diff-badge" :data-diff="course.difficulty">{{ DIFFICULTY_LABEL[course.difficulty] }}</span>
              <span class="d-tag">{{ CATEGORY_LABEL[course.category] }}</span>
              <span class="d-tag">{{ course.estimatedMinutes }} 分钟</span>
              <span class="d-tag">{{ course.estimatedCalories }} 千卡</span>
              <span v-if="course.pinned" class="d-tag warm">★ 已置顶</span>
            </div>
          </div>
          <div v-if="course.description" class="d-section">
            <div class="d-label">描述</div>
            <div class="d-text">{{ course.description }}</div>
          </div>
          <div class="d-section">
            <div class="d-label">训练步骤（{{ course.steps.length }}）</div>
            <div v-for="(s, i) in course.steps" :key="s.id" class="d-step">
              <div class="d-step-head">
                <span class="d-step-idx">{{ i + 1 }}</span>
                <span class="d-step-name">{{ s.exerciseName }}</span>
                <span class="d-step-phase" :style="{ background: phaseColor(s.phase) }">{{ s.phase }}</span>
              </div>
              <div class="d-step-meta">
                <span>{{ s.sets }} 组</span>
                <span v-if="s.reps" class="dot">·</span>
                <span v-if="s.reps">{{ s.reps }} 次</span>
                <span v-if="s.durationSec" class="dot">·</span>
                <span v-if="s.durationSec">{{ s.durationSec }}s</span>
                <span class="dot">·</span>
                <span>休息 {{ s.restSec }}s</span>
                <span v-if="s.weight" class="dot">·</span>
                <span v-if="s.weight">{{ s.weight }}</span>
              </div>
              <div v-if="s.note" class="d-text-sm">{{ s.note }}</div>
              <div v-if="s.cautions" class="d-caution">
                <i class="bi bi-exclamation-triangle"></i>
                <span>{{ s.cautions }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 课程列表详情 -->
        <template v-else-if="cardType === 'course-list' && courseList.length">
          <div class="d-section">
            <div class="d-label">共 {{ courseList.length }} 个课程</div>
            <div v-for="c in courseList" :key="c.id" class="d-row">
              <div class="d-row-main">
                <span class="d-row-name">{{ c.name }}</span>
                <span class="diff-badge" :data-diff="c.difficulty">{{ DIFFICULTY_LABEL[c.difficulty] }}</span>
              </div>
              <div class="d-row-meta">{{ CATEGORY_LABEL[c.category] }} · {{ c.estimatedMinutes }}min · {{ c.estimatedCalories }}kcal · {{ c.steps.length }}步</div>
              <div v-if="c.description" class="d-text-sm">{{ c.description }}</div>
            </div>
          </div>
        </template>

        <!-- 动作详情 -->
        <template v-else-if="cardType === 'exercise' && exercise">
          <div class="d-section">
            <div class="d-title">{{ exercise.name }}</div>
            <div class="d-tags">
              <span class="diff-badge" :data-diff="exercise.difficulty">{{ EXERCISE_DIFFICULTY_LABEL[exercise.difficulty] }}</span>
              <span class="d-tag">{{ EXERCISE_CATEGORY_LABEL[exercise.category] }}</span>
              <span class="d-tag">{{ MUSCLE_GROUP_LABEL[exercise.muscleGroup] }}</span>
              <span v-if="exercise.equipment" class="d-tag">器械：{{ exercise.equipment }}</span>
              <span v-if="exercise.custom" class="d-tag warm">自定义</span>
            </div>
          </div>
          <div v-if="exercise.description" class="d-section">
            <div class="d-label">简介</div>
            <div class="d-text">{{ exercise.description }}</div>
          </div>
          <div v-if="exercise.executionDetails" class="d-section">
            <div class="d-label">执行细节</div>
            <div class="d-text">{{ exercise.executionDetails }}</div>
          </div>
          <div v-if="exercise.cautions" class="d-section">
            <div class="d-label">注意事项</div>
            <div class="d-caution">
              <i class="bi bi-exclamation-triangle"></i>
              <span>{{ exercise.cautions }}</span>
            </div>
          </div>
        </template>

        <!-- 动作列表详情 -->
        <template v-else-if="cardType === 'exercise-list' && exerciseList.length">
          <div class="d-section">
            <div class="d-label">共 {{ exerciseList.length }} 个动作</div>
            <div v-for="e in exerciseList" :key="e.id" class="d-row">
              <div class="d-row-main">
                <span class="d-row-name">{{ e.name }}</span>
                <span class="diff-badge" :data-diff="e.difficulty">{{ EXERCISE_DIFFICULTY_LABEL[e.difficulty] }}</span>
              </div>
              <div class="d-row-meta">{{ MUSCLE_GROUP_LABEL[e.muscleGroup] }}<span v-if="e.equipment"> · {{ e.equipment }}</span></div>
              <div v-if="e.executionDetails" class="d-text-sm">{{ e.executionDetails }}</div>
            </div>
          </div>
        </template>

        <!-- 统计详情 -->
        <template v-else-if="cardType === 'stats' && stats">
          <div class="d-section">
            <div class="d-stats-grid">
              <div class="d-stat">
                <div class="d-stat-num">{{ stats.totalSessions }}</div>
                <div class="d-stat-label">总训练次数</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ Math.round(stats.totalDurationSec / 60) }}</div>
                <div class="d-stat-label">总分钟</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ Math.round(stats.totalCalories) }}</div>
                <div class="d-stat-label">总千卡</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ stats.streakDays }}</div>
                <div class="d-stat-label">连续天数</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ stats.totalCompletedSets }}</div>
                <div class="d-stat-label">完成组数</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ stats.totalSets }}</div>
                <div class="d-stat-label">总组数</div>
              </div>
            </div>
          </div>
          <div v-if="stats.last7Days.length" class="d-section">
            <div class="d-label">近 7 天训练次数</div>
            <div class="d-bars">
              <div v-for="d in stats.last7Days" :key="d.date" class="d-bar-col">
                <div class="d-bar" :style="{ height: `${(d.sessions / stats7Max) * 100}%` }" />
                <span class="d-bar-label">{{ d.date.slice(5) }}</span>
              </div>
            </div>
          </div>
          <div v-if="Object.keys(stats.perCategoryCount).length" class="d-section">
            <div class="d-label">按部位分布</div>
            <div class="d-kv-list">
              <div v-for="(v, k) in stats.perCategoryCount" :key="k" class="kv-row">
                <span class="kv-key">{{ (CATEGORY_LABEL as Record<string, string>)[k] ?? k }}</span>
                <span class="kv-val">{{ v }} 次</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 待办详情 -->
        <template v-else-if="(cardType === 'todo' || cardType === 'todo-list') && todoData">
          <div class="d-section">
            <div class="d-label">{{ todoData.date === "all" ? "全部待办" : todoData.date }} · 共 {{ todoData.items.length }} 条</div>
            <div v-if="!todoData.items.length" class="empty">暂无待办</div>
            <div v-for="t in todoData.items" :key="t.id" class="d-todo">
              <span class="todo-cb" :class="{ 'is-done': t.done }">
                <i v-if="t.done" class="bi bi-check-lg"></i>
              </span>
              <div class="d-todo-main">
                <div class="d-todo-head">
                  <span class="d-todo-title" :class="{ 'is-done': t.done }">{{ t.title }}</span>
                  <span class="todo-pri" :data-pri="t.priority">{{ t.priorityLabel }}</span>
                  <span v-if="t.urgent" class="d-tag warm">紧急</span>
                </div>
                <div class="d-todo-meta">
                  <span v-if="t.dueDate">{{ t.dueDate }}</span>
                  <span v-if="t.dueTime" class="dot">·</span>
                  <span v-if="t.dueTime">{{ t.dueTime }}</span>
                  <span v-if="t.startTime" class="dot">·</span>
                  <span v-if="t.startTime">{{ t.startTime }}-{{ t.endTime }}</span>
                  <span v-if="t.kind" class="dot">·</span>
                  <span v-if="t.kind">{{ t.kind }}</span>
                </div>
                <div v-if="t.note" class="d-text-sm">{{ t.note }}</div>
                <div v-if="t.subtasks && t.subtasks.length" class="d-subtasks">
                  <div v-for="(st, i) in t.subtasks" :key="i" class="d-subtask">
                    <span class="todo-cb sm" :class="{ 'is-done': st.done }">
                      <i v-if="st.done" class="bi bi-check-lg"></i>
                    </span>
                    <span :class="{ 'is-done': st.done }">{{ st.title }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- 饮水详情 -->
        <template v-else-if="cardType === 'water' && waterData">
          <div class="d-section">
            <div class="d-water">
              <svg class="water-ring lg" width="120" height="120" viewBox="0 0 44 44">
                <circle cx="22" cy="22" :r="waterRingR" fill="none" stroke="var(--bg-200)" stroke-width="4" />
                <circle
                  cx="22" cy="22" :r="waterRingR" fill="none"
                  stroke="var(--ring-inner)" stroke-width="4"
                  stroke-linecap="round"
                  :stroke-dasharray="waterRingC"
                  :stroke-dashoffset="waterRingC - (waterPct / 100) * waterRingC"
                  :style="{ transform: 'rotate(-90deg)', transformOrigin: '22px 22px' }"
                />
              </svg>
              <div class="d-water-meta">
                <div class="d-water-num">{{ waterData.total }}<span class="water-unit">ml</span></div>
                <div class="d-water-goal">目标 {{ waterGoal }}ml</div>
                <div class="d-water-pct">已完成 {{ Math.round(waterPct) }}%</div>
                <div v-if="waterData.amount > 0" class="d-water-add">本次 +{{ waterData.amount }}ml</div>
              </div>
            </div>
          </div>
        </template>

        <!-- 饮食记录详情 -->
        <template v-else-if="cardType === 'food-record' && foodRecData">
          <div class="d-section">
            <div class="d-label">今日汇总</div>
            <div class="d-stats-grid">
              <div class="d-stat">
                <div class="d-stat-num">{{ foodRecData.todayTotals.calories }}</div>
                <div class="d-stat-label">千卡</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ foodRecData.todayTotals.carbs }}g</div>
                <div class="d-stat-label">碳水</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ foodRecData.todayTotals.protein }}g</div>
                <div class="d-stat-label">蛋白</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ foodRecData.todayTotals.fat }}g</div>
                <div class="d-stat-label">脂肪</div>
              </div>
            </div>
          </div>
          <div class="d-section">
            <div class="d-label">饮食记录</div>
            <div v-if="foodRecData.record" class="d-row">
              <div class="d-row-main">
                <span class="d-row-name">{{ foodRecData.record.foodName }}</span>
                <span class="d-tag">{{ foodRecData.record.calories }} 千卡</span>
              </div>
              <div class="d-row-meta">
                {{ foodRecData.record.grams }}g
                <span v-if="foodRecData.record.carbs" class="dot">·</span>
                <span v-if="foodRecData.record.carbs">碳 {{ foodRecData.record.carbs }}g</span>
                <span v-if="foodRecData.record.protein" class="dot">·</span>
                <span v-if="foodRecData.record.protein">蛋 {{ foodRecData.record.protein }}g</span>
                <span v-if="foodRecData.record.fat" class="dot">·</span>
                <span v-if="foodRecData.record.fat">脂 {{ foodRecData.record.fat }}g</span>
              </div>
            </div>
            <div v-else-if="foodRecData.records && foodRecData.records.length">
              <div v-for="r in foodRecData.records" :key="r.id" class="d-row">
                <div class="d-row-main">
                  <span class="d-row-name">{{ r.foodName }}</span>
                  <span class="d-tag">{{ r.calories }} 千卡</span>
                </div>
                <div class="d-row-meta">{{ r.grams }}g · 碳{{ r.carbs ?? 0 }} / 蛋{{ r.protein ?? 0 }} / 脂{{ r.fat ?? 0 }}</div>
              </div>
            </div>
            <div v-else class="empty">暂无记录</div>
          </div>
        </template>

        <!-- 食品库详情 -->
        <template v-else-if="cardType === 'food-db' && foodDbData">
          <div class="d-section">
            <div class="d-label">共 {{ foodDbData.items.length }} 个食品</div>
            <div v-for="f in foodDbData.items" :key="f.id" class="d-row">
              <div class="d-row-main">
                <span class="d-row-name">{{ f.name }}</span>
                <span class="health-dot lg" :data-score="f.healthScore" />
                <span class="d-tag">{{ f.caloriesPer100g }} 千卡/100g</span>
              </div>
              <div class="d-row-meta">
                {{ f.category }}
                · 碳 {{ f.carbsPer100g }}g
                · 蛋 {{ f.proteinPer100g }}g
                · 脂 {{ f.fatPer100g }}g
              </div>
              <div v-if="f.description" class="d-text-sm">{{ f.description }}</div>
            </div>
          </div>
        </template>

        <!-- 当前训练详情 -->
        <template v-else-if="cardType === 'workout' && workoutData">
          <div class="d-section">
            <div class="d-title">{{ workoutData.planName }}</div>
            <div class="d-tags">
              <span class="d-tag">步骤 {{ workoutData.currentStepIndex + 1 }}/{{ workoutData.totalSteps }}</span>
              <span class="d-tag">已完成 {{ workoutData.completedSets }}/{{ workoutData.totalSets }} 组</span>
              <span class="d-tag">已用 {{ Math.floor(workoutData.totalElapsedSeconds / 60) }}min</span>
              <span v-if="workoutData.stepSecondsRemaining != null" class="d-tag warm">剩 {{ formatTime(workoutData.stepSecondsRemaining) }}</span>
            </div>
          </div>
          <div class="d-section">
            <div class="d-label">当前步骤</div>
            <div class="d-step">
              <div class="d-step-head">
                <span class="d-step-name">{{ workoutData.step.title }}</span>
                <span class="d-step-phase" :style="{ background: phaseColor(workoutData.step.phase) }">{{ workoutData.step.phase }}</span>
              </div>
              <div class="d-step-meta">
                <span>组 {{ workoutData.currentSetInStep + 1 }}/{{ workoutData.step.sets ?? 1 }}</span>
                <span v-if="workoutData.step.muscleGroup" class="dot">·</span>
                <span v-if="workoutData.step.muscleGroup">{{ (MUSCLE_GROUP_LABEL as Record<string, string>)[workoutData.step.muscleGroup] ?? workoutData.step.muscleGroup }}</span>
                <span v-if="workoutData.step.equipment" class="dot">·</span>
                <span v-if="workoutData.step.equipment">{{ workoutData.step.equipment }}</span>
                <span v-if="workoutData.step.weight" class="dot">·</span>
                <span v-if="workoutData.step.weight">{{ workoutData.step.weight }}</span>
              </div>
              <div v-if="workoutData.step.guide" class="d-text">{{ workoutData.step.guide }}</div>
              <div v-if="workoutData.step.cautions" class="d-caution">
                <i class="bi bi-exclamation-triangle"></i>
                <span>{{ workoutData.step.cautions }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 体征详情 -->
        <template v-else-if="cardType === 'body-metrics' && bodyRecord">
          <div class="d-section">
            <div class="d-label">当前记录</div>
            <div class="d-stats-grid">
              <div v-if="bodyRecord.heightCm != null" class="d-stat">
                <div class="d-stat-num">{{ bodyRecord.heightCm }}</div>
                <div class="d-stat-label">cm</div>
              </div>
              <div v-if="bodyRecord.weightKg != null" class="d-stat">
                <div class="d-stat-num">{{ bodyRecord.weightKg }}</div>
                <div class="d-stat-label">kg</div>
              </div>
              <div v-if="bodyRecord.bodyFatPercent != null" class="d-stat">
                <div class="d-stat-num">{{ bodyRecord.bodyFatPercent }}</div>
                <div class="d-stat-label">%体脂</div>
              </div>
              <div v-if="bodyRecord.bmi != null" class="d-stat">
                <div class="d-stat-num">{{ bodyRecord.bmi.toFixed(1) }}</div>
                <div class="d-stat-label">BMI</div>
              </div>
            </div>
            <div v-if="bodyRecord.timestamp" class="d-text-sm">记录时间：{{ new Date(bodyRecord.timestamp).toLocaleString() }}</div>
          </div>
          <div v-if="bodyHistory.length > 1" class="d-section">
            <div class="d-label">历史记录（{{ bodyHistory.length }}）</div>
            <div v-for="(h, i) in bodyHistory" :key="i" class="d-row">
              <div class="d-row-main">
                <span class="d-row-name">{{ h.timestamp ? formatDateShort(h.timestamp) : "—" }}</span>
                <span v-if="h.bmi != null" class="d-tag">BMI {{ h.bmi.toFixed(1) }}</span>
              </div>
              <div class="d-row-meta">
                <span v-if="h.weightKg != null">{{ h.weightKg }}kg</span>
                <span v-if="h.bodyFatPercent != null" class="dot">·</span>
                <span v-if="h.bodyFatPercent != null">{{ h.bodyFatPercent }}%体脂</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 运动历史详情 -->
        <template v-else-if="cardType === 'workout-history' && workoutHistoryData">
          <template v-if="workoutHistoryData.record">
            <div class="d-section">
              <div class="d-title">{{ workoutHistoryData.record.courseName }}</div>
              <div class="d-tags">
                <span class="d-tag">{{ workoutHistoryData.record.courseCategory }}</span>
                <span class="d-tag">{{ formatDateShort(workoutHistoryData.record.startedAt) }}</span>
                <span class="d-tag">{{ Math.round(workoutHistoryData.record.durationSec / 60) }} 分钟</span>
                <span class="d-tag">{{ workoutHistoryData.record.caloriesBurned }} 千卡</span>
                <span class="d-tag" :class="{ warm: !workoutHistoryData.record.finished }">
                  {{ workoutHistoryData.record.finished ? "已完成" : "未完成" }}
                </span>
              </div>
            </div>
            <div class="d-section">
              <div class="d-label">汇总</div>
              <div class="d-kv-list">
                <div class="kv-row">
                  <span class="kv-key">开始</span>
                  <span class="kv-val">{{ new Date(workoutHistoryData.record.startedAt).toLocaleString() }}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">结束</span>
                  <span class="kv-val">{{ new Date(workoutHistoryData.record.endedAt).toLocaleString() }}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">组数</span>
                  <span class="kv-val">{{ workoutHistoryData.record.completedSets }} / {{ workoutHistoryData.record.totalSets }}</span>
                </div>
                <div v-if="workoutHistoryData.record.avgHeartRate" class="kv-row">
                  <span class="kv-key">平均心率</span>
                  <span class="kv-val">{{ workoutHistoryData.record.avgHeartRate }} bpm</span>
                </div>
              </div>
            </div>
            <div v-if="workoutHistoryData.record.steps && workoutHistoryData.record.steps.length" class="d-section">
              <div class="d-label">执行步骤（{{ workoutHistoryData.record.steps.length }}）</div>
              <div v-for="(s, i) in workoutHistoryData.record.steps" :key="i" class="d-step">
                <div class="d-step-head">
                  <span class="d-step-idx">{{ i + 1 }}</span>
                  <span class="d-step-name">{{ s.exerciseName }}</span>
                </div>
                <div class="d-step-meta">
                  <span>{{ s.completedSets }}/{{ s.sets }} 组</span>
                  <span v-if="s.reps" class="dot">·</span>
                  <span v-if="s.reps">{{ s.reps }} 次</span>
                  <span v-if="s.weight" class="dot">·</span>
                  <span v-if="s.weight">{{ s.weight }}</span>
                </div>
              </div>
            </div>
          </template>
          <template v-else-if="workoutHistoryData.records && workoutHistoryData.records.length">
            <div class="d-section">
              <div class="d-label">共 {{ workoutHistoryData.records.length }} 条记录</div>
              <div v-for="r in workoutHistoryData.records" :key="r.id" class="d-row">
                <div class="d-row-main">
                  <span class="d-row-name">{{ r.courseName }}</span>
                  <span class="d-tag" :class="{ warm: !r.finished }">{{ r.finished ? "完成" : "未完" }}</span>
                </div>
                <div class="d-row-meta">
                  {{ formatDateShort(r.startedAt) }} · {{ Math.round(r.durationSec / 60) }}min · {{ r.caloriesBurned }}kcal
                  · {{ r.completedSets }}/{{ r.totalSets }} 组
                </div>
              </div>
            </div>
          </template>
        </template>

        <!-- 营养目标详情 -->
        <template v-else-if="cardType === 'nutrition' && nutritionData">
          <div class="d-section">
            <div class="d-label">每日营养目标</div>
            <div class="d-stats-grid">
              <div class="d-stat">
                <div class="d-stat-num">{{ nutritionData.target.calories }}</div>
                <div class="d-stat-label">千卡/日</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ nutritionData.target.carbs }}g</div>
                <div class="d-stat-label">碳水</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ nutritionData.target.protein }}g</div>
                <div class="d-stat-label">蛋白</div>
              </div>
              <div class="d-stat">
                <div class="d-stat-num">{{ nutritionData.target.fat }}g</div>
                <div class="d-stat-label">脂肪</div>
              </div>
            </div>
          </div>
          <div class="d-section">
            <div class="d-kv-list">
              <div class="kv-row">
                <span class="kv-key">饮水目标</span>
                <span class="kv-val">{{ nutritionData.waterGoalMl }} ml</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">饮食目标</span>
                <span class="kv-val">{{ DIET_GOAL_LABEL[nutritionData.dietGoal] }}</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">活动水平</span>
                <span class="kv-val">{{ ACTIVITY_LEVEL_LABEL[nutritionData.activityLevel] }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- raw fallback：结构化键值 -->
        <template v-else>
          <div class="d-section">
            <div class="d-label">完整数据</div>
            <div class="d-kv-list">
              <div v-for="([k, v]) in rawEntries(data)" :key="k" class="kv-row">
                <span class="kv-key">{{ k }}</span>
                <span class="kv-val">{{ v }}</span>
              </div>
              <div v-if="!rawEntries(data).length" class="empty">无数据</div>
            </div>
          </div>
        </template>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.tool-card {
  background: var(--card-bg);
  border-radius: var(--radius-lg);
  box-shadow: var(--card-shadow);
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  border-left: 3px solid var(--color-warm);
  max-height: 84px;
  overflow: hidden;
  cursor: pointer;
  transition: box-shadow var(--dur-fast) var(--ease-immersive), transform var(--dur-fast) var(--ease-immersive);
  animation: card-fade-in var(--dur-fast) var(--ease-immersive) both;
}
.tool-card:hover {
  box-shadow: var(--shadow-card-hover);
  transform: translateY(-1px);
}
.tool-card:focus-visible {
  outline: 2px solid var(--color-warm);
  outline-offset: 2px;
}
@keyframes card-fade-in {
  from { opacity: 0; transform: translateY(4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.tool-card.is-error {
  border-left-color: var(--color-danger);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: nowrap;
  min-height: 18px;
}
.tool-badge {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  flex-shrink: 0;
  font-size: 10px;
}
.tool-badge.ok { background: var(--color-success); }
.tool-badge.err { background: var(--color-danger); }
.tool-action {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-warm);
  background: var(--color-warm-soft);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
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
.info-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  font-size: 12px;
  transition: background var(--dur-fast);
}
.info-btn:hover { background: var(--bg-300); color: var(--color-text); }
.info-btn:active { transform: scale(0.92); }

.tool-body {
  min-height: 0;
  overflow: hidden;
  flex: 1;
}

/* ===== 通用：单行省略 ===== */
.dot { color: var(--color-text-tertiary); padding: 0 2px; }
.empty { font-size: var(--text-xs); color: var(--color-text-tertiary); padding: var(--space-1); }

/* ===== 难度徽章 ===== */
.diff-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  font-weight: var(--fw-semibold);
  background: var(--bg-200);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.diff-badge[data-diff="beginner"] { background: var(--success-50); color: var(--success-600); }
.diff-badge[data-diff="intermediate"] { background: var(--warning-50); color: var(--warning-600); }
.diff-badge[data-diff="advanced"] { background: var(--danger-50); color: var(--danger-600); }

/* ===== 课程卡 ===== */
.course-card { display: flex; flex-direction: column; gap: 2px; }
.course-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.course-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  overflow: hidden;
  white-space: nowrap;
}

/* ===== 列表卡（通用） ===== */
.list-card { display: flex; flex-direction: column; gap: 2px; }
.list-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-xs);
  cursor: pointer;
  min-height: 20px;
  transition: background var(--dur-fast);
}
.list-row:hover { background: var(--bg-200); }
.row-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.row-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-200);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.row-meta {
  font-size: 10px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}
.list-more {
  font-size: 10px;
  color: var(--color-warm);
  text-align: center;
  padding: 1px;
  font-weight: var(--fw-medium);
}

/* ===== 健康分圆点 ===== */
.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--bg-400);
}
.health-dot[data-score="0"], .health-dot[data-score="1"] { background: var(--danger-500); }
.health-dot[data-score="2"] { background: var(--warning-500); }
.health-dot[data-score="3"] { background: var(--warm-400); }
.health-dot[data-score="4"], .health-dot[data-score="5"] { background: var(--success-500); }
.health-dot.lg { width: 12px; height: 12px; }

/* ===== 动作卡 ===== */
.exercise-card { display: flex; flex-direction: column; gap: 2px; }
.ex-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ex-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
  white-space: nowrap;
}
.ex-detail {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 统计卡 ===== */
.stats-card { padding: 0; }
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.stat-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}
.stat-num {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
}
.stat-label {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

/* ===== 待办卡 ===== */
.todo-card { display: flex; flex-direction: column; gap: 2px; }
.todo-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-xs);
  cursor: pointer;
  min-height: 20px;
}
.todo-cb {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--bg-400);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  color: white;
}
.todo-cb.sm { width: 10px; height: 10px; font-size: 7px; }
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
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--radius-full);
  font-weight: var(--fw-semibold);
  flex-shrink: 0;
}
.todo-pri[data-pri="high"] { background: var(--glow-red); color: var(--danger-600); }
.todo-pri[data-pri="normal"] { background: var(--glow-orange); color: var(--warning-600); }
.todo-pri[data-pri="low"] { background: var(--bg-200); color: var(--color-text-tertiary); }

/* ===== 饮水卡 ===== */
.water-card {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
}
.water-ring { flex-shrink: 0; }
.water-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.water-num {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.water-unit {
  font-size: var(--text-xs);
  font-weight: var(--fw-regular);
  color: var(--color-text-secondary);
  margin-left: 2px;
}
.water-goal {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

/* ===== 饮食记录卡 ===== */
.food-rec-card { display: flex; flex-direction: column; gap: 2px; }
.fr-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.fr-cal {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  flex-shrink: 0;
}
.fr-cal-num {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1;
}
.fr-cal-unit {
  font-size: 10px;
  color: var(--color-text-tertiary);
}
.fr-macros {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.macro-mini {
  display: flex;
  align-items: center;
  gap: 4px;
}
.macro-track {
  flex: 1;
  height: 4px;
  background: var(--bg-200);
  border-radius: var(--radius-full);
  overflow: hidden;
  min-width: 0;
}
.macro-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width var(--dur-fast) var(--ease-immersive);
}
.macro-label {
  font-size: 9px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  white-space: nowrap;
}

/* ===== 当前训练卡 ===== */
.workout-card { display: flex; flex-direction: column; gap: 2px; }
.wk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.wk-plan {
  font-size: var(--text-sm);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.wk-phase {
  font-size: 10px;
  color: white;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  font-weight: var(--fw-semibold);
  flex-shrink: 0;
}
.wk-step {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-xs);
}
.wk-step-title {
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wk-sets {
  font-size: 10px;
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 体征卡 ===== */
.body-card { padding: 0; }
.body-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.body-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 2px;
  background: var(--bg-100);
  border-radius: var(--radius-xs);
}
.bd-num {
  font-size: var(--text-sm);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.bd-label {
  font-size: 9px;
  color: var(--color-text-tertiary);
}

/* ===== 营养目标卡 ===== */
.nutrition-card { display: flex; flex-direction: column; gap: 2px; }
.nt-main {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.nt-cal {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1;
}
.nt-cal-unit {
  font-size: 10px;
  color: var(--color-text-tertiary);
}
.nt-goal-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--color-warm-soft);
  color: var(--color-warm);
  font-weight: var(--fw-semibold);
}
.nt-macros {
  font-size: 10px;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
  white-space: nowrap;
}

/* ===== raw fallback 卡 ===== */
.raw-card { display: flex; flex-direction: column; gap: 1px; }
.kv-row {
  display: flex;
  gap: var(--space-2);
  font-size: var(--text-xs);
  padding: 1px var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-xs);
  align-items: baseline;
}
.kv-key {
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
  flex-shrink: 0;
  min-width: 60px;
}
.kv-val {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* ===== 紧凑模式 ===== */
.tool-card.is-compact {
  padding: var(--space-1) var(--space-2);
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
  gap: var(--space-4);
  padding-top: var(--space-2);
}
.detail-summary {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  line-height: var(--lh-base);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.d-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.d-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: var(--lh-tight);
}
.d-label {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.d-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  align-items: center;
}
.d-tag {
  font-size: var(--text-xs);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--bg-100);
  color: var(--color-text-secondary);
}
.d-tag.warm { background: var(--color-warm-soft); color: var(--color-warm); }
.d-text {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  line-height: var(--lh-base);
  white-space: pre-wrap;
}
.d-text-sm {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  line-height: var(--lh-base);
}

/* 详情中的步骤 */
.d-step {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.d-step-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.d-step-idx {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-warm);
  color: white;
  font-size: var(--text-xs);
  font-weight: var(--fw-bold);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.d-step-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  flex: 1;
  min-width: 0;
}
.d-step-phase {
  font-size: 10px;
  color: white;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  font-weight: var(--fw-semibold);
  flex-shrink: 0;
}
.d-step-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}
.d-caution {
  display: flex;
  gap: 4px;
  align-items: flex-start;
  font-size: var(--text-xs);
  color: var(--danger-600);
  background: var(--danger-50);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  margin-top: 2px;
}

/* 详情中的列表行 */
.d-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.d-row-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.d-row-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.d-row-meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}

/* 详情统计网格 */
.d-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
}
.d-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.d-stat-num {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.d-stat-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

/* 详情 7 天柱状 */
.d-bars {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  height: 80px;
  padding-top: var(--space-2);
}
.d-bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 100%;
  min-width: 0;
}
.d-bar {
  width: 100%;
  max-width: 20px;
  background: linear-gradient(180deg, var(--color-warm), var(--warm-300));
  border-radius: 4px 4px 2px 2px;
  min-height: 3px;
  transition: height var(--dur-fast) var(--ease-immersive);
}
.d-bar-label {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

/* 详情键值列表 */
.d-kv-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.d-kv-list .kv-row {
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
}
.d-kv-list .kv-key { min-width: 80px; }
.d-kv-list .kv-val { white-space: normal; }

/* 详情待办 */
.d-todo {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-sm);
  align-items: flex-start;
}
.d-todo-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.d-todo-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.d-todo-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  flex: 1;
  min-width: 0;
}
.d-todo-title.is-done {
  color: var(--color-text-tertiary);
  text-decoration: line-through;
}
.d-todo-meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}
.d-subtasks {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
}
.d-subtask {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

/* 详情饮水 */
.d-water {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.water-ring.lg { width: 96px; height: 96px; }
.d-water-meta { display: flex; flex-direction: column; gap: 2px; }
.d-water-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.d-water-goal {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
.d-water-pct {
  font-size: var(--text-sm);
  color: var(--ring-inner);
  font-weight: var(--fw-semibold);
}
.d-water-add {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
</style>
