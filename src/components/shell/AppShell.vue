<script setup lang="ts">
import AppTopBar from "./AppTopBar.vue";
import AppTabBar from "./AppTabBar.vue";
import { useBreakpoint } from "@/composables/useBreakpoint";

const { mode } = useBreakpoint();
</script>

<template>
  <div class="app-shell">
    <AppTopBar />

    <div class="app-body">
      <slot name="sidebar" v-if="mode === 'desktop'" />

      <main class="app-main scrollbar-hide">
        <slot name="content" />
      </main>
    </div>

    <AppTabBar v-if="mode !== 'desktop'" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
}

.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.app-main {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--space-4);
  padding-bottom: 80px;
}
</style>
