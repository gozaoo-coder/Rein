<script setup lang="ts">
import { computed } from "vue";
import AppTopBar from "./AppTopBar.vue";
import AppTabBar from "./AppTabBar.vue";
import WindowTitleBar from "./WindowTitleBar.vue";
import { useDevice } from "@/composables/useDevice";
import { useBreakpoint } from "@/composables/useBreakpoint";

const { device } = useDevice();
const { mode } = useBreakpoint();
// 桌面平台使用自定义窗口标题栏，移动端使用 AppTopBar
const isDesktop = computed(() => device.value.isDesktop);
// 宽型窗口（desktop mode ≥1200px）：tab-bar 改为左侧侧栏
const isWideLayout = computed(() => mode.value === "desktop");
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell-wide': isWideLayout }">
    <WindowTitleBar v-if="isDesktop" />
    <AppTopBar v-else />

    <div class="app-body" :class="{ 'app-body-wide': isWideLayout }">
      <!-- 宽型窗口：左侧侧栏 tab-bar -->
      <AppTabBar v-if="isWideLayout" side />

      <main class="app-main page-scroll" :class="{ 'app-main-wide': isWideLayout }">
        <div class="app-main-inner" :class="{ 'app-main-inner-wide': isWideLayout }">
          <slot name="content" />
        </div>
      </main>
    </div>

    <!-- 非宽型窗口：底部浮动 tab-bar -->
    <AppTabBar v-if="!isWideLayout" />
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

/* Pad：内容居中收敛，保留阅读宽度 */
@media (min-width: 768px) {
  .app-main-inner {
    max-width: 560px;
    padding: 0 var(--space-5);
  }
}

/* Desktop：进一步放宽，避免大屏留白过多 */
@media (min-width: 1200px) {
  .app-main-inner {
    max-width: 720px;
  }
}

/* ===== 宽型窗口（desktop mode）：左侧侧栏 + 右侧 main ===== */
.app-shell-wide {
  /* 保持 column 布局：顶部 WindowTitleBar + 下方 .app-body-wide(row) */
}

.app-body-wide {
  flex-direction: row;
}

/* 侧栏 tab-bar 已自带 sticky + 高度 100% */
.app-main-wide {
  /* 宽型窗口无底部浮动 tab-bar，无需预留 padding-bottom */
  padding-bottom: var(--space-6);
}

.app-main-inner-wide {
  /* 宽型窗口允许内容横向展开，但仍居中收敛 */
  max-width: 1280px;
  padding: 0 var(--space-6);
}
</style>
