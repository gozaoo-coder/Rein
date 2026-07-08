<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { useBreakpoint } from "@/composables/useBreakpoint";
import PhoneLayout from "@/layouts/PhoneLayout.vue";
import PadLayout from "@/layouts/PadLayout.vue";
import DesktopLayout from "@/layouts/DesktopLayout.vue";
import ToastHost from "@/components/ui/ToastHost.vue";
import PairRequestHost from "@/components/sync/PairRequestHost.vue";
import { initPairRequest, destroyPairRequest } from "@/composables/usePairRequest";

const { mode } = useBreakpoint();

onMounted(() => initPairRequest());
onBeforeUnmount(() => destroyPairRequest());
</script>

<template>
  <PhoneLayout v-if="mode === 'phone'" />
  <PadLayout v-else-if="mode === 'pad'" />
  <DesktopLayout v-else />
  <ToastHost />
  <PairRequestHost />
</template>

<!-- Styles imported in main.ts -->
