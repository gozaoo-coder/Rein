<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { RouterView } from 'vue-router'

import TabBar from '@/components/layout/TabBar.vue'
import DesktopRail from '@/components/layout/DesktopRail.vue'
import DesktopInspector from '@/components/layout/DesktopInspector.vue'
import ActiveWorkoutBar from '@/components/exercise/ActiveWorkoutBar.vue'
import RecordFloatBar from '@/components/record/RecordFloatBar.vue'
import GrabFloatBar from '@/components/campus/GrabFloatBar.vue'
import VoiceSessionView from '@/components/voice/VoiceSessionView.vue'
import VoiceFloatBar from '@/components/voice/VoiceFloatBar.vue'
import SessionOverlay from '@/components/exercise/SessionOverlay.vue'
import UpdatePrompt from '@/components/update/UpdatePrompt.vue'
import ToastHost from '@/components/common/ToastHost.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'
import { useUpdateStore } from '@/stores/update'
import { kickPerfWatch, startPerfWatch } from '@/system/perf'
import { immersiveClosing, immersiveOpen } from '@/system/sessionImmersive'

const route = useRoute()
/** 桌面工作台：视口 ≥ DESKTOP_MIN 时以三窗格壳（导航轨 + 主人区 + 右侧信息栏）替代底部 TabBar */
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

/** 全屏形态：fullscreen 路由（跑步）或训练课沉浸层打开——隐藏壳导航与悬浮条 */
const fullscreenUI = computed(() => route.meta.fullscreen === true || immersiveOpen.value)
/** 沉浸层收起动画期间悬浮条提前回归，与形变块同位接续（v-show 保实例，动画不打断弹簧状态） */
const wbarVisible = computed(() => !fullscreenUI.value || immersiveClosing.value)

/** 路由切换是一轮已知的重负载（整页重建 + 入场过渡）：让性能采样插队补一轮，
 *  不必等休息窗口到期——卡顿最容易发生在这里，也最容易被「刚好没在采样」漏掉。 */
watch(() => route.fullPath, () => kickPerfWatch())

/**
 * 启动静默检查更新：只在「开关开着 + 距上次检查超过间隔」时真的联网，
 * 有新版本就弹一张明确的更新卡片（立即更新 / 稍后 / 跳过此版本）。
 * 刻意不阻塞任何首屏渲染：慢网络下最坏的结果只是卡片晚几秒出现。
 */
const updatePrompt = ref(false)

onMounted(() => {
  startPerfWatch()
  const update = useUpdateStore()
  void (async () => {
    await update.load()
    if (await update.autoCheckIfDue()) updatePrompt.value = true
  })()
})
</script>

<template>
  <!-- 桌面三窗格壳：沉浸页（运动模式）同样隐藏导航轨 -->
  <div v-if="isDesktop" class="desk-frame">
    <DesktopRail v-if="!fullscreenUI" />
    <main class="desk-main" :class="{ wide: route.name === 'home' || route.name === 'todos' }">
      <RouterView v-slot="{ Component }">
        <Transition name="page">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>
    <!-- 第三窗格 · 今日信息栏：全页面常驻（沉浸页除外），保证桌面构图平衡 -->
    <DesktopInspector v-if="!fullscreenUI" />
  </div>

  <!-- 移动端（原结构）：内容居中窄栏 + 底部标签导航 -->
  <div v-else class="app-frame">
    <RouterView v-slot="{ Component }">
      <Transition name="page">
        <component :is="Component" />
      </Transition>
    </RouterView>
    <TabBar v-if="!fullscreenUI" />
  </div>
  <!-- 悬浮运动条：异常中断恢复提示，桌面/移动共用（沉浸形态下隐藏；收起动画期间提前回归接续） -->
  <ActiveWorkoutBar v-show="wbarVisible" />
  <!-- 录音悬浮条：录音进行中常驻（可拖拽停靠，轻点进录音页） -->
  <RecordFloatBar v-show="wbarVisible" />
  <!-- 语音转写悬浮条：语音会话收起后台转写继续（与录音浮条同套停靠、独立 key） -->
  <VoiceFloatBar v-show="wbarVisible" />
  <!-- 抢课监视器：后台引擎有活儿时顶部落一条，点进选课页（顶部定位，不与底部三条浮条抢位） -->
  <GrabFloatBar v-show="wbarVisible" />
  <!-- 语音会话视图：单例 runtime 驱动，任何入口可唤起（voiceRuntime.openView） -->
  <VoiceSessionView />
  <!-- 训练课沉浸层：常驻挂载不走路由（system/sessionImmersive 驱动显隐与形变） -->
  <SessionOverlay />
  <!-- 启动检查到新版本时的更新卡片（立即更新 / 稍后 / 跳过此版本） -->
  <UpdatePrompt :open="updatePrompt" @close="updatePrompt = false" />
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

/* 页面切换：新页淡入衔接，旧页同步让位——不做 out-in 空屏，也不做旧页淡出 */
.page-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}

.page-enter-from {
  opacity: 0;
}

/* 离场瞬时移除：淡出会与入场抢同一段视觉，读起来像两次变化 */
.page-leave-active {
  transition: none;
}
</style>
