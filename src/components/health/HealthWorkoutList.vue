<script setup lang="ts">
import { WORKOUT_META } from '@/config/domain'
import { fmtDateCn, minToHHmm } from '@/utils/date'
import type { HealthSyncWorkout, WorkoutType } from '@/types'

/**
 * 第三方运动记录行列表（只读）。
 *
 * 只服务「第三方数据管理」页：把「手机同步进来的」与「没填开始时间、回写时被跳过的本机
 * 记录」两组按同一形状列出来。刻意不复用 exercise 域的 WorkoutRow —— 那个组件要完整的
 * Workout 形状（effort / sessionId / createdAt），还带删除入口；这里只要用户最关心的
 * 几列，而且是只读的（补填与删除仍在「全部运动记录」页）。
 */
const props = withDefaults(
  defineProps<{
    items: HealthSyncWorkout[]
    /** 是否逐行标来源：块内来源单一（如「没填开始时间」块恒为本机）时可关掉 */
    showSource?: boolean
  }>(),
  { showSource: true },
)

/** 运动类型标签：导入记录的 type 正常落在 WORKOUT_META 内，脏数据兜底显示原文 */
function typeLabel(t: string): string {
  return WORKOUT_META[t as WorkoutType]?.label ?? t
}

/** 日期 · 时刻；没有开始时间就直说，别留空白让人以为是渲染坏了 */
function timeLine(w: HealthSyncWorkout): string {
  return `${fmtDateCn(w.date)} · ${w.startMin != null ? minToHHmm(w.startMin) : '未填开始时间'}`
}

const SOURCE_LABEL: Record<HealthSyncWorkout['source'], string> = {
  health_connect: '手机同步',
  local: '本机',
}
</script>

<template>
  <ul class="list">
    <li v-for="w in props.items" :key="w.id" class="item row">
      <i class="ic col center">{{ typeLabel(w.type).slice(0, 1) }}</i>
      <div class="flex-1">
        <p class="name">
          <span class="nm">{{ w.name }}</span>
          <span v-if="props.showSource" class="src" :class="w.source">
            {{ SOURCE_LABEL[w.source] }}
          </span>
        </p>
        <p class="meta num">{{ timeLine(w) }} · {{ typeLabel(w.type) }}</p>
        <p v-if="w.note" class="note">{{ w.note }}</p>
      </div>
      <div class="col right">
        <b class="num kcal">{{ w.kcal }}</b>
        <span class="unit num">{{ w.durationMin }} 分钟</span>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  gap: 12px;
  padding: 12px 0;
}

/* 分隔线用 :not(:first-child)：跨组件实例的同级 li 依然成立（与 WorkoutRow 同款） */
.item:not(:first-child) {
  border-top: 0.5px solid var(--line);
}

.ic {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: var(--radius-m);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-weight: 800;
  font-size: var(--fs-callout);
}

.name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-body);
  font-weight: 600;
}

.nm {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 来源标签：导入记录用强调色，本机记录用中性底 —— 「手机同步」是这一页的主角 */
.src {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 600;
}

.src.health_connect {
  background: var(--accent-soft);
  color: var(--accent);
}

.meta {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.note {
  margin-top: 3px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: 1.4;
}

.right {
  align-items: flex-end;
  flex: none;
}

.kcal {
  color: var(--c-exercise-deep);
  font-weight: 800;
  font-size: var(--fs-callout);
}

.unit {
  font-size: var(--fs-micro);
  color: var(--text-3);
}
</style>
