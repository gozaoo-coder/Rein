<script setup lang="ts">
import { computed, ref } from 'vue'

import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import type { ProgramTier } from '@/types'
import { TIER_SPECS } from '@/utils/programEngine'
import {
  CURVES,
  FREQ_CURVE,
  JETLAG_CURVE,
  SLEEP_CURVE,
  TIER_JETLAG_TOLERANCE,
  polylinePoints,
  sampleCurve,
  toX,
  toY,
  type CurveBand,
  type CurveSpec,
} from '@/utils/programCurves'

/**
 * 档位科学依据：把三条研究曲线做成可切换的解释视图。
 *
 * 目的不是科普，而是回答「为什么频次这样安排」——研究里的 2~3 次/周
 * 指同一肌群每周被练到的次数，方案用分化（全身×3 / 上下×2 / 推拉腿混排）保证；
 * 01 的对比矩阵给的是数字差异，这里给的是差异背后的证据。
 */
const props = defineProps<{
  open: boolean
  /** 当前选中/生效的档位，用于在曲线与表格上高亮该档的位置 */
  tier: ProgramTier
}>()

const emit = defineEmits<{ close: [] }>()

const TAB_LABEL: Record<string, string> = {
  freq: '训练频次',
  sleep: '睡眠时长',
  jetlag: '社交时差',
}

const tab = ref('freq')
const options = CURVES.map((c) => ({ value: c.key, label: TAB_LABEL[c.key] ?? c.key }))
const curve = computed<CurveSpec>(() => CURVES.find((c) => c.key === tab.value) ?? CURVES[0]!)

/* ---------------- 画布坐标 ---------------- */

const PLOT = { left: 34, top: 14, width: 288, height: 114 }
const Y_MAX = 100

const axis = computed(() => {
  const ticks = curve.value.ticks
  return { xMin: ticks[0] ?? 0, xMax: ticks[ticks.length - 1] ?? 1, yMax: Y_MAX }
})

const xOf = (x: number): number => toX(PLOT, axis.value, x)
const yOf = (v: number): number => toY(PLOT, Y_MAX, v)

const gridLines = computed(() => [100, 75, 50, 25, 0].map((v) => ({ v, y: yOf(v) })))

const strengthPoints = computed(() => polylinePoints(curve.value, PLOT, axis.value, 'strength'))
const musclePoints = computed(() => polylinePoints(curve.value, PLOT, axis.value, 'muscle'))

const markerList = computed(() => curve.value.markers ?? [])

/* ---------------- 图上的标记点 ---------------- */

interface Mark {
  x: number
  label: string
  sub: string
  /** 是否为当前档位（高亮） */
  on: boolean
}

const TIERS: ProgramTier[] = ['conservative', 'balanced', 'aggressive']

const marks = computed<Mark[]>(() => {
  const c = curve.value
  // 频次曲线的横轴是「同一肌群每周被练到的次数」；所有档位的分化设计都落在此窗口内
  if (c.key === 'freq') {
    return [
      { x: 2, label: '设计下限', sub: '每肌群 ≥2 次/周', on: true },
      { x: 3, label: '三练档', sub: '全身×3', on: false },
    ]
  }
  if (c.key === 'sleep') {
    return [{ x: 8, label: '推荐', sub: '7.5-8h', on: true }]
  }
  return []
})

/* ---------------- 曲线下方的要点表 ---------------- */

type RowTone = CurveBand['tone'] | 'muted'

interface Row {
  label: string
  value: string
  tone: RowTone
}

const rows = computed<Row[]>(() => {
  const c = curve.value

  if (c.key === 'freq') {
    const at2 = sampleCurve(FREQ_CURVE, 2)
    const at3 = sampleCurve(FREQ_CURVE, 3)
    return [
      {
        label: '分化设计下限 · 每个肌群',
        value: `≥2 次/周 · 肌肉 ${at2.muscle}%`,
        tone: 'best' as RowTone,
      },
      { label: '三练档 · 全身×3', value: `3 次/周 · 肌肉 ${at3.muscle}%`, tone: 'muted' as RowTone },
      { label: '四练及以上 · 上下/推拉腿混排', value: '2~3 次/周', tone: 'muted' as RowTone },
    ]
  }

  if (c.key === 'sleep') {
    const at = (h: number): number => sampleCurve(SLEEP_CURVE, h).strength
    return [
      { label: '< 5h 严重剥夺', value: `力量 ${at(5)}%`, tone: 'risk' },
      { label: '6h 合成代谢抵抗', value: `力量 ${at(6)}%`, tone: 'warn' },
      { label: '7-8h 黄金窗口', value: `力量 ${at(8)}%`, tone: 'best' },
      { label: '10h+ U 型右端', value: `力量 ${at(10)}%`, tone: 'warn' },
    ]
  }

  const at = (h: number): number => sampleCurve(JETLAG_CURVE, h).strength
  return [
    { label: '≤ 1h 规律', value: `力量 ${at(1)}%`, tone: 'best' as RowTone },
    { label: '2h 抑制阈值', value: `力量 ${at(2)}%`, tone: 'warn' as RowTone },
    { label: '3h 中度失调', value: `力量 ${at(3)}%`, tone: 'risk' as RowTone },
    ...TIERS.map((t) => ({
      label: `${TIER_SPECS[t].label}档耐受`,
      value: `≤ ${TIER_JETLAG_TOLERANCE[t]}h`,
      tone: t === props.tier ? ('best' as RowTone) : ('muted' as RowTone),
    })),
  ]
})

const tableTitle = computed(() => {
  if (curve.value.key === 'freq') return '频次设计落点'
  if (curve.value.key === 'sleep') return '关键发现'
  return '时差影响与档位耐受度'
})

const bandFill = (tone: CurveBand['tone']): string => {
  if (tone === 'best') return 'var(--ok)'
  if (tone === 'good') return 'var(--c-exercise)'
  if (tone === 'warn') return 'var(--warn)'
  return 'var(--danger)'
}

const bandX = (b: CurveBand): number => xOf(b.from)
const bandW = (b: CurveBand): number => Math.max(0, xOf(b.to) - xOf(b.from))

/** 曲线上某点的力量值（用于把标记圆点画在曲线上） */
const strengthAt = (x: number): number => sampleCurve(curve.value, x).strength
</script>

<template>
  <SheetModal :open="open" title="为什么是这样" initial-snap="large" @close="emit('close')">
    <div class="ev">
      <SegmentedControl v-model="tab" :options="options" />

      <section class="card">
        <header class="card-head">
          <b>{{ curve.title }}</b>
          <span class="unit">{{ curve.axisLabel }}</span>
        </header>

        <svg class="chart" viewBox="0 0 330 176" role="img" :aria-label="curve.title">
          <!-- 背景分区 -->
          <rect
            v-for="(b, i) in curve.bands"
            :key="`b${i}`"
            :x="bandX(b)"
            :y="PLOT.top"
            :width="bandW(b)"
            :height="PLOT.height"
            :fill="bandFill(b.tone)"
            :opacity="b.tone === 'best' ? 0.18 : 0.1"
          />

          <!-- 网格与坐标轴 -->
          <line
            v-for="g in gridLines"
            :key="`g${g.v}`"
            :x1="PLOT.left"
            :y1="g.y"
            :x2="PLOT.left + PLOT.width"
            :y2="g.y"
            stroke="var(--line-strong)"
            stroke-width="0.5"
            stroke-dasharray="2 3"
          />
          <line
            :x1="PLOT.left"
            :y1="PLOT.top"
            :x2="PLOT.left"
            :y2="PLOT.top + PLOT.height"
            stroke="var(--line-strong)"
            stroke-width="0.5"
          />
          <line
            :x1="PLOT.left"
            :y1="PLOT.top + PLOT.height"
            :x2="PLOT.left + PLOT.width"
            :y2="PLOT.top + PLOT.height"
            stroke="var(--line-strong)"
            stroke-width="0.5"
          />

          <!-- 阈值 / 峰值竖线 -->
          <template v-for="m in markerList" :key="`k${m.at}`">
            <line
              :x1="xOf(m.at)"
              :y1="PLOT.top"
              :x2="xOf(m.at)"
              :y2="PLOT.top + PLOT.height"
              stroke="var(--warn)"
              stroke-width="1"
              stroke-dasharray="3 3"
              opacity="0.7"
            />
            <text
              :x="xOf(m.at)"
              :y="PLOT.top + 9"
              text-anchor="middle"
              font-size="9"
              font-weight="700"
              fill="var(--warn)"
            >
              {{ m.label }}
            </text>
          </template>

          <!-- 两条曲线 -->
          <polyline
            :points="strengthPoints"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <polyline
            :points="musclePoints"
            fill="none"
            stroke="var(--c-protein)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.85"
          />

          <!-- 档位 / 推荐标记 -->
          <template v-for="mk in marks" :key="`m${mk.label}`">
            <line
              :x1="xOf(mk.x)"
              :y1="PLOT.top"
              :x2="xOf(mk.x)"
              :y2="PLOT.top + PLOT.height"
              :stroke="mk.on ? 'var(--accent)' : 'var(--line-strong)'"
              :stroke-width="mk.on ? 2 : 1"
              :stroke-dasharray="mk.on ? '3 2' : '2 2'"
            />
            <circle
              :cx="xOf(mk.x)"
              :cy="yOf(strengthAt(mk.x))"
              :r="mk.on ? 4.5 : 3.5"
              :fill="mk.on ? 'var(--accent)' : 'var(--text-3)'"
              :stroke="mk.on ? 'var(--surface)' : 'none'"
              :stroke-width="mk.on ? 1.5 : 0"
            />
          </template>

          <!-- 纵轴刻度 -->
          <text
            v-for="g in gridLines"
            :key="`y${g.v}`"
            :x="PLOT.left - 5"
            :y="g.y + 3"
            text-anchor="end"
            font-size="8"
            fill="var(--text-3)"
          >
            {{ g.v }}
          </text>

          <!-- 横轴刻度 -->
          <text
            v-for="t in curve.ticks"
            :key="`x${t}`"
            :x="xOf(t)"
            :y="PLOT.top + PLOT.height + 14"
            text-anchor="middle"
            font-size="8"
            fill="var(--text-3)"
          >
            {{ t }}
          </text>

          <!-- 标记文字 -->
          <template v-for="mk in marks" :key="`mt${mk.label}`">
            <text
              :x="xOf(mk.x)"
              :y="PLOT.top + PLOT.height + 29"
              text-anchor="middle"
              font-size="9"
              :font-weight="mk.on ? 700 : 600"
              :fill="mk.on ? 'var(--accent)' : 'var(--text-2)'"
            >
              {{ mk.label }}
            </text>
            <text
              :x="xOf(mk.x)"
              :y="PLOT.top + PLOT.height + 40"
              text-anchor="middle"
              font-size="8"
              :font-weight="mk.on ? 600 : 400"
              :fill="mk.on ? 'var(--accent)' : 'var(--text-3)'"
            >
              {{ mk.sub }}
            </text>
          </template>
        </svg>

        <ul class="legend">
          <li><i class="sw" style="background: var(--accent)" />力量</li>
          <li><i class="sw" style="background: var(--c-protein)" />肌肉</li>
          <li v-for="(b, i) in curve.bands" :key="`l${i}`">
            <i class="sw" :style="{ background: bandFill(b.tone), opacity: 0.5 }" />{{ b.label }}
          </li>
        </ul>
      </section>

      <section class="card">
        <header class="card-head">
          <b>{{ tableTitle }}</b>
        </header>
        <ul class="rows num">
          <li v-for="r in rows" :key="r.label" :class="r.tone">
            <span class="rl">{{ r.label }}</span>
            <span class="rv">{{ r.value }}</span>
          </li>
        </ul>
      </section>

      <p class="note">{{ curve.conclusion }}</p>

      <p v-if="curve.key === 'jetlag'" class="note sub">
        社交时差 = 工作日与休息日「睡眠中点」的差值。当前版本尚未记录睡眠数据，
        这里只展示其与档位选择的关系；接入睡眠记录后即可把你的位置标到曲线上。
      </p>

      <button class="primary" @click="emit('close')">明白了</button>
    </div>
  </SheetModal>
</template>

<style scoped>
.ev {
  display: grid;
  gap: 12px;
  padding-bottom: 20px;
}

.card {
  padding: 13px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.card-head b {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.unit {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.chart {
  display: block;
  width: 100%;
  height: auto;
}

.legend {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 3px 11px;
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.sw {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex: none;
}

.rows {
  display: grid;
  gap: 7px;
}

.rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-caption);
}

.rows li.best {
  background: var(--accent-soft);
}

.rl {
  font-weight: 600;
  color: var(--text-1);
}

.rv {
  color: var(--text-2);
  white-space: nowrap;
}

.rows li.best .rv {
  color: var(--accent);
  font-weight: 700;
}

.rows li.risk .rv {
  color: var(--danger);
  font-weight: 600;
}

.rows li.warn .rv {
  color: var(--warn);
  font-weight: 600;
}

.note {
  font-size: var(--fs-footnote);
  color: var(--text-2);
  line-height: 1.6;
}

.note.sub {
  font-size: var(--fs-micro);
  color: var(--text-3);
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
</style>
