<script setup lang="ts">
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
</script>

<template>
  <div class="editable-card glass-card" :class="[sizeClass, { 'is-editing': isEditing }]">
    <div v-if="isEditing" class="edit-overlay">
      <button class="drag-handle" aria-label="拖拽排序">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="2" /><circle cx="15" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" /><circle cx="15" cy="12" r="2" />
          <circle cx="9" cy="18" r="2" /><circle cx="15" cy="18" r="2" />
        </svg>
      </button>
      <button class="remove-btn" aria-label="移除" @click="removeCard(config.id)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <component v-if="resolvedComponent" :is="resolvedComponent" v-bind="config.props" />
    <div v-else class="card-placeholder">
      <span class="placeholder-text">{{ config.component }}</span>
    </div>
  </div>
</template>

<style scoped>
.editable-card {
  position: relative;
  min-height: 140px;
  padding: var(--space-4);
  transition: box-shadow 0.2s ease;
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
  outline: 2px dashed var(--brand-500);
  outline-offset: -2px;
  border-radius: var(--radius-lg);
}

.edit-overlay {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  z-index: 10;
}

.drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--bg-200);
  color: var(--text-500);
  cursor: grab;
}

.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--danger-500);
  color: white;
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
  color: var(--text-400);
  font-size: 13px;
}
</style>
