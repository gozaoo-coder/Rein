<script setup lang="ts">
import { computed } from "vue";
import AppTopBar from "./AppTopBar.vue";
import AppTabBar from "./AppTabBar.vue";
import WindowTitleBar from "./WindowTitleBar.vue";
import { useDevice } from "@/composables/useDevice";

const { device } = useDevice();
// 桌面平台使用自定义窗口标题栏，移动端使用 AppTopBar
const isDesktop = computed(() => device.value.isDesktop);
</script>

<template>
  <div class="app-shell">
    <WindowTitleBar v-if="isDesktop" />
    <AppTopBar v-else />

    <div class="app-body">
      <main class="app-main page-scroll">
        <div class="app-main-inner">
          <slot name="content" />
        </div>
      </main>
    </div>

    <AppTabBar />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--color-bg);
}

.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.app-main {
  flex: 1;
  min-width: 0;
  /* padding-bottom reserves space for floating pill tab bar */
  padding-bottom: calc(var(--pill-bar-height) + env(safe-area-inset-bottom, 0px) + var(--space-6));
}

.app-main-inner {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  padding: 0 var(--space-4);
  padding-top: var(--space-2);
  margin: 0 auto;
}

@media (min-width: 768px) {
  .app-main-inner {
    max-width: 520px;
    padding: 0 var(--space-5);
  }
}
</style>
