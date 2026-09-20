<script setup lang="ts">
import { computed } from 'vue'

import type { ScheduleEntry } from '@/types'
import { monthGrid, parseDate, todayStr } from '@/utils/date'

/**
 * 月视图 · 整月概览。每格最多画两条课程色条，其余折成「+N」。
 * 点某天会切到日视图并定位过去（由父组件接管）。
 */
const props = defineProps<{
  entries: ScheduleEntry[]
  /** 该月内任意一天 */
  anchor: string
}>()

const emit = defineEmits<{ select: [date: string] }>()

const today = todayStr()

const cells = computed(() => {
  const d = parseDate(props.anchor)
  return monthGrid(d.getFullYear(), d.getMonth() + 1)
})

const byDate = computed(() => {
  const map = new Map<string, ScheduleEntry[]>()
  for (const e of props.entries) {
    const list = map.get(e.date)
    if (list) list.push(e)
    else map.set(e.date, [e])
  }
  return map
})

function entriesOn(date: string | null): ScheduleEntry[] {
  return date ? (byDate.value.get(date) ?? []) : []
}

function colorOf(e: ScheduleEntry): string {
  return e.session.color ?? 'var(--cat-class)'
}

const monthLabel = computed(() => {
  const d = parseDate(props.anchor)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
})

/** 本月上课天数与总课时，给出一句概览 */
const stats = computed(() => {
  const days = new Set<string>()
  let count = 0
  for (const [date, list] of byDate.value) {
    if (date.slice(0, 7) !== props.anchor.slice(0, 7)) continue
    days.add(date)
    count += list.length
  }
  return { days: days.size, count }
})
</script>

<template>
  <div class="month">
    <p class="sum">
      {{ monthLabel }} · 上课 {{ stats.days }} 天 / {{ stats.count }} 节
    </p>

    <div class="head">
      <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w">{{ w }}</span>
    </div>

    <div class="grid">
      <button
        v-for="(c, i) in cells"
        :key="i"
        class="cell"
        :class="{ blank: !c.date, today: c.date === today }"
        :disabled="!c.date"
        @click="c.date && emit('select', c.date)"
      >
        <template v-if="c.date">
          <span class="d">{{ c.day }}</span>
          <span class="chips">
            <span
              v-for="e in entriesOn(c.date).slice(0, 2)"
              :key="e.session.id"
              class="chip"
              :style="{ '--blk': colorOf(e) }"
            >
              {{ e.session.courseName }}
            </span>
            <span v-if="entriesOn(c.date).length > 2" class="more">
              +{{ entriesOn(c.date).length - 2 }}
            </span>
          </span>
        </template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.month {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sum {
  font-size: var(--fs-caption);
  color: var(--text-2);
  padding: 0 2px;
}

.head {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  padding: 0 1px;
}

.head span {
  text-align: center;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
}

.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.cell {
  min-height: 68px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 4px;
  border-radius: var(--radius-s);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  overflow: hidden;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.cell:active {
  transform: scale(0.96);
}

.cell.blank {
  background: transparent;
  box-shadow: none;
}

.cell.today {
  outline: 1.5px solid var(--accent);
}

.d {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.cell.today .d {
  color: var(--accent);
  font-weight: 700;
}

.chips {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.chip {
  font-size: 9px;
  line-height: 1.3;
  padding: 1px 3px;
  border-radius: 4px;
  border-left: 2px solid var(--blk);
  background: color-mix(in srgb, var(--blk) 16%, transparent);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more {
  font-size: 9px;
  color: var(--text-3);
  font-weight: 600;
  padding-left: 3px;
}
</style>
