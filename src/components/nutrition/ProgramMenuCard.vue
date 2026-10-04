<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Sparkles } from 'lucide-vue-next'

import { mealTypeOfSlot } from '@/config/domain'
import { useModelsStore } from '@/stores/models'
import { useProgramStore } from '@/stores/program'
import { parseBlob } from '@/utils/programEngine'
import { todayStr } from '@/utils/date'
import type { ProgramMeal } from '@/types'
import type { AiMenuMeal } from '@/ai/recipeGen'

/**
 * 方案今日菜单卡（营养页）：聚焦「今天按方案吃什么」。
 *
 * 从方案页搬来——菜单是饮食决策，归营养页；方案页只管方案本身。
 * 供能结构用横向堆叠条（不画大环），餐次列表是唯一事实源，
 * AI 菜单与模板回落共用同一渲染；AI 生成按需触发，生成一次落库稳定。
 */
const emit = defineEmits<{ log: [] }>()

const program = useProgramStore()
const models = useModelsStore()

const parsed = computed(() => {
  if (!program.active) return null
  try {
    return parseBlob(program.active)
  } catch {
    return null
  }
})

/** 今天在方案周期内的那一天；不在周期内（未开跑 / 已结束）整卡不渲染 */
const day = computed(() => parsed.value?.days.find((d) => d.date === todayStr()) ?? null)

const aiMeals = ref<AiMenuMeal[] | null>(null)
const aiLoading = ref(false)
const aiStatus = ref('')
const aiError = ref('')

/** AI 菜单优先、未生成时回落模板菜单；统一成 ProgramMeal 展示结构 */
const meals = computed<ProgramMeal[]>(() => {
  if (aiMeals.value) {
    return aiMeals.value.map((m) => ({
      mealType: mealTypeOfSlot(m.slot),
      slot: m.slot,
      name: m.name,
      items: m.items.map((it) => `${it.label} ${it.grams}g`),
      kcal: m.kcal,
      protein: m.protein,
      carb: m.carb,
      fat: m.fat,
    }))
  }
  return day.value?.meals ?? []
})

const targetProtein = computed(() => Math.round(parsed.value?.params.targets.protein ?? 0))

const totals = computed(() => {
  const sum = (k: 'kcal' | 'protein' | 'carb' | 'fat') => meals.value.reduce((s, m) => s + m[k], 0)
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

const macroBars = computed(() => [
  { key: 'p', label: '蛋白质', color: 'var(--c-protein)', v: totals.value.share.p, g: Math.round(totals.value.protein) },
  { key: 'c', label: '碳水', color: 'var(--c-carb)', v: totals.value.share.c, g: Math.round(totals.value.carb) },
  { key: 'f', label: '脂肪', color: 'var(--c-fat)', v: totals.value.share.f, g: Math.round(totals.value.fat) },
])

/** 目标区间 = 目标 ±10%；刻度右端 = 区间上界 × 1.25，点超出即顶格 */
const proteinScale = computed(() => {
  const target = targetProtein.value
  if (target <= 0) return null
  const lo = Math.round(target * 0.9)
  const hi = Math.round(target * 1.1)
  const max = hi * 1.25
  const pos = Math.min(totals.value.protein / max, 1)
  const loPct = (lo / max) * 100
  const hiPct = (hi / max) * 100
  return { lo, hi, pos, loPct, hiPct, inRange: totals.value.protein >= lo && totals.value.protein <= hi }
})

const verdict = computed(() => {
  const s = totals.value.share
  if (totals.value.kcal <= 0) return ''
  const training = !(day.value?.rest ?? true)
  const pText =
    s.p >= 25 && s.p <= 40
      ? `蛋白供能 ${s.p}%，处于${training ? '训练日' : '休息日'}的推荐区间`
      : s.p < 25
        ? `蛋白供能只占 ${s.p}%，偏低——优先补足蛋白质再谈其他`
        : `蛋白供能 ${s.p}% 偏高，碳水不足会影响训练表现`
  const cText = training
    ? '碳水集中在练前练后两餐，与训练时间匹配。'
    : '休息日碳水自然回落，属正常安排。'
  return `${pText}；${cText}`
})

/** 读取当天 AI 菜单缓存（未生成返回 null，回落模板） */
async function loadCached(): Promise<void> {
  aiMeals.value = null
  aiError.value = ''
  if (!program.active || !day.value) return
  try {
    aiMeals.value = await program.loadDayMeals(program.active, todayStr())
  } catch {
    /* 缓存读取失败按未生成处理 */
  }
}

async function regenerate(): Promise<void> {
  if (!program.active || !day.value) return
  aiLoading.value = true
  aiError.value = ''
  aiStatus.value = ''
  try {
    await models.load()
    aiMeals.value = await program.generateDayMeals(program.active, todayStr(), (s) => {
      aiStatus.value = s
    })
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiLoading.value = false
    aiStatus.value = ''
  }
}

onMounted(() => {
  void loadCached()
})

// 方案切换 / 调整重建后，当天菜单缓存可能已作废，重新读一次
watch(
  () => [program.active?.id, program.active?.version],
  () => void loadCached(),
)
</script>

<template>
  <section v-if="program.active && day" class="card menu-card" data-testid="program-menu">
    <header class="head">
      <b class="title">今日菜单</b>
      <span class="pill" :class="{ ghost: day.rest }">{{ day.rest ? '休息日' : '训练日' }}</span>
    </header>

    <!-- 供能结构：横向堆叠条 + 三行宏量 -->
    <div class="stack-head">
      <span>供能结构</span>
      <span class="num">{{ Math.round(totals.kcal) }} 大卡</span>
    </div>
    <div class="stack" role="img" aria-label="三大营养素供能占比">
      <i
        v-for="m in macroBars"
        :key="m.key"
        :style="{ flex: Math.max(m.v, 1), background: m.color }"
        :title="`${m.label} ${m.v}%`"
      />
    </div>
    <div class="macros">
      <div v-for="m in macroBars" :key="`l${m.key}`" class="macro-row">
        <span class="macro-name">
          <i class="dot" :style="{ background: m.color }" />
          {{ m.label }}
        </span>
        <span class="num macro-val"><b>{{ m.g }}g</b> · {{ m.v }}%</span>
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

    <p v-if="verdict" class="verdict">{{ verdict }}</p>

    <div class="split" />

    <!-- 餐次列表：AI 菜单与模板回落共用一行式渲染 -->
    <p v-if="!aiMeals" class="menu-fallback">模板菜单 · 配置模型后可按你的偏好生成</p>
    <p v-else class="ai-tag"><Sparkles :size="12" style="vertical-align:-1px;margin-right:3px" />AI 菜单 · 数值来自食物库实算</p>
    <ul class="menu">
      <li v-for="m in meals" :key="m.slot">
        <em>{{ m.slot }}</em>
        <div>
          <p>{{ m.name }}<b class="num"> 约{{ Math.round(m.kcal) }}大卡 · 蛋白{{ Math.round(m.protein) }}g</b></p>
          <p class="items">{{ m.items.join('、') }}</p>
        </div>
      </li>
    </ul>

    <div class="menu-acts">
      <button class="linkbtn" @click="emit('log')">＋ 记一笔</button>
      <button class="linkbtn" :disabled="aiLoading" @click="regenerate">
        <template v-if="aiLoading">正在按你的目标与偏好生成…</template>
        <template v-else>
          <Sparkles v-if="!aiMeals" :size="13" style="margin-right:3px" />
          {{ aiMeals ? '换一批' : 'AI 生成今日菜单' }}
        </template>
      </button>
      <span v-if="aiLoading && aiStatus" class="ai-status num">{{ aiStatus }}</span>
      <span v-if="aiError" class="ai-err">{{ aiError }}</span>
    </div>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.title {
  font-size: var(--fs-title3);
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
  white-space: nowrap;
}

.pill.ghost {
  background: var(--surface-2);
  color: var(--text-3);
}

/* 供能堆叠条 */
.stack-head {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.stack {
  display: flex;
  height: 10px;
  border-radius: var(--radius-full);
  overflow: hidden;
  gap: 2px;
}

.stack i {
  display: block;
  height: 100%;
  opacity: 0.9;
  min-width: 4px;
}

.macros {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.macro-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.macro-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.macro-val b {
  color: var(--text-1);
  font-weight: 600;
}

/* 蛋白对照刻度 */
.ptarget {
  margin-top: 13px;
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

.verdict {
  margin-top: 11px;
  padding: 10px 13px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.55;
}

.split {
  height: 0.5px;
  margin: 14px 0 4px;
  background: var(--line);
}

/* 来源标注 */
.menu-fallback {
  margin-top: 10px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.ai-tag {
  margin-top: 10px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* 餐次列表 */
.menu {
  margin-top: 4px;
  display: grid;
}

.menu li {
  display: grid;
  grid-template-columns: 62px 1fr;
  gap: 10px;
  padding: 9px 0;
  border-top: 0.5px solid var(--line);
}

.menu li:first-child {
  border-top: none;
}

.menu em {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
  padding-top: 1px;
}

.menu p {
  font-size: var(--fs-subhead);
}

.menu p b {
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin-left: 4px;
  font-weight: 400;
}

.items {
  margin-top: 2px;
  line-height: 1.5;
}

.menu-acts {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

.linkbtn {
  display: inline-flex;
  align-items: center;
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.linkbtn:disabled {
  opacity: 0.55;
}

.ai-err {
  font-size: var(--fs-caption);
  color: var(--danger);
}

/* 生成中的流式活动摘要（匹配食材…） */
.ai-status {
  font-size: var(--fs-micro);
  color: var(--text-3);
}
</style>
