<script setup lang="ts">
/**
 * LineChart — 折线图 (smooth line chart).
 *
 * Use case: continuous trend over time (weight, temperature, sleep quality trend).
 * Supports: smooth curve (catmull-rom), optional area fill, point dots,
 * optional reference line, optional axis labels/grid.
 *
 * Props:
 *   data        — number[] (y values, auto-scaled)
 *   color       — line color
 *   fill        — area fill color (gradient to transparent)
 *   smooth      — use smooth curve (default true)
 *   showArea    — fill area under line (default true)
 *   showDots    — render data point circles (default false)
 *   labels      — x-axis labels aligned to points
 *   ticks       — indices to show labels at
 *   showXAxis   — render x baseline (default false)
 *   showYAxis   — render y labels + baseline (default false)
 *   showGrid    — faint horizontal grid (default false)
 *   yMin/yMax   — override value range
 *   yUnit       — unit text for max label
 *   referenceLine — optional { value, color, dashed } horizontal reference
 *   height      — plot area height (default 60)
 *   strokeWidth — line thickness (default 2)
 */
import { computed } from "vue";

export interface ReferenceLine {
  value: number;
  color?: string;
  dashed?: boolean;
}

const props = withDefaults(
  defineProps<{
    data: number[];
    color?: string;
    fill?: string;
    smooth?: boolean;
    showArea?: boolean;
    showDots?: boolean;
    labels?: string[];
    ticks?: number[];
    showXAxis?: boolean;
    showYAxis?: boolean;
    showGrid?: boolean;
    yMin?: number;
    yMax?: number;
    yUnit?: string;
    referenceLine?: ReferenceLine | null;
    height?: number;
    strokeWidth?: number;
  }>(),
  {
    color: undefined,
    fill: undefined,
    smooth: true,
    showArea: true,
    showDots: false,
    labels: () => [],
    ticks: () => [],
    showXAxis: false,
    showYAxis: false,
    showGrid: false,
    yMin: null as unknown as number,
    yMax: null as unknown as number,
    yUnit: "",
    referenceLine: null,
    height: 60,
    strokeWidth: 2,
  }
);

const lineColor = computed(() => props.color || "var(--color-primary)");
const fillColor = computed(() => {
  if (props.fill) return props.fill;
  return "url(#lineGradient)";
});

const n = computed(() => props.data.length);

const dataMin = computed(() => Math.min(...props.data, 0));
const dataMax = computed(() => Math.max(...props.data, 1));
const yLo = computed(() =>
  props.yMin !== null && props.yMin !== undefined ? props.yMin : dataMin.value
);
const yHi = computed(() =>
  props.yMax !== null && props.yMax !== undefined ? props.yMax : dataMax.value
);
const yRange = computed(() => Math.max(yHi.value - yLo.value, 1));

const PAD_L = computed(() => (props.showYAxis ? 30 : 0));
const PAD_B = computed(() => (props.labels.length > 0 ? 16 : 4));
const VB_W = 200;
const VB_H = computed(() => props.height + PAD_B.value + 6);

function xAt(i: number) {
  const plotW = VB_W - PAD_L.value;
  if (n.value <= 1) return PAD_L.value + plotW / 2;
  return PAD_L.value + (plotW * i) / (n.value - 1);
}
function yAt(v: number) {
  return VB_H.value - PAD_B.value - ((v - yLo.value) / yRange.value) * props.height;
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

const points = computed<[number, number][]>(() =>
  props.data.map((v, i) => [xAt(i), yAt(v)])
);

const linePath = computed(() =>
  props.smooth ? smoothPath(points.value) : linearPath(points.value)
);

const areaPath = computed(() => {
  if (!props.showArea || points.value.length === 0) return "";
  const start = points.value[0];
  const end = points.value[points.value.length - 1];
  const baseY = VB_H.value - PAD_B.value;
  return `${linePath.value} L ${end[0]} ${baseY} L ${start[0]} ${baseY} Z`;
});

const resolvedTicks = computed(() => {
  if (props.ticks.length > 0) return props.ticks.filter((t) => t < n.value);
  if (props.labels.length === 0) return [];
  if (n.value <= 1) return [0];
  return [0, Math.floor(n.value / 2), n.value - 1];
});

const gridLines = computed(() => {
  if (!props.showGrid) return [];
  return [0, 0.25, 0.5, 0.75, 1];
});

function refY(): number | null {
  if (!props.referenceLine) return null;
  return yAt(props.referenceLine.value);
}
</script>

<template>
  <div class="line-chart-wrap">
    <svg
      class="line-chart-svg"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      width="100%"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="lineGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="lineColor" stop-opacity="0.28" />
          <stop offset="100%" :stop-color="lineColor" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- Grid -->
      <template v-if="showGrid">
        <line
          v-for="(g, gi) in gridLines"
          :key="gi"
          :x1="PAD_L"
          :x2="VB_W"
          :y1="VB_H - PAD_B - g * height"
          :y2="VB_H - PAD_B - g * height"
          stroke="var(--bg-300)"
          stroke-width="0.3"
          stroke-dasharray="1 1"
        />
      </template>

      <!-- X baseline -->
      <line
        v-if="showXAxis || showYAxis"
        :x1="PAD_L"
        :x2="VB_W"
        :y1="VB_H - PAD_B"
        :y2="VB_H - PAD_B"
        stroke="var(--bg-400)"
        stroke-width="0.4"
      />

      <!-- Reference line -->
      <line
        v-if="referenceLine && refY() !== null"
        :x1="PAD_L"
        :x2="VB_W"
        :y1="refY()!"
        :y2="refY()!"
        :stroke="referenceLine.color || 'var(--color-danger)'"
        stroke-width="0.6"
        :stroke-dasharray="referenceLine.dashed ? '2 1.5' : ''"
      />

      <!-- Y labels -->
      <template v-if="showYAxis">
        <text :x="PAD_L - 3" :y="yAt(yHi) + 2" class="axis-label axis-label-y" text-anchor="end">
          {{ Math.round(yHi) }}{{ yUnit }}
        </text>
        <text :x="PAD_L - 3" :y="VB_H - PAD_B + 3" class="axis-label axis-label-y" text-anchor="end">
          {{ Math.round(yLo) }}
        </text>
      </template>

      <!-- Area fill -->
      <path v-if="showArea" :d="areaPath" :fill="fillColor" />

      <!-- Line -->
      <path
        :d="linePath"
        fill="none"
        :stroke="lineColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <!-- Dots -->
      <circle
        v-if="showDots"
        v-for="(pt, i) in points"
        :key="i"
        :cx="pt[0]"
        :cy="pt[1]"
        r="1.2"
        :fill="lineColor"
      />

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
.line-chart-wrap {
  width: 100%;
  line-height: 0;
}
.line-chart-svg {
  display: block;
  overflow: visible;
}
.axis-label {
  fill: var(--color-text-tertiary);
  font-size: 4px;
  font-family: var(--font-sans);
}
.axis-label-y {
  font-size: 3.2px;
}
</style>
