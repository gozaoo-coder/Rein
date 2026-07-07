<script setup lang="ts">
import { useBreakpoint } from "@/composables/useBreakpoint";
import PhoneLayout from "@/layouts/PhoneLayout.vue";
import PadLayout from "@/layouts/PadLayout.vue";
import DesktopLayout from "@/layouts/DesktopLayout.vue";

const { mode } = useBreakpoint();
</script>

<template>
  <PhoneLayout v-if="mode === 'phone'" />
  <PadLayout v-else-if="mode === 'pad'" />
  <DesktopLayout v-else />
</template>

<style>
/* Global reset */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#app {
  height: 100%;
  width: 100%;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial,
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background: var(--color-bg);
  color: var(--color-text);
}
</style>
