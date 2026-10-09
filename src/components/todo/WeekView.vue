<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { useTodoStore } from '@/stores/todo'
import { WEEKDAY_LABELS, todayStr, weekDates } from '@/utils/date'

/**
 * 周视图（完成度速览）：横轴七日一排，每天只留「星期 · 日号 · 完成数 · 进度条」，
 * 不再罗列事件标题——标题是画布（/todos）的事，这格要回答的是「哪天欠着账」。
 * 一屏尽收七列，点列进入该日画布；顶部一行给出本周合计。
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
}

const columns = computed<DayColumn[]>(() =>
  dates.map((date, i) => {
    const day = store.allTodos.filter((t) => t.date === date)
    return {
      date,
      label: WEEKDAY_LABELS[i] ?? '',
      dayNum: Number(date.slice(8, 10)),
      isToday: date === today,
      isSelected: date === props.selected,
      total: day.length,
      done: day.filter((t) => t.status === 'done').length,
    }
  }),
)

const weekDone = computed(() => columns.value.reduce((s, c) => s + c.done, 0))
const weekTotal = computed(() => columns.value.reduce((s, c) => s + c.total, 0))
const weekPct = computed(() => (weekTotal.value ? Math.round((weekDone.value / weekTotal.value) * 100) : 0))

function onKey(e: KeyboardEvent, date: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('select', date)
  }
}
</script>

<template>
  <div class="week" data-rubber-self>
    <p class="wsum num">
      本周 <b>{{ weekDone }}</b><span class="dim">/{{ weekTotal }}</span>
      <span class="pct" :class="{ full: weekTotal > 0 && weekDone >= weekTotal }">· 完成 {{ weekPct }}%</span>
    </p>
    <div class="strip">
      <div
        v-for="c in columns"
        :key="c.date"
        class="wcell"
        :class="{ today: c.isToday, selected: c.isSelected }"
        role="button"
        tabindex="0"
        :aria-label="`查看 ${c.date} 的画布，完成 ${c.done}/${c.total}`"
        @click="emit('select', c.date)"
        @keydown="onKey($event, c.date)"
      >
        <header class="wd-head">
          <span class="wd-label" :class="{ today: c.isToday }">{{ c.label }}</span>
          <span class="num wd-date">{{ c.dayNum }}</span>
        </header>
        <span class="num wd-count" :class="{ full: c.total > 0 && c.done >= c.total }">
          {{ c.total ? `${c.done}/${c.total}` : '–' }}
        </span>
        <div class="wd-bar">
          <i class="wd-fill" :class="{ full: c.total > 0 && c.done >= c.total }" :style="{ '--p': c.total ? c.done / c.total : 0 }" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 本周合计：完成度卡的小结行，数字加重、百分位随时可读 */
.wsum {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.wsum b {
  font-weight: 800;
  color: var(--text-1);
}

.wsum .dim {
  color: var(--text-3);
}

.wsum .pct {
  margin-left: 2px;
  color: var(--text-3);
}

.wsum .pct.full {
  color: var(--ok-strong);
  font-weight: 700;
}

/* 七列一排：flex 均分（窄屏一列也有 ~40px，放得下「周一」「0/2」） */
.strip {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}

.wcell {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 8px 2px 7px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    box-shadow var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .wcell:hover {
    box-shadow: var(--shadow-card);
  }
}

.wcell.selected {
  background: var(--accent-soft);
}

/* 星期收成单字 + 日号：手机标定宽度（~393px 视口）下七列一排每列只有 ~40px，
   「周一 28」这种双字标签放不下、CJK 会在字间折行（实测踩过）；单字 + nowrap 才稳 */
.wd-head {
  display: flex;
  align-items: baseline;
  gap: 3px;
  white-space: nowrap;
}

.wd-label {
  font-size: var(--fs-micro);
  font-weight: 600;
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
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.wd-count.full {
  color: var(--ok-strong);
}

/* 进度条占满列宽：完成度是这格的主语，条比数字更先被读到 */
.wd-bar {
  align-self: stretch;
  height: 3px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  overflow: hidden;
}

.wd-fill {
  display: block;
  height: 100%;
  width: 100%;
  transform: scaleX(var(--p, 0));
  transform-origin: left center;
  border-radius: inherit;
  background: var(--accent);
  transition: transform var(--dur-base) var(--ease-standard);
}

.wd-fill.full {
  background: var(--ok);
}
</style>
