<script setup lang="ts">
import { computed, ref } from 'vue'

import type { Goal, ProgramAdjustment, ProgramChange } from '@/types'
import { toY, type PlotBox } from '@/utils/programCurves'

/**
 * 参数演进图：调整历史不再是文字墙——热量偏移画成折线、训练天数画成阶梯线，
 * 节点实心 = AI 复盘、空心 = 手动，点节点看该次 before → after。
 *
 * 系列值从各条调整记录的 changes 前后值解析（kcalDelta「-400 大卡」/ days「4 天」），
 * 第一条记录的 before 值作为起点补上，无需后端新增字段。
 */
const props = defineProps<{
  adjustments: ProgramAdjustment[]
  goal: Goal
}>()

const num = (s: string | undefined): number | null => {
  if (!s) return null
  const m = s.match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}

interface EvoNode {
  idx: number
  version: number
  dateLabel: string
  summary: string
  source: 'ai' | 'manual'
  delta: number | null
  days: number | null
  changes: ProgramChange[]
}

const nodes = computed<EvoNode[]>(() => {
  let curDelta: number | null = null
  let curDays: number | null = null
  const out: EvoNode[] = []
  props.adjustments.forEach((a, i) => {
    const dChange = a.changes.find((c) => c.field === 'kcalDelta')
    const tChange = a.changes.find((c) => c.field === 'trainingDays')
    let seedDelta: number | null = null
    let seedDays: number | null = null
    if (dChange) {
      if (curDelta == null) seedDelta = num(dChange.before)
      curDelta = num(dChange.after) ?? curDelta
    }
    if (tChange) {
      if (curDays == null) seedDays = num(tChange.before)
      curDays = num(tChange.after) ?? curDays
    }
    if (seedDelta != null) {
      out.push({
        idx: i - 0.5,
        version: a.version - 1,
        dateLabel: '',
        summary: '起点',
        source: 'manual',
        delta: seedDelta,
        days: null,
        changes: [],
      })
    }
    out.push({
      idx: i,
      version: a.version,
      dateLabel: a.at.slice(5, 10).replace('-', '/'),
      summary: a.summary,
      source: a.source,
      delta: curDelta,
      days: curDays,
      changes: a.changes,
    })
    if (seedDays != null && curDays != null) {
      // 训练天数起点：插入在首条记录前的种子点（天数阶梯线用）
      out.splice(out.length - 1, 0, {
        idx: i - 0.5,
        version: a.version - 1,
        dateLabel: '',
        summary: '起点',
        source: 'manual',
        delta: null,
        days: seedDays,
        changes: [],
      })
    }
  })
  return out
})

const deltaNodes = computed(() => nodes.value.filter((n) => n.delta != null) as (EvoNode & { delta: number })[])
const dayNodes = computed(() => nodes.value.filter((n) => n.days != null) as (EvoNode & { days: number })[])
/** 只在「天数真的变了」的节点画点（其余节点只是阶梯线的延续） */
const dayChangeNodes = computed(() => dayNodes.value.filter((n) => n.changes.some((c) => c.field === 'trainingDays')))

/* ---------------- 画布 ---------------- */

const W = 330
const LANE_A: PlotBox = { left: 36, top: 14, width: 284, height: 62 }
const LANE_B: PlotBox = { left: 36, top: 108, width: 284, height: 52 }

/** 节点 → x（按 idx 在 [minIdx, maxIdx] 上均分，两侧留 8px） */
const xDomain = computed<[number, number]>(() => {
  const all = nodes.value
  if (!all.length) return [0, 1]
  return [all[0]!.idx, all.at(-1)!.idx]
})

const xOfIdx = (idx: number): number => {
  const [a, b] = xDomain.value
  const t = b === a ? 0 : (idx - a) / (b - a)
  return LANE_A.left + 8 + t * (LANE_A.width - 16)
}

/** 热量偏移 y 域：数据 min/max 外扩 12%，取整到 50 */
const deltaDomain = computed<[number, number]>(() => {
  const vs = deltaNodes.value.map((n) => n.delta)
  let lo = Math.min(...vs)
  let hi = Math.max(...vs)
  if (lo === hi) {
    lo -= 100
    hi += 100
  }
  const pad = Math.max((hi - lo) * 0.12, 50)
  return [Math.floor((lo - pad) / 50) * 50, Math.ceil((hi + pad) / 50) * 50]
})

const deltaY = (v: number): number => {
  const [lo, hi] = deltaDomain.value
  return toY(LANE_A, hi - lo, v - lo)
}

const DAYS_MAX = 7
const dayY = (v: number): number => toY(LANE_B, DAYS_MAX, Math.min(v, DAYS_MAX))

const deltaLine = computed(() =>
  deltaNodes.value.map((n) => `${xOfIdx(n.idx).toFixed(1)},${deltaY(n.delta).toFixed(1)}`).join(' '),
)

/** 训练天数阶梯线：横向段 + 跳变竖线 */
const daySteps = computed(() => {
  const ns = dayNodes.value
  if (!ns.length) return ''
  const parts: string[] = []
  ns.forEach((n, i) => {
    const x = xOfIdx(n.idx)
    if (i === 0) parts.push(`${x.toFixed(1)},${dayY(n.days).toFixed(1)}`)
    else parts.push(`${x.toFixed(1)},${dayY(ns[i - 1]!.days).toFixed(1)}`, `${x.toFixed(1)},${dayY(n.days).toFixed(1)}`)
  })
  return parts.join(' ')
})

const deltaGrid = computed(() => {
  const [lo, hi] = deltaDomain.value
  return [hi, (hi + lo) / 2, lo].map((v) => ({ v: Math.round(v), y: deltaY(v) }))
})

const deltaTickLabel = (v: number): string => `${v > 0 ? '+' : ''}${v}`

/* ---------------- 判定：加码 / 微调 / 摇摆 ---------------- */

const verdict = computed<{ tag: string; tone: 'ok' | 'warn'; text: string } | null>(() => {
  const moves = deltaNodes.value
    .filter((n) => n.changes.some((c) => c.field === 'kcalDelta'))
    .map((n) => n.delta)
  if (moves.length < 2) {
    if (!moves.length) return null
    return { tag: '起步', tone: 'ok', text: '只有一次调整，先按新参数执行两周再观察趋势。' }
  }
  const dirs: number[] = []
  for (let i = 1; i < moves.length; i++) {
    const d = moves[i]! - moves[i - 1]!
    if (Math.abs(d) >= 100) dirs.push(Math.sign(d))
  }
  const reversals = dirs.filter((d, i) => i > 0 && d !== dirs[i - 1]).length
  if (reversals >= 2) {
    return {
      tag: '反复摇摆',
      tone: 'warn',
      text: '同一参数短期内来回变动——焦虑驱动的调整比保守更伤执行。建议先稳定一整周，让数据说话。',
    }
  }
  const net = moves.at(-1)! - moves[0]!
  const hardening = props.goal === 'bulk' ? net > 0 : net < 0
  return hardening
    ? { tag: '稳定加码', tone: 'ok', text: '热量缺口（盈余）在逐步扩大且没有来回摇摆——这是有依据的推进，不是焦虑驱动。' }
    : { tag: '回调放松', tone: 'ok', text: '近期把参数往回收了收，通常是在给恢复留空间；执行稳定后可以再评估。' }
})

/* ---------------- 节点 diff ---------------- */

const selected = ref<number | null>(null)
const selNode = computed(() => nodes.value.find((n) => n.idx === selected.value) ?? null)

function pick(n: EvoNode): void {
  if (!n.changes.length) return
  selected.value = selected.value === n.idx ? null : n.idx
}

const sourceText = (s: 'ai' | 'manual'): string => (s === 'ai' ? 'AI 复盘' : '手动')

/** 时间轴标签：首 / 中 / 末（有日期的节点），避免密集重叠 */
const dateLabels = computed(() => {
  const withDate = nodes.value.filter((n) => n.dateLabel)
  if (withDate.length <= 2) return withDate.map((n) => ({ idx: n.idx, label: n.dateLabel }))
  const mid = withDate[Math.floor(withDate.length / 2)]!
  return [withDate[0]!, mid, withDate.at(-1)!].map((n) => ({ idx: n.idx, label: n.dateLabel }))
})
</script>

<template>
  <section class="pod">
    <header class="pod-head">
      <b>参数演进</b>
      <span class="pill num">v{{ nodes.at(-1)?.version ?? 1 }}</span>
    </header>

    <svg :viewBox="`0 0 ${W} 186`" class="chart" role="img" aria-label="参数演进图">
      <!-- 热量偏移泳道 -->
      <text :x="4" :y="LANE_A.top + 8" font-size="8.5" fill="var(--text-3)">缺口</text>
      <line
        :x1="LANE_A.left" :y1="LANE_A.top + LANE_A.height" :x2="LANE_A.left + LANE_A.width" :y2="LANE_A.top + LANE_A.height"
        stroke="var(--line-strong)" stroke-width="0.5"
      />
      <template v-if="deltaNodes.length">
        <g v-for="g in deltaGrid" :key="`g${g.v}`">
          <line
            :x1="LANE_A.left" :y1="g.y" :x2="LANE_A.left + LANE_A.width" :y2="g.y"
            stroke="var(--line-strong)" stroke-width="0.5" stroke-dasharray="2 3"
          />
          <text :x="LANE_A.left - 5" :y="g.y + 3" text-anchor="end" font-size="8" fill="var(--text-3)" class="num">
            {{ deltaTickLabel(g.v) }}
          </text>
        </g>
        <polyline :points="deltaLine" fill="none" stroke="var(--c-intake)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <circle
          v-for="n in deltaNodes"
          :key="`dn${n.idx}`"
          :cx="xOfIdx(n.idx)"
          :cy="deltaY(n.delta)"
          :r="n.changes.length ? 4.5 : 3"
          :fill="n.changes.length && n.source === 'ai' ? 'var(--c-intake)' : 'var(--surface)'"
          :stroke="n.changes.length ? 'var(--c-intake)' : 'var(--text-3)'"
          stroke-width="2"
          class="node"
          :class="{ dead: !n.changes.length }"
          @click="pick(n)"
        >
          <title>{{ n.changes.length ? `${n.dateLabel} ${sourceText(n.source)} · ${n.summary}` : '起点' }}</title>
        </circle>
      </template>
      <text v-else :x="LANE_A.left + LANE_A.width / 2" :y="LANE_A.top + 30" text-anchor="middle" font-size="10" fill="var(--text-3)">
        还没有热量调整记录
      </text>

      <!-- 训练天数泳道（阶梯线，0-7 满幅） -->
      <text :x="4" :y="LANE_B.top + 8" font-size="8.5" fill="var(--text-3)">频率</text>
      <line
        :x1="LANE_A.left" :y1="LANE_B.top + LANE_B.height" :x2="LANE_A.left + LANE_A.width" :y2="LANE_B.top + LANE_B.height"
        stroke="var(--line-strong)" stroke-width="0.5"
      />
      <template v-if="dayNodes.length">
        <polyline :points="daySteps" fill="none" stroke="var(--c-exercise)" stroke-width="2" stroke-linejoin="round" opacity="0.7" />
        <circle
          v-for="n in dayChangeNodes"
          :key="`tn${n.idx}`"
          :cx="xOfIdx(n.idx)"
          :cy="dayY(n.days)"
          r="4"
          :fill="n.source === 'ai' ? 'var(--c-exercise)' : 'var(--surface)'"
          stroke="var(--c-exercise)"
          stroke-width="2"
          class="node"
          @click="pick(n)"
        />
        <text :x="LANE_A.left - 5" :y="dayY(0) + 3" text-anchor="end" font-size="8" fill="var(--text-3)">0</text>
        <text :x="LANE_A.left - 5" :y="dayY(7) + 3" text-anchor="end" font-size="8" fill="var(--text-3)">7</text>
      </template>
      <text v-else :x="LANE_A.left + LANE_A.width / 2" :y="LANE_B.top + 26" text-anchor="middle" font-size="10" fill="var(--text-3)">
        训练天数未调整过
      </text>

      <!-- 时间轴：首 / 中 / 末 -->
      <template v-for="n in dateLabels" :key="`x${n.idx}`">
        <text :x="xOfIdx(n.idx)" :y="182" text-anchor="middle" font-size="8" fill="var(--text-3)" class="num">{{ n.label }}</text>
      </template>
    </svg>

    <ul class="legend">
      <li><i class="sw" style="background: var(--c-intake)" />热量偏移</li>
      <li><i class="sw" style="background: var(--c-exercise); opacity: 0.7" />训练天数</li>
      <li><i class="dot solid" />AI</li>
      <li><i class="dot hollow" />手动</li>
    </ul>

    <!-- 节点 diff -->
    <div v-if="selNode" class="diff">
      <header class="diff-head">
        <b>v{{ selNode.version }} · {{ selNode.summary }}</b>
        <span class="num t-3">{{ selNode.dateLabel }} · {{ sourceText(selNode.source) }}</span>
      </header>
      <ul class="diff-rows num">
        <li v-for="c in selNode.changes" :key="c.field">
          <span>{{ c.label }}</span>
          <b>{{ c.before }} → {{ c.after }}</b>
        </li>
      </ul>
    </div>

    <!-- 趋势判定 -->
    <div v-if="verdict" class="verdict">
      <span class="vtag" :class="verdict.tone">{{ verdict.tag }}</span>
      <p>{{ verdict.text }}</p>
    </div>

    <!-- 调整记录 -->
    <ul class="records">
      <li v-for="a in [...adjustments].reverse()" :key="`${a.version}-${a.at}`">
        <div class="rec-main">
          <p class="rec-title"><b class="num">v{{ a.version }}</b> {{ a.summary }}</p>
          <p class="rec-sub t-3">{{ a.at.slice(5, 10).replace('-', '/') }} · {{ sourceText(a.source) }}</p>
        </div>
        <span v-for="c in a.changes.slice(0, 1)" :key="c.field" class="rec-tag num">{{ c.before }} → {{ c.after }}</span>
      </li>
    </ul>
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
  margin-bottom: 8px;
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

.chart {
  display: block;
  width: 100%;
  height: auto;
}

.node {
  cursor: pointer;
}

/* 无变更的「起点」种子点：不可展开，不用手型 */
.node.dead {
  cursor: default;
}

.legend {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.sw {
  width: 11px;
  height: 2px;
  border-radius: 1px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot.solid {
  background: var(--c-intake);
}

.dot.hollow {
  background: var(--surface);
  box-shadow: inset 0 0 0 2px var(--c-intake);
}

/* 节点 diff */
.diff {
  margin-top: 12px;
  padding: 11px 13px;
  border-radius: var(--radius-m);
  background: var(--accent-soft);
}

.diff-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
}

.diff-head b {
  font-size: var(--fs-caption);
  font-weight: 700;
}

.diff-rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0;
  font-size: var(--fs-caption);
}

.diff-rows span {
  color: var(--text-2);
}

/* 趋势判定 */
.verdict {
  margin-top: 10px;
  display: flex;
  align-items: flex-start;
  gap: 9px;
}

.vtag {
  flex: none;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.vtag.ok {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.vtag.warn {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
}

.verdict p {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.55;
}

/* 调整记录 */
.records {
  margin-top: 12px;
}

.records li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 0;
  border-top: 0.5px solid var(--line);
}

.rec-title {
  font-size: var(--fs-subhead);
  font-weight: 500;
}

.rec-title b {
  margin-right: 5px;
}

.rec-sub {
  margin-top: 1px;
  font-size: var(--fs-micro);
}

.rec-tag {
  flex: none;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-micro);
  font-weight: 600;
  white-space: nowrap;
}
</style>
