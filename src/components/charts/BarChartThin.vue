<script setup lang="ts">
/**
 * BarChartThin — 细条直线柱图 (thin vertical bars).
 *
 * Use case: time-series with many samples where each bar is narrow
 * (e.g. hourly calories, steps per hour, minutes listened per hour).
 * X axis = time labels; Y axis = value magnitude.
 *
 * Props:
 *   data       — array of numbers (bar heights; auto-normalized to max)
 *   color      — bar color (CSS color); default warm coral
 *   labels     — optional x-axis labels (shown at start/middle/end or ticks)
 *   xLabels    — explicit array of label strings aligned 1:1 with data (used if ticks provided)
 *   ticks      — indices to show labels at (default: [0, Math.floor(n/2), n-1])
 *   showYAxis  — render y-axis baseline + unit labels (default false)
 *   showGrid   — render faint horizontal grid lines (default false)
 *   yMax       — override max value for normalization (default: Math.max(...data))
 *   yUnit      — unit text shown next to top y-label (e.g. "千卡")
 *   height     — chart area height in px (default 48)
 *   barRadius  — top corner radius (default 2)
 *   gapRatio   — gap between bars as fraction of bar width (default 0.6)
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    data: number[];
    color?: string;
    labels?: string[];
    ticks?: number[];
    showYAxis?: boolean;
    showGrid?: boolean;
    yMax?: number;
    yUnit?: string;
    height?: number;
    barRadius?: number;
    gapRatio?: number;
  }>(),
  {
    color: undefined,
    labels: () => [],
    ticks: () => [],
    showYAxis: false,
    showGrid: false,
    yMax: 0,
    yUnit: "",
    height: 48,
    barRadius: 2,
    gapRatio: 0.6,
  }
);

const effectiveColor = computed(() => props.color || "var(--color-warm)");
const maxVal = computed(() =>
  props.yMax > 0 ? props.yMax : Math.max(...props.data, 1)
);
const n = computed(() => props.data.length);

/** Font scale from height prop, clamped to readable bounds. */
const FONT_BASE_H = 48;
const fontScale = computed(() => {
  const s = props.height / FONT_BASE_H;
  return Math.min(Math.max(s, 0.7), 2.2);
});

const AXIS_PAD_LEFT = computed(() => (props.showYAxis ? 28 : 0));
const AXIS_PAD_BOTTOM = computed(() => (props.labels.length > 0 ? 16 : 0));

const VB_W = 100;
const VB_H = computed(
  () => props.height + AXIS_PAD_BOTTOM.value + (props.showYAxis ? 0 : 0)
);

function xPos(i: number) {
  const plotW = VB_W - AXIS_PAD_LEFT.value;
  if (n.value <= 1) return AXIS_PAD_LEFT.value + plotW / 2;
  const gap = plotW / n.value;
  return AXIS_PAD_LEFT.value + gap * (i + 0.5);
}

function barWidth() {
  const plotW = VB_W - AXIS_PAD_LEFT.value;
  const gap = plotW / n.value;
  return gap / (1 + props.gapRatio);
}

function barH(v: number) {
  const ratio = v / maxVal.value;
  return Math.max(ratio * props.height, props.barRadius);
}

function yTop(v: number) {
  return VB_H.value - AXIS_PAD_BOTTOM.value - barH(v);
}

const resolvedTicks = computed(() => {
  if (props.ticks.length > 0) return props.ticks.filter((t) => t < n.value);
  if (props.labels.length === 0) return [];
  if (n.value <= 1) return [0];
  return [0, Math.floor(n.value / 2), n.value - 1];
});

function labelForTick(i: number) {
  if (props.labels[i] !== undefined) return props.labels[i];
  return "";
}

const gridLines = computed(() => {
  if (!props.showGrid) return [];
  return [0.25, 0.5, 0.75, 1];
});
</script>

<template>
  <div class="bar-thin-wrap" :style="{ '--fs': fontScale }">
    <svg
      class="bar-thin-svg"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      preserveAspectRatio="none"
      width="100%"
      aria-hidden="true"
    >
      <!-- Horizontal grid lines -->
      <template v-if="showGrid">
        <line
          v-for="(g, gi) in gridLines"
          :key="'g' + gi"
          :x1="AXIS_PAD_LEFT"
          :x2="VB_W"
          :y1="VB_H - AXIS_PAD_BOTTOM - g * height"
          :y2="VB_H - AXIS_PAD_BOTTOM - g * height"
          stroke="var(--bg-300)"
          stroke-width="0.3"
          stroke-dasharray="0.8 0.8"
        />
      </template>

      <!-- Y axis baseline -->
      <line
        v-if="showYAxis"
        :x1="AXIS_PAD_LEFT"
        :x2="VB_W"
        :y1="VB_H - AXIS_PAD_BOTTOM"
        :y2="VB_H - AXIS_PAD_BOTTOM"
        stroke="var(--bg-400)"
        stroke-width="0.4"
      />

      <!-- Y axis unit labels -->
      <template v-if="showYAxis">
        <text :x="AXIS_PAD_LEFT - 2" :y="VB_H - AXIS_PAD_BOTTOM - height + 2" class="axis-label axis-label-y" text-anchor="end">
          {{ Math.round(maxVal) }}{{ yUnit }}
        </text>
        <text :x="AXIS_PAD_LEFT - 2" :y="VB_H - AXIS_PAD_BOTTOM + 3" class="axis-label axis-label-y" text-anchor="end">
          0
        </text>
      </template>

      <!-- Bars -->
      <rect
        v-for="(v, i) in data"
        :key="i"
        :x="xPos(i) - barWidth() / 2"
        :y="yTop(v)"
        :width="barWidth()"
        :height="barH(v)"
        :rx="barRadius"
        :ry="barRadius"
        :fill="effectiveColor"
        :opacity="v > 0 ? 1 : 0.15"
      />

      <!-- X axis labels -->
      <text
        v-for="ti in resolvedTicks"
        :key="'l' + ti"
        :x="xPos(ti)"
        :y="VB_H - 2"
        class="axis-label axis-label-x"
        text-anchor="middle"
      >
        {{ labelForTick(ti) }}
      </text>
    </svg>
  </div>
</template>

<style scoped>
.bar-thin-wrap {
  width: 100%;
  line-height: 0;
}
.bar-thin-svg {
  display: block;
  overflow: visible;
}
.axis-label {
  fill: var(--color-text-tertiary);
  font-size: calc(4px * var(--fs, 1));
  font-weight: var(--fw-medium);
  font-family: var(--font-sans);
}
.axis-label-y {
  font-size: calc(3px * var(--fs, 1));
}
</style>
