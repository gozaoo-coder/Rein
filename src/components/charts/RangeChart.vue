<script setup lang="ts">
/**
 * RangeChart — 横轴时间+数轴区间图 (24h time-axis with colored zone bands).
 *
 * Background horizontal bands represent value zones (e.g. heart rate:
 * 休息/热身/燃脂/有氧/极限). A time series line overlays showing actual values
 * across x-axis (24h or other range).
 *
 * Use case: heart rate zones, blood pressure ranges, stress levels across day.
 *
 * Props:
 *   data     — number[] (actual values; length aligns with samples across x axis)
 *   zones    — { from: number; to: number; color: string; label?: string }[]
 *              zones are stacked in y-axis (y range auto from min from..max to)
 *   xLabels  — labels at ticks (default ['00:00','06:00','12:00','18:00','24:00'])
 *   xTicks   — normalized positions 0..1 for x labels (default [0,.25,.5,.75,1])
 *   color    — overlay line color
 *   showLine — render the overlay data line (default true)
 *   showArea — fill under data line with translucent color (default false)
 *   showZoneLabels — show zone labels on left side (default false)
 *   showYAxis — render y axis values (default false)
 *   height   — chart plot height (default 56)
 *   smooth   — smooth curve (default true)
 */
import { computed } from "vue";

export interface ChartZone {
  from: number;
  to: number;
  color: string;
  label?: string;
}

const props = withDefaults(
  defineProps<{
    data?: number[];
    zones: ChartZone[];
    xLabels?: string[];
    xTicks?: number[];
    color?: string;
    showLine?: boolean;
    showArea?: boolean;
    showZoneLabels?: boolean;
    showYAxis?: boolean;
    showXAxis?: boolean;
    height?: number;
    smooth?: boolean;
    strokeWidth?: number;
  }>(),
  {
    data: () => [],
    xLabels: () => ["00:00", "06:00", "12:00", "18:00", "24:00"],
    xTicks: () => [0, 0.25, 0.5, 0.75, 1],
    color: undefined,
    showLine: true,
    showArea: false,
    showZoneLabels: false,
    showYAxis: false,
    showXAxis: true,
    height: 56,
    smooth: true,
    strokeWidth: 1.8,
  }
);

const lineColor = computed(() => props.color || "var(--color-danger)");

const yMin = computed(() =>
  Math.min(...props.zones.map((z) => z.from), ...(props.data.length ? props.data : [0]))
);
const yMax = computed(() =>
  Math.max(...props.zones.map((z) => z.to), ...(props.data.length ? props.data : [1]))
);
const yRange = computed(() => Math.max(yMax.value - yMin.value, 1));

const PAD_L = computed(() => {
  if (props.showZoneLabels) return 28;
  if (props.showYAxis) return 22;
  return 0;
});
const PAD_B = computed(() => (props.xLabels.length > 0 ? 16 : 4));
const VB_W = 200;
const VB_H = computed(() => props.height + PAD_B.value + 4);

function plotW() {
  return VB_W - PAD_L.value;
}
function yAt(v: number) {
  return (
    VB_H.value -
    PAD_B.value -
    ((v - yMin.value) / yRange.value) * props.height
  );
}
function xAtRatio(r: number) {
  return PAD_L.value + r * plotW();
}
function xAtSample(i: number, total: number) {
  if (total <= 1) return PAD_L.value + plotW() / 2;
  return PAD_L.value + (plotW() * i) / (total - 1);
}

/** Catmull-Rom smooth path */
function smoothPath(points: [number, number][]): string {
  if (points.length < 2) return "";
  if (points.length === 2)
    return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
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

const dataPoints = computed<[number, number][]>(() => {
  if (!props.data || props.data.length === 0) return [];
  return props.data.map((v, i) => [xAtSample(i, props.data.length), yAt(v)]);
});

const dataPath = computed(() => {
  if (dataPoints.value.length === 0) return "";
  return props.smooth
    ? smoothPath(dataPoints.value)
    : linearPath(dataPoints.value);
});

const areaPath = computed(() => {
  if (dataPoints.value.length === 0 || !props.showArea) return "";
  const start = dataPoints.value[0];
  const end = dataPoints.value[dataPoints.value.length - 1];
  const base = yAt(yMin.value);
  return `${dataPath.value} L ${end[0]} ${base} L ${start[0]} ${base} Z`;
});

function zoneY0(z: ChartZone) {
  return yAt(z.to);
}
function zoneHeight(z: ChartZone) {
  return ((z.to - z.from) / yRange.value) * props.height;
}
</script>

<template>
  <div class="range-chart-wrap">
    <svg
      class="range-chart-svg"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      width="100%"
      aria-hidden="true"
    >
      <!-- Zone bands -->
      <rect
        v-for="(z, i) in zones"
        :key="'z' + i"
        :x="PAD_L"
        :y="zoneY0(z)"
        :width="plotW()"
        :height="zoneHeight(z)"
        :fill="z.color"
        opacity="0.55"
      />

      <!-- Zone labels -->
      <template v-if="showZoneLabels">
        <text
          v-for="(z, i) in zones"
          :key="'zl' + i"
          :x="PAD_L - 3"
          :y="zoneY0(z) + zoneHeight(z) / 2 + 1.5"
          class="axis-label axis-label-y"
          text-anchor="end"
        >
          {{ z.label }}
        </text>
      </template>

      <!-- X baseline -->
      <line
        v-if="showXAxis"
        :x1="PAD_L"
        :x2="VB_W"
        :y1="VB_H - PAD_B"
        :y2="VB_H - PAD_B"
        stroke="var(--bg-400)"
        stroke-width="0.3"
      />

      <!-- Y axis labels -->
      <template v-if="showYAxis">
        <text :x="PAD_L - 3" :y="yAt(yMax) + 1.5" class="axis-label axis-label-y" text-anchor="end">
          {{ Math.round(yMax) }}
        </text>
        <text :x="PAD_L - 3" :y="VB_H - PAD_B + 3" class="axis-label axis-label-y" text-anchor="end">
          {{ Math.round(yMin) }}
        </text>
      </template>

      <!-- Area fill under line -->
      <path v-if="showArea && dataPath" :d="areaPath" :fill="lineColor" opacity="0.2" />

      <!-- Data line -->
      <path
        v-if="showLine && dataPath"
        :d="dataPath"
        fill="none"
        :stroke="lineColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <!-- X labels -->
      <text
        v-for="(lab, i) in xLabels"
        :key="'xl' + i"
        :x="xAtRatio(xTicks[i] ?? i / (xLabels.length - 1))"
        :y="VB_H - 3"
        class="axis-label axis-label-x"
        text-anchor="middle"
      >
        {{ lab }}
      </text>
    </svg>
  </div>
</template>

<style scoped>
.range-chart-wrap {
  width: 100%;
  line-height: 0;
}
.range-chart-svg {
  display: block;
  overflow: visible;
}
.axis-label {
  fill: var(--color-text-tertiary);
  font-size: 3.8px;
  font-family: var(--font-sans);
}
.axis-label-y {
  font-size: 3px;
}
</style>
