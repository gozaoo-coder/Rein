<script setup lang="ts">
import { computed } from 'vue'

import { MACRO_GUIDES } from '@/config/dri'
import { macroStatsFrom, useNutritionStore } from '@/stores/nutrition'
import type { DailySummary } from '@/types'

/** 宏量营养素详解：当日进度数值 + 作用与来源说明。
 *  默认读 nutrition store 的「今天」；传了 `summary` 就按那一份渲染（饮食历史回看某一天），
 *  与「摄入总览 / 微量元素」用的是同一份汇总。 */
const props = defineProps<{
  /** 指定日期的汇总；不传则用 store 的「今天」 */
  summary?: DailySummary | null
}>()

const n = useNutritionStore()

/** 区分「没传」与「传了 null」：前者回落 store，后者是「这天还没拿到数据」 */
const data = computed(() => (props.summary === undefined ? n.summary : props.summary))

const rows = computed(() =>
  MACRO_GUIDES.map((g) => {
    const m = macroStatsFrom(data.value).find((x) => x.key === g.key)
    return {
      ...g,
      current: Math.round(m?.current ?? 0),
      target: Math.round(m?.target ?? 0),
      unit: m?.unit ?? 'g',
    }
  }),
)
</script>

<template>
  <section class="card">
    <header class="head">
      <h2>宏量营养素</h2>
      <p class="t-3">作用 · 来源 · 当日进度</p>
    </header>

    <ul class="list">
      <li v-for="r in rows" :key="r.key" class="item">
        <div class="row between top">
          <span class="name row center">
            <i class="dot" :style="{ background: `var(${r.colorVar})` }" />
            {{ r.label }}
          </span>
          <span class="num val">
            {{ r.current }}<em> / {{ r.target }} {{ r.unit }}</em>
          </span>
        </div>
        <p class="desc">{{ r.desc }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.head p {
  font-size: var(--fs-caption);
  margin-top: 1px;
}

.list {
  margin-top: 6px;
}

.item {
  padding: 12px 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.top {
  margin-bottom: 4px;
}

.name {
  gap: 7px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
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
  margin-left: 2px;
}

.desc {
  font-size: var(--fs-footnote);
  line-height: 1.6;
  color: var(--text-2);
}
</style>
