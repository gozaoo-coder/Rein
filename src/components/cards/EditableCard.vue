<script setup lang="ts">
/**
 * EditableCard — card surface in edit mode, using GlassCard.
 * Adds drag handle + remove button overlay when editing.
 */
import GlassCard from "@/components/ui/GlassCard.vue";
import ReinIcon from "@/components/ui/ReinIcon.vue";
import { CARD_SIZE_MAP } from "@/types/card";
import type { CardConfig } from "@/types/card";
import { useCardEditor } from "@/composables/useCardEditor";
import { getCardComponent } from "./CardRegistry";
import { computed } from "vue";

const props = defineProps<{
  config: CardConfig;
}>();

const { isEditing, removeCard } = useCardEditor();

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
    :interactive="false"
    :padding="4"
    :class="[sizeClass, { 'is-editing': isEditing }]"
    class="editable-card"
  >
    <div v-if="isEditing" class="edit-overlay">
      <button class="drag-handle" aria-label="拖拽排序">
        <ReinIcon name="drag" :size="14" />
      </button>
      <button
        class="remove-btn"
        aria-label="移除"
        @click="removeCard(config.id)"
      >
        <ReinIcon name="close" :size="14" :stroke-width="2.4" />
      </button>
    </div>
    <component v-if="resolvedComponent" :is="resolvedComponent" v-bind="config.props" />
    <div v-else class="card-placeholder">
      <span class="placeholder-text">{{ config.component }}</span>
    </div>
  </GlassCard>
</template>

<style scoped>
.editable-card {
  position: relative;
  min-height: 140px;
  cursor: pointer;
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

.is-editing {
  outline: 2px dashed var(--color-primary);
  outline-offset: -2px;
}

.edit-overlay {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  z-index: 10;
}

.drag-handle,
.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-immersive);
}

.drag-handle {
  background: var(--bg-200);
  color: var(--text-500);
  cursor: grab;
}

.remove-btn {
  background: var(--color-danger);
  color: #ffffff;
}

.remove-btn:active {
  opacity: 0.7;
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
