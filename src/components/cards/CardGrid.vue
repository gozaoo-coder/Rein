<script setup lang="ts">
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import EditableCard from "./EditableCard.vue";
import StaticCard from "./StaticCard.vue";
import { useCardEditor } from "@/composables/useCardEditor";

const layoutStore = useCardLayoutStore();
const { isEditing } = useCardEditor();
</script>

<template>
  <div class="card-grid">
    <template v-for="card in layoutStore.layout.cards" :key="card.id">
      <EditableCard v-if="card.editable && isEditing" :config="card" />
      <EditableCard v-else-if="card.editable" :config="card" />
      <StaticCard v-else :config="card" />
    </template>
  </div>
</template>

<style scoped>
.card-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-3);
  padding: var(--space-1) 0;
}

/* Responsive: 2 columns on phone */
@media (max-width: 767px) {
  .card-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
