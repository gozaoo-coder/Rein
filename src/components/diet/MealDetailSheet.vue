<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Trash2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { MICROS } from '@/config/dri'
import { MEAL_LABELS, fmtGrams, mealKcal, mealQtyText } from '@/config/domain'
import type { DailyTargets, MealLog, NutrientIntake } from '@/types'

/** 单笔饮食记录详情：按记录克重把「每 100g」营养折成实际摄入量，
 *  宏量对照当日目标、微量对照 DRI；删除交回父层二次确认。 */
const props = defineProps<{
  open: boolean
  log: MealLog | null
  /** 所选日期的每日目标；为 null 或某项为 0 时该处不画占比 */
  targets: DailyTargets | null
}>()

const emit = defineEmits<{ close: []; delete: [] }>()

/** Food 与 NutrientIntake 同名同义的字段（均为每 100g 的数值列） */
const NUTRIENT_KEYS: (keyof NutrientIntake)[] = [
  'kcal',
  'protein',
  'carb',
  'fat',
  'fiber',
  'sugar',
  'sodiumMg',
  'potassiumMg',
  'calciumMg',
  'ironMg',
  'zincMg',
  'magnesiumMg',
  'vitAUg',
  'vitCMg',
  'vitDUg',
  'vitEMg',
  'vitB12Ug',
  'folateUg',
]

/** 实际摄入量 = 每 100g 值 × 克重 ÷ 100 */
const scaled = computed(() => {
  const out = {} as Record<keyof NutrientIntake, number>
  const f = props.log?.food
  if (!f) return out
  const k = props.log!.grams / 100
  for (const key of NUTRIENT_KEYS) out[key] = (f[key] as number) * k
  return out
})

const kcal = computed(() => {
  if (!props.log) return 0
  return mealKcal(props.log) ?? Math.round(scaled.value.kcal)
})

/* 宏量供能占比：比例与克重无关，直接用每 100g 值算（与食品详情同口径） */
const share = computed(() => {
  const f = props.log?.food
  if (!f) return []
  const parts = [
    { key: 'protein' as const, label: '蛋白质', grams: f.protein, colorVar: '--c-protein' },
    { key: 'carb' as const, label: '碳水', grams: f.carb, colorVar: '--c-carb' },
    { key: 'fat' as const, label: '脂肪', grams: f.fat, colorVar: '--c-fat' },
  ]
  const total = parts.reduce((s, x) => s + x.grams * (x.key === 'fat' ? 9 : 4), 0)
  if (total <= 0) return []
  return parts
    .map((x) => ({ ...x, pct: ((x.grams * (x.key === 'fat' ? 9 : 4)) / total) * 100 }))
    .filter((x) => x.pct > 0.5)
})

/** 占本日：热量 + 三大宏量 + 钠，对照当日目标；目标未设（≤0）只给实际量 */
const dayRows = computed(() => {
  const t = props.targets
  const rows = [
    { label: '热量', unit: '大卡', actual: scaled.value.kcal, target: t?.kcal ?? 0, colorVar: '--c-intake' },
    { label: '蛋白质', unit: 'g', actual: scaled.value.protein, target: t?.protein ?? 0, colorVar: '--c-protein' },
    { label: '碳水', unit: 'g', actual: scaled.value.carb, target: t?.carb ?? 0, colorVar: '--c-carb' },
    { label: '脂肪', unit: 'g', actual: scaled.value.fat, target: t?.fat ?? 0, colorVar: '--c-fat' },
    { label: '钠', unit: 'mg', actual: scaled.value.sodiumMg, target: t?.sodiumMg ?? 0, colorVar: '--c-sodium' },
  ]
  return rows.map((r) => {
    const pct = r.target > 0 ? (r.actual / r.target) * 100 : null
    return {
      ...r,
      pct,
      fill: pct == null ? 0 : Math.min(100, pct),
      valueText: r.unit === 'g' ? fmtGrams(r.actual) : String(Math.round(r.actual)),
    }
  })
})

/** 微量营养素：按实际克重折算后对照 DRI，含量为 0 的不列 */
const microRows = computed(() =>
  MICROS.map((m) => {
    const value = scaled.value[m.key] ?? 0
    return { ...m, value, pct: m.dri > 0 ? Math.round((value / m.dri) * 100) : 0 }
  }).filter((r) => r.value > 0),
)

const timeText = computed(() => {
  const iso = props.log?.createdAt
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

/* 数据入场：抽屉展开后供能条/进度条从零生长（双 rAF 确保初始态先上屏） */
const grown = ref(false)
watch(
  () => props.open,
  (open) => {
    if (!open) {
      grown.value = false
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        grown.value = true
      })
    })
  },
)
</script>

<template>
  <SheetModal :open="open" :title="log?.food?.name ?? '记录详情'" @close="emit('close')">
    <template v-if="log?.food">
      <div class="anim" :class="{ grown }">
        <!-- 热量 + 宏量供能占比 -->
        <section class="card hero">
          <div class="row between top">
            <div>
              <p class="kcal num"><b>{{ kcal }}</b><em> 大卡</em></p>
            </div>
            <ul class="macros row">
              <li v-for="m in share" :key="m.key">
                <i class="dot" :style="{ background: `var(${m.colorVar})` }" />
                <span class="ml">{{ m.label }}</span>
                <b class="num">{{ fmtGrams(scaled[m.key]) }}g</b>
              </li>
            </ul>
          </div>
          <!-- 元信息单独占行：挤在数字旁边会被右侧宏量列表压到折行 -->
          <p class="meta t-3 num">
            {{ MEAL_LABELS[log.mealType] }}<template v-if="timeText"> · {{ timeText }}</template>
            · {{ mealQtyText(log) }}
          </p>

          <div v-if="share.length" class="share">
            <span
              v-for="(m, i) in share"
              :key="m.key"
              :style="{ flex: m.pct, background: `var(${m.colorVar})`, '--i': i }"
            />
          </div>
          <p v-if="share.length" class="share-label num t-3">
            <template v-for="(m, i) in share" :key="m.key">
              {{ i > 0 ? ' · ' : '' }}{{ m.label }} {{ Math.round(m.pct) }}%
            </template>
            <span class="src">供能占比</span>
          </p>
        </section>

        <!-- 占本日：这一笔在当日目标里的分量 -->
        <section class="card">
          <header class="head"><h2>占本日</h2><p class="t-3">这一笔计入当天目标的分量</p></header>
          <ul class="daylist">
            <li v-for="r in dayRows" :key="r.label">
              <div class="row between drow">
                <span class="dlabel">
                  <i class="dot" :style="{ background: `var(${r.colorVar})` }" />{{ r.label }}
                </span>
                <span class="dval num">
                  {{ r.valueText }}<span class="dunit">{{ r.unit }}</span>
                  <template v-if="r.target > 0">
                    <em>/ {{ Math.round(r.target) }}{{ r.unit }}</em>
                    <b class="dpct">{{ Math.round(r.pct!) }}%</b>
                  </template>
                </span>
              </div>
              <div v-if="r.target > 0" class="bar">
                <div
                  class="fill"
                  :style="{ '--p': `${r.fill}%`, background: `var(${r.colorVar})` }"
                />
              </div>
            </li>
          </ul>
        </section>

        <!-- 微量营养素 · 实际摄入量对照 DRI -->
        <section v-if="microRows.length" class="card">
          <header class="head"><h2>微量营养素</h2><p class="t-3">按这份的实际克重折算</p></header>
          <ul class="micros">
            <li v-for="m in microRows" :key="m.key">
              <div class="row between mrow">
                <span class="mlabel">
                  {{ m.label }}<em v-if="m.isLimit" class="lim">上限</em>
                </span>
                <span class="num mval">{{ fmtGrams(m.value) }} {{ m.unit }}</span>
              </div>
              <div class="bar">
                <div class="fill" :class="{ limit: m.isLimit }" :style="{ '--p': `${Math.min(m.pct, 100)}%` }" />
              </div>
              <p class="num mpct t-3">约占每日{{ m.isLimit ? '建议上限' : '推荐摄入' }}的 {{ m.pct }}%</p>
            </li>
          </ul>
          <p class="note t-3">百分比以《中国居民膳食营养素参考摄入量》成人数值为基准。</p>
        </section>
      </div>
    </template>
    <p v-else class="missing">这条记录缺少食物详情</p>

    <template v-if="log?.food" #footer>
      <button class="del" @click="emit('delete')">
        <Trash2 :size="17" /> 删除这条记录
      </button>
    </template>
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

.head p {
  font-size: var(--fs-caption);
  margin-top: 1px;
}

.hero .top {
  align-items: flex-start;
}

.kcal b {
  font-size: var(--fs-display-m);
  font-weight: 800;
  letter-spacing: -1px;
}

.kcal em {
  font-style: normal;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
}

.meta {
  margin-top: 6px;
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

/* 入场：供能段从左向右逐个展开（30ms stagger），其余条同步生长 */
.anim:not(.grown) .share span {
  transform: scaleX(0);
}

.share span {
  transform-origin: left center;
  transition: transform var(--dur-base) var(--ease-standard);
  transition-delay: calc(var(--i, 0) * 30ms);
}

.share-label {
  margin-top: 7px;
  font-size: var(--fs-caption);
}

.share-label .src {
  float: right;
}

/* 占本日 */
.daylist {
  margin-top: 4px;
}

.daylist li {
  padding: 10px 0;
}

.daylist li + li {
  border-top: 0.5px solid var(--line);
}

.drow {
  margin-bottom: 7px;
}

.dlabel {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-subhead);
  font-weight: 600;
}

/* 数字走中性色、颜色留给条：四个指标色当文字用对比度全不达标（同摄入总览的取舍） */
.dval {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.dunit {
  font-size: var(--fs-caption);
  font-weight: 400;
  color: var(--text-3);
}

.dval em {
  font-style: normal;
  font-weight: 400;
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin-left: 3px;
}

.dpct {
  margin-left: 4px;
  color: var(--text-2);
}

.bar {
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--line);
  overflow: hidden;
}

.fill {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.anim:not(.grown) .fill {
  clip-path: inset(0 100% 0 0 round var(--radius-full));
}

.fill.limit {
  background: var(--c-sodium);
}

/* 微量营养素 */
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
  background: var(--danger-soft);
  color: var(--c-sodium);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.mval {
  font-weight: 600;
}

.mpct {
  margin-top: 4px;
  font-size: var(--fs-micro);
}

.note {
  margin-top: 14px;
  font-size: var(--fs-micro);
}

/* 删除入口：抽屉固定操作区，内容从下方滚过时不被顶走 */
.del {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  height: 48px;
  border-radius: 24px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-body);
  font-weight: 700;
}
</style>
