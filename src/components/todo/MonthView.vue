<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

import { useTodoStore } from '@/stores/todo'
import { fmtMonthTitle, monthGrid, todayStr } from '@/utils/date'

/** 月视图：todolist 完成度日历。格子下方进度条 = 当日完成比例。 */
const props = defineProps<{
  selected?: string
}>()

const emit = defineEmits<{ select: [date: string] }>()

const store = useTodoStore()
const today = todayStr()

const now = new Date()
const year = ref(now.getFullYear())
const month = ref(now.getMonth() + 1)

const cells = computed(() => monthGrid(year.value, month.value))
const title = computed(() => fmtMonthTitle(year.value, month.value))

function shift(n: number): void {
  const d = new Date(year.value, month.value - 1 + n, 1)
  year.value = d.getFullYear()
  month.value = d.getMonth() + 1
}

async function load(): Promise<void> {
  const lastDay = new Date(year.value, month.value, 0).getDate()
  const pad = (x: number) => String(x).padStart(2, '0')
  await store.loadStats(`${year.value}-${pad(month.value)}-01`, `${year.value}-${pad(month.value)}-${pad(lastDay)}`)
}

onMounted(load)
watch([year, month], load)

const ratioOf = (date: string): number => {
  const s = store.statsByDate[date]
  if (!s || s.total === 0) return 0
  return s.done / s.total
}
</script>

<template>
  <div>
    <header class="row between head">
      <button class="nav" aria-label="上一月" @click="shift(-1)"><ChevronLeft :size="18" /></button>
      <b class="title">{{ title }}</b>
      <button class="nav" aria-label="下一月" @click="shift(1)"><ChevronRight :size="18" /></button>
    </header>

    <ul class="grid">
      <li
        v-for="(c, i) in cells"
        :key="i"
        class="cell col center"
        :class="{
          empty: !c.date,
          today: c.date === today,
          selected: c.date && c.date === props.selected,
        }"
        @click="c.date && emit('select', c.date)"
      >
        <span v-if="c.date" class="num day">{{ c.day }}</span>
        <span v-if="c.date" class="bar">
          <i :style="{ width: `${ratioOf(c.date) * 100}%` }" :class="{ full: ratioOf(c.date) >= 1 }" />
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.head {
  margin-bottom: 8px;
}

.title {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.nav {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.cell {
  aspect-ratio: 1 / 1.06;
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.cell.empty {
  cursor: default;
}

.cell.selected {
  background: var(--accent-soft);
}

.day {
  font-size: var(--fs-subhead);
  font-weight: 500;
}

.cell.today .day {
  color: var(--accent);
  font-weight: 700;
}

.bar {
  width: 16px;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
  margin-top: 4px;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-standard);
}

.bar i.full {
  background: var(--ok);
}
</style>
