<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { House, User } from 'lucide-vue-next'

import GlassSurface from '@/components/common/GlassSurface.vue'
import { useFeaturesStore } from '@/stores/features'
import { liquidGlass } from '@/system/perf'
import type { NavContribution } from '@/plugins'

/**
 * 底部悬浮 Dock：内核页固定在两端（主页 / 我），中间条目来自插件层——
 * 关掉「运动」模块，Dock 里就不会再有运动这一格。
 *
 * 材质走全局 `.glass-surface`（styles/base.css）：半透明玻璃底 + 上亮下暗的受光描边
 * （--glass-rim-*）+ 内顶高光（--glass-sheen），颜色一律走 tokens；弱档由 base.css
 * 把玻璃顶成实底、blur 由该档全局关停。
 *
 * 柔性反馈：按下一拍快速挤压（volume-preserving squash），松手沿弹簧曲线
 * 回弹过冲（--ease-spring 会冲过目标再收回），一段过渡自然带出
 * 「压扁 → 拉长 → 回正」的物理观感，不需要 JS。
 *
 * **超高档（liquidGlass）多一层折射**：一块 GlassSurface 垫在页签底下 —— 与画质预览页
 * 的标本同一个组件、同一组默认参数（只有底的不透明度按「真实内容」调厚一点，见下）。
 * 折射采样的是元素背后**页面真实内容**，所以它必须是这一摞里的最底层：这一档 nav 自己
 * 不再画底、不再模糊，否则折射层采到的是自己那层色膜，什么都看不出来。
 */
const CORE_TABS: NavContribution[] = [
  { route: 'home', label: '主页', icon: House, surfaces: ['tabbar'], order: 0 },
  { route: 'me', label: '我', icon: User, surfaces: ['tabbar'], order: 990 },
]

const features = useFeaturesStore()
const items = computed(() => [...CORE_TABS, ...features.nav('tabbar')].sort((a, b) => a.order - b.order))

const route = useRoute()

/** 折射开不开：只看 system/perf 的三道门（超高档 + 未降级 + 内核认 url() 滤镜） */
const refract = computed(() => liquidGlass.value)
</script>

<template>
  <nav class="dock glass-surface" :class="{ 'is-refract': refract }">
    <!-- 折射层：只负责底与模糊（受光边与内顶高光在它自己身上，同一套 --glass-* 令牌）。
         底沿用高画质档的玻璃浓度（0.5 ≈ 亮色 --glass-fill 的 0.52）—— 标本压在暗场壁上、
         前景永远是浅色，真实 Dock 背后却是任意页面：底再薄一点，页签文字的真图对比度
         就会从 2.42 掉到 2.04（真图采像素，见 scripts/e2e-perf-glass.mjs 第 6 节）。
         pointer-events:none —— 命中区仍归页签。 -->
    <GlassSurface
      v-if="refract"
      class="refract-layer"
      border-radius="var(--radius-full)"
      :background-opacity="0.5"
      :style="{
        position: 'absolute',
        inset: '1px',
        width: 'auto',
        height: 'auto',
        zIndex: '0',
        pointerEvents: 'none',
      }"
    />
    <RouterLink
      v-for="it in items"
      :key="it.route"
      :to="{ name: it.route }"
      class="tab"
      :class="{ active: route.name === it.route }"
    >
      <component :is="it.icon" :size="22" :stroke-width="route.name === it.route ? 2.4 : 1.9" />
      <span>{{ it.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
/* 几何归 Dock 自己；材质（fill / 受光边 / 内顶高光 / blur / 投影 / 退化）在全局
   .glass-surface 里，与悬浮条共用同一份定义 */
.dock {
  position: fixed;
  bottom: calc(var(--safe-bottom) + var(--dock-float));
  left: var(--safe-left);
  right: var(--safe-right);
  margin: 0 auto;
  max-width: var(--frame-max);
  height: var(--tabbar-h);
  padding: 0 var(--radius-m);
  display: flex;
  z-index: 60;
  border-radius: var(--radius-full);
}

/* 超高档：底与模糊让给折射层（nav 退成纯定位壳）。
   但**受光边留着** —— 渐变描边（上亮下暗）是玻璃「厚度」的来源，折射层只管"透"，
   少了这条，超高档会比高画质更像一块塑料膜。折射层 inset 1px，正好让出这条边。 */
.dock.is-refract {
  background: linear-gradient(to bottom, var(--glass-rim-hi), var(--glass-rim-lo) 70%) border-box;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-color: transparent;
  box-shadow: none;
}

/* 折射层是 nav 的第一个定位子元素：页签必须自建层叠上下文，否则活动亮斑
   （.tab::before 的 z-index:-1）会掉到折射层底下 —— 整块衬底看不见 */
.dock.is-refract .tab {
  z-index: 1;
}

.tab {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-radius: var(--radius-full);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 600;
  text-decoration: none;
  /* 松手后的回弹段：弹簧曲线冲过 1 再收回（压扁 → 拉长 → 回正） */
  transition:
    transform 480ms var(--ease-spring),
    color var(--dur-fast) var(--ease-standard);
}

/* 按压段：快速挤压（纵向压得多、横向略胀，近似体积守恒）并即时换色 */
.tab:active {
  transform: scale(1.06, 0.9);
  transition:
    transform 120ms var(--ease-out),
    color var(--dur-fast) var(--ease-standard);
}

/* 活动页签的受光亮斑：顶光在玻璃面留下的柔亮区，随切页淡入淡出。
   z-index 压到内容下面（Dock 是 fixed 的层叠上下文，-1 恰落在玻璃底之上） */
.tab::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 4px 5px;
  border-radius: var(--radius-full);
  background: linear-gradient(to bottom, var(--glass-tab-hi), transparent 78%);
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-standard);
}

.tab.active {
  color: var(--accent);
}

.tab.active::before {
  opacity: 1;
}
</style>
