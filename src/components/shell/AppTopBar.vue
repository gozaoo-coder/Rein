<script setup lang="ts">
/**
 * AppTopBar — Sticky top floating bar.
 * Material: Ultra_Thin (HarmonyOS spec: top floating component).
 */
import ReinIcon from "@/components/ui/ReinIcon.vue";

defineProps<{
  title?: string;
  icon?: "plus" | "edit" | "settings";
}>();

const emit = defineEmits<{
  (e: "action"): void;
}>();
</script>

<template>
  <header class="app-top-bar glass-ultra-thin safe-area-top">
    <div class="top-bar-inner">
      <h1 class="top-bar-title">{{ title || "Rein" }}</h1>
      <button
        class="top-bar-action"
        aria-label="操作"
        @click="emit('action')"
      >
        <ReinIcon :name="icon || 'plus'" :size="20" :stroke-width="2.4" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-top-bar {
  position: sticky;
  top: 0;
  z-index: 100;
  border-bottom: 1px solid var(--color-divider);
}

.top-bar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 var(--space-5);
}

.top-bar-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  letter-spacing: -0.01em;
}

.top-bar-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  background: var(--color-primary);
  color: var(--color-primary-text);
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    opacity var(--dur-fast) var(--ease-immersive);
}

.top-bar-action:active {
  transform: scale(0.9);
  opacity: 0.85;
}
</style>
