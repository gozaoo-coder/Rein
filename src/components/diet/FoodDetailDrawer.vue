<script setup lang="ts">
import { computed } from 'vue'
import { Plus } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { MICROS } from '@/config/dri'
import type { Food } from '@/types'

/** 食品详情抽屉：每 100g 全营养表 + 宏量供能占比 + 份量换算 + 微量对照 DRI；「记录」交由父层打开 FoodPickerSheet。 */
const props = defineProps<{
  open: boolean
  food: Food | null
}>()

const emit = defineEmits<{
  close: []
  record: []
}>()

/* 宏量供能占比（蛋白/碳水 4 kcal、脂肪 9 kcal） */
const share = computed(() => {
  const f = props.food
  if (!f) return []
  const parts = [
    { label: '蛋白质', grams: f.protein, colorVar: '--c-protein' },
    { label: '碳水', grams: f.carb, colorVar: '--c-carb' },
    { label: '脂肪', grams: f.fat, colorVar: '--c-fat' },
  ]
  const total = parts.reduce((s, x) => s + x.grams * (x.label === '脂肪' ? 9 : 4), 0)
  if (total <= 0) return []
  return parts
    .map((x) => ({ ...x, pct: ((x.grams * (x.label === '脂肪' ? 9 : 4)) / total) * 100 }))
    .filter((x) => x.pct > 0.5)
})

/** 微量营养素：每 100g 含量 + 占每日推荐（或上限）摄入的百分比 */
const microRows = computed(() => {
  const f = props.food
  if (!f) return []
  return MICROS.map((m) => {
    const value = Number(f[m.key]) || 0
    return { ...m, value, pct: m.dri > 0 ? Math.round((value / m.dri) * 100) : 0 }
  }).filter((r) => r.value > 0)
})

function fmt(n: number): string {
  if (!n) return '0'
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
}
</script>

<template>
  <SheetModal :open="open" :title="food?.name ?? '食品详情'" @close="emit('close')">
    <template v-if="food">
      <!-- 热量 + 宏量 -->
      <section class="card hero">
      <div class="row between top">
        <div>
          <p class="kcal num"><b>{{ fmt(food.kcal) }}</b><em> 大卡</em></p>
          <p class="per t-3">/ 100 g</p>
        </div>
        <ul class="macros row">
          <li v-for="m in share" :key="m.label">
            <i class="dot" :style="{ background: `var(${m.colorVar})` }" />
            <span class="ml">{{ m.label }}</span>
            <b class="num">{{ fmt(m.grams) }}g</b>
          </li>
        </ul>
      </div>

      <!-- 供能占比堆叠条 -->
      <div v-if="share.length" class="share" :style="{ '--n': share.length }">
        <span
          v-for="m in share"
          :key="m.label"
          :style="{ flex: m.pct, background: `var(${m.colorVar})` }"
        />
      </div>
      <p v-if="share.length" class="share-label num t-3">
        <template v-for="(m, i) in share" :key="m.label">
          {{ i > 0 ? ' · ' : '' }}{{ m.label }} {{ Math.round(m.pct) }}%
        </template>
        <span class="src">供能占比</span>
      </p>
    </section>

    <!-- 份量换算 -->
    <section v-if="food.units.length" class="card">
      <header class="head"><h2>份量换算</h2></header>
      <ul class="units">
        <li v-for="u in food.units" :key="u.name" class="row between urow">
          <span>1 {{ u.name }}</span>
          <span class="num t-3">≈ {{ u.grams }}g</span>
          <b class="num">≈ {{ Math.round((food.kcal * u.grams) / 100) }} 大卡</b>
        </li>
      </ul>
    </section>

    <!-- 微量营养素 · 对照每日推荐摄入 -->
    <section v-if="microRows.length" class="card">
      <header class="head"><h2>微量营养素</h2></header>
      <ul class="micros">
        <li v-for="m in microRows" :key="m.key">
          <div class="row between mrow">
            <span class="mlabel">
              {{ m.label }}<em v-if="m.isLimit" class="lim">上限</em>
            </span>
            <span class="num mval">{{ fmt(m.value) }} {{ m.unit }}</span>
          </div>
          <div class="bar">
            <div class="fill" :class="{ limit: m.isLimit }" :style="{ width: `${Math.min(m.pct, 100)}%` }" />
          </div>
          <p class="num mpct t-3">每 100g 约占每日{{ m.isLimit ? '建议上限' : '推荐摄入' }}的 {{ m.pct }}%</p>
        </li>
      </ul>
      <p class="note t-3">百分比以《中国居民膳食营养素参考摄入量》成人数值为基准。</p>
    </section>

    <!-- 记录：交给父层打开 FoodPickerSheet（同页单一弹层）；悬浮吸附在抽屉底部，内容从下方滚过 -->
    <div class="record-dock">
      <button class="record row center" @click="emit('record')">
        <Plus :size="18" /> 记录这一食物
      </button>
    </div>
    </template>
    <p v-else class="missing">食物不存在或已下架</p>
  </SheetModal>
</template>

<style scoped>
.missing {
  text-align: center;
  padding: 40px 0;
  font-size: var(--fs-subhead);
  color: var(--text-3);
}

.card {
  margin-top: 12px;
  padding: 16px;
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.card:first-child {
  margin-top: 4px;
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.hero .top {
  align-items: flex-start;
}

.kcal b {
  font-size: 40px;
  font-weight: 800;
  letter-spacing: -1px;
}

.kcal em {
  font-style: normal;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
}

.per {
  margin-top: -2px;
  font-size: var(--fs-footnote);
}

.macros {
  gap: 14px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.macros li {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-caption);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.ml {
  color: var(--text-2);
}

.macros b {
  font-weight: 700;
}

.share {
  display: flex;
  gap: 3px;
  height: 10px;
  margin-top: 16px;
  border-radius: var(--radius-full);
  overflow: hidden;
}

.share span:first-child {
  border-radius: var(--radius-full) 0 0 var(--radius-full);
}

.share span:last-child {
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
}

.share-label {
  margin-top: 7px;
  font-size: var(--fs-caption);
}

.share-label .src {
  float: right;
}

.units {
  margin-top: 6px;
}

.urow {
  padding: 12px 0;
}

.urow + .urow {
  border-top: 0.5px solid var(--line);
}

.micros {
  margin-top: 6px;
}

.micros li + li {
  margin-top: 15px;
}

.mrow {
  margin-bottom: 6px;
}

.mlabel {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.lim {
  font-style: normal;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: rgba(255, 59, 48, 0.12);
  color: var(--c-sodium);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.mval {
  font-weight: 600;
}

.bar {
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--surface);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
}

.fill.limit {
  background: var(--c-sodium);
}

.mpct {
  margin-top: 4px;
  font-size: var(--fs-micro);
}

.note {
  margin-top: 14px;
  font-size: var(--fs-micro);
}

/* 悬浮记录按钮：sticky 吸附在抽屉底部；负 margin 抵消 .body 的内边距贴到边缘，
   渐变遮罩保证内容滚过时按钮可读；遮罩区不拦截触摸（pointer-events），滚动手势可穿透 */
.record-dock {
  position: sticky;
  bottom: 0;
  z-index: 1;
  margin: 16px -18px calc(-20px - var(--safe-bottom));
  padding: 12px 18px calc(16px + var(--safe-bottom));
  background: linear-gradient(to top, var(--surface) 55%, transparent);
  pointer-events: none;
}

.record {
  width: 100%;
  gap: 7px;
  height: 52px;
  border-radius: 26px;
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: 700;
  box-shadow: 0 8px 20px rgba(29, 29, 31, 0.22);
  pointer-events: auto;
}
</style>
