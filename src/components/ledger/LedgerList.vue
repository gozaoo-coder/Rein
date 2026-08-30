<script setup lang="ts">
import { computed } from 'vue'

import { categoryOf, fmtCents } from '@/config/ledger'
import { fmtDateCn } from '@/utils/date'
import type { LedgerEntry } from '@/types'

/** 流水列表：按日期分组，点击行进入编辑。 */
const props = defineProps<{
  entries: LedgerEntry[]
}>()

const emit = defineEmits<{ edit: [entry: LedgerEntry] }>()

interface DayGroup {
  date: string
  entries: LedgerEntry[]
  expenseCents: number
  incomeCents: number
}

const groups = computed<DayGroup[]>(() => {
  const map = new Map<string, LedgerEntry[]>()
  for (const e of props.entries) {
    const list = map.get(e.date) ?? []
    list.push(e)
    map.set(e.date, list)
  }
  return [...map.entries()].map(([date, list]) => ({
    date,
    entries: list,
    expenseCents: list.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amountCents, 0),
    incomeCents: list.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amountCents, 0),
  }))
})
</script>

<template>
  <ul class="list">
    <li v-for="g in groups" :key="g.date" class="day">
      <header class="dhead">
        <span class="num">{{ fmtDateCn(g.date) }}</span>
        <span class="num dmeta">
          <template v-if="g.expenseCents > 0">支出 ¥{{ fmtCents(g.expenseCents) }}</template>
          <template v-if="g.incomeCents > 0"> · 收入 ¥{{ fmtCents(g.incomeCents) }}</template>
        </span>
      </header>
      <ul class="items">
        <li v-for="e in g.entries" :key="e.id">
          <button
            class="row item"
            :aria-label="`编辑：${categoryOf(e.category)?.label ?? e.category} ${fmtCents(e.amountCents)}`"
            @click="emit('edit', e)"
          >
            <i class="ic center" :style="{ background: categoryOf(e.category)?.colorVar ?? 'var(--led-other)' }" />
            <div class="flex-1 meta">
              <span class="lbl">{{ categoryOf(e.category)?.label ?? e.category }}</span>
              <span v-if="e.note" class="note t-3">{{ e.note }}</span>
            </div>
            <b class="num amt" :class="e.kind">
              {{ e.kind === 'expense' ? '−' : '+' }}¥{{ fmtCents(e.amountCents) }}
            </b>
          </button>
        </li>
      </ul>
    </li>
  </ul>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dhead {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0 4px 6px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.dmeta {
  font-weight: 500;
  color: var(--text-3);
  font-size: var(--fs-caption);
}

.items {
  display: flex;
  flex-direction: column;
}

.items > li + li {
  border-top: 0.5px solid var(--line);
}

.item {
  width: 100%;
  gap: 10px;
  padding: 10px 6px;
  text-align: left;
}

.ic {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 50%;
}

.meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.lbl {
  font-size: var(--fs-callout);
  font-weight: 500;
  color: var(--text-1);
}

.note {
  font-size: var(--fs-footnote);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.amt {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

.amt.income {
  color: var(--led-income);
}
</style>
