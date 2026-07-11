<script setup lang="ts">
/**
 * MultiLineChart — 多系列折线图 (multi-series smooth line chart).
 *
 * Use case: compare multiple metrics over the same x-axis (e.g. calories /
 * carbs / protein / fat over a week or month), with an optional reference
 * line representing a target intake (100%).
 *
 * Reference line semantics:
 *   The reference line (target) renders at `referenceRatioFromTop` (default
 *   0.3) from the TOP of the plot area. When `yMax` is not provided we
 *   compute it so that `referenceLine.value` maps to that vertical position:
 *     yHi = yLo + (referenceLine.value - yLo) / (1 - referenceRatioFromTop)
 *   (with yMin=0 this simplifies to referenceLine.value / (1 - ratio)).
 *   When `yMax` is provided we keep the user scale and just draw the line at
 *   the ratio position from the top.
 *
 * Props:
 *   series      — { data: number[]; color: string; label?: string }[]
 *   labels      — x-axis labels (shown at start/middle/end)
 *   height      — plot area height (default 60)
 *   referenceLine        — optional { value, color, label, dashed }
 *   referenceRatioFromTop — 0..1, position of ref line from top (default 0.3)
 *   yMin / yMax — override value range
 *   smooth      — smooth curve via catmull-rom (default true)
 *   showLegend  — render legend chips above chart (default false)
 *   showYAxis   — render y labels + baseline (default false)
 *   showGrid    — faint horizontal grid (default false)
 *
 * SVG viewBox with responsive width; font scaling by height like LineChart.
 * LTTB downsample per series when > 30 points. HarmonyOS style.
 */
import { computed } from "vue";

export interface MultiSeries {
  data: number[];
  color: string;
  label?: string;
}

export interface MultiReferenceLine {
  value: number;
  color?: string;
  label?: string;
  dashed?: boolean;
}

const props = withDefaults(
  defineProps<{
    series: MultiSeries[];
    labels?: string[];
    height?: number;
    referenceLine?: MultiReferenceLine | null;
    referenceRatioFromTop?: number;
    yMin?: number;
    yMax?: number;
    smooth?: boolean;
    showLegend?: boolean;
    showYAxis?: boolean;
    showGrid?: boolean;
  }>(),
  {
    labels: () => [],
    height: 60,
    referenceLine: null,
    referenceRatioFromTop: 0.3,
    yMin: null as unknown as number,
    yMax: null as unknown as number,
    smooth: true,
    showLegend: false,
    showYAxis: false,
    showGrid: false,
  },
);

/** Font scale from height prop, clamped to readable bounds. */
const FONT_BASE_H = 60;
const STROKE_BASE_H = 60;
const DOWNSAMPLE_THRESHOLD = 30;
const fontScale = computed(() => {
  const s = props.height / FONT_BASE_H;
  return Math.min(Math.max(s, 0.7), 2.2);
});
const scaledStroke = computed(() => {
  const s = props.height / STROKE_BASE_H;
  return 2 * Math.min(Math.max(s, 0.7), 2.2);
});

const maxLen = computed(() =>
  props.series.reduce((m, s) => Math.max(m, s.data.length), 0),
);

const dataMaxAll = computed(() => {
  let m = -Infinity;
  for (const s of props.series) {
    for (const v of s.data) if (v > m) m = v;
  }
  return Number.isFinite(m) ? Math.max(m, 1) : 1;
});

const yLo = computed(() =>
  props.yMin !== null && props.yMin !== undefined ? props.yMin : 0,
);
const yHi = computed(() => {
  if (props.yMax !== null && props.yMax !== undefined) return props.yMax;
  if (props.referenceLine) {
    const ratio = Math.min(Math.max(props.referenceRatioFromTop, 0.01), 0.99);
    const v = props.referenceLine.value;
    const lo = yLo.value;
    // range = (v - lo) / (1 - ratio); yHi = lo + range
    const range = (v - lo) / (1 - ratio);
    return lo + Math.max(range, 1);
  }
  return dataMaxAll.value;
});
const yRange = computed(() => Math.max(yHi.value - yLo.value, 1));

const PAD_L = computed(() => (props.showYAxis ? 30 : 0));
const PAD_B = computed(() => (props.labels.length > 0 ? 16 : 4));
const PAD_R = computed(() => (maxLen.value > DOWNSAMPLE_THRESHOLD ? 6 : 2));
const VB_W = 200;
const VB_H = computed(() => props.height + PAD_B.value + 6);

function xAt(i: number): number {
  const plotW = VB_W - PAD_L.value - PAD_R.value;
  if (maxLen.value <= 1) return PAD_L.value + plotW / 2;
  return PAD_L.value + (plotW * i) / (maxLen.value - 1);
}
function yAt(v: number): number {
  return VB_H.value - PAD_B.value - ((v - yLo.value) / yRange.value) * props.height;
}

/** Reference line drawn at `referenceRatioFromTop` from the top of plot area. */
function refY(): number | null {
  if (!props.referenceLine) return null;
  const ratio = Math.min(Math.max(props.referenceRatioFromTop, 0.01), 0.99);
  return VB_H.value - PAD_B.value - props.height + ratio * props.height;
}

/**
 * LTTB (Largest Triangle Three Buckets) downsample for visual shape preservation.
 * Returns indices into source array. Always keeps first/last point.
 */
function lttbIndices(values: number[], threshold: number): number[] {
  const len = values.length;
  if (len <= threshold) return values.map((_, i) => i);
  const out: number[] = [0];
  const every = (len - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const rangeStart = Math.floor((i + 1) * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * every) + 1, len);
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, len);
    const avgLen = Math.max(avgEnd - avgStart, 1);
    let avgX = 0;
    let avgY = 0;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += j;
      avgY += values[j];
    }
    avgX /= avgLen;
    avgY /= avgLen;
    let maxArea = -1;
    let nextA = rangeStart;
    const ax = a;
    const ay = values[a];
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (ax - avgX) * (values[j] - ay) - (ax - j) * (avgY - ay),
      ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }
    out.push(nextA);
    a = nextA;
  }
  out.push(len - 1);
  return out;
}

interface SampledPoint { v: number; i: number; }

/** Per-series downsampled view with forced inclusion of global min/max. */
function sampleSeries(data: number[]): SampledPoint[] {
  if (data.length <= DOWNSAMPLE_THRESHOLD) {
    return data.map((v, i) => ({ v, i }));
  }
  const idxs = lttbIndices(data, DOWNSAMPLE_THRESHOLD);
  const set = new Set(idxs);
  const minV = Math.min(...data);
  const maxV = Math.max(...data);
  let minIdx = -1;
  let maxIdx = -1;
  for (let i = 0; i < data.length; i++) {
    if (minIdx === -1 && data[i] === minV) minIdx = i;
    if (maxIdx === -1 && data[i] === maxV) maxIdx = i;
  }
  if (minIdx !== -1) set.add(minIdx);
  if (maxIdx !== -1) set.add(maxIdx);
  return Array.from(set).sort((p, q) => p - q).map((i) => ({ v: data[i], i }));
}

interface SeriesView {
  color: string;
  label?: string;
  points: [number, number][];
  linePath: string;
  areaPath: string;
  gradientId: string;
}

/** Catmull-Rom to Bezier for smooth curve. */
function smoothPath(points: [number, number][]): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
  }
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function linearPath(points: [number, number][]): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`)
    .join(" ");
}

const seriesViews = computed<SeriesView[]>(() =>
  props.series.map((s, idx) => {
    const sampled = sampleSeries(s.data);
    const pts: [number, number][] = sampled.map((sp) => [xAt(sp.i), yAt(sp.v)]);
    const line = props.smooth ? smoothPath(pts) : linearPath(pts);
    let area = "";
    // Area fill only for single-series view to keep multi-series readable.
    if (props.series.length === 1 && pts.length > 0) {
      const start = pts[0];
      const end = pts[pts.length - 1];
      const baseY = VB_H.value - PAD_B.value;
      area = `${line} L ${end[0]} ${baseY} L ${start[0]} ${baseY} Z`;
    }
    return {
      color: s.color,
      label: s.label,
      points: pts,
      linePath: line,
      areaPath: area,
      gradientId: `mlc-grad-${idx}`,
    };
  }),
);

const resolvedTicks = computed(() => {
  if (props.labels.length === 0) return [];
  if (maxLen.value <= 1) return [0];
  return [0, Math.floor(maxLen.value / 2), maxLen.value - 1];
});

const gridLines = computed(() => (props.showGrid ? [0, 0.25, 0.5, 0.75, 1] : []));
</script>

<template>
  <div class="mlc-wrap" :style="{ '--fs': fontScale }">
    <div v-if="showLegend && series.length > 0" class="mlc-legend">
      <span
        v-for="(s, i) in series"
        :key="i"
        class="mlc-legend-chip"
      >
        <span class="mlc-legend-dot" :style="{ background: s.color }" />
        <span class="mlc-legend-text">{{ s.label }}</span>
      </span>
    </div>
    <svg
      class="mlc-svg"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      width="100%"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          v-for="sv in seriesViews"
          :key="sv.gradientId"
          :id="sv.gradientId"
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop offset="0%" :stop-color="sv.color" stop-opacity="0.24" />
          <stop offset="100%" :stop-color="sv.color" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- Grid -->
      <template v-if="showGrid">
        <line
          v-for="(g, gi) in gridLines"
          :key="'g' + gi"
          :x1="PAD_L"
          :x2="VB_W - PAD_R"
          :y1="VB_H - PAD_B - g * height"
          :y2="VB_H - PAD_B - g * height"
          stroke="var(--bg-300)"
          stroke-width="0.3"
          stroke-dasharray="1 1"
        />
      </template>

      <!-- X baseline -->
      <line
        v-if="showYAxis"
        :x1="PAD_L"
        :x2="VB_W - PAD_R"
        :y1="VB_H - PAD_B"
        :y2="VB_H - PAD_B"
        stroke="var(--bg-400)"
        stroke-width="0.4"
      />

      <!-- Reference line -->
      <template v-if="referenceLine && refY() !== null">
        <line
          :x1="PAD_L"
          :x2="VB_W - PAD_R"
          :y1="refY()!"
          :y2="refY()!"
          :stroke="referenceLine.color || 'var(--color-danger)'"
          stroke-width="0.6"
          :stroke-dasharray="referenceLine.dashed === false ? '' : '2 1.5'"
        />
        <text
          v-if="referenceLine.label"
          :x="VB_W - PAD_R"
          :y="refY()! - 1.5"
          class="axis-label ref-label"
          text-anchor="end"
        >
          {{ referenceLine.label }}
        </text>
      </template>

      <!-- Y labels -->
      <template v-if="showYAxis">
        <text :x="PAD_L - 3" :y="yAt(yHi) + 2" class="axis-label axis-label-y" text-anchor="end">
          {{ Math.round(yHi) }}
        </text>
        <text :x="PAD_L - 3" :y="VB_H - PAD_B + 3" class="axis-label axis-label-y" text-anchor="end">
          {{ Math.round(yLo) }}
        </text>
      </template>

      <!-- Series: area + line -->
      <template v-for="sv in seriesViews" :key="sv.gradientId">
        <path v-if="sv.areaPath" :d="sv.areaPath" :fill="`url(#${sv.gradientId})`" />
        <path
          :d="sv.linePath"
          fill="none"
          :stroke="sv.color"
          :stroke-width="scaledStroke"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </template>

      <!-- X labels -->
      <text
        v-for="ti in resolvedTicks"
        :key="'l' + ti"
        :x="xAt(ti)"
        :y="VB_H - 3"
        class="axis-label axis-label-x"
        text-anchor="middle"
      >
        {{ labels[ti] }}
      </text>
    </svg>
  </div>
</template>

<style scoped>
.mlc-wrap {
  width: 100%;
  line-height: 0;
}
.mlc-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 2px 6px;
  line-height: 1.4;
}
.mlc-legend-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mlc-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.mlc-legend-text {
  font-size: calc(0.25rem * var(--fs, 1));
  font-weight: var(--fw-medium);
  color: var(--color-text-secondary);
  font-family: var(--font-sans);
}
.mlc-svg {
  display: block;
  overflow: visible;
}
.axis-label {
  fill: var(--color-text-tertiary);
  font-size: calc(0.25rem * var(--fs, 1));
  font-weight: var(--fw-medium);
  font-family: var(--font-sans);
}
.axis-label-y {
  font-size: calc(0.1875rem * var(--fs, 1));
}
.ref-label {
  fill: var(--color-text-secondary);
  font-size: calc(0.25rem * var(--fs, 1));
  font-weight: var(--fw-medium);
}
</style>
