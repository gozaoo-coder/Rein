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

<!-- Styles imported in main.ts -->
