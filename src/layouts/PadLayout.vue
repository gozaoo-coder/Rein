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
/* 列数由 HomeCardGrid 内的 useGridColumns 响应式控制（pad=3 列） */
</style>
