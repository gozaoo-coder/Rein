<script setup lang="ts">
/**
 * ReinButton — Immersive Light button.
 *
 * Variants:
 *   - filled:    solid brand background, primary action
 *   - tinted:    brand-tinted glass, secondary action
 *   - glass:     glass-material surface, floating action
 *   - plain:     text-only, tertiary action
 *
 * Sizes: sm | md | lg
 *
 * @example
 * <ReinButton variant="filled" size="md" @click="save">保存</ReinButton>
 * <ReinButton variant="glass" tier="thick" glow="primary">打开</ReinButton>
 */
import { computed, ref } from "vue";
import { useAnime } from "@/composables/useAnime";

type Variant = "filled" | "tinted" | "glass" | "plain";
type Size = "sm" | "md" | "lg";
type MaterialTier = "ultra-thin" | "thin" | "medium" | "thick" | "ultra-thick";

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    size?: Size;
    /** Glass tier (only for variant="glass"). @default "medium" */
    tier?: MaterialTier;
    /** Block (full-width) button. @default false */
    block?: boolean;
    /** Disabled state. @default false */
    disabled?: boolean;
    /** Loading state (shows spinner, disables interaction). @default false */
    loading?: boolean;
    type?: "button" | "submit" | "reset";
  }>(),
  {
    variant: "filled",
    size: "md",
    tier: "medium",
    block: false,
    disabled: false,
    loading: false,
    type: "button",
  }
);

const emit = defineEmits<{
  (e: "click", ev: MouseEvent): void;
}>();

const classes = computed(() => [
  "rein-btn",
  `rein-btn--${props.variant}`,
  `rein-btn--${props.size}`,
  {
    "rein-btn--block": props.block,
    "rein-btn--disabled": props.disabled || props.loading,
    "rein-btn--loading": props.loading,
  },
]);

const tierClass = computed(() =>
  props.variant === "glass" ? `glass-${props.tier}` : null
);

function onClick(ev: MouseEvent) {
  if (props.disabled || props.loading) return;
  emit("click", ev);
}

const rootRef = ref<HTMLButtonElement | null>(null);
const { animate, spring, reduced } = useAnime(rootRef);

/** tap 物理按压：pointerdown 压缩，pointerup/leave 回弹，spring snappy 自然 overshoot */
function onPointerDown() {
  if (props.disabled || props.loading || reduced.value || !rootRef.value) return;
  animate(rootRef.value, {
    scale: 0.94,
    ease: spring("snappy"),
    duration: 400,
  });
}

function onPointerUp() {
  if (props.disabled || props.loading || reduced.value || !rootRef.value) return;
  animate(rootRef.value, {
    scale: 1,
    ease: spring("snappy"),
    duration: 400,
  });
}
</script>

<template>
  <button
    ref="rootRef"
    :type="type"
    :class="[classes, tierClass]"
    :disabled="disabled || loading"
    @click="onClick"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
  >
    <span v-if="loading" class="rein-btn-spinner" aria-hidden="true" />
    <slot name="icon-left" />
    <span class="rein-btn-label"><slot /></span>
    <slot name="icon-right" />
  </button>
</template>

<style scoped>
.rein-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  font-family: var(--font-sans);
  font-weight: var(--fw-semibold);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    opacity var(--dur-fast) var(--ease-immersive),
    background-color var(--dur-fast) var(--ease-immersive);
}

/* Sizes */
.rein-btn--sm {
  height: 32px;
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
}
.rein-btn--md {
  height: 40px;
  padding: 0 var(--space-5);
  font-size: var(--text-md);
}
.rein-btn--lg {
  height: 48px;
  padding: 0 var(--space-6);
  font-size: var(--text-lg);
}

.rein-btn--block {
  display: flex;
  width: 100%;
}

/* Variants */
.rein-btn--filled {
  background: var(--color-primary);
  color: var(--color-primary-text);
}
.rein-btn--filled:hover {
  background: var(--brand-600);
}

.rein-btn--tinted {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.rein-btn--tinted:hover {
  background: var(--brand-100);
}

.rein-btn--glass {
  color: var(--color-text);
  border: var(--glass-border);
}
.rein-btn--glass:hover {
  border-color: transparent;
}

.rein-btn--plain {
  background: transparent;
  color: var(--color-primary);
  padding: 0 var(--space-2);
}
.rein-btn--plain:hover {
  background: var(--color-primary-soft);
}

/* States */
.rein-btn--disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

.rein-btn:active:not(.rein-btn--disabled) {
  transform: scale(0.97);
}

/* Spinner */
.rein-btn-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: rein-btn-spin 0.6s linear infinite;
}

@keyframes rein-btn-spin {
  to {
    transform: rotate(360deg);
  }
}

.rein-btn-label:empty {
  display: none;
}
</style>
