<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { useTodoStore } from '@/stores/todo'
import { WEEKDAY_LABELS, todayStr, weekDates } from '@/utils/date'

/** 周视图：todolist 自动汇总的本周完成度（竖向进度条）。 */
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

const ratioOf = (date: string): number => {
  const s = store.statsByDate[date]
  if (!s || s.total === 0) return 0
  return s.done / s.total
}

const countOf = computed(
  () => (date: string) => store.statsByDate[date] ?? { total: 0, done: 0 },
)
</script>

<template>
  <ul class="week row">
    <li v-for="(d, i) in dates" :key="d">
      <button
        type="button"
        class="wcell col center"
        :class="{ today: d === today, selected: d === props.selected }"
        @click="emit('select', d)"
      >
        <span class="label">周{{ WEEKDAY_LABELS[i] }}</span>
        <span class="track">
          <i class="fill" :style="{ '--p': `${ratioOf(d) * 100}%` }" :class="{ full: ratioOf(d) >= 1 }" />
        </span>
        <span class="num count">{{ countOf(d).done }}/{{ countOf(d).total }}</span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.week {
  justify-content: space-between;
  gap: 4px;
}

.week li {
  flex: 1;
  display: flex;
}

/* 列是真按钮：键盘可达，按压反馈走全局 :active */
.wcell {
  width: 100%;
  gap: 7px;
  padding: 10px 0 8px;
  border-radius: var(--radius-m);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.wcell.selected {
  background: var(--accent-soft);
}

.label {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: 600;
}

.track {
  position: relative;
  width: 14px;
  height: 46px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

/* 自底部生长走 clip-path：不触发 layout */
.fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--accent);
  clip-path: inset(calc(100% - var(--p, 0%)) 0 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.fill.full {
  background: var(--ok);
}

.count {
  font-size: var(--fs-micro);
  color: var(--text-2);
}

.wcell.today .label {
  color: var(--accent);
}
</style>
