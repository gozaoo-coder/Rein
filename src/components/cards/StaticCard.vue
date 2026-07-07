<script setup lang="ts">
/**
 * StaticCard — non-editable card surface using GlassCard.
 * Tier: medium (default content card).
 * Glow: derived from card config.glow if provided, else none.
 */
import GlassCard from "@/components/ui/GlassCard.vue";
import { CARD_SIZE_MAP } from "@/types/card";
import type { CardConfig } from "@/types/card";
import { getCardComponent } from "./CardRegistry";
import { computed } from "vue";

const props = defineProps<{
  config: CardConfig;
}>();

const resolvedComponent = computed(() => getCardComponent(props.config.component));

const sizeClass = computed(() => {
  const size = CARD_SIZE_MAP[props.config.size];
  return {
    "card-span-2-col": size.cols === 2,
    "card-span-2-row": size.rows === 2,
    "card-span-4-row": size.rows === 4,
  };
});

const glow = computed(() => props.config.glow ?? "none");
</script>

<template>
  <GlassCard
    tier="medium"
    :glow="glow"
    :hover-halo="true"
    :interactive="true"
    :padding="4"
    :class="sizeClass"
    class="static-card"
  >
    <component v-if="resolvedComponent" :is="resolvedComponent" v-bind="config.props" />
    <div v-else class="card-placeholder">
      <span class="placeholder-text">{{ config.component }}</span>
    </div>
  </GlassCard>
</template>

<style scoped>
.static-card {
  min-height: 140px;
}

.card-span-2-col {
  grid-column: span 2;
}

.card-span-2-row {
  grid-row: span 2;
}

.card-span-4-row {
  grid-row: span 4;
}

.card-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 80px;
}

.placeholder-text {
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}
</style>
