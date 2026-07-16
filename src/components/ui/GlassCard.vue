<script setup lang="ts">
/**
 * GlassCard — Immersive Light surface component.
 *
 * Wraps the 沉浸光感 (Immersive Light) material tier system into a single
 * composable card. Combines:
 *   - 5-tier glass elevation (HarmonyOS Ultra_Thin → Ultra_Thick)
 *   - Optional radial colored glow (ambient light)
 *   - Optional hover halo (signature light ring)
 *   - Specular top-edge highlight per tier
 *
 * Scene mapping (per HarmonyOS spec):
 *   tier="ultra-thin"  → sticky top bars, top floating components
 *   tier="thin"        → bottom tab bars, bottom sheets
 *   tier="medium"      → default content cards, FABs
 *   tier="thick"       → popovers, dropdowns, toasts
 *   tier="ultra-thick" → half-modals, large dialogs
 *
 * @example
 * <GlassCard tier="thick" glow="primary" hover-halo> ... </GlassCard>
 */
import { computed, ref } from "vue";
import { useAnime } from "@/composables/useAnime";

type MaterialTier =
  | "ultra-thin"
  | "thin"
  | "medium"
  | "thick"
  | "ultra-thick";

type GlowColor =
  | "none"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "accent";

const props = withDefaults(
  defineProps<{
    tier?: MaterialTier;
    glow?: GlowColor;
    hoverHalo?: boolean;
    interactive?: boolean;
    padding?: 0 | 2 | 3 | 4 | 5 | 6;
    radius?: "sm" | "md" | "lg" | "xl" | "2xl" | "full" | "pill" | "card";
  }>(),
  {
    tier: "medium",
    glow: "none",
    hoverHalo: false,
    interactive: false,
    padding: 0,
    radius: undefined,
  }
);

const rootRef = ref<HTMLElement | null>(null);
const { animate, spring, reduced } = useAnime(rootRef);

/** hover 微光晕：仅 interactive 时生效，anime 管 translateY，CSS 管 box-shadow */
function onEnter() {
  if (!props.interactive || reduced.value || !rootRef.value) return;
  animate(rootRef.value, {
    translateY: -2,
    ease: spring("smooth"),
    duration: 300,
  });
}

function onLeave() {
  if (!props.interactive || reduced.value || !rootRef.value) return;
  animate(rootRef.value, {
    translateY: 0,
    ease: spring("smooth"),
    duration: 300,
  });
}

const tierClass = computed(() => `glass-${props.tier}`);

const glowClass = computed(() =>
  props.glow === "none" ? null : `glow-${props.glow}`
);

const haloClass = computed(() => (props.hoverHalo ? "halo-hover" : null));

const paddingVar = computed(() =>
  props.padding === 0 ? "0px" : `var(--space-${props.padding})`
);

const radiusVar = computed(() => {
  if (props.radius) {
    if (props.radius === "pill") return "var(--radius-pill)";
    if (props.radius === "card") return "var(--card-radius)";
    return `var(--radius-${props.radius})`;
  }
  if (props.tier === "thick" || props.tier === "ultra-thick") {
    return "var(--radius-popover)";
  }
  if (props.tier === "thin" || props.tier === "ultra-thin") {
    return "var(--radius-xl)";
  }
  return "var(--radius-lg)";
});

const rootClasses = computed(() => [
  "glass-card-root",
  tierClass.value,
  glowClass.value,
  haloClass.value,
  { interactive: props.interactive },
]);

const rootStyle = computed(() => ({
  "--card-padding": paddingVar.value,
  "--card-radius": radiusVar.value,
}));
</script>

<template>
  <div
    ref="rootRef"
    :class="rootClasses"
    :style="rootStyle"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <slot />
  </div>
</template>

<style scoped>
.glass-card-root {
  position: relative;
  border-radius: var(--card-radius);
  padding: var(--card-padding);
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive),
    background-color var(--dur-halo) var(--ease-immersive);
}

.glass-card-root.interactive {
  cursor: pointer;
}

.glass-card-root.interactive:active {
  transform: scale(0.97);
}

/* ===== 5-tier material application ===== */
.glass-ultra-thin {
  background: var(--material-ultra-thin-bg);
  -webkit-backdrop-filter: blur(var(--material-ultra-thin-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-ultra-thin-blur)) saturate(180%);
  border: 1px solid var(--material-ultra-thin-border);
  box-shadow: var(--material-ultra-thin-shadow);
}
.glass-thin {
  background: var(--material-thin-bg);
  -webkit-backdrop-filter: blur(var(--material-thin-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-thin-blur)) saturate(180%);
  border: 1px solid var(--material-thin-border);
  box-shadow: var(--material-thin-shadow);
}
.glass-medium {
  background: var(--material-medium-bg);
  -webkit-backdrop-filter: blur(var(--material-medium-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-medium-blur)) saturate(180%);
  border: 1px solid var(--material-medium-border);
  box-shadow: var(--material-medium-shadow);
}
.glass-thick {
  background: var(--material-thick-bg);
  -webkit-backdrop-filter: blur(var(--material-thick-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-thick-blur)) saturate(180%);
  border: 1px solid var(--material-thick-border);
  box-shadow: var(--material-thick-shadow);
}
.glass-ultra-thick {
  background: var(--material-ultra-thick-bg);
  -webkit-backdrop-filter: blur(var(--material-ultra-thick-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-ultra-thick-blur)) saturate(180%);
  border: 1px solid var(--material-ultra-thick-border);
  box-shadow: var(--material-ultra-thick-shadow);
}
</style>
