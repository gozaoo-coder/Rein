<script setup lang="ts">
/**
 * BarChartThick — 粗条直线柱图 (thick rounded bars).
 *
 * Use case: small number of prominent aggregate bars (1-7 bars),
 * e.g. PAI by week, vitality score, moderate-high intensity minutes by day.
 * X axis = categories/time labels; Y axis = magnitude.
 *
 * Props:
 *   data       — { value: number; label?: string; color?: string }[]
 *   color      — default bar color (can be overridden per-bar)
 *   showYAxis  — y axis baseline + top label (default false)
 *   showXLabels— show x labels below bars (default true when data has labels)
 *   showGrid   — faint horizontal grid (default false)
 *   yMax       — override max value
 *   yUnit      — unit label at top (e.g. "分")
 *   height     — chart plot height (default 60)
 *   barRadius  — corner radius (default 6)
 *   gapRatio   — gap : bar ratio (default 0.35; smaller = wider bars)
 */
import { computed } from "vue";

export interface ThickBar {
  value: number;
  label?: string;
  color?: string;
}

const props = withDefaults(
  defineProps<{
    data: ThickBar[];
    color?: string;
    showYAxis?: boolean;
    showXLabels?: boolean;
    showGrid?: boolean;
    yMax?: number;
    yUnit?: string;
    height?: number;
    barRadius?: number;
    gapRatio?: number;
  }>(),
  {
    color: undefined,
    showYAxis: false,
    showXLabels: true,
    showGrid: false,
    yMax: 0,
    yUnit: "",
    height: 60,
    barRadius: 6,
    gapRatio: 0.35,
  }
);

const defaultColor = computed(() => props.color || "var(--color-warm)");
const n = computed(() => props.data.length);
const maxVal = computed(() => {
  if (props.yMax > 0) return props.yMax;
  return Math.max(...props.data.map((d) => d.value), 1);
});

/** Font scale from height prop, clamped to readable bounds. */
const FONT_BASE_H = 60;
const fontScale = computed(() => {
  const s = props.height / FONT_BASE_H;
  return Math.min(Math.max(s, 0.7), 2.2);
});

const AXIS_PAD_LEFT = computed(() => (props.showYAxis ? 28 : 0));
const PAD_BOTTOM = computed(() => (props.showXLabels ? 18 : 4));
const VB_W = 100;
const VB_H = computed(() => props.height + PAD_BOTTOM.value + 4);

function xCenter(i: number) {
  const plotW = VB_W - AXIS_PAD_LEFT.value;
  if (n.value <= 1) return AXIS_PAD_LEFT.value + plotW / 2;
  const slot = plotW / n.value;
  return AXIS_PAD_LEFT.value + slot * (i + 0.5);
}

function barW() {
  const plotW = VB_W - AXIS_PAD_LEFT.value;
  const slot = plotW / n.value;
  return slot / (1 + props.gapRatio);
}

function bHeight(v: number) {
  return Math.max((v / maxVal.value) * props.height, props.barRadius);
}
function bTop(v: number) {
  return VB_H.value - PAD_BOTTOM.value - bHeight(v);
}

const hasLabels = computed(() =>
  props.showXLabels && props.data.some((d) => d.label)
);

const gridLines = computed(() => {
  if (!props.showGrid) return [];
  return [0.5, 1];
});
</script>

<template>
  <div class="bar-thick-wrap" :style="{ '--fs': fontScale }">
    <svg
      class="bar-thick-svg"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      width="100%"
      aria-hidden="true"
    >
      <template v-if="showGrid">
        <line
          v-for="(g, gi) in gridLines"
          :key="gi"
          :x1="AXIS_PAD_LEFT"
          :x2="VB_W"
          :y1="VB_H - PAD_BOTTOM - g * height"
          :y2="VB_H - PAD_BOTTOM - g * height"
          stroke="var(--bg-300)"
          stroke-width="0.3"
          stroke-dasharray="1 1"
        />
      </template>

      <line
        v-if="showYAxis"
        :x1="AXIS_PAD_LEFT"
        :x2="VB_W"
        :y1="VB_H - PAD_BOTTOM"
        :y2="VB_H - PAD_BOTTOM"
        stroke="var(--bg-400)"
        stroke-width="0.4"
      />

      <template v-if="showYAxis">
        <text :x="AXIS_PAD_LEFT - 2" :y="VB_H - PAD_BOTTOM - height + 2" class="axis-label axis-label-y" text-anchor="end">
          {{ Math.round(maxVal) }}{{ yUnit }}
        </text>
        <text :x="AXIS_PAD_LEFT - 2" :y="VB_H - PAD_BOTTOM + 3" class="axis-label axis-label-y" text-anchor="end">0</text>
      </template>

      <rect
        v-for="(d, i) in data"
        :key="i"
        :x="xCenter(i) - barW() / 2"
        :y="bTop(d.value)"
        :width="barW()"
        :height="bHeight(d.value)"
        :rx="barRadius"
        :ry="barRadius"
        :fill="d.color || defaultColor"
      />

      <text
        v-for="(d, i) in data"
        v-if="hasLabels"
        :key="'l' + i"
        :x="xCenter(i)"
        :y="VB_H - 4"
        class="axis-label axis-label-x"
        text-anchor="middle"
      >
        {{ d.label }}
      </text>
    </svg>
  </div>
</template>

<style scoped>
.bar-thick-wrap {
  width: 100%;
  line-height: 0;
}
.bar-thick-svg {
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
</style>
