<script setup lang="ts">
import { computed, ref } from 'vue'

import PillChip from '@/components/common/PillChip.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import type { Goal, ProgramPlan, ProgramTier } from '@/types'
import { PROGRAM_TIERS } from '@/types'
import {
  courseShort,
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

/** 网格图例：格子里那 1 字是课程缩写（courseShort 取首字），不列出课程名读不懂 */
const courseLegend = computed(() => {
  const seen = new Map<string, string>()
  for (const d of selPlan.value?.days ?? []) {
    if (d.rest || !d.courseName) continue
    if (!seen.has(d.courseName)) seen.set(d.courseName, courseShort(d.courseName))
  }
  return [...seen].map(([name, short]) => ({ name, short }))
})

/** 有没有「训练日但没有课名」的日子（格子以 — 占位，图例里要交代） */
const hasUnnamedDay = computed(() => (selPlan.value?.days ?? []).some((d) => !d.rest && !d.courseName))
</script>

<template>
  <div class="cmp">
    <SegmentedControl v-model="view" :options="viewOptions" />

    <!-- 01 · 参数对比矩阵：随视图生灭，进出只淡不飞 -->
    <Transition name="fade">
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
                  {{ p.tierLabel }}
                </button>
                <!-- 不可用档：胶囊单独承载，不吃整列压暗，11px 也读得清 -->
                <PillChip v-if="!p.feasible" class="off-tag" size="sm" tone="muted">不可用</PillChip>
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
        </header>

        <!-- 档位切换：紧贴标题，切换即重画网格 -->
        <div class="tier-pick">
          <button
            v-for="p in orderedPlans"
            :key="p.tier"
            class="chip"
            :class="{ on: p.tier === selectedTier, off: !p.feasible }"
            :aria-pressed="p.tier === selectedTier"
            :disabled="!p.feasible"
            @click="emit('select', p.tier)"
          >
            {{ p.tierLabel }}
          </button>
        </div>

        <!-- 格子里那 1 字是课程缩写：图例放网格正上方，缩写 → 课程名 -->
        <p v-if="courseLegend.length" class="grid-legend">
          <span v-for="c in courseLegend" :key="c.name" class="gl-item">
            <b class="gl-key">{{ c.short }}</b>{{ c.name }}
          </span>
          <span v-if="hasUnnamedDay" class="gl-item">
            <b class="gl-key">—</b>未命名课程
          </span>
        </p>

        <div class="grid">
          <div class="week-row head">
            <span class="wlabel" />
            <div class="cells">
              <span v-for="w in weekdayHead" :key="w" class="wd">{{ w }}</span>
            </div>
            <!-- 周时长列的单位列头（行内只留数字，11px 放得下） -->
            <span class="wtotal">分钟</span>
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
                {{ c.rest ? '休' : (c.label ?? '—') }}
              </span>
            </div>
            <span class="wtotal num" :class="{ hot: wi === peakWeekIdx }">{{ w.totalMin }}</span>
          </div>
        </div>
      </section>
    </Transition>

    <!-- 动态解说：选中变化时实时改写 -->
    <Transition name="fade">
      <section v-if="diff && view === 'matrix'" class="pod">
        <header class="pod-head">
          <b>差在哪</b>
          <span class="pill ghost">{{ diff.title }}</span>
        </header>
        <p class="explain">{{ diff.text }}</p>
      </section>
    </Transition>

    <section class="pod">
      <header class="pod-head">
        <b>这档适合</b>
        <span class="pill ghost">{{ plans.find((p) => p.tier === selectedTier)?.tierLabel }}</span>
      </header>
      <p class="explain">{{ fitText }}</p>
    </section>

    <Transition name="fade">
      <section v-if="view === 'load' && rhythm" class="pod">
        <header class="pod-head">
          <b>强度节奏</b>
          <StatusChip v-if="peakWeekIdx > 0" tone="warn">第 {{ peakWeekIdx + 1 }} 周最累</StatusChip>
        </header>
        <p class="explain">{{ rhythm }}</p>
      </section>
    </Transition>

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
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
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
  border-radius: var(--radius-xs) var(--radius-xs) 0 0;
}

.matrix tbody tr:last-child td.on {
  border-radius: 0 0 var(--radius-xs) var(--radius-xs);
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
  transition:
    color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

th.on .col-hit {
  color: var(--accent);
  font-weight: 700;
}

/* 不可用档：压暗只落在列头按钮上（禁用态浓度走令牌），
   「不可用」胶囊在压暗之外单独承载，不叠 opacity */
th.off .col-hit {
  opacity: var(--disabled-opacity);
}

.off-tag {
  margin-top: 3px;
}

/* 强度预览网格 */
.grid {
  display: grid;
  gap: 5px;
}

/* 网格图例：缩写 → 课程名（11px + --text-3，一行铺开） */
.grid-legend {
  margin-bottom: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 3px 10px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.gl-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 缩写键：仿格子本身的底色，图例与网格对得上 */
.gl-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: var(--radius-xs);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-micro);
  font-weight: 600;
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
  border-radius: var(--radius-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-micro);
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

/* 预览视图的档位切换 chips：紧贴标题，不可用档不可点 */
.tier-pick {
  margin-bottom: 12px;
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
    color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
}

.chip.off {
  opacity: var(--disabled-opacity);
}

.primary {
  width: 100%;
  padding: 13px 0;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

/* 视图/解说块的进出场：内容整体更换，只走不透明度且进出同向 */
.fade-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.fade-enter-from {
  opacity: 0;
}
.fade-leave-active {
  transition: none;
}
</style>
