<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
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

/* 数据入场：抽屉展开后供能条/微量条从零生长（双 rAF 确保初始态先上屏） */
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
  <SheetModal :open="open" :title="food?.name ?? '食品详情'" @close="emit('close')">
    <template v-if="food">
      <div class="anim" :class="{ grown }">
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
          v-for="(m, i) in share"
          :key="m.label"
          :style="{ flex: m.pct, background: `var(${m.colorVar})`, '--i': i }"
        />
      </div>
      <!-- 「供能占比」是行话：做行首标签，三项占比各一枚带色点胶囊（色条靠同一色点认色） -->
      <p v-if="share.length" class="share-label">
        <span class="sl-label">供能占比</span>
        <span v-for="m in share" :key="m.label" class="spill">
          <i class="dot" :style="{ background: `var(${m.colorVar})` }" />
          {{ m.label }}<b class="num">{{ Math.round(m.pct) }}%</b>
        </span>
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
      <!-- 口径上提分组头：完整说明（DRI 出处 / 上限语义）收进标题行右侧 InfoHint -->
      <header class="head">
        <h2>微量营养素</h2>
        <InfoHint
          class="hint"
          title="微量营养素：口径"
          content="每 100g 含量占《中国居民膳食营养素参考摄入量》成人每日推荐摄入的比例；标记「上限」的项目（如添加糖、钠）对照的是每日建议上限。"
        />
      </header>
      <ul class="micros">
        <li v-for="m in microRows" :key="m.key">
          <div class="row between mrow">
            <span class="mlabel">
              {{ m.label }}<em v-if="m.isLimit" class="lim">上限</em>
            </span>
            <span class="mright">
              <span class="num mval">{{ fmt(m.value) }}<em class="munit"> {{ m.unit }}</em></span>
              <b class="num mpct">{{ m.pct }}%</b>
            </span>
          </div>
          <div class="bar">
            <div class="fill" :class="{ limit: m.isLimit }" :style="{ '--p': `${Math.min(m.pct, 100)}%` }" />
          </div>
        </li>
      </ul>
    </section>

    <!-- 记录：交给父层打开 FoodPickerSheet（同页单一弹层）；悬浮吸附在抽屉底部，内容从下方滚过 -->
    <div class="record-dock">
      <button class="record row center" @click="emit('record')">
        <Plus :size="18" /> 记录这一食物
      </button>
    </div>
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

/* 卡头是 flex 行：帮助入口放标题行右端（与标题同一行居中） */
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head .hint {
  margin-left: auto;
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

/* 入场：供能段从左向右逐个展开（30ms stagger），微量条同步生长 */
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
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 「供能占比」是行话：做行首标签（比占比读数重一档） */
.sl-label {
  color: var(--text-2);
}

/* 三项占比各一枚胶囊：前导色点与堆叠条同色，认色不靠文字 */
.spill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-2);
}

.spill b {
  font-weight: 700;
  color: var(--text-1);
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

/* 实际含量 + 结论占比同一行右端：含量是详情，占比是结论 */
.mright {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
}

.mval em {
  font-style: normal;
  font-weight: 400;
  color: var(--text-3);
}

.mpct {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
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
  /* 「高钠」是健康状态词，读不出来等于没标。soft 底上的文字走 strong 档
     （--c-sodium 是 danger 实底档，压 soft 底只有 3.5:1，STANDARDS §4） */
  color: var(--danger-strong);
  font-size: var(--fs-caption);
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
  border-radius: var(--radius-xl);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: 700;
  box-shadow: var(--shadow-float);
  pointer-events: auto;
}
</style>
