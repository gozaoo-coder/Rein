<script setup lang="ts">
/**
 * GlassCard — Immersive Light surface component.
 *
 * Wraps the 沉浸光感 (Immersive Light) material tier system into a single
 * composable card. Combines:
 *   - 5-tier glass elevation (HarmonyOS Ultra_Thin → Ultra_Thick)
 *   - Optional radial colored glow (ambient light)
 *   - Optional hover halo (signature light ring)
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
import { computed } from "vue";

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
    /** Material elevation tier. @default "medium" */
    tier?: MaterialTier;
    /** Radial glow color. @default "none" */
    glow?: GlowColor;
    /** Show hover halo (signature light ring). @default false */
    hoverHalo?: boolean;
    /** Interactive (enables cursor pointer + active scale). @default false */
    interactive?: boolean;
    /** Padding scale; use 0 to disable. @default 4 */
    padding?: 0 | 2 | 3 | 4 | 5 | 6;
    /** Radius override; defaults to tier-appropriate value. */
    radius?: "sm" | "md" | "lg" | "xl" | "2xl" | "full" | "pill";
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
    return props.radius === "pill"
      ? "var(--radius-pill)"
      : `var(--radius-${props.radius})`;
  }
  // Tier-appropriate defaults
  if (props.tier === "thick" || props.tier === "ultra-thick") {
    return "var(--radius-popover)";
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
  <div :class="rootClasses" :style="rootStyle">
    <slot />
  </div>
</template>

<style scoped>
.glass-card-root {
  position: relative;
  border: var(--glass-border);
  border-radius: var(--card-radius);
  padding: var(--card-padding);
  /* Background-image (glow) layers above background-color (glass) because
     glow utility sets background-image while glass tier sets background-color.
     Both compose natively. */
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive),
    border-color var(--dur-halo) var(--ease-immersive);
}

.glass-card-root.interactive {
  cursor: pointer;
}

.glass-card-root.interactive:active {
  transform: scale(0.97);
}

/* Border fade on hover (HarmonyOS pop-up signature) */
.glass-card-root.interactive:hover {
  border-color: transparent;
}
</style>
