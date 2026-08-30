<script setup lang="ts">
import { computed, reactive, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import { useNutritionStore } from '@/stores/nutrition'
import type { ProgramChange, ProgramParams } from '@/types'
import type { AdjustmentPatch } from '@/utils/programEngine'
import { clampAdjustment } from '@/utils/programEngine'
import type { WeekCompare } from '@/ai/programReview'

/**
 * 复盘卡片流：AI 建议不再「全盘接受或全部放弃」——
 * 每条参数建议独立成卡、独立开关；勾选变化时「将变更为」实时重算
 * （仍走 clampAdjustment，越界值当场标注），最后只把勾选子集交给 store.adjust。
 */
const props = defineProps<{
  open: boolean
  phase: 'running' | 'done' | 'error'
  error: string
  diagnosis: string
  advice: string[]
  /** 模型原始建议（未经钳制） */
  proposed: AdjustmentPatch
  /** 生效中的方案参数（钳制与 diff 的基准） */
  current: ProgramParams | null
  /** 本周 vs 上周执行对比（数据先行：先看数据再看 AI 说了什么） */
  compare: WeekCompare | null
}>()

const emit = defineEmits<{
  apply: [patch: AdjustmentPatch, summary: string]
  retry: []
  close: []
}>()

const n = useNutritionStore()

interface FieldMeta {
  key: keyof AdjustmentPatch
  title: string
  reason: string
  fmt: (v: number) => string
}

const FIELD_META: FieldMeta[] = [
  {
    key: 'kcalDelta',
    title: '调整每日热量偏移',
    reason: '按最近的体重趋势与摄入达成度校准缺口',
    fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} 大卡`,
  },
  {
    key: 'proteinPerKg',
    title: '调整蛋白质配比',
    reason: '缺口下保护肌肉，按当前体重重算蛋白目标',
    fmt: (v) => `${v.toFixed(1)} g/kg`,
  },
  {
    key: 'trainingDays',
    title: '调整每周训练天数',
    reason: '依从性优先：完成不了的频次不如降下来做满',
    fmt: (v) => `${Math.round(v)} 天`,
  },
]

/** 有建议的参数才出卡片 */
const cards = computed(() => FIELD_META.filter((f) => props.proposed[f.key] != null))

const selected = reactive<Record<string, boolean>>({})

watch(
  () => [props.open, props.phase] as const,
  ([open, phase]) => {
    if (open && phase === 'done') {
      for (const f of FIELD_META) {
        const v = props.proposed[f.key]
        if (v != null) selected[f.key] = true
      }
    }
    if (!open) {
      for (const k of Object.keys(selected)) delete selected[k]
    }
  },
  { immediate: true },
)

/** 单字段 patch（TS 对计算键不做窄化，显式分支更稳） */
function patchOf(f: FieldMeta): AdjustmentPatch {
  const p: AdjustmentPatch = {}
  if (f.key === 'kcalDelta') p.kcalDelta = props.proposed.kcalDelta
  else if (f.key === 'proteinPerKg') p.proteinPerKg = props.proposed.proteinPerKg
  else p.trainingDays = props.proposed.trainingDays
  return p
}

/** 单条卡片的钳制结果（A → B / 已钳制标注） */
function cardChange(f: FieldMeta): ProgramChange | null {
  if (!props.current || !n.profile || props.proposed[f.key] == null) return null
  const { changes } = clampAdjustment(n.profile, props.current, patchOf(f))
  return changes.find((c) => c.field === f.key) ?? null
}

function isClamped(f: FieldMeta, c: ProgramChange | null): boolean {
  const raw = props.proposed[f.key]
  if (raw == null || !c) return false
  const after = Number(c.after.replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(after) && Math.abs(after - raw) > 1e-6
}

/** 勾选子集 → 实际会生效的全部变更（含目标连带变化） */
const finalChanges = computed<ProgramChange[]>(() => {
  if (!props.current || !n.profile) return []
  const patch = selectedPatch()
  if (!patch) return []
  return clampAdjustment(n.profile, props.current, patch).changes
})

function selectedPatch(): AdjustmentPatch | null {
  let any = false
  const p: AdjustmentPatch = {}
  for (const f of FIELD_META) {
    if (selected[f.key] && props.proposed[f.key] != null) {
      const one = patchOf(f)
      Object.assign(p, one)
      any = true
    }
  }
  return any ? p : null
}

const selectedCount = computed(() => cards.value.filter((f) => selected[f.key]).length)

function apply(): void {
  const patch = selectedPatch()
  if (!patch) return
  emit('apply', patch, props.diagnosis.slice(0, 60) || 'AI 周复盘调整')
}

/* ---------------- 数据先行：本周 vs 上周 ---------------- */

const compareBar = (p: { now: number; prev: number }): number => {
  const max = Math.max(p.now, p.prev, 1)
  return Math.min(p.now / max, 1)
}

const arrowOf = (p: { now: number; prev: number }): { text: string; cls: string } => {
  if (p.now > p.prev) return { text: '↑', cls: 'up' }
  if (p.now < p.prev) return { text: '↓', cls: 'down' }
  return { text: '—', cls: 'flat' }
}
</script>

<template>
  <SheetModal :open="open" title="AI 本周复盘" initial-snap="large" @close="emit('close')">
    <div class="review">
      <template v-if="phase === 'running'">
        <p class="t-2 center wait">正在汇总最近 7 天的执行数据并交给模型分析…</p>
      </template>

      <template v-else-if="phase === 'error'">
        <p class="err">{{ error }}</p>
        <button class="primary" @click="emit('retry')">重试</button>
      </template>

      <template v-else>
        <!-- 数据先行：先自己看数据，再看 AI 怎么说 -->
        <section v-if="compare" class="card">
          <header class="card-head">
            <b>本周执行度</b>
            <span class="t-3">本周 vs 上周</span>
          </header>
          <div class="bars">
            <div v-for="p in compare.points" :key="p.label" class="bar-row">
              <div class="bar-top">
                <span>{{ p.label }}</span>
                <span class="num">
                  {{ p.prev }} → {{ p.now }} {{ p.unit }}
                  <b class="arrow" :class="arrowOf(p).cls">{{ arrowOf(p).text }}</b>
                </span>
              </div>
              <div class="bar-track">
                <i class="bar-fill" :style="{ width: `${compareBar(p) * 100}%` }" />
              </div>
            </div>
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <b>诊断</b>
            <span class="tag">AI</span>
          </header>
          <p class="diag">{{ diagnosis }}</p>
        </section>

        <!-- 建议卡片化：逐条采纳 -->
        <section v-if="cards.length" class="card">
          <header class="card-head">
            <b>建议（可逐条采纳）</b>
            <span class="tag num">已选 {{ selectedCount }} / {{ cards.length }}</span>
          </header>
          <div v-for="f in cards" :key="f.key" class="sug">
            <button
              class="check"
              :class="{ on: selected[f.key] }"
              :aria-pressed="!!selected[f.key]"
              :aria-label="`采纳：${f.title}`"
              @click="selected[f.key] = !selected[f.key]"
            >
              {{ selected[f.key] ? '✓' : '' }}
            </button>
            <div class="sug-body">
              <p class="sug-title" :class="{ dim: !selected[f.key] }">{{ f.title }}</p>
              <p class="sug-reason">{{ f.reason }}</p>
              <span v-if="cardChange(f)" class="tag num">{{ cardChange(f)!.before }} → {{ cardChange(f)!.after }}</span>
              <span v-if="cardChange(f) && isClamped(f, cardChange(f))" class="tag clamp">超出安全范围 · 已钳制</span>
            </div>
          </div>
        </section>
        <section v-else class="card">
          <p class="diag t-2">数据不足以支持调整，建议保持现参数再观察一周。</p>
        </section>

        <!-- 实时汇总：将变更为 -->
        <section v-if="finalChanges.length" class="card final">
          <header class="card-head">
            <b class="accent">将变更为</b>
          </header>
          <ul class="final-rows num">
            <li v-for="c in finalChanges" :key="c.field">
              <span>{{ c.label }}</span>
              <b>{{ c.before }} → {{ c.after }}</b>
            </li>
          </ul>
        </section>

        <ul v-if="advice.length" class="advice">
          <li v-for="a in advice" :key="a">{{ a }}</li>
        </ul>

        <button v-if="selectedCount" class="primary" @click="apply">
          应用这 {{ selectedCount }} 条并重排日程
        </button>
        <p v-if="selectedCount" class="foot">日程将从今天起重排，已完成的记录不受影响</p>
      </template>
    </div>
  </SheetModal>
</template>

<style scoped>
.review {
  display: grid;
  gap: 12px;
  padding-bottom: 20px;
}

.wait {
  padding: 26px 0;
}

.err {
  color: var(--danger);
  font-size: var(--fs-subhead);
  line-height: 1.5;
}

.card {
  padding: 13px 15px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.card.final {
  background: var(--accent-soft);
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 9px;
}

.card-head b {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.card-head b.accent {
  color: var(--accent);
}

.tag {
  padding: 2px 9px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.tag.clamp {
  margin-left: 6px;
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
}

/* 数据先行条 */
.bars {
  display: grid;
  gap: 10px;
}

.bar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.arrow.up {
  color: var(--ok-strong);
}

.arrow.down {
  color: var(--danger);
}

.arrow.flat {
  color: var(--text-3);
}

.bar-track {
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--surface);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  opacity: 0.75;
  transition: width var(--dur-base) var(--ease-standard);
}

.diag {
  font-size: var(--fs-callout);
  line-height: 1.55;
}

/* 建议卡片 */
.sug {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  border-top: 0.5px solid var(--line);
}

.sug:first-of-type {
  border-top: none;
  padding-top: 2px;
}

.check {
  flex: none;
  width: 19px;
  height: 19px;
  margin-top: 1px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  background: var(--surface);
  color: var(--on-accent);
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.check.on {
  background: var(--accent);
  border-color: var(--accent);
}

.sug-body {
  flex: 1;
  min-width: 0;
}

.sug-title {
  font-size: var(--fs-subhead);
  font-weight: 600;
  transition: color var(--dur-fast) var(--ease-standard);
}

.sug-title.dim {
  color: var(--text-3);
}

.sug-reason {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: 1.5;
}

.sug-body .tag {
  margin-top: 6px;
  display: inline-block;
  background: var(--surface);
}

/* 汇总 */
.final-rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0;
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-caption);
}

.final-rows li:first-child {
  border-top: none;
}

.final-rows span {
  color: var(--text-1);
}

.final-rows b {
  color: var(--accent);
}

.advice {
  display: grid;
  gap: 5px;
  padding-left: 17px;
  list-style: disc;
}

.advice li {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.5;
}

.primary {
  width: 100%;
  padding: 13px 0;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
}

.foot {
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill,
  .check,
  .sug-title {
    transition: none;
  }
}
</style>
