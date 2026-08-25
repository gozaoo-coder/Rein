<script setup lang="ts">
import type { MacroStat } from '@/stores/nutrition'

/** 宏量营养素进度条组（蛋白质 / 碳水 / 脂肪 / 钠）。 */
const props = defineProps<{ macros: MacroStat[] }>()

const pctOf = (m: MacroStat): number => (m.target <= 0 ? 0 : Math.min((m.current / m.target) * 100, 100))
</script>

<template>
  <ul class="macros">
    <li v-for="m in props.macros" :key="m.key">
      <div class="row between labels">
        <span class="name row center">
          <i class="dot" :style="{ background: `var(${m.colorVar})` }" />
          {{ m.label }}
        </span>
        <span class="num val">
          {{ Math.round(m.current) }}<em> / {{ Math.round(m.target) }} {{ m.unit }}</em>
        </span>
      </div>
      <div class="bar">
        <div
          class="fill"
          :class="{ over: m.isLimit && m.current > m.target }"
          :style="{ width: `${pctOf(m)}%`, background: `var(${m.colorVar})` }"
        />
      </div>
    </li>
  </ul>
</template>

<style scoped>
.macros {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 18px;
}

.labels {
  margin-bottom: 5px;
}

.name {
  gap: 6px;
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.val {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.val em {
  font-style: normal;
  font-weight: 400;
  color: var(--text-3);
  font-size: var(--fs-caption);
}

.bar {
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: inherit;
  transition: width 600ms var(--ease-sheet);
}

/* 上限类营养超标：变红警示 */
.fill.over {
  background: var(--danger) !important;
}
</style>
