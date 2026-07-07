<script setup lang="ts">
import AppShell from "@/components/shell/AppShell.vue";
</script>

<template>
  <AppShell>
    <template #content>
      <router-view />
    </template>
  </AppShell>
</template>

<style scoped>
/* Pad layout overrides: wider cards, more grid columns */
:deep(.card-grid) {
  grid-template-columns: repeat(3, 1fr);
}
</style>
