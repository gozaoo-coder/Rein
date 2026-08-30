<script setup lang="ts">
import { computed } from 'vue'

import type { BodyMetric, Goal } from '@/types'
import { addDays, diffDays, todayStr } from '@/utils/date'
import { toX, toY, type PlotBox } from '@/utils/programCurves'
import { weightTrendAlert } from '@/utils/weightTrend'

/**
 * 体重航道：体重不是对一条「目标线」，而是对一条随档位斜率下行的「走廊」
 * （理想轨迹 ±0.3kg 的合理波动）。带内即健康——单点出带只是水分波动，
 * 连续出带才需要警惕。
 */
const props = defineProps<{
  /** 体重记录（时间正序，已截取到方案区间） */
  points: { date: string; kg: number }[]
  goal: Goal
  /** 档位预期速率（kg/周）：kcalDelta × 7 ÷ 7700 */
  weeklyRateKg: number
  startWeight: number
  targetWeight: number | null
  startDate: string
  /** 图右端（今天与方案结束日取较晚者） */
  endDate: string
}>()

const BAND = 0.3
const PLOT: PlotBox = { left: 36, top: 14, width: 286, height: 130 }

/** 某日期的理想轨迹值（到达目标后钳在目标上） */
function idealAt(date: string): number {
  const linear = props.startWeight + (props.weeklyRateKg / 7) * diffDays(props.startDate, date)
  if (props.targetWeight == null || props.weeklyRateKg === 0) return linear
  // cut（速率<0）不跌破目标；bulk 不越过目标
  return props.weeklyRateKg < 0 ? Math.max(linear, props.targetWeight) : Math.min(linear, props.targetWeight)
}

const xOfDate = (date: string): number => {
  const total = Math.max(diffDays(props.startDate, props.endDate), 1)
  const t = Math.min(Math.max(diffDays(props.startDate, date) / total, 0), 1)
  return toX(PLOT, { xMin: 0, xMax: 1 }, t)
}

// 必须取本地时区日期：toISOString() 是 UTC，UTC+8 在 00:00–08:00 会算成昨天，
// 与其余组件 todayStr() 的「今天」错位
const today = todayStr()

const yDomain = computed<[number, number]>(() => {
  const candidates: number[] = [props.startWeight - BAND, props.startWeight + BAND]
  const endIdeal = idealAt(props.endDate)
  candidates.push(endIdeal - BAND, endIdeal + BAND)
  props.points.forEach((p) => candidates.push(p.kg))
  if (props.targetWeight != null) candidates.push(props.targetWeight)
  let lo = Math.min(...candidates)
  let hi = Math.max(...candidates)
  const pad = Math.max((hi - lo) * 0.15, 0.4)
  return [lo - pad, hi + pad]
})

const yOfKg = computed<(kg: number) => number>(() => {
  const [lo, hi] = yDomain.value
  return (kg: number) => toY(PLOT, hi - lo, kg - lo)
})

/** 走廊多边形：上沿（理想+BAND）左→右，下沿（理想-BAND）右→左（各采样 9 点） */
const bandPath = computed(() => {
  const y = yOfKg.value
  const steps = 8
  const upper: string[] = []
  const lower: string[] = []
  for (let i = 0; i <= steps; i++) {
    const date = dateAtFraction(i / steps)
    const mid = idealAt(date)
    upper.push(`${xOfDate(date).toFixed(1)},${y(mid + BAND).toFixed(1)}`)
    lower.push(`${xOfDate(date).toFixed(1)},${y(mid - BAND).toFixed(1)}`)
  }
  return `M${upper.join(' L')} L${lower.reverse().join(' L')} Z`
})

function dateAtFraction(f: number): string {
  const total = Math.max(diffDays(props.startDate, props.endDate), 1)
  return addDays(props.startDate, Math.round(total * f))
}

const idealLine = computed(() => {
  const y = yOfKg.value
  const steps = 8
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const date = dateAtFraction(i / steps)
    pts.push(`${xOfDate(date).toFixed(1)},${y(idealAt(date)).toFixed(1)}`)
  }
  return pts.join(' ')
})

const actualLine = computed(() => {
  const y = yOfKg.value
  return props.points.map((p) => `${xOfDate(p.date).toFixed(1)},${y(p.kg).toFixed(1)}`).join(' ')
})

/** 点色：带内 = ok；带外 = warn；连续 2 次带外升级 danger */
const dotColors = computed<string[]>(() => {
  const flags = props.points.map((p) => Math.abs(p.kg - idealAt(p.date)) <= BAND)
  return flags.map((inBand, i) => {
    if (inBand) return 'var(--ok)'
    const run = (i > 0 && !flags[i - 1] ? 1 : 0) + (i < flags.length - 1 && !flags[i + 1] ? 1 : 0)
    return run >= 1 ? 'var(--danger)' : 'var(--warn)'
  })
})

/** x 轴日期标签：起点 / 中点 / 右端 */
const xLabels = computed(() => {
  const mid = dateAtFraction(0.5)
  const fmt = (s: string): string => s.slice(5).replace('-', '/')
  return [
    { x: xOfDate(props.startDate), label: fmt(props.startDate), accent: false },
    { x: xOfDate(mid), label: fmt(mid), accent: false },
    { x: xOfDate(props.endDate), label: props.endDate >= today ? '今天' : fmt(props.endDate), accent: props.endDate >= today },
  ]
})

/* ---------------- 统计与判定 ---------------- */

const lastPoint = computed(() => props.points.at(-1) ?? null)

const stats = computed(() => {
  const out: { em: string; value: string; unit: string }[] = []
  if (props.points.length >= 2) {
    const first = props.points[0]!
    const days = Math.max(diffDays(first.date, lastPoint.value!.date), 1)
    const weekly = ((lastPoint.value!.kg - first.kg) / days) * 7
    out.push({ em: '周均', value: `${weekly > 0 ? '+' : ''}${weekly.toFixed(2)}`, unit: 'kg' })
  }
  if (props.targetWeight != null && lastPoint.value) {
    const remain = Math.round((props.targetWeight - lastPoint.value.kg) * 10) / 10
    out.push({ em: '距目标', value: `${remain > 0 ? '+' : ''}${remain}`, unit: 'kg' })
    const rate = Math.abs(props.weeklyRateKg)
    if (rate > 0.05 && Math.sign(remain) === Math.sign(props.weeklyRateKg)) {
      out.push({ em: '预计达标', value: `${Math.max(1, Math.round(Math.abs(remain) / rate))}`, unit: '周' })
    }
  }
  return out.slice(0, 3)
})

const alert = computed(() => {
  if (props.points.length < 3) return null
  const metrics = props.points.map((p) => ({ date: p.date, weightKg: p.kg }) as BodyMetric)
  return weightTrendAlert(metrics, props.goal, lastPoint.value?.kg ?? null)
})

const verdictText = computed(() => {
  if (props.points.length < 2) return '记满 2 次体重就能画出实际曲线；目前走廊按方案档位速率铺出。'
  if (alert.value) return alert.value.reason
  const off = dotColors.value.filter((c) => c !== 'var(--ok)').length
  return off === 0
    ? `实际体重全程走在航道内——当前速率与「${props.goal === 'bulk' ? '增肌' : props.goal === 'keep' ? '保持' : '减脂'}」的预期轨迹一致，无需调整参数。`
    : `有 ${off} 次记录落在走廊外，多为水分波动；只要没有连续出带就不必改参数。`
})
</script>

<template>
  <section class="pod">
    <header class="pod-head">
      <div>
        <p class="big num">
          {{ lastPoint ? lastPoint.kg : startWeight }}<span class="unit"> kg</span>
        </p>
        <p class="sub num">
          <template v-if="lastPoint && Math.abs(lastPoint.kg - startWeight) >= 0.05">
            较起点 {{ lastPoint.kg - startWeight > 0 ? '+' : '' }}{{ Math.round((lastPoint.kg - startWeight) * 10) / 10 }}kg
          </template>
          <template v-else>起点 {{ startWeight }}kg</template>
          <template v-if="targetWeight != null"> · 距目标 {{ Math.abs(Math.round((targetWeight - (lastPoint?.kg ?? startWeight)) * 10) / 10) }}kg</template>
        </p>
      </div>
      <span class="pill" :class="{ off: !!alert }">{{ alert ? '需要留意' : '航道内' }}</span>
    </header>

    <svg viewBox="0 0 330 168" class="chart" role="img" aria-label="体重航道图">
      <path :d="bandPath" fill="var(--ok)" opacity="0.12" />
      <polyline :points="idealLine" fill="none" stroke="var(--ok)" stroke-width="1" stroke-dasharray="3 3" opacity="0.55" />
      <polyline
        v-if="points.length >= 2"
        :points="actualLine"
        fill="none"
        stroke="var(--accent)"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle
        v-for="(p, i) in points"
        :key="p.date"
        :cx="xOfDate(p.date)"
        :cy="yOfKg(p.kg)"
        :r="i === points.length - 1 ? 4 : 3"
        :fill="dotColors[i]"
        stroke="var(--surface)"
        stroke-width="1"
      />
      <text v-for="(l, i) in xLabels" :key="`x${i}`" :x="l.x" y="162" text-anchor="middle" font-size="8" :fill="l.accent ? 'var(--accent)' : 'var(--text-3)'" class="num">
        {{ l.label }}
      </text>
    </svg>

    <ul class="legend">
      <li><i class="sw band" />目标走廊（±0.3kg）</li>
      <li><i class="sw line" />实际体重</li>
    </ul>

    <div class="verdict">
      <span class="vtag" :class="alert ? 'warn' : 'ok'">{{ alert ? '判定' : '稳定' }}</span>
      <p>{{ verdictText }}</p>
    </div>

    <ul v-if="stats.length" class="stats num">
      <li v-for="s in stats" :key="s.em">
        <em>{{ s.em }}</em>
        <b>{{ s.value }}<i>{{ s.unit }}</i></b>
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.big {
  font-size: 27px;
  font-weight: 700;
  letter-spacing: -0.6px;
  line-height: 1.1;
}

.unit {
  font-size: 14px;
  color: var(--text-3);
  font-weight: 400;
}

.sub {
  margin-top: 3px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.pill {
  flex: none;
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--ok-soft);
  color: var(--ok-strong);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.pill.off {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
}

.chart {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 12px;
}

.legend {
  margin-top: 6px;
  display: flex;
  gap: 14px;
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.sw.band {
  width: 11px;
  height: 8px;
  border-radius: 2px;
  background: var(--ok);
  opacity: 0.25;
}

.sw.line {
  width: 11px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
}

.verdict {
  margin-top: 11px;
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

.stats {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.stats em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.stats b {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.stats i {
  font-style: normal;
  font-weight: 400;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: 1px;
}
</style>
