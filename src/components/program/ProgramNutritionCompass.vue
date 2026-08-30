<script setup lang="ts">
import { computed } from 'vue'

import type { ProgramMeal } from '@/types'

/**
 * 营养结构罗盘：聚焦日的宏量供能占比（三色环）+ 餐次分布 + 蛋白目标对照。
 *
 * 菜单不再只是一列文字——ProgramMeal.protein/carb/fat 一直都有，这里把它们
 * 画出来，让「这天吃得均不均衡」一眼可判。数值来自模板实算或 AI 菜单实算，
 * 两条路径字段一致。
 */
const props = defineProps<{
  meals: ProgramMeal[]
  /** 方案的每日蛋白目标（g），对照刻度用 */
  targetProtein: number
  /** 训练日 / 休息日（影响结论文案） */
  trainingDay: boolean
}>()

const totals = computed(() => {
  const sum = (k: 'kcal' | 'protein' | 'carb' | 'fat') => props.meals.reduce((s, m) => s + m[k], 0)
  const kcal = sum('kcal')
  const protein = sum('protein')
  const carb = sum('carb')
  const fat = sum('fat')
  const pE = protein * 4
  const cE = carb * 4
  const fE = fat * 9
  const eSum = pE + cE + fE
  return {
    kcal,
    protein,
    carb,
    fat,
    share: {
      p: eSum > 0 ? Math.round((pE / eSum) * 100) : 0,
      c: eSum > 0 ? Math.round((cE / eSum) * 100) : 0,
      f: eSum > 0 ? Math.round((fE / eSum) * 100) : 0,
    },
  }
})

/* ---------------- 三色环（dasharray 拼接，间隙留给描边） ---------------- */

const R = 40
const CIRC = 2 * Math.PI * R

/** 餐次堆叠条配色（与设计稿一致：绿/橙/青/黄循环） */
const MEAL_COLORS = ['var(--c-protein)', 'var(--c-carb)', 'var(--c-balance)', 'var(--c-fat)']

const ringSegments = computed(() => {
  const s = totals.value.share
  const defs = [
    { key: 'p', color: 'var(--c-protein)', v: s.p },
    { key: 'c', color: 'var(--c-carb)', v: s.c },
    { key: 'f', color: 'var(--c-fat)', v: s.f },
  ]
  let acc = 0
  return defs.map((d) => {
    const len = (d.v / 100) * CIRC
    const seg = { ...d, len, offset: -acc }
    acc += len
    return seg
  })
})

/* ---------------- 蛋白目标对照刻度 ---------------- */

/** 目标区间 = 目标 ±10%；刻度右端 = 区间上界 × 1.25，点超出即顶格 */
const proteinScale = computed(() => {
  const target = props.targetProtein
  if (target <= 0) return null
  const lo = Math.round(target * 0.9)
  const hi = Math.round(target * 1.1)
  const max = hi * 1.25
  const pos = Math.min(totals.value.protein / max, 1)
  const loPct = (lo / max) * 100
  const hiPct = (hi / max) * 100
  return { lo, hi, pos, loPct, hiPct, inRange: totals.value.protein >= lo && totals.value.protein <= hi }
})

/* ---------------- 结论一句话 ---------------- */

const verdict = computed(() => {
  const s = totals.value.share
  if (totals.value.kcal <= 0) return ''
  const pText =
    s.p >= 25 && s.p <= 40
      ? `蛋白供能 ${s.p}%，处于${props.trainingDay ? '训练日' : '休息日'}的推荐区间`
      : s.p < 25
        ? `蛋白供能只占 ${s.p}%，偏低——优先补足蛋白质再谈其他`
        : `蛋白供能 ${s.p}% 偏高，碳水不足会影响训练表现`
  const cText = props.trainingDay
    ? '碳水集中在练前练后两餐，与训练时间匹配。'
    : '休息日碳水自然回落，属正常安排。'
  return `${pText}；${cText}`
})
</script>

<template>
  <section class="pod">
    <header class="pod-head">
      <b>营养结构</b>
      <span class="pill num">{{ Math.round(totals.kcal) }} 大卡</span>
    </header>

    <div class="compass">
      <svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label="三大营养素供能占比">
        <circle cx="52" cy="52" :r="R" fill="none" stroke="var(--surface-2)" stroke-width="15" />
        <circle
          v-for="seg in ringSegments"
          :key="seg.key"
          cx="52"
          cy="52"
          :r="R"
          fill="none"
          :stroke="seg.color"
          stroke-width="15"
          :stroke-dasharray="`${seg.len} ${CIRC - seg.len}`"
          :stroke-dashoffset="seg.offset"
          transform="rotate(-90 52 52)"
        />
        <text x="52" y="50" text-anchor="middle" font-size="19" font-weight="600" fill="var(--text-1)" class="num">
          {{ Math.round(totals.kcal) }}
        </text>
        <text x="52" y="66" text-anchor="middle" font-size="10" fill="var(--text-3)">大卡</text>
      </svg>

      <div class="macros">
        <div v-for="seg in ringSegments" :key="`l${seg.key}`" class="macro-row">
          <span class="macro-name">
            <i class="dot" :style="{ background: seg.color }" />
            {{ seg.key === 'p' ? '蛋白质' : seg.key === 'c' ? '碳水' : '脂肪' }}
          </span>
          <span class="num macro-val">
            <b>{{ seg.key === 'p' ? totals.protein : seg.key === 'c' ? totals.carb : totals.fat }}g</b>
            · {{ seg.v }}%
          </span>
        </div>
      </div>
    </div>

    <!-- 蛋白目标对照 -->
    <div v-if="proteinScale" class="ptarget">
      <div class="ptarget-head">
        <span>蛋白目标区间</span>
        <span class="num">{{ proteinScale.lo }}–{{ proteinScale.hi }}g</span>
      </div>
      <div class="ptarget-track">
        <i class="range" :style="{ left: `${proteinScale.loPct}%`, width: `${proteinScale.hiPct - proteinScale.loPct}%` }" />
        <i class="marker" :class="{ off: !proteinScale.inRange }" :style="{ left: `calc(${proteinScale.pos * 100}% - 4.5px)` }" />
      </div>
    </div>

    <div class="split" />

    <!-- 按餐次分布 -->
    <p class="sub-label">按餐次分布 · {{ meals.length }} 餐</p>
    <div v-if="meals.length" class="stack">
      <i
        v-for="(m, i) in meals"
        :key="m.slot"
        :style="{ flex: Math.max(m.kcal, 1), background: MEAL_COLORS[i % MEAL_COLORS.length] }"
        :title="`${m.slot} ${Math.round(m.kcal)} 大卡`"
      />
    </div>
    <ul class="meal-rows">
      <li v-for="m in meals" :key="`r${m.slot}`">
        <span class="lbl">{{ m.slot }} · {{ m.name }}</span>
        <span class="val num"><b>{{ Math.round(m.kcal) }}</b> 大卡 · 蛋白 {{ Math.round(m.protein) }}g</span>
      </li>
    </ul>

    <p v-if="verdict" class="verdict">{{ verdict }}</p>
  </section>
</template>

<style scoped>
.pod {
  padding: 15px 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
}

.pod-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pod-head b {
  font-size: var(--fs-headline);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.pill {
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.compass {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.macros {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 9px;
}

.macro-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.macro-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.macro-val b {
  color: var(--text-1);
  font-weight: 600;
}

/* 蛋白对照刻度 */
.ptarget {
  margin-top: 14px;
}

.ptarget-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.ptarget-track {
  position: relative;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.ptarget-track .range {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--ok-soft);
}

.ptarget-track .marker {
  position: absolute;
  top: -0.5px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ok);
}

.ptarget-track .marker.off {
  background: var(--warn);
}

.split {
  height: 0.5px;
  margin: 14px 0 11px;
  background: var(--line);
}

/* 餐次分布 */
.sub-label {
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-bottom: 7px;
}

.stack {
  display: flex;
  height: 26px;
  border-radius: 7px;
  overflow: hidden;
  gap: 2px;
}

.stack i {
  display: block;
  height: 100%;
  opacity: 0.85;
}

.meal-rows {
  margin-top: 4px;
}

.meal-rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 0;
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-caption);
}

.meal-rows li:first-child {
  border-top: none;
}

.lbl {
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.val {
  color: var(--text-2);
  white-space: nowrap;
}

.val b {
  color: var(--text-1);
  font-weight: 600;
}

.verdict {
  margin-top: 11px;
  padding: 11px 13px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.55;
}
</style>
