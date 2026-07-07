<script setup lang="ts">
/**
 * LevelIndicator — 程度指示标识 (level indicator bar).
 *
 * Equal-length colored segments representing quality/intensity zones
 * with a triangular pointer at current value.
 * Use case: sleep quality (待提高/一般/良好/优), stress level, activity intensity.
 *
 * Props:
 *   segments  — Array<{ color: string; label?: string }> (all same width)
 *   value     — current position 0..1 (0 = leftmost, 1 = rightmost)
 *   trackColor — segment gap/track color (default transparent → segments have gap)
 *   showLabels — show labels below segments (default: true if any segment has label)
 *   pointerColor — triangle color (default 'currentColor')
 *   height    — segment bar height (default 10)
 *
 * Example (sleep quality, 4 levels):
 *   segments=[
 *     {color:'#d4c9ff', label:'待提高'},
 *     {color:'#a999ff'},
 *     {color:'#7c6cf7'},
 *     {color:'#5a49f0', label:'优'},
 *   ]
 *   value=0.15
 */
import { computed } from "vue";

export interface LevelSegment {
  color: string;
  label?: string;
}

const props = withDefaults(
  defineProps<{
    segments: LevelSegment[];
    value: number;
    showLabels?: boolean;
    pointerColor?: string;
    height?: number;
    gap?: number;
  }>(),
  {
    showLabels: undefined as unknown as boolean,
    pointerColor: "var(--color-text)",
    height: 10,
    gap: 2,
  }
);

const clamped = computed(() => Math.min(Math.max(props.value, 0), 1));

const VB_W = 100;
const VB_H = computed(() => {
  const hasLabels =
    props.showLabels !== false && props.segments.some((s) => s.label);
  return props.height + (hasLabels ? 14 : 0) + 8; /* pointer space on top */
});

const BAR_Y = 10;
const POINTER_BASE_Y = 3;
const POINTER_TIP_Y = BAR_Y;

const n = computed(() => props.segments.length);

function segWidth() {
  const gapTotal = props.gap * (n.value - 1);
  return (VB_W - gapTotal) / n.value;
}

function segX(i: number) {
  return i * (segWidth() + props.gap);
}

const pointerX = computed(() => clamped.value * VB_W);

const showLabels = computed(() => {
  if (props.showLabels === false) return false;
  return props.segments.some((s) => s.label);
});

/** Pointer triangle path. */
const pointerPath = computed(() => {
  const size = 4;
  const x = pointerX.value;
  return `M ${x - size / 2} ${POINTER_BASE_Y} L ${x + size / 2} ${POINTER_BASE_Y} L ${x} ${POINTER_TIP_Y} Z`;
});
</script>

<template>
  <div class="level-indicator">
    <svg
      class="level-svg"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      width="100%"
      aria-hidden="true"
    >
      <!-- Triangle pointer -->
      <path
        :d="pointerPath"
        :fill="pointerColor"
      />

      <!-- Segments -->
      <rect
        v-for="(seg, i) in segments"
        :key="i"
        :x="segX(i)"
        :y="BAR_Y"
        :width="segWidth()"
        :height="height"
        :rx="height / 2"
        :ry="height / 2"
        :fill="seg.color"
      />

      <!-- Labels (only segments with label set) -->
      <template v-if="showLabels">
        <template v-for="(seg, i) in segments" :key="'l' + i">
          <text
            v-if="seg.label"
            :x="segX(i) + segWidth() / 2"
            :y="BAR_Y + height + 8"
            class="level-label"
            text-anchor="middle"
          >
            {{ seg.label }}
          </text>
        </template>
      </template>
    </svg>
  </div>
</template>

<style scoped>
.level-indicator {
  width: 100%;
  line-height: 0;
}
.level-svg {
  display: block;
  overflow: visible;
}
.level-label {
  fill: var(--color-text-tertiary);
  font-size: 4.5px;
  font-family: var(--font-sans);
}
</style>
