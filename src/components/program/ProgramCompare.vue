<script setup lang="ts">
import { computed, ref } from 'vue'

import SegmentedControl from '@/components/common/SegmentedControl.vue'
import type { Goal, ProgramPlan, ProgramTier } from '@/types'
import { PROGRAM_TIERS } from '@/types'
import {
  matrixRows,
  rhythmText,
  tierDiffText,
  tierFitText,
  weekPreview,
} from '@/utils/programSetup'

/**
 * 三档选择的双视图：01 参数对比矩阵（看数字）+ 02 强度预览（看生活）。
 *
 * 把「纵向三张卡」换成「横向一张表 / 一张 7×4 网格」，让选择变成对比而不是
 * 上下滚动记数字；点列选中，选中列高亮，下方解说实时改写。
 */
const props = defineProps<{
  plans: ProgramPlan[]
  selectedTier: ProgramTier
  goal: Goal
}>()

const emit = defineEmits<{
  select: [tier: ProgramTier]
  activate: []
}>()

const view = ref('matrix')
const viewOptions = [
  { value: 'matrix', label: '参数对比' },
  { value: 'load', label: '强度预览' },
]

const rows = computed(() => matrixRows(props.plans))

const orderedPlans = computed(() =>
  PROGRAM_TIERS.map((t) => props.plans.find((p) => p.tier === t)).filter(
    (p): p is ProgramPlan => p != null,
  ),
)

const diff = computed(() => tierDiffText(props.plans, props.selectedTier, props.goal))
const fitText = computed(() => {
  const sel = props.plans.find((p) => p.tier === props.selectedTier)
  return sel ? tierFitText(sel.tier, props.goal) : ''
})

const selPlan = computed(() => props.plans.find((p) => p.tier === props.selectedTier) ?? null)

/* ---------------- 02 · 强度预览 ---------------- */

const weeks = computed(() => (selPlan.value ? weekPreview(selPlan.value) : []))
const rhythm = computed(() => rhythmText(weeks.value))
const weekdayHead = ['一', '二', '三', '四', '五', '六', '日']

/** 色深即负荷：按时长分三档（轻 <40 / 中 40-60 / 重 >60 分钟） */
function loadClass(min: number | null): string {
  if (min == null || min <= 0) return ''
  if (min < 40) return 'l1'
  if (min <= 60) return 'l2'
  return 'l3'
}

/** 周时长列：最累周标警示色 */
const peakWeekIdx = computed(() => {
  if (!weeks.value.length) return -1
  const totals = weeks.value.map((w) => w.totalMin)
  const max = Math.max(...totals)
  return max > 0 ? totals.indexOf(max) : -1
})
</script>

<template>
  <div class="cmp">
    <SegmentedControl v-model="view" :options="viewOptions" />

    <!-- 01 · 参数对比矩阵 -->
    <section v-if="view === 'matrix'" class="pod">
      <table class="matrix">
        <thead>
          <tr>
            <th class="corner" />
            <th
              v-for="p in orderedPlans"
              :key="p.tier"
              :class="{ on: p.tier === selectedTier, off: !p.feasible }"
            >
              <button
                class="col-hit"
                :aria-pressed="p.tier === selectedTier"
                :disabled="!p.feasible"
                @click="emit('select', p.tier)"
              >
                {{ p.tierLabel }}<span v-if="!p.feasible" class="off-tag">不可用</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.label" :class="{ strong: row.strong }">
            <td class="row-label">{{ row.label }}</td>
            <td
              v-for="(v, i) in row.values"
              :key="i"
              class="num"
              :class="{ on: orderedPlans[i]?.tier === selectedTier }"
            >
              {{ v }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 02 · 强度预览 -->
    <section v-else class="pod">
      <header class="pod-head">
        <b>{{ selPlan?.tierLabel }}档 · 4 周负荷</b>
        <span class="pill">下方按钮切换档位</span>
      </header>

      <div class="grid">
        <div class="week-row head">
          <span class="wlabel" />
          <div class="cells">
            <span v-for="w in weekdayHead" :key="w" class="wd">{{ w }}</span>
          </div>
          <span class="wtotal" />
        </div>
        <div v-for="(w, wi) in weeks" :key="w.label" class="week-row">
          <span class="wlabel">{{ w.label }}</span>
          <div class="cells">
            <!-- 首行星期占位：把第 1 天推到它真正的星期列 -->
            <span v-for="b in w.lead" :key="`b${b}`" class="cell blank" aria-hidden="true" />
            <span
              v-for="c in w.cells"
              :key="c.date"
              class="cell"
              :class="[loadClass(c.min), { rest: c.rest }]"
            >
              {{ c.rest ? '休' : (c.label ?? '·') }}
            </span>
          </div>
          <span class="wtotal num" :class="{ hot: wi === peakWeekIdx }">{{ w.totalMin }}′</span>
        </div>
      </div>

      <div class="tier-pick">
        <button
          v-for="p in orderedPlans"
          :key="p.tier"
          class="chip"
          :class="{ on: p.tier === selectedTier }"
          :aria-pressed="p.tier === selectedTier"
          @click="emit('select', p.tier)"
        >
          {{ p.tierLabel }}
        </button>
      </div>
    </section>

    <!-- 动态解说：选中变化时实时改写 -->
    <section v-if="diff && view === 'matrix'" class="pod">
      <header class="pod-head">
        <b>差在哪</b>
        <span class="pill ghost">{{ diff.title }}</span>
      </header>
      <p class="explain">{{ diff.text }}</p>
    </section>

    <section class="pod">
      <header class="pod-head">
        <b>这档适合</b>
        <span class="pill ghost">{{ plans.find((p) => p.tier === selectedTier)?.tierLabel }}</span>
      </header>
      <p class="explain">{{ fitText }}</p>
    </section>

    <section v-if="view === 'load' && rhythm" class="pod">
      <header class="pod-head">
        <b>强度节奏</b>
        <span v-if="peakWeekIdx > 0" class="pill warn">第 {{ peakWeekIdx + 1 }} 周最累</span>
      </header>
      <p class="explain">{{ rhythm }}</p>
    </section>

    <button
      class="primary"
      :disabled="!selPlan?.feasible"
      @click="emit('activate')"
    >
      启用「{{ plans.find((p) => p.tier === selectedTier)?.tierLabel }}」方案
    </button>
  </div>
</template>

<style scoped>
.cmp {
  display: grid;
  gap: 12px;
}

.pod {
  padding: 14px 15px;
  border-radius: var(--radius-l);
  background: var(--surface);
}

.pod-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.pod-head b {
  font-size: var(--fs-subhead);
  font-weight: 700;
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

.pill.warn {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
}

.explain {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.6;
}

/* 矩阵表 */
.matrix {
  width: 100%;
  border-collapse: collapse;
}

.matrix th,
.matrix td {
  padding: 8px 4px;
  text-align: center;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
}

.matrix .corner,
.matrix .row-label {
  text-align: left;
  color: var(--text-3);
  font-weight: 400;
  width: 72px;
  min-width: 66px;
  font-size: var(--fs-micro);
  white-space: nowrap;
}

.matrix thead th {
  padding-bottom: 6px;
  border-bottom: 0.5px solid var(--line);
}

.matrix tbody td {
  border-bottom: 0.5px solid var(--line);
  font-weight: 500;
}

.matrix tbody tr:last-child td {
  border-bottom: none;
}

.matrix td.on,
.matrix th.on {
  background: var(--accent-soft);
  font-weight: 700;
  color: var(--text-1);
}

.matrix thead th.on {
  color: var(--accent);
  border-radius: 8px 8px 0 0;
}

.matrix tbody tr:last-child td.on {
  border-radius: 0 0 8px 8px;
}

.matrix tr.strong td {
  font-weight: 700;
  font-size: var(--fs-subhead);
}

.col-hit {
  width: 100%;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
}

th.on .col-hit {
  color: var(--accent);
  font-weight: 700;
}

th.off {
  opacity: 0.45;
}

.off-tag {
  display: block;
  font-size: 9px;
  color: var(--danger);
  font-weight: 600;
}

/* 强度预览网格 */
.grid {
  display: grid;
  gap: 5px;
}

.week-row {
  display: grid;
  grid-template-columns: 44px 1fr 36px;
  align-items: center;
  gap: 8px;
}

.wlabel {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.wtotal {
  font-size: var(--fs-micro);
  color: var(--text-3);
  text-align: right;
}

.wtotal.hot {
  color: var(--warn);
  font-weight: 700;
}

.cells {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.wd {
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
  padding-bottom: 2px;
}

.cell {
  aspect-ratio: 1;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  background: var(--surface-2);
  color: var(--text-3);
}

/* 首行星期占位：占列但不呈现成一天 */
.cell.blank {
  background: transparent;
}

/* 色深即负荷 */
.cell.l1 {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  opacity: 0.6;
}

.cell.l2 {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.cell.l3 {
  background: var(--c-exercise);
  color: var(--on-accent);
  font-weight: 700;
}

.cell.rest {
  background: transparent;
  border: 0.5px dashed var(--line);
  opacity: 0.6;
}

/* 预览视图的档位切换 chips */
.tier-pick {
  margin-top: 12px;
  display: flex;
  gap: 7px;
}

.chip {
  flex: 1;
  padding: 8px 0;
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: 500;
  color: var(--text-2);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
}

.primary {
  width: 100%;
  padding: 13px 0;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.primary:disabled {
  opacity: 0.45;
}
</style>
