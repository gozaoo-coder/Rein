<script setup lang="ts">
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
</script>

<template>
  <div class="static-card glass-card" :class="sizeClass">
    <component v-if="resolvedComponent" :is="resolvedComponent" v-bind="config.props" />
    <div v-else class="card-placeholder">
      <span class="placeholder-text">{{ config.component }}</span>
    </div>
  </div>
</template>

<style scoped>
.static-card {
  min-height: 140px;
  padding: var(--space-4);
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
  color: var(--text-400);
  font-size: 13px;
}
</style>
