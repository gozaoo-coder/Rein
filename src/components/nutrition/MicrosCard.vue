<script setup lang="ts">
import { computed } from 'vue'

import { MICROS } from '@/config/dri'
import { useNutritionStore } from '@/stores/nutrition'

/** 微量元素全览：逐项对照 DRI，附作用与来源说明；上限类（≤）语义为「不要超过」。 */
const n = useNutritionStore()

const cells = computed(() => {
  const intake = n.summary?.intake
  return MICROS.map((def) => {
    const current = intake?.[def.key] ?? 0
    return {
      ...def,
      value: Math.round(current * 10) / 10,
      pct: def.dri <= 0 ? 0 : Math.min((current / def.dri) * 100, 100),
      over: def.isLimit === true && current > def.dri,
    }
  })
})
</script>

<template>
  <section class="card">
    <header class="head">
      <h2>微量元素</h2>
      <p class="t-3">对照膳食参考摄入量 · 上限项标 ≤</p>
    </header>

    <ul class="list">
      <li v-for="c in cells" :key="c.key" class="item" :class="{ over: c.over }">
        <div class="row between top">
          <span class="name">{{ c.label }}<em v-if="c.isLimit"> ≤</em></span>
          <span class="num val">
            {{ c.value }}<em> / {{ c.dri }}{{ c.unit }}</em>
          </span>
        </div>
        <div class="bar">
          <i :style="{ '--p': `${c.pct}%`, background: `var(${c.over ? '--danger' : '--accent'})` }" />
        </div>
        <p class="desc">{{ c.desc }}</p>
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
  margin-bottom: 6px;
}

.item.over .val {
  color: var(--danger);
}

.name {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.name em {
  font-style: normal;
  color: var(--text-3);
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

.bar {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.bar i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.desc {
  margin-top: 5px;
  font-size: var(--fs-footnote);
  line-height: 1.6;
  color: var(--text-2);
}
</style>
