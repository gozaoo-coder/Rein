<script setup lang="ts">
/**
 * ActivityRing — Triple concentric semi-circular progress arcs.
 * Reference: 华为健康 hero rings.
 *
 * Three half-rings opening upward:
 *   Outer  (coral)  — calories
 *   Middle (gold)   — exercise / steps
 *   Inner  (blue)   — moderate-high intensity minutes
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    calories?: number;
    caloriesGoal?: number;
    steps?: number;
    stepsGoal?: number;
    exerciseMinutes?: number;
    exerciseGoal?: number;
  }>(),
  {
    calories: 0,
    caloriesGoal: 400,
    steps: 0,
    stepsGoal: 9000,
    exerciseMinutes: 0,
    exerciseGoal: 30,
  }
);

const VB_W = 200;
const VB_H = 130;
const CX = 100;
const CY = 110;
const R_OUTER = 74;
const R_MIDDLE = 54;
const R_INNER = 34;
const STROKE_W = 14;

function arcPath(r: number): string {
  return `M ${CX - r} ${CY} A ${r} ${r} 0 0 1 ${CX + r} ${CY}`;
}

function halfCircumference(r: number): number {
  return Math.PI * r;
}

function dashFor(value: number, goal: number, r: number) {
  const pct = Math.min(Math.max(value / goal, 0), 1);
  const total = halfCircumference(r);
  const filled = pct * total;
  return `${filled} ${total - filled}`;
}

const outerDash = computed(() =>
  dashFor(props.calories, props.caloriesGoal, R_OUTER)
);
const middleDash = computed(() =>
  dashFor(props.steps, props.stepsGoal, R_MIDDLE)
);
const innerDash = computed(() =>
  dashFor(props.exerciseMinutes, props.exerciseGoal, R_INNER)
);
</script>

<template>
  <div class="activity-ring-wrap">
    <svg
      class="activity-rings"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      width="100%"
      aria-hidden="true"
    >
      <!-- Tracks (light tints) -->
      <path :d="arcPath(R_OUTER)" fill="none" stroke="#ffddd0" :stroke-width="STROKE_W" stroke-linecap="round" />
      <path :d="arcPath(R_MIDDLE)" fill="none" stroke="#fff0cc" :stroke-width="STROKE_W" stroke-linecap="round" />
      <path :d="arcPath(R_INNER)" fill="none" stroke="#d0e8ff" :stroke-width="STROKE_W" stroke-linecap="round" />

      <!-- Progress fills -->
      <path class="ring-fill ring-outer" :d="arcPath(R_OUTER)" fill="none" :stroke-dasharray="outerDash" :stroke-width="STROKE_W" stroke-linecap="round" />
      <path class="ring-fill ring-middle" :d="arcPath(R_MIDDLE)" fill="none" :stroke-dasharray="middleDash" :stroke-width="STROKE_W" stroke-linecap="round" />
      <path class="ring-fill ring-inner" :d="arcPath(R_INNER)" fill="none" :stroke-dasharray="innerDash" :stroke-width="STROKE_W" stroke-linecap="round" />
    </svg>

    <div class="ring-reflection" aria-hidden="true" />
  </div>
</template>

<style scoped>
.activity-ring-wrap {
  position: relative;
  width: 100%;
  max-width: 260px;
  margin: 0 auto;
  display: flex;
  justify-content: center;
}

.activity-rings {
  width: 100%;
  height: auto;
  display: block;
}

.ring-outer { stroke: var(--ring-outer); }
.ring-middle { stroke: var(--ring-middle); }
.ring-inner { stroke: var(--ring-inner); }

.ring-fill {
  transition: stroke-dasharray 1s var(--ease-immersive);
}

.ring-reflection {
  position: absolute;
  bottom: 4px;
  left: 10%;
  right: 10%;
  height: 24px;
  background: radial-gradient(
    ellipse at center,
    rgba(255, 102, 51, 0.10) 0%,
    rgba(255, 184, 0, 0.06) 40%,
    transparent 70%
  );
  filter: blur(6px);
  pointer-events: none;
  border-radius: 50%;
}
</style>
