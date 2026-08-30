<script setup lang="ts">
import { computed } from 'vue'

import { fmtKg, type StrengthDay } from '@/utils/strength'

/**
 * 动作重量曲线：每次训练的最大重量组连成折线（渐进超负荷可视化）。
 * 点 = 单次训练 top set；右上标注最新重量，左下/左上标注区间。仅 SVG，无依赖。
 */
const props = withDefaults(
  defineProps<{
    days: StrengthDay[]
    height?: number
  }>(),
  { height: 150 },
)

const W = 480

const PAD = { l: 40, r: 56, t: 18, b: 20 }

const pts = computed(() => {
  const ds = props.days.filter((d) => d.top > 0)
  if (!ds.length) return []
  const innerW = W - PAD.l - PAD.r
  const innerH = props.height - PAD.t - PAD.b
  const weights = ds.map((d) => d.top)
  const rawMin = Math.min(...weights)
  const rawMax = Math.max(...weights)
  const span = Math.max(2.5, rawMax - rawMin)
  const pad = Math.max(1.25, span * 0.18)
  const y0 = rawMin - pad
  const y1 = rawMax + pad
  const n = ds.length
  return ds.map((d, i) => ({
    ...d,
    x: n === 1 ? PAD.l + innerW / 2 : PAD.l + (innerW * i) / (n - 1),
    y: PAD.t + innerH * (1 - (d.top - y0) / (y1 - y0)),
  }))
})

/** y 轴上下界标注（重量区间） */
const yLabels = computed(() => {
  if (pts.value.length < 2) return null
  const ys = pts.value.map((p) => p.y)
  const top = Math.min(...ys)
  const bot = Math.max(...ys)
  const hi = Math.max(...pts.value.map((p) => p.top))
  const lo = Math.min(...pts.value.map((p) => p.top))
  return { top, bot, hi: fmtKg(hi), lo: fmtKg(lo) }
})

const linePath = computed(() =>
  pts.value.length < 2 ? '' : pts.value.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
)

/** 渐变面积路径：折线 → 底边闭合 */
const areaPath = computed(() => {
  if (pts.value.length < 2) return ''
  const base = props.height - PAD.b
  const first = pts.value[0]!
  const last = pts.value[pts.value.length - 1]!
  return `${linePath.value} L${last.x.toFixed(1)},${base} L${first.x.toFixed(1)},${base} Z`
})

const last = computed(() => pts.value[pts.value.length - 1] ?? null)

/** 相对首次的增幅（kg） */
const delta = computed(() => {
  if (pts.value.length < 2) return null
  const d = pts.value[pts.value.length - 1]!.top - pts.value[0]!.top
  return Math.round(d * 10) / 10
})

function shortDate(date: string): string {
  const [, m, d] = date.split('-')
  return `${Number(m)}/${Number(d)}`
}
</script>

<template>
  <div class="curve">
    <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <linearGradient id="wc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--c-exercise)" stop-opacity="0.22" />
          <stop offset="100%" stop-color="var(--c-exercise)" stop-opacity="0.02" />
        </linearGradient>
      </defs>

      <template v-if="pts.length >= 2">
        <line class="grid" :x1="PAD.l" :x2="W - PAD.r" :y1="yLabels!.top" :y2="yLabels!.top" />
        <line class="grid" :x1="PAD.l" :x2="W - PAD.r" :y1="yLabels!.bot" :y2="yLabels!.bot" />
        <text class="ylabel" :x="PAD.l - 6" :y="yLabels!.top + 3">{{ yLabels!.hi }}</text>
        <text class="ylabel" :x="PAD.l - 6" :y="yLabels!.bot + 3">{{ yLabels!.lo }}</text>
        <path class="area" :d="areaPath" />
        <path class="line" :d="linePath" />
      </template>

      <g v-for="(p, i) in pts" :key="p.workoutId">
        <circle class="dot" :cx="p.x" :cy="p.y" :r="i === pts.length - 1 ? 5 : 3.5" />
      </g>

      <template v-if="last">
        <text class="lastval num" :x="W - PAD.r + 8" :y="last.y + 4">{{ fmtKg(last.top) }}</text>
        <text class="xdate" :x="last.x" :y="height - 4" text-anchor="end">{{ shortDate(last.date) }}</text>
      </template>
      <text v-if="pts.length >= 2" class="xdate" :x="pts[0]!.x" :y="height - 4" text-anchor="start">
        {{ shortDate(pts[0]!.date) }}
      </text>
    </svg>

    <p class="legend num">
      <template v-if="pts.length >= 2">
        {{ pts.length }} 次训练 · 最新 {{ fmtKg(last!.top) }} kg
        <b v-if="delta != null && delta !== 0" :class="{ up: delta > 0, down: delta < 0 }">
          {{ delta > 0 ? '+' : '' }}{{ fmtKg(delta) }} kg
        </b>
      </template>
      <template v-else-if="pts.length === 1">首次记录 · {{ fmtKg(last!.top) }} kg × {{ last!.topReps ?? '—' }}</template>
    </p>
  </div>
</template>

<style scoped>
.curve svg {
  display: block;
  width: 100%;
}

.grid {
  stroke: var(--line);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

.ylabel {
  font-size: 10px;
  fill: var(--text-3);
  text-anchor: end;
}

.area {
  fill: url(#wc-fill);
  stroke: none;
}

.line {
  fill: none;
  stroke: var(--c-exercise);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.dot {
  fill: var(--bg);
  stroke: var(--c-exercise);
  stroke-width: 2;
}

.lastval {
  font-size: 12px;
  font-weight: 700;
  fill: var(--text-1);
}

.xdate {
  font-size: 10px;
  fill: var(--text-3);
}

.legend {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.legend b {
  margin-left: 6px;
  font-weight: 700;
}

.legend b.up {
  color: var(--c-exercise);
}

.legend b.down {
  color: var(--danger);
}
</style>
