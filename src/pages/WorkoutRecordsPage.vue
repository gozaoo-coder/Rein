<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronLeft, ChevronRight, Dumbbell, Flame } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ExerciseBars from '@/components/exercise/ExerciseBars.vue'
import WorkoutRow from '@/components/exercise/WorkoutRow.vue'
import WorkoutDetailDrawer from '@/components/exercise/WorkoutDetailDrawer.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useExerciseStore } from '@/stores/exercise'
import type { Workout } from '@/types'
import { WEEKDAY_LABELS, addDays, addMonths, fmtDateCn, monthKey, parseDate, todayStr, weekDates } from '@/utils/date'

/** 全部运动记录 · 二级页：日 / 周 / 年三视图。
 *  结构沿用本周运动卡的视觉语言：概览卡（周期导航 + 分钟柱状图 + 统计行）+ 分组记录列表。 */
type ViewKey = 'day' | 'week' | 'year'

const viewOptions: { value: ViewKey; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'year', label: '年' },
]

const ex = useExerciseStore()
const view = ref<ViewKey>('week')

// 各视图独立的周期锚点（锚在周期内任一天），默认今天
const today = todayStr()
const dayAnchor = ref(today)
const weekAnchor = ref(today)
const yearAnchor = ref(today)

onMounted(() => {
  void ex.loadAll()
})

/* ---------- 周期边界与导航 ---------- */

const dayRange = computed<[string, string]>(() => [dayAnchor.value, dayAnchor.value])

const weekRange = computed<[string, string]>(() => {
  const days = weekDates(weekAnchor.value)
  return [days[0]!, days[6]!]
})

const yearNum = computed(() => parseDate(yearAnchor.value).getFullYear())

/** 是否处于最新周期（未来不会有记录，故前进键与「回到今天」都以此为准） */
const atCurrent = computed(() => {
  switch (view.value) {
    case 'day':
      return dayAnchor.value === today
    case 'week':
      return weekRange.value[1]! >= today
    case 'year':
      return yearNum.value === Number(today.slice(0, 4))
  }
})

function shift(n: number): void {
  switch (view.value) {
    case 'day':
      dayAnchor.value = addDays(dayAnchor.value, n)
      break
    case 'week':
      weekAnchor.value = addDays(weekAnchor.value, n * 7)
      break
    case 'year':
      yearAnchor.value = addMonths(yearAnchor.value, n * 12)
      break
  }
}

function backToCurrent(): void {
  dayAnchor.value = today
  weekAnchor.value = today
  yearAnchor.value = today
}

/* ---------- 周期标签 ---------- */

function shortDay(date: string): string {
  const d = parseDate(date)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

const periodLabel = computed(() => {
  switch (view.value) {
    case 'day': {
      const d = parseDate(dayAnchor.value)
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAY_LABELS[(d.getDay() + 6) % 7]}`
    }
    case 'week': {
      const [s, e] = weekRange.value
      return `${shortDay(s!)} – ${shortDay(e!)}${atCurrent.value ? ' · 本周' : ''}`
    }
    case 'year':
      return `${yearNum.value}年`
  }
})

const currentWord = computed(() => {
  switch (view.value) {
    case 'day':
      return '今天'
    case 'week':
      return '本周'
    case 'year':
      return '今年'
  }
})

/* ---------- 数据切片：统计 / 柱状图 / 分组列表 ---------- */

const periodWorkouts = computed<Workout[]>(() => {
  switch (view.value) {
    case 'day':
      return ex.allWorkouts.filter((w) => w.date === dayRange.value[0])
    case 'week': {
      const [s, e] = weekRange.value
      return ex.allWorkouts.filter((w) => w.date >= s! && w.date <= e!)
    }
    case 'year': {
      const y = String(yearNum.value)
      return ex.allWorkouts.filter((w) => w.date.slice(0, 4) === y)
    }
  }
})

const stats = computed(() => ({
  count: periodWorkouts.value.length,
  minutes: periodWorkouts.value.reduce((s, w) => s + w.durationMin, 0),
  kcal: periodWorkouts.value.reduce((s, w) => s + w.kcal, 0),
}))

const bars = computed(() => {
  if (view.value === 'week') {
    return weekDates(weekAnchor.value).map((date) => ({
      label: WEEKDAY_LABELS[(parseDate(date).getDay() + 6) % 7],
      value: periodWorkouts.value.filter((w) => w.date === date).reduce((s, w) => s + w.durationMin, 0),
      highlight: date === today,
    }))
  }
  if (view.value === 'year') {
    const curYear = Number(today.slice(0, 4))
    const curMonth = Number(today.slice(5, 7))
    return Array.from({ length: 12 }, (_, i) => {
      const mk = `${yearNum.value}-${String(i + 1).padStart(2, '0')}`
      return {
        label: String(i + 1),
        value: periodWorkouts.value.filter((w) => monthKey(w.date) === mk).reduce((s, w) => s + w.durationMin, 0),
        highlight: yearNum.value === curYear && i + 1 === curMonth,
      }
    })
  }
  return [] // 日视图无图表，直接看当天明细
})

interface Group {
  key: string
  label: string
  items: Workout[]
}

function dayGroupLabel(date: string): string {
  if (date === today) return '今天'
  if (date === addDays(today, -1)) return '昨天'
  return fmtDateCn(date)
}

const groups = computed<Group[]>(() => {
  if (view.value === 'day') {
    return [{ key: dayAnchor.value, label: '', items: periodWorkouts.value }]
  }
  if (view.value === 'week') {
    const byDate = new Map<string, Workout[]>()
    for (const w of periodWorkouts.value) {
      if (!byDate.has(w.date)) byDate.set(w.date, [])
      byDate.get(w.date)!.push(w)
    }
    return [...byDate.entries()].map(([date, items]) => ({ key: date, label: dayGroupLabel(date), items }))
  }
  const byMonth = new Map<string, Workout[]>()
  for (const w of periodWorkouts.value) {
    if (!byMonth.has(monthKey(w.date))) byMonth.set(monthKey(w.date), [])
    byMonth.get(monthKey(w.date))!.push(w)
  }
  return [...byMonth.entries()].map(([mk, items]) => ({
    key: mk,
    label: `${Number(mk.slice(5, 7))}月 · ${items.length} 次`,
    items,
  }))
})

/* ---------- 记录详情抽屉 ---------- */

const detailOpen = ref(false)
const detailWorkout = ref<Workout | null>(null)

function openDetail(w: Workout): void {
  detailWorkout.value = w
  detailOpen.value = true
}
</script>

<template>
  <div class="page">
    <PageHeader title="全部运动记录" subtitle="按日 / 周 / 年回顾你的每一次训练" back />

    <SegmentedControl v-model="view" :options="viewOptions" class="seg" />

    <main :key="`${view}-${groups[0]?.key ?? periodLabel}`" class="content">
      <!-- 概览卡：周期导航 + 柱状图（周/年）+ 统计行 -->
      <section class="card">
        <header class="row between nav">
          <div class="row arrows">
            <button class="navbtn row center pressable" aria-label="上一周期" @click="shift(-1)">
              <ChevronLeft :size="17" />
            </button>
            <span class="nav-label num">{{ periodLabel }}</span>
            <button class="navbtn row center pressable" :disabled="!atCurrent" aria-label="下一周期" @click="shift(1)">
              <ChevronRight :size="17" />
            </button>
          </div>
          <button v-if="!atCurrent" class="pill row center pressable" @click="backToCurrent">{{ currentWord }}</button>
        </header>

        <ExerciseBars v-if="bars.length > 0" :bars="bars" class="chart" />

        <footer class="stat row">
          <Flame :size="15" style="color: var(--c-exercise)" />
          运动 <b class="num">{{ stats.count }}</b> 次 · <b class="num">{{ stats.minutes }}</b> 分钟 · <b class="num">{{ stats.kcal }}</b> 大卡
        </footer>
      </section>

      <!-- 记录列表：日视图单列；周视图按日分组；年视图按月分组 -->
      <section class="card">
        <header class="head"><h2>运动记录</h2></header>
        <EmptyState
          v-if="periodWorkouts.length === 0 && !ex.loading"
          :icon="Dumbbell"
          title="这段时间还没有运动记录"
          hint="去「运动」页开始一次训练吧"
        />
        <template v-else>
          <div v-for="g in groups" :key="g.key" class="group">
            <h3 v-if="g.label" class="grouplabel">{{ g.label }}</h3>
            <ul>
              <WorkoutRow
                v-for="w in g.items"
                :key="w.id"
                :workout="w"
                :show-date="false"
                @detail="openDetail(w)"
                @remove="ex.remove(w.id)"
              />
            </ul>
          </div>
        </template>
      </section>
    </main>

    <!-- 运动详情抽屉（Teleport；保证页面单根） -->
    <WorkoutDetailDrawer :open="detailOpen" :workout="detailWorkout" @close="detailOpen = false" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.seg {
  margin-bottom: 14px;
}

/* 视图 / 周期切换的轻过渡 */
.content {
  animation: rise var(--dur-base) var(--ease-standard);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.nav {
  min-height: 32px;
}

.arrows {
  gap: 10px;
}

.navbtn {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-1);
}

.navbtn:disabled {
  opacity: 0.35;
}

.nav-label {
  min-width: 150px;
  text-align: center;
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.pill {
  padding: 5px 10px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.chart {
  margin-top: 16px;
}

.stat {
  gap: 4px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.stat b {
  color: var(--text-1);
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.group + .group {
  margin-top: 18px;
}

.grouplabel {
  margin-bottom: 2px;
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .content {
    animation: none;
  }
}
</style>
