<script setup lang="ts">
import { computed } from 'vue'
import { Activity, TrendingDown, TrendingUp } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import {
  formatMetricDay,
  formatMetricValue,
  lastLocalDays,
  type HealthMetricMeta,
} from '@/config/healthMetrics'
import type { HealthMetricSeries } from '@/types'

/**
 * 体征指标详情抽屉（预览卡点某个指标行打开）。
 *
 * 上半是趋势图 + 窗口统计，下半是**raw 数据列表** —— 镜像表里这个指标的
 * 全部按天聚合行（近 90 天窗口），一天一行、含较前一天的增量。
 * 趋势图画法与历史列表语言沿用 BodyTrackerCard（体重追踪）那套既定口径，
 * 数据形状换成通用的 `(day, value)` 序列。
 */
const props = defineProps<{
  open: boolean
  meta: HealthMetricMeta | null
  series: HealthMetricSeries | null
}>()

const emit = defineEmits<{ close: [] }>()

/* ---- 窗口统计 ---- */
const stats = computed(() => {
  const pts = props.series?.points ?? []
  if (!pts.length || !props.meta) return null
  const vs = pts.map((p) => p.value)
  const fmt = (v: number) => formatMetricValue(props.meta!, v)
  return {
    count: pts.length,
    latest: fmt(props.series!.latestValue),
    latestDay: formatMetricDay(props.series!.latestDay),
    min: fmt(Math.min(...vs)),
    max: fmt(Math.max(...vs)),
    avg: fmt(vs.reduce((a, b) => a + b, 0) / vs.length),
  }
})

/* ---- 趋势图（与 BodyTrackerCard 同一画法：折线 + 渐变面积 + 末点） ---- */
const CHART_W = 320
const CHART_H = 96
const PAD_X = 5
const PAD_Y = 14

const trendGeom = computed(() => {
  const pts = props.series?.points ?? []
  if (pts.length < 2) return null
  const vs = pts.map((p) => p.value)
  const min = Math.min(...vs)
  const max = Math.max(...vs)
  const span = Math.max(max - min, Math.abs(max) * 0.02, 0.8)
  const lo = min - span * 0.12
  const hi = max + span * 0.12
  const x = (i: number) => PAD_X + (i * (CHART_W - PAD_X * 2)) / (pts.length - 1)
  const y = (v: number) => PAD_Y + ((hi - v) / (hi - lo)) * (CHART_H - PAD_Y * 2)
  return {
    points: pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' '),
    area: `M${x(0).toFixed(1)},${y(vs[0]!).toFixed(1)} ${pts
      .map((p, i) => `L${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
      .join(' ')} L${x(pts.length - 1).toFixed(1)},${CHART_H} L${x(0).toFixed(1)},${CHART_H} Z`,
    last: { x: x(pts.length - 1), y: y(vs[vs.length - 1]!) },
    from: formatMetricDay(pts[0]!.day),
    to: formatMetricDay(pts[pts.length - 1]!.day),
  }
})

/* ---- raw 数据列表：新 → 旧，每行带较前一天的增量 ---- */
interface RawRow {
  day: string
  display: string
  today: boolean
  delta: number | null
}

const rawRows = computed<RawRow[]>(() => {
  const pts = props.series?.points ?? []
  const today = lastLocalDays(1)[0]!
  return [...pts]
    .reverse()
    .map((p, i) => {
      const prev = pts[pts.length - 1 - i - 1] // 升序里它前一个 = 更早的一天
      const delta =
        prev != null ? Math.round((p.value - prev.value) * 10) / 10 : null
      return {
        day: p.day,
        display: formatMetricValue(props.meta!, p.value),
        today: p.day === today,
        delta: delta != null && delta !== 0 ? delta : null,
      }
    })
})
</script>

<template>
  <SheetModal
    :open="open"
    :title="meta?.label ?? '指标详情'"
    initial-snap="large"
    @close="emit('close')"
  >
    <EmptyState
      v-if="!stats"
      :icon="Activity"
      title="还没有数据"
      hint="先同步一次，这里会显示读到的原始数据"
    />
    <div v-else class="detail">
      <!-- 窗口统计：主格 2×2，右侧四格 -->
      <ul class="stats">
        <li class="main">
          <em>最新 · {{ stats.latestDay }}</em>
          <b class="num">{{ stats.latest }}<i v-if="meta?.unit">{{ meta.unit }}</i></b>
        </li>
        <li><em>最低</em><b class="num">{{ stats.min }}</b></li>
        <li><em>最高</em><b class="num">{{ stats.max }}</b></li>
        <li><em>平均</em><b class="num">{{ stats.avg }}</b></li>
        <li><em>有数据</em><b class="num">{{ stats.count }} 天</b></li>
      </ul>

      <!-- 趋势 -->
      <figure v-if="trendGeom" class="trend">
        <figcaption class="num">
          <span>近 {{ stats.count }} 天有数据</span>
          <span>{{ trendGeom.from }} — {{ trendGeom.to }}</span>
        </figcaption>
        <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="hm-trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.22" />
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path :d="trendGeom.area" fill="url(#hm-trend-fill)" />
          <polyline
            :points="trendGeom.points"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <circle :cx="trendGeom.last.x" :cy="trendGeom.last.y" r="3.2" fill="var(--accent)" />
        </svg>
        <span class="axis num"><i>{{ trendGeom.from }}</i><i>{{ trendGeom.to }}</i></span>
      </figure>
      <p v-else class="trend-note">只有一天数据，还画不出趋势</p>

      <!-- raw 数据 -->
      <h3 class="rtitle">原始数据</h3>
      <ul class="raw">
        <li v-for="row in rawRows" :key="row.day">
          <span class="date num">
            {{ formatMetricDay(row.day) }}
            <i v-if="row.today">今天</i>
          </span>
          <span class="delta num">
            <template v-if="row.delta !== null">
              <TrendingDown v-if="row.delta < 0" :size="12" />
              <TrendingUp v-else :size="12" />
              {{ row.delta > 0 ? '+' : '' }}{{ row.delta }}
            </template>
          </span>
          <span class="val num">
            {{ row.display }}<i v-if="meta?.unit"> {{ meta.unit }}</i>
          </span>
        </li>
      </ul>
      <p class="fnote">以 Health Connect 为准，每次同步整表刷新</p>
    </div>
  </SheetModal>
</template>

<style scoped>
/* 窗口统计（BodyTrackerCard 同款四格） */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.stats li {
  padding: 9px 10px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  min-width: 0;
}

.stats li.main {
  grid-column: span 2;
  grid-row: span 2;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: var(--accent-soft);
}

.stats em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.stats li.main em {
  color: var(--accent);
}

.stats b {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stats li.main b {
  font-size: var(--fs-title1);
}

.stats b i {
  font-style: normal;
  font-weight: 400;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: 2px;
}

/* 趋势图 */
.trend {
  margin: 14px 0 0;
}

.trend figcaption {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.trend svg {
  display: block;
  width: 100%;
  height: 96px;
  margin-top: 6px;
}

.axis {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.axis i {
  font-style: normal;
}

.trend-note {
  margin-top: 12px;
  color: var(--text-3);
  font-size: var(--fs-caption);
}

/* raw 数据列表（BodyTrackerCard 历史列表同款语言） */
.rtitle {
  margin-top: 16px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.raw {
  margin-top: 2px;
}

.raw > * + * {
  border-top: 0.5px solid var(--line);
}

.raw li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 14px;
  padding: 9px 0;
}

.raw .date {
  font-size: var(--fs-subhead);
  font-weight: 500;
}

.raw .date i {
  font-style: normal;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.raw .delta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  justify-self: end;
}

.raw .val {
  font-size: var(--fs-subhead);
  font-weight: 600;
  min-width: 72px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.raw .val i {
  font-style: normal;
  font-weight: 400;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.fnote {
  margin-top: 10px;
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
