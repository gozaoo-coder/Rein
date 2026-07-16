<script setup lang="ts">
import { onBeforeUnmount, onMounted, nextTick, watch } from "vue";
import { useRoute } from "vue-router";
import { useBreakpoint } from "@/composables/useBreakpoint";
import { useAnime } from "@/composables/useAnime";
import PhoneLayout from "@/layouts/PhoneLayout.vue";
import PadLayout from "@/layouts/PadLayout.vue";
import DesktopLayout from "@/layouts/DesktopLayout.vue";
import ToastHost from "@/components/ui/ToastHost.vue";
import PairRequestHost from "@/components/sync/PairRequestHost.vue";
import { initPairRequest, destroyPairRequest } from "@/composables/usePairRequest";

const { mode } = useBreakpoint();
const route = useRoute();
const { enter, reduced } = useAnime();

onMounted(() => initPairRequest());
onBeforeUnmount(() => destroyPairRequest());

// 路由转场：监听 route.path 变化，在新路由组件挂载后（nextTick）播放 pageRight 入场。
// 动画目标为 AppShell 内的 .app-main 滚动容器（router-view 实际渲染位置）。
// useAnime.enter 仅设置目标值（from 取当前），故需先手动预设起点 opacity:0 / translateX:24px。
// 仅做入场——旧路由直接被 Vue 替换。尊重 reduced-motion（useAnime 内部已处理，起点亦跳过）。
watch(
  () => route.path,
  () => {
    nextTick(() => {
      const mainEl = document.querySelector(".app-main") as HTMLElement | null;
      if (!mainEl || reduced.value) return;
      mainEl.style.opacity = "0";
      mainEl.style.transform = "translateX(24px)";
      enter(mainEl, "pageRight", { springName: "smooth", duration: 320 });
    });
  },
);
</script>

<template>
  <PhoneLayout v-if="mode === 'phone'" />
  <PadLayout v-else-if="mode === 'pad'" />
  <DesktopLayout v-else />
  <ToastHost />
  <PairRequestHost />
</template>

<!-- Styles imported in main.ts -->
