<script setup lang="ts">
import { computed } from 'vue'

import {
  cellText,
  groupByWeek,
  phaseLabel,
  type CellState,
  type CycleStats,
  type DayCell,
} from '@/utils/programProgress'

/**
 * 全周期地图：把 4 周（或任意长度）方案铺成 7×N 网格。
 *
 * 与「只显示未来 7 天」的列表不同，这里已经走过的日子同样在场——
 * 长周期产品最忌讳的就是让用户的坚持痕迹在界面上消失。
 */
const props = defineProps<{
  cells: DayCell[]
  stats: CycleStats
  /** 当前聚焦日期（与页面的 focusedDay 共享同一状态） */
  focusedDate: string | null
  /** 今天 YYYY-MM-DD，用于判定「今天」格 */
  today: string
}>()

const emit = defineEmits<{
  focus: [date: string]
}>()

const weeks = computed(() => groupByWeek(props.cells))
const focused = computed(() => props.cells.find((c) => c.date === props.focusedDate) ?? null)

const weekdayHead = ['一', '二', '三', '四', '五', '六', '日']

/** 图例只列与当前数据相关的状态，避免展示用不到的图例项 */
const legend = computed<{ state: CellState; label: string }[]>(() => {
  const seen = new Set(props.cells.map((c) => c.state))
  const all: { state: CellState; label: string }[] = [
    { state: 'done', label: '已完成' },
    { state: 'missed', label: '错过' },
    { state: 'today', label: '今天' },
    { state: 'future', label: '未开始' },
    { state: 'restPast', label: '休息' },
  ]
  return all.filter((l) => seen.has(l.state) || l.state === 'today')
})

const rateText = computed(() => `${Math.round(props.stats.rate * 100)}%`)
</script>

<template>
  <section class="pod">
    <header class="pod-head">
      <h2>周期地图</h2>
      <span class="pill">共 {{ stats.total }} 天</span>
    </header>

    <!-- 统计：分母只算已发生的训练日，未到的不拉低完成率 -->
    <ul class="stats num">
      <li><em>已练</em><b>{{ stats.done }}<i>次</i></b></li>
      <li><em>计划</em><b>{{ stats.planned }}<i>次</i></b></li>
      <li><em>完成率</em><b>{{ rateText }}</b></li>
      <li><em>剩余</em><b>{{ stats.future }}<i>天</i></b></li>
    </ul>

    <div class="grid">
      <div class="week-row head">
        <span class="phase" />
        <div class="cells">
          <span v-for="w in weekdayHead" :key="w" class="wd">{{ w }}</span>
        </div>
      </div>

      <div v-for="(week, wi) in weeks" :key="wi" class="week-row">
        <span class="phase">{{ phaseLabel(wi, weeks.length) }}</span>
        <div class="cells">
          <button
            v-for="c in week"
            :key="c.date"
            class="cell"
            :class="[c.state, { sel: c.date === focusedDate }]"
            :aria-label="`第 ${c.dayNo} 天 ${c.rest ? '休息' : (c.courseName ?? '训练')}`"
            :aria-current="c.date === today ? 'date' : undefined"
            @click="emit('focus', c.date)"
          >
            <b class="num">{{ c.dayNo }}</b>
            <span class="ct">{{ cellText(c) }}</span>
          </button>
        </div>
      </div>
    </div>

    <ul class="legend">
      <li v-for="l in legend" :key="l.state">
        <i class="swatch" :class="l.state" />
        {{ l.label }}
      </li>
    </ul>

    <!-- 聚焦日详情：点格子即切换，与页面共享 focusedDay -->
    <div v-if="focused" class="focus">
      <div class="focus-head">
        <b>第 {{ focused.dayNo }} 天 · {{ focused.date }}</b>
        <span class="pill" :class="{ ghost: focused.rest }">
          {{ focused.rest ? '休息日' : '训练日' }}
        </span>
      </div>
      <p class="focus-sub">
        {{ focused.courseName ?? '休息日 · 散步拉伸即可' }}
        <template v-if="focused.kcal > 0">
          <span class="num"> · {{ Math.round(focused.kcal) }} 大卡</span>
        </template>
      </p>
    </div>
  </section>
</template>

<style scoped>
.pod {
  padding: 15px 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
}

.pod-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

h2 {
  font-size: var(--fs-headline);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.pill {
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 700;
  white-space: nowrap;
}

.pill.ghost {
  background: var(--surface-2);
  color: var(--text-3);
}

.stats {
  margin: 12px 0 14px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.stats em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.stats b {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.stats i {
  font-style: normal;
  font-weight: 400;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: 1px;
}

/* 网格 */
.grid {
  display: grid;
  gap: 5px;
}

.week-row {
  display: grid;
  grid-template-columns: 46px 1fr;
  align-items: center;
  gap: 8px;
}

.phase {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.2;
}

.cells {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.wd {
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
  padding-bottom: 2px;
}

.cell {
  aspect-ratio: 1;
  border: none;
  border-radius: 7px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  background: var(--surface-2);
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.cell b {
  font-size: var(--fs-caption);
  font-weight: 700;
  line-height: 1.1;
}

.cell .ct {
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1.1;
}

/* 六态语义色：全部引用令牌 */
.cell.done {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.cell.missed {
  background: var(--danger-soft);
  color: var(--danger);
}

.cell.today {
  background: var(--accent-soft);
  color: var(--accent);
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  animation: breathe 2.4s var(--ease-standard) infinite;
}

.cell.future {
  background: transparent;
  border: 0.5px dashed var(--line-strong);
}

.cell.restPast {
  background: var(--surface-2);
  opacity: 0.55;
}

.cell.restFuture {
  background: transparent;
  border: 0.5px dashed var(--line);
  opacity: 0.6;
}

/* 选中态与 VirtualTimeline 同惯例：outline 环，不占布局 */
.cell.sel:not(.today) {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

@keyframes breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.62;
  }
}

/* 图例 */
.legend {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: var(--surface-2);
}

.swatch.done {
  background: var(--c-exercise-soft);
  box-shadow: inset 0 0 0 1px var(--c-exercise-deep);
}

.swatch.missed {
  background: var(--danger-soft);
  box-shadow: inset 0 0 0 1px var(--danger);
}

.swatch.today {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.swatch.future {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong);
}

.swatch.restPast {
  background: var(--surface-2);
}

/* 聚焦日 */
.focus {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 0.5px solid var(--line);
}

.focus-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-subhead);
}

.focus-sub {
  margin-top: 3px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .cell,
  .cell.today {
    transition: none;
    animation: none;
  }
}
</style>
