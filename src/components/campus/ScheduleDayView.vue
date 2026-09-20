<script setup lang="ts">
import { computed } from 'vue'

import EmptyState from '@/components/common/EmptyState.vue'
import type { ScheduleEntry } from '@/types'
import { fmtDateCn, nowMin, todayStr } from '@/utils/date'
import { CalendarOff } from 'lucide-vue-next'

/**
 * 日视图 · 一天的上课清单，按真实时间排列。
 *
 * 左侧时间柱显示**实际上课时间**（教务的 `startTime`/`endTime`）与节次区间，
 * 右侧是课程卡片；当天正在进行的那一节会被高亮，并标出剩余时间。
 */
const props = defineProps<{
  entries: ScheduleEntry[]
  date: string
}>()

const now = nowMin()
const isToday = computed(() => props.date === todayStr())

/**
 * 只取当天的课。**必须自己过滤而不是直接用 props.entries**：
 * 切到日视图会异步重载该日区间，在重载回来之前 store 里仍是上一个视图的数据，
 * 直接渲染会出现「9月16日 周三」下列着周一/周二的课这种串台。
 */
const list = computed(() => props.entries.filter((e) => e.date === props.date))

function startMin(e: ScheduleEntry): number {
  const [h, m] = e.session.startTime.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function endMin(e: ScheduleEntry): number {
  const [h, m] = e.session.endTime.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** 正在进行：今天的课，且当前时刻落在区间内 */
function isNow(e: ScheduleEntry): boolean {
  return isToday.value && now >= startMin(e) && now < endMin(e)
}

/** 下一节：今天的课，还没开始 */
function isNext(e: ScheduleEntry, i: number): boolean {
  if (!isToday.value) return false
  if (now >= startMin(e)) return false
  return i === 0 || now >= endMin(list.value[i - 1]!)
}

const activeIndex = computed(() => list.value.findIndex((e) => isNow(e)))

function colorOf(e: ScheduleEntry): string {
  return e.session.color ?? 'var(--cat-class)'
}

function place(e: ScheduleEntry): string {
  return [e.session.building, e.session.room].filter(Boolean).join(' ')
}
</script>

<template>
  <div class="day">
    <p class="date-line">{{ fmtDateCn(date) }}<span v-if="isToday" class="today-tag">今天</span></p>

    <EmptyState
      v-if="list.length === 0"
      :icon="CalendarOff"
      title="这天没有课"
      hint="好好休息，或者去看看别的日期"
    />

    <ul v-else class="list">
      <li
        v-for="(e, i) in list"
        :key="e.session.id"
        class="row"
        :class="{ now: i === activeIndex, next: isNext(e, i) }"
        :style="{ '--blk': colorOf(e) }"
      >
        <!-- 左侧时间柱：实际上课时间 + 节次 -->
        <div class="rail">
          <span class="t1">{{ e.session.startTime }}</span>
          <span class="line" />
          <span class="t2">{{ e.session.endTime }}</span>
          <span class="unit">第{{ e.session.startUnit }}-{{ e.session.endUnit }}节</span>
        </div>

        <div class="card">
          <div class="top">
            <span class="name">{{ e.session.courseName }}</span>
            <span v-if="i === activeIndex" class="badge">进行中</span>
            <span v-else-if="isNext(e, i)" class="badge soft">下一节</span>
          </div>
          <p v-if="place(e)" class="meta">{{ place(e) }}</p>
          <p v-if="e.session.teachers.length" class="meta">
            {{ e.session.teachers.join('、') }}
          </p>
          <p class="meta dim">
            <span v-if="e.session.weeksStr">第 {{ e.session.weeksStr }} 周</span>
            <span v-if="e.session.credits"> · {{ e.session.credits }} 学分</span>
            <span v-if="e.session.courseType"> · {{ e.session.courseType }}</span>
          </p>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.day {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.date-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
  padding: 0 2px;
}

.today-tag {
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: 1px 8px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  gap: 10px;
  background: var(--surface);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-card);
  border-left: 3px solid var(--blk);
  padding: 12px 14px 12px 10px;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.row.now {
  border-left-width: 4px;
  background: color-mix(in srgb, var(--blk) 8%, var(--surface));
}

.row:active {
  transform: scale(0.995);
}

.rail {
  flex: none;
  width: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.t1 {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

/* 时间柱中间那条竖线，把起止时刻连起来 */
.line {
  width: 1.5px;
  flex: 1;
  min-height: 8px;
  background: var(--blk);
  opacity: 0.35;
  border-radius: 1px;
}

.t2 {
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.unit {
  font-size: 9px;
  color: var(--text-3);
  margin-top: 2px;
  white-space: nowrap;
}

.card {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.name {
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.25;
  word-break: break-all;
}

.badge {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: 1px 7px;
}

.badge.soft {
  color: var(--accent);
  background: var(--accent-soft);
}

.meta {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.35;
}

.meta.dim {
  color: var(--text-3);
  font-size: var(--fs-micro);
}
</style>
