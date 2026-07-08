<script setup lang="ts">
/**
 * AiToolCard — 渲染 AI 工具调用结果为精美卡片。
 * 复用 SportsPage 的 course-card-body 视觉语言 + 健康页统计卡风格。
 */
import { computed } from "vue";
import type { ToolResult } from "@/types/ai";
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

const props = defineProps<{ result: ToolResult }>();

const cardType = computed(() => props.result.card ?? "raw");
const data = computed(() => props.result.cardData);
const ok = computed(() => props.result.ok);

const course = computed(() => (data.value as Course | undefined) ?? null);
const courseList = computed(() => (Array.isArray(data.value) ? (data.value as Course[]) : []));
const exercise = computed(() => (data.value as Exercise | undefined) ?? null);
const exerciseList = computed(() => (Array.isArray(data.value) ? (data.value as Exercise[]) : []));
const stats = computed(() => (data.value as WorkoutStats | undefined) ?? null);

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
};
const actionLabel = computed(() => toolLabel[props.result.name] ?? props.result.name);
</script>

<template>
  <div class="tool-card" :class="{ 'is-error': !ok }">
    <div class="tool-head">
      <div class="tool-badge" :class="ok ? 'ok' : 'err'">
        <svg v-if="ok" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
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

    <!-- raw / error -->
    <div v-else class="raw-body">
      <pre>{{ JSON.stringify(data, null, 2) }}</pre>
    </div>
  </div>
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
  overflow: hidden;
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
</style>
