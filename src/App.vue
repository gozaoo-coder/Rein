<script setup lang="ts">
import { useRoute } from 'vue-router'
import { RouterView } from 'vue-router'

import TabBar from '@/components/layout/TabBar.vue'
import DesktopRail from '@/components/layout/DesktopRail.vue'
import DesktopInspector from '@/components/layout/DesktopInspector.vue'
import ActiveWorkoutBar from '@/components/exercise/ActiveWorkoutBar.vue'
import ToastHost from '@/components/common/ToastHost.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'

const route = useRoute()
/** 桌面工作台：视口 ≥ DESKTOP_MIN 时以三窗格壳（导航轨 + 主人区 + 右侧信息栏）替代底部 TabBar */
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)
</script>

<template>
  <!-- 桌面三窗格壳：沉浸页（运动模式）同样隐藏导航轨 -->
  <div v-if="isDesktop" class="desk-frame">
    <DesktopRail v-if="!route.meta.fullscreen" />
    <main class="desk-main" :class="{ wide: route.name === 'home' }">
      <RouterView v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>
    <!-- 第三窗格 · 今日信息栏：全页面常驻（沉浸页除外），保证桌面构图平衡 -->
    <DesktopInspector v-if="!route.meta.fullscreen" />
  </div>

  <!-- 移动端（原结构）：内容居中窄栏 + 底部标签导航 -->
  <div v-else class="app-frame">
    <RouterView v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" />
      </Transition>
    </RouterView>
    <TabBar v-if="!route.meta.fullscreen" />
  </div>
  <!-- 悬浮运动条：异常中断恢复提示，桌面/移动共用（沉浸页隐藏） -->
  <ActiveWorkoutBar v-if="!route.meta.fullscreen" />
  <ToastHost />
</template>

<style scoped>
.app-frame {
  position: relative;
  max-width: var(--frame-max);
  min-height: 100dvh;
  margin: 0 auto;
  /* 避开手机状态栏/刘海；背景渐变铺满 body，内容在其下方滚动 */
  padding-top: var(--safe-top);
}

/* 桌面壳：导航轨 + 主人区 */
.desk-frame {
  display: flex;
  height: 100dvh;
  overflow: hidden;
}

.desk-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
}

/* 桌面端非主页页面：内容窄栏居中（移动端布局即 iPad 观感），右侧有常驻信息栏配重 */
.desk-main:not(.wide) :deep(.page) {
  max-width: 560px;
  margin: 0 auto;
}

/* 标签页切换：轻微淡入即可，不做位移（iOS 标签切换习惯） */
.page-enter-active,
.page-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}

.page-enter-from,
.page-leave-to {
  opacity: 0;
}
</style>
