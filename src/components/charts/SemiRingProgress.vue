<script setup lang="ts">
/**
 * SemiRingProgress — 同心半圆进度环 (concentric semi-circular progress rings).
 *
 * N half-arcs opening upward; each ring has value/goal/color.
 * Default 3 rings match Huawei Health (calories/steps/exercise);
 * pass `rings` prop for any other use (single ring summary, dual-ring PAI, etc.).
 *
 * Props:
 *   rings  — Array<{ value: number; goal: number; color: string; track?: string }>
 *            If omitted, renders health defaults from calories/steps/exerciseMinutes.
 *   size   — visual width hint (px); component is responsive (width:100%).
 *   strokeWRatio — stroke width as fraction of radius gap (default 1.0)
 */
import { computed, watch } from "vue";
import { useAnime } from "@/composables/useAnime";

export interface RingConfig {
  value: number;
  goal: number;
  color: string;
  /** Optional track color; if omitted auto-lightens from color. */
  track?: string;
}

const props = withDefaults(
  defineProps<{
    rings?: RingConfig[];
    // Legacy convenience props (used when rings not provided)
    calories?: number;
    caloriesGoal?: number;
    steps?: number;
    stepsGoal?: number;
    exerciseMinutes?: number;
    exerciseGoal?: number;
  }>(),
  {
    rings: undefined,
    calories: 0,
    caloriesGoal: 400,
    steps: 0,
    stepsGoal: 9000,
    exerciseMinutes: 0,
    exerciseGoal: 30,
  }
);

const effectiveRings = computed<RingConfig[]>(() => {
  if (props.rings && props.rings.length > 0) return props.rings;
  return [
    {
      value: props.calories,
      goal: props.caloriesGoal,
      color: "var(--ring-outer)",
      track: "#ffddd0",
    },
    {
      value: props.steps,
      goal: props.stepsGoal,
      color: "var(--ring-middle)",
      track: "#fff0cc",
    },
    {
      value: props.exerciseMinutes,
      goal: props.exerciseGoal,
      color: "var(--ring-inner)",
      track: "#d0e8ff",
    },
  ];
});

const VB_W = 200;
const VB_H = 130;
const CX = 100;
const CY = 110;
const STROKE_W = 14;
const RING_GAP = 6;

function ringRadius(index: number, total: number): number {
  const baseOuter = 74;
  return baseOuter - index * (STROKE_W + RING_GAP);
}

function arcPath(r: number): string {
  return `M ${CX - r} ${CY} A ${r} ${r} 0 0 1 ${CX + r} ${CY}`;
}

function halfCircumference(r: number): number {
  return Math.PI * r;
}

function dashFor(value: number, goal: number, r: number): string {
  const pct = Math.min(Math.max(value / goal, 0), 1);
  const total = halfCircumference(r);
  const filled = pct * total;
  return `${filled} ${total - filled}`;
}

function autoTrack(color: string): string {
  if (color === "var(--ring-outer)") return "#ffddd0";
  if (color === "var(--ring-middle)") return "#fff0cc";
  if (color === "var(--ring-inner)") return "#d0e8ff";
  return "rgba(0,0,0,0.08)";
}

// ===== anime.js spring 驱动 stroke-dasharray =====
// 替代原 CSS transition：每个 .ring-fill path 的 stroke-dasharray 由
// spring('card') 物理动画驱动。由于 dasharray 是 "filled total-filled"
// 字符串无法直接插值，这里对一个 JS 对象 {p:0→1} 做插值，在 onUpdate 中
// 按进度重算并 setAttribute 到对应 path。尊重 reduced-motion（瞬时跳变）。
const { animate, spring, reduced } = useAnime();

/** 按 index 收集每个 .ring-fill path 元素（函数 ref）。 */
const ringFillEls: SVGPathElement[] = [];
/** 每个环上一次最终的 dasharray，作为下一次动画的起点。 */
const prevDash: string[] = [];

function bindRingRef(i: number): (el: unknown) => void {
  return (el: unknown) => {
    if (!(el instanceof SVGPathElement)) return;
    ringFillEls[i] = el;
    // 首次绑定时立即设为 0 起点，避免首帧闪烁目标值
    if (prevDash[i] !== undefined) return;
    const ring = effectiveRings.value[i];
    if (!ring) return;
    el.setAttribute(
      "stroke-dasharray",
      dashFor(0, ring.goal, ringRadius(i, effectiveRings.value.length)),
    );
  };
}

function animateRing(i: number, fromDash: string, toDash: string): void {
  const el = ringFillEls[i];
  if (!el) return;
  if (reduced.value) {
    el.setAttribute("stroke-dasharray", toDash);
    return;
  }
  const [fromFilled, fromRest] = fromDash.split(" ").map(Number);
  const [toFilled] = toDash.split(" ").map(Number);
  const total = fromFilled + fromRest;
  // 先回到起点，避免 Vue 已将 DOM 设为目标值造成闪烁
  el.setAttribute("stroke-dasharray", fromDash);
  const obj = { p: 0 };
  animate(obj, {
    p: 1,
    ease: spring("card"),
    onUpdate: () => {
      const filled = fromFilled + (toFilled - fromFilled) * obj.p;
      el.setAttribute("stroke-dasharray", `${filled} ${total - filled}`);
    },
    onComplete: () => {
      el.setAttribute("stroke-dasharray", toDash);
    },
  });
}

/** 挂载与 rings 变化时同步：对每个环从 prevDash 动画到当前目标值。 */
function syncRings(): void {
  const rings = effectiveRings.value;
  rings.forEach((ring, i) => {
    const r = ringRadius(i, rings.length);
    const toDash = dashFor(ring.value, ring.goal, r);
    const fromDash = prevDash[i];
    if (fromDash === toDash) return; // 值未变化，跳过
    const startDash = fromDash ?? dashFor(0, ring.goal, r);
    animateRing(i, startDash, toDash);
    prevDash[i] = toDash;
  });
}

watch(effectiveRings, () => syncRings(), { flush: "post", immediate: true });
</script>

<template>
  <div class="semi-rings-wrap">
    <svg
      class="semi-rings-svg"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      width="100%"
      aria-hidden="true"
    >
      <template v-for="(ring, i) in effectiveRings" :key="i">
        <!-- Track -->
        <path
          :d="arcPath(ringRadius(i, effectiveRings.length))"
          fill="none"
          :stroke="ring.track || autoTrack(ring.color)"
          :stroke-width="STROKE_W"
          stroke-linecap="round"
        />
        <!-- Progress fill -->
        <path
          class="ring-fill"
          :ref="bindRingRef(i)"
          :d="arcPath(ringRadius(i, effectiveRings.length))"
          fill="none"
          :stroke="ring.color"
          :stroke-dasharray="dashFor(ring.value, ring.goal, ringRadius(i, effectiveRings.length))"
          :stroke-width="STROKE_W"
          stroke-linecap="round"
        />
      </template>
    </svg>
    <div class="ring-reflection" aria-hidden="true" />
  </div>
</template>

<style scoped>
.semi-rings-wrap {
  position: relative;
  width: 100%;
  max-width: 260px;
  margin: 0 auto;
}
.semi-rings-svg {
  width: 100%;
  height: auto;
  display: block;
}
/* .ring-fill 的 stroke-dasharray 改由 anime.js v4 spring 驱动（见 script），不再使用 CSS transition */
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
