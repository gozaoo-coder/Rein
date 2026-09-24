<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { House, Sparkles, User } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import GlassSurface from '@/components/common/GlassSurface.vue'
import { useDockStore } from '@/stores/dock'
import { useFeaturesStore } from '@/stores/features'
import type { NavContribution } from '@/plugins'

/**
 * 底部悬浮 Dock：三块并列的玻璃，装配与画质预览页的标本台同款（圆 + 药丸 + 圆）。
 *
 *   左 · 独立圆钮：**用户自定义落点**（默认课表，长按换一个模块主页面）
 *   中 · 药丸：内核两格（主页 / 我）与插件条目（运动…）按 order 排在一起
 *   右 · 独立圆钮：AI —— 内核功能（不可关），与主页/我 一样由 Dock 自己声明
 *
 * 材质一律走 GlassSurface（与标本同一个组件、同一组默认参数）：超高档三块各自折射
 * 背后的**页面真实内容**，其余档位退化成普通毛玻璃；弱档由 base.css 全局关掉 blur、
 * 把玻璃顶成实底。三块**并列留缝、互不叠压** —— 各自都带受光边，一叠就会在缝上
 * 出现一道月牙形硬边（与标本台同一条结论）。折射的底**直接用 --glass-fill**
 * （与其余档位、其余玻璃同色）：底再薄一点，页签文字的真图对比度就会掉下去
 * （真图采像素，见 scripts/e2e-perf-glass.mjs 第 6 节）。
 *
 * 柔性反馈沿用老 Dock：按下一拍快速挤压（volume-preserving squash），松手沿弹簧
 * 曲线回弹过冲，一段过渡自然带出「压扁 → 拉长 → 回正」，不需要 JS。
 */
const CORE_TABS: NavContribution[] = [
  { route: 'home', label: '主页', icon: House, surfaces: ['tabbar'], order: 0 },
  { route: 'me', label: '我', icon: User, surfaces: ['tabbar'], order: 990 },
]

/** 右独立圆钮的落点：AI */
const AI_TAB: NavContribution = { route: 'ai', label: 'AI', icon: Sparkles, surfaces: ['tabbar'], order: 0 }

/** 三块玻璃的几何：两侧正圆与药丸同高（= Dock 高度），圆角从高度推出来 */
const BLOCK = 'var(--tabbar-h)'
/** 长按判定：按住这么久就开选择器（松手不跳转） */
const LONG_PRESS_MS = 480

const features = useFeaturesStore()
const dock = useDockStore()
const route = useRoute()
const router = useRouter()

/** 药丸页签：内核两格 + 插件条目，按 order 排（关掉「运动」模块，这一格就消失） */
const tabs = computed(() => [...CORE_TABS, ...features.nav('tabbar')].sort((a, b) => a.order - b.order))

/** 左钮候选：导航轨里的模块主页面（已按插件开关过滤），去掉 Dock 里已有的落点 */
const candidates = computed(() => {
  const taken = new Set([...tabs.value.map((t) => t.route), AI_TAB.route])
  return features.nav('rail').filter((n) => !taken.has(n.route))
})

/** 左钮落点：存量落点失效（模块被关）时回落到候选第一项；一个候选都没有就整块不画 */
const leftTab = computed(
  () => candidates.value.find((c) => c.route === dock.leftRoute) ?? candidates.value[0] ?? null,
)

/* ---------- 左钮：短按直达 / 长按换落点 ---------- */
const pickerOpen = ref(false)
let pressTimer: ReturnType<typeof setTimeout> | null = null
let longPressed = false

function cancelPress(): void {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

function startPress(): void {
  longPressed = false
  cancelPress()
  pressTimer = setTimeout(() => {
    pressTimer = null
    longPressed = true
    pickerOpen.value = true
  }, LONG_PRESS_MS)
}

function onLeftClick(e: MouseEvent): void {
  // 长按已经开过选择器：这次抬手不该再当成一次跳转
  if (longPressed) {
    e.preventDefault()
    return
  }
  if (leftTab.value) void router.push({ name: leftTab.value.route })
}

function closePicker(): void {
  pickerOpen.value = false
  longPressed = false
}

const pickerActions = computed(() => candidates.value.map((c) => ({ label: c.label, value: c.route })))

onBeforeUnmount(cancelPress)
</script>

<template>
  <nav class="dock" aria-label="主导航">
    <!-- 左 · 独立圆钮（自定义落点）：短按直达，长按换一个模块主页面 -->
    <GlassSurface
      v-if="leftTab"
      class="dock-block"
      data-slot="left"
      :width="BLOCK"
      :height="BLOCK"
      border-radius="50%"
      fill="var(--glass-fill)"
    >
      <button
        type="button"
        class="dock-slot"
        :class="{ active: route.name === leftTab.route }"
        :aria-label="`${leftTab.label}（长按更换）`"
        @pointerdown="startPress"
        @pointerup="cancelPress"
        @pointerleave="cancelPress"
        @pointercancel="cancelPress"
        @contextmenu.prevent
        @click="onLeftClick"
      >
        <component :is="leftTab.icon" :size="21" :stroke-width="route.name === leftTab.route ? 2.4 : 1.9" />
        <span>{{ leftTab.label }}</span>
      </button>
    </GlassSurface>

    <!-- 中 · 药丸：内核 + 插件页签 -->
    <GlassSurface
      class="dock-block pill"
      :height="BLOCK"
      border-radius="var(--radius-full)"
      fill="var(--glass-fill)"
    >
      <RouterLink
        v-for="it in tabs"
        :key="it.route"
        :to="{ name: it.route }"
        class="dock-tab"
        :class="{ active: route.name === it.route }"
      >
        <component :is="it.icon" :size="22" :stroke-width="route.name === it.route ? 2.4 : 1.9" />
        <span>{{ it.label }}</span>
      </RouterLink>
    </GlassSurface>

    <!-- 右 · 独立圆钮：AI -->
    <GlassSurface
      class="dock-block"
      data-slot="ai"
      :width="BLOCK"
      :height="BLOCK"
      border-radius="50%"
      fill="var(--glass-fill)"
    >
      <RouterLink
        :to="{ name: AI_TAB.route }"
        class="dock-slot"
        :class="{ active: route.name === AI_TAB.route }"
      >
        <component
          :is="AI_TAB.icon"
          :size="21"
          :stroke-width="route.name === AI_TAB.route ? 2.4 : 1.9"
        />
        <span>{{ AI_TAB.label }}</span>
      </RouterLink>
    </GlassSurface>

    <!-- 长按左钮的选择器：候选来自插件层（关掉模块即从清单里消失） -->
    <ActionSheet
      :open="pickerOpen"
      title="底栏左键"
      :actions="pickerActions"
      @select="dock.setLeftRoute"
      @close="closePicker"
    />
  </nav>
</template>

<style scoped>
/* 几何归 Dock 自己；三块玻璃的尺寸关系与前景（.dock-block / .dock-tab / .dock-slot）
   在全局 base.css —— 与画质预览页的标本共用同一份，标本才不会与真实 Dock 长得不像；
   材质（折射 / 毛玻璃 / 退化）全在 GlassSurface 里。 */
.dock {
  position: fixed;
  bottom: calc(var(--safe-bottom) + var(--dock-float));
  left: var(--safe-left);
  right: var(--safe-right);
  margin: 0 auto;
  max-width: var(--frame-max);
  height: var(--tabbar-h);
  display: flex;
  gap: 8px;
  z-index: 60;
}
</style>
