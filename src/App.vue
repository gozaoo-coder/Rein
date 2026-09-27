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
import { campusService } from '@/services/campusService'
import { useFeaturesStore } from '@/stores/features'
import { useUpdateStore } from '@/stores/update'
import { useCourseSelectStore } from '@/stores/courseSelect'
import { useToast } from '@/composables/useToast'
import { askAiForGrabRescue } from '@/utils/campusAi'

const route = useRoute()
/** 桌面工作台：视口 ≥ DESKTOP_MIN 时以三窗格壳（导航轨 + 主人区 + 右侧信息栏）替代底部 TabBar */
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

/** 全屏形态：fullscreen 路由（跑步）或训练课沉浸层打开——隐藏壳导航与悬浮条 */
const shellVisible = computed(() => route.meta.fullscreen !== true)

/* ---------------- 参数错误 → 立刻交给 AI 补救 ----------------
 *
 * 教务说「参数错误」就是**这条请求的写法不对**：重试一万次也是同一个结果，
 * 而且每次都在用错的参数骚扰教务。引擎那边会停下来把任务标成 `needs_ai`
 * （见 grab.rs 的 `absorb_error`），这里负责**立刻把现场递给 AI**：
 * 用户要的是「放着不管它也有人在救」，而不是「先弹个提示等我来点」。
 *
 * 放在 App 层而不是抢课页里：用户可能已经翻去别的页面了，救援不该挑页面。
 * 每条任务只自动递一次（AI 那边可能有来回，不能反复把人拽走），之后
 * 面板上仍有「交给 AI 排查」的手动入口。
 *
 * **整个 watcher 受抢课开关管**：模块关着的时候任务根本不会推进，
 * 更不该把用户拽去 AI 页。
 */
const courseSelect = useCourseSelectStore()
const features = useFeaturesStore()
/** 抢课模块是否开着（课表的子模块，默认关闭） */
const grabOn = computed(() => features.isEnabled('campus-grab'))
const toast = useToast()
const aiHandedOff = new Set<number>()
watch(
  () => courseSelect.grabTasks.map((t) => `${t.id}:${t.status}`).join(','),
  () => {
    if (!grabOn.value) return
    const bad = courseSelect.rejectedTasks.filter((t) => !aiHandedOff.has(t.id))
    if (!bad.length) return
    for (const t of bad) aiHandedOff.add(t.id)
    const first = bad[0]!
    askAiForGrabRescue(courseSelect.grab)
    toast.toast(
      `教务拒绝了抢课请求（参数错误）：「${first.courseName ?? first.lessonName ?? '这门课'}」已交给 AI 排查`,
    )
  },
)

/**
 * 把抢课开关同步给 Rust 引擎。三个时机都要做，缺一个就会出现
 * 「界面关了、引擎还在跑」这种最糟的不一致：
 * 1. 启动时（引擎自己也会从 `app_meta` 读，这里是双保险 + 覆盖热重载）；
 * 2. 开关被拨动时（含在设置页里拨）；
 * 3. 父模块「课表」被关掉时 —— 子模块随之失效，引擎也必须停。
 */
watch(
  grabOn,
  (on) => {
    void campusService.grabSetEnabled(on).catch(() => {
      /* 引擎开关同步失败不该弹错：下次拨动或重启会再同步一次 */
    })
  },
  { immediate: true },
)

/**
 * 启动静默检查更新：只在「开关开着 + 距上次检查超过间隔」时真的联网，
 * 有新版本就弹一张明确的更新卡片（立即更新 / 稍后 / 跳过此版本）。
 * 刻意不阻塞任何首屏渲染：慢网络下最坏的结果只是卡片晚几秒出现。
 */
const updatePrompt = ref(false)

onMounted(() => {
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
    <DesktopRail v-show="shellVisible" data-immersive-shell />
    <main class="desk-main" :class="{ wide: route.name === 'home' || route.name === 'todos' }">
      <!-- 超范围平移层（桌面）：到边拖动时整页位移，只写 transform、不改布局（system/rubberScroll） -->
      <div data-rubber-content>
        <RouterView v-slot="{ Component }">
          <Transition name="page">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </div>
    </main>
    <!-- 第三窗格 · 今日信息栏：全页面常驻（沉浸页除外），保证桌面构图平衡 -->
    <DesktopInspector v-show="shellVisible" data-immersive-shell />
  </div>

  <!-- 移动端（原结构）：内容居中窄栏 + 底部标签导航 -->
  <div v-else class="app-frame">
    <!-- 超范围平移层（移动端）：页面内容整体位移；TabBar 留在层外保持定格 -->
    <div data-rubber-page>
      <RouterView v-slot="{ Component }">
        <Transition name="page">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </div>
    <TabBar
      v-show="shellVisible"
      data-immersive-shell
    />
  </div>
  <!-- 悬浮运动条：收起完成后才恢复，自身按停靠方向渐入 -->
  <ActiveWorkoutBar />
  <!-- 录音悬浮条：录音进行中常驻（可拖拽停靠，轻点进录音页） -->
  <RecordFloatBar v-show="shellVisible" data-immersive-shell />
  <!-- 语音转写悬浮条：语音会话收起后台转写继续（与录音浮条同套停靠、独立 key） -->
  <VoiceFloatBar v-show="shellVisible" data-immersive-shell />
  <!-- 抢课监视器：后台引擎有活儿时顶部落一条，点进选课页（顶部定位，不与底部三条浮条抢位）。
       受模块开关管：关掉抢课（默认关）就不该有任何常驻 UI。 -->
  <GrabFloatBar v-if="grabOn" v-show="shellVisible" data-immersive-shell />
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
