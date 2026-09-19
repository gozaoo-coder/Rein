<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { useTodoStore } from '@/stores/todo'
import { WEEKDAY_LABELS, minToHHmm, todayStr, weekDates } from '@/utils/date'
import type { Todo } from '@/types'

/**
 * 周视图：横轴为日（一~日），窄屏横向滚动；每列展示当日具体事件
 * （已排程按时间排序，未安排置底），点列进入该日画布。完成度以顶部细进度条表达。
 */
const props = defineProps<{
  selected?: string
}>()

const emit = defineEmits<{ select: [date: string] }>()

const store = useTodoStore()
const today = todayStr()
const dates = weekDates(today)

onMounted(() => {
  void store.loadStats(dates[0]!, dates[6]!)
})

interface DayColumn {
  date: string
  label: string
  dayNum: number
  isToday: boolean
  isSelected: boolean
  done: number
  total: number
  /** 已排程事件，按开始时间排序 */
  events: Todo[]
  /** 未安排（无时间）且未完成 */
  pool: Todo[]
}

const columns = computed<DayColumn[]>(() =>
  dates.map((date, i) => {
    const day = store.allTodos.filter((t) => t.date === date)
    const events = day
      .filter((t) => t.startMin != null)
      .sort((a, b) => a.startMin! - b.startMin! || a.id - b.id)
    return {
      date,
      label: WEEKDAY_LABELS[i] ?? '',
      dayNum: Number(date.slice(8, 10)),
      isToday: date === today,
      isSelected: date === props.selected,
      total: day.length,
      done: day.filter((t) => t.status === 'done').length,
      events,
      pool: day.filter((t) => t.startMin == null && t.status !== 'done'),
    }
  }),
)

function onKey(e: KeyboardEvent, date: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('select', date)
  }
}
</script>

<template>
  <div class="week">
    <div
      v-for="c in columns"
      :key="c.date"
      class="wcell"
      :class="{ today: c.isToday, selected: c.isSelected }"
      role="button"
      tabindex="0"
      :aria-label="`查看 ${c.date} 的画布`"
      @click="emit('select', c.date)"
      @keydown="onKey($event, c.date)"
    >
      <header class="wd-head">
        <span class="wd-label" :class="{ today: c.isToday }">周{{ c.label }}</span>
        <span class="num wd-date">{{ c.dayNum }}日</span>
        <span class="num wd-count" :class="{ full: c.total > 0 && c.done >= c.total }">{{ c.done }}/{{ c.total }}</span>
      </header>
      <div class="wd-bar">
        <i class="wd-fill" :class="{ full: c.total > 0 && c.done >= c.total }" :style="{ '--p': `${c.total ? (c.done / c.total) * 100 : 0}%` }" />
      </div>
      <ul class="wd-events">
        <li v-for="t in c.events" :key="t.id" class="wev" :class="{ done: t.status === 'done' }">
          <span class="num wt">{{ minToHHmm(t.startMin!) }}</span>
          <span class="wtt">{{ t.title }}</span>
        </li>
        <li v-for="t in c.pool" :key="`p-${t.id}`" class="wev pool">
          <span class="wt">·</span>
          <span class="wtt">{{ t.title }}</span>
        </li>
        <li v-if="!c.events.length && !c.pool.length" class="wempty">暂无安排</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* 横轴为日：窄屏横向滚动（列有下限宽），宽屏 7 列均分铺满。
   滚动条不占位也不显示（滚动可达性由被切半的下一列表达）：Windows/WebView2 的原生
   滚动条会在列下方多出一条 10px 的槽，看着像卡片底部多了一段空白间距。 */
.week {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  padding-bottom: 4px;
}

.week::-webkit-scrollbar {
  height: 0;
}

.wcell {
  flex: 1 0 172px;
  min-width: 172px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 11px 9px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    box-shadow var(--dur-fast) var(--ease-standard);
}

.wcell:hover {
  box-shadow: var(--shadow-card);
}

.wcell.selected {
  background: var(--accent-soft);
}

.wd-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.wd-label {
  font-size: var(--fs-caption);
  font-weight: 650;
  color: var(--text-2);
}

.wd-label.today {
  color: var(--accent);
}

.wd-date {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.wd-count {
  margin-left: auto;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.wd-count.full {
  color: var(--ok);
  font-weight: 700;
}

.wd-bar {
  height: 3px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  overflow: hidden;
}

.wd-fill {
  display: block;
  height: 100%;
  width: var(--p, 0%);
  border-radius: inherit;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-standard);
}

.wd-fill.full {
  background: var(--ok);
}

.wd-events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.wev {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 3.5px 0;
  min-width: 0;
}

.wt {
  flex: none;
  min-width: 34px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.wtt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-footnote);
  font-weight: 550;
  color: var(--text-1);
}

.wev.done .wtt {
  color: var(--text-3);
  text-decoration: line-through;
}

.wev.done .wt {
  opacity: 0.7;
}

.wev.pool .wtt {
  color: var(--text-3);
  font-weight: 500;
}

.wempty {
  padding: 6px 0 2px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  text-align: center;
}
</style>
