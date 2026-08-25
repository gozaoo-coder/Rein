<script setup lang="ts">
import { computed, onMounted, type Component } from 'vue'
import { Apple, ChevronRight, Coffee, Dumbbell, Scale, Timer, TrendingUp, Utensils, Wallet } from 'lucide-vue-next'

import { CATEGORY_META, MEAL_LABELS } from '@/config/domain'
import { categoryOf, fmtCents } from '@/config/ledger'
import { useDietStore } from '@/stores/diet'
import { useExerciseStore } from '@/stores/exercise'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm, nowMin, todayStr } from '@/utils/date'

/** 桌面主页 · 一日脊柱：把今天已发生的记录按时间轴纵向陈列，未来安排用虚线标示。 */

interface SpineEvent {
  key: string
  /** 距 00:00 的分钟数；无确切时间的记录不参与排序，排在末尾 */
  min: number | null
  label: string
  sub: string
  value: string | null
  colorVar: string
  icon: Component
  done?: boolean
  planned?: boolean
  live?: boolean
}

const today = todayStr()
const now = nowMin()

const nutrition = useNutritionStore()
const diet = useDietStore()
const exercise = useExerciseStore()
const pomo = usePomodoroStore()
const ledger = useLedgerStore()
const todo = useTodoStore()

onMounted(() => {
  void nutrition.loadSummary(today)
  void nutrition.loadMetrics(30)
  void diet.load(today)
  void exercise.loadWeek(today)
  void pomo.loadToday()
  void ledger.loadMonth()
  void todo.loadDay(today)
})

const MEAL_ICON: Record<string, Component> = { breakfast: Coffee, lunch: Utensils, dinner: Utensils, snack: Apple }
const MEAL_COLOR: Record<string, string> = {
  breakfast: 'var(--led-food)',
  lunch: 'var(--c-protein)',
  dinner: 'var(--cat-study)',
  snack: 'var(--c-carb)',
}

const events = computed<SpineEvent[]>(() => {
  const out: SpineEvent[] = []

  // 晨重（无准确时刻，固定排首）
  const metrics = nutrition.metrics
  const m0 = metrics.find((m) => m.date === today && m.weightKg != null)
  if (m0) {
    const prev = metrics.find((m) => m.date < today && m.weightKg != null)
    let sub = '体重记录'
    if (prev?.weightKg != null && prev.weightKg !== 0) {
      const d = m0.weightKg! - prev.weightKg
      sub += ` · 较前次 ${d >= 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(1)}`
    }
    out.push({ key: 'weight', min: 0, label: `晨重 ${m0.weightKg} kg`, sub, value: null, colorVar: 'var(--accent)', icon: Scale })
  }

  // 饮食记录
  for (const m of diet.meals) {
    const food = m.food
    const kcal = food ? Math.round((food.kcal * m.grams) / 100) : null
    out.push({
      key: `meal-${m.id}`,
      min: minFromIso(m.createdAt),
      label: food?.name ?? MEAL_LABELS[m.mealType],
      sub: `${MEAL_LABELS[m.mealType]} · ${m.grams} g`,
      value: kcal != null ? `${kcal} kcal` : null,
      colorVar: MEAL_COLOR[m.mealType],
      icon: MEAL_ICON[m.mealType],
    })
  }

  // 今日运动
  for (const w of exercise.weekWorkouts.filter((x) => x.date === today)) {
    out.push({
      key: `workout-${w.id}`,
      min: w.startMin,
      label: w.name,
      sub: `运动 · ${w.durationMin} 分钟`,
      value: `${w.kcal} kcal`,
      colorVar: 'var(--c-exercise)',
      icon: Dumbbell,
    })
  }

  // 番茄会话
  for (const s of pomo.todaySessions) {
    out.push({
      key: `pomo-${s.id}`,
      min: minFromIso(s.startedAt),
      label: '番茄 · 专注',
      sub: `${s.focusMin} 分钟`,
      value: null,
      colorVar: 'var(--c-intake)',
      icon: Timer,
    })
  }

  // 进行中的番茄（实时呼吸点）
  if (pomo.running) {
    out.push({
      key: 'pomo-live',
      min: now,
      label: pomo.phase === 'focus' ? '专注进行中' : '休息中',
      sub: pomo.displayTime,
      value: null,
      colorVar: 'var(--c-intake)',
      icon: Timer,
      live: true,
    })
  }

  // 今日收支
  for (const e of ledger.entries.filter((x) => x.date === today)) {
    const cat = categoryOf(e.category)
    const income = e.kind === 'income'
    out.push({
      key: `ledger-${e.id}`,
      min: minFromIso(e.createdAt),
      label: cat?.label ?? e.category,
      sub: e.note ?? (income ? '收入' : '支出'),
      value: `${income ? '+' : '-'}¥${fmtCents(e.amountCents)}`,
      colorVar: income ? 'var(--led-income)' : (cat?.colorVar ?? 'var(--led-expense)'),
      icon: income ? TrendingUp : Wallet,
    })
  }

  // 有时间安排的待办（未来 = 计划，虚线）
  for (const t of todo.dayTodos) {
    if (t.startMin == null) continue
    const done = t.status === 'done'
    out.push({
      key: `todo-${t.id}`,
      min: t.startMin,
      label: t.title,
      sub: CATEGORY_META[t.category].label + (t.durationMin ? ` · 约 ${t.durationMin} 分钟` : ''),
      value: null,
      colorVar: CATEGORY_META[t.category].colorVar,
      icon: ChevronRight,
      done,
      planned: !done && t.startMin > now,
    })
  }

  // 排序：有时间按分钟；无时间排在末尾（按是否有则后置）
  return [...out].sort((a, b) => {
    const am = a.min ?? 9999
    const bm = b.min ?? 9999
    return am - bm
  })
})

/** 展示行序列：在第一个未来事件前插入「现在」呼吸点（全部已发生则置于末尾） */
type Row = { type: 'ev'; e: SpineEvent } | { type: 'now' }
const rows = computed<Row[]>(() => {
  const arr: Row[] = []
  let inserted = false
  for (const e of events.value) {
    if (!inserted && e.min != null && e.min > now) {
      arr.push({ type: 'now' })
      inserted = true
    }
    arr.push({ type: 'ev', e })
  }
  if (!inserted && events.value.length) arr.push({ type: 'now' })
  return arr
})

function minFromIso(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

function fmtMin(min: number | null): string {
  return min == null ? '—' : minToHHmm(min)
}
</script>

<template>
  <div class="spine">
    <div v-if="events.length" class="tl">
      <template v-for="(row, i) in rows" :key="i">
        <div v-if="row.type === 'now'" class="nowrow">
          <span class="nowchip num">现在<br />{{ fmtMin(now) }}</span>
          <i class="nowdot" />
        </div>
        <div
          v-else
          class="ev"
          :class="{ plan: row.e.planned, live: row.e.live, done: row.e.done }"
          :style="{ '--ec': row.e.colorVar }"
        >
          <span class="time num">{{ fmtMin(row.e.min) }}</span>
          <i class="node" />
          <section class="ecard">
            <i class="eic"><component :is="row.e.icon" :size="19" /></i>
            <div class="col flex-1">
              <span class="ett" :class="{ done: row.e.done }">{{ row.e.label }}</span>
              <span class="esb">{{ row.e.sub }}</span>
            </div>
            <b v-if="row.e.value" class="eval_ num">{{ row.e.value }}</b>
          </section>
        </div>
      </template>
    </div>
    <p v-else class="t-3 empty">今天还没有记录，从记一笔饮食或待办开始吧</p>
  </div>
</template>

<style scoped>
.spine {
  max-width: 860px;
  padding-bottom: 40px;
}

.tl {
  position: relative;
  padding-left: 72px;
}

.tl::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--line);
}

.ev {
  position: relative;
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}

.ev .time {
  position: absolute;
  left: -72px;
  top: 16px;
  width: 54px;
  text-align: right;
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-3);
}

.ev .node {
  position: absolute;
  left: -6.5px;
  top: 20px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: inset 0 0 0 2.5px var(--ec, var(--text-3));
  z-index: 1;
}

.ev .ecard {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  background: var(--surface);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
}

.ev .eic {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--ec) 14%, transparent);
  color: var(--ec);
}

.ev .ett {
  font-size: var(--fs-callout);
  font-weight: 650;
}

.ev .esb {
  font-size: var(--fs-footnote);
  color: var(--text-2);
  margin-top: 1px;
}

.ev .eval_ {
  margin-left: auto;
  font-size: var(--fs-subhead);
  font-weight: 700;
  white-space: nowrap;
  padding-left: 12px;
}

.ev.done .ett {
  color: var(--text-3);
  text-decoration: line-through;
}

/* 未来计划：虚线卡 */
.ev.plan .ecard {
  border: 1.6px dashed var(--line-strong);
  box-shadow: none;
  background: transparent;
}

/* 进行中：呼吸点 */
.ev.live .node {
  background: var(--accent);
  box-shadow: inset 0 0 0 2.5px var(--accent);
  animation: pulse 1.6s var(--ease-standard) infinite;
}

.nowrow {
  position: relative;
  height: 34px;
  margin-bottom: 6px;
}

.nowchip {
  position: absolute;
  left: -72px;
  top: 4px;
  width: 54px;
  text-align: right;
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--accent);
  line-height: 1.4;
}

.nowdot {
  position: absolute;
  left: -9px;
  top: 10px;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.nowdot::after {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.6s var(--ease-standard) infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.empty {
  padding: 40px 0;
  text-align: center;
  font-size: var(--fs-callout);
}

@media (prefers-reduced-motion: reduce) {
  .ev.live .node,
  .nowdot::after {
    animation: none;
  }
}
</style>
