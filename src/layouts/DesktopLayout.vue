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
