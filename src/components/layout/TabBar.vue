<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { House, User } from 'lucide-vue-next'

import { useFeaturesStore } from '@/stores/features'
import type { NavContribution } from '@/plugins'

/**
 * 底部悬浮 Dock：内核页固定在两端（主页 / 我），中间条目来自插件层——
 * 关掉「运动」模块，Dock 里就不会再有运动这一格。
 *
 * 玻璃体（ColorOS 17 风格演示）：胶囊悬浮于底缘之上——半透明玻璃底 +
 * backdrop 模糊、上亮下暗的受光描边（--glass-rim-*）、内顶高光（--glass-sheen），
 * 颜色一律走 tokens；弱档（system/perf 默认档）由 base.css 把玻璃顶成实底、
 * blur 由该档全局关停。
 *
 * 柔性反馈：按下一拍快速挤压（volume-preserving squash），松手沿弹簧曲线
 * 回弹过冲（--ease-spring 会冲过目标再收回），一段过渡自然带出
 * 「压扁 → 拉长 → 回正」的物理观感，不需要 JS。
 */
const CORE_TABS: NavContribution[] = [
  { route: 'home', label: '主页', icon: House, surfaces: ['tabbar'], order: 0 },
  { route: 'me', label: '我', icon: User, surfaces: ['tabbar'], order: 990 },
]

const features = useFeaturesStore()
const items = computed(() => [...CORE_TABS, ...features.nav('tabbar')].sort((a, b) => a.order - b.order))

const route = useRoute()
</script>

<template>
  <nav class="dock">
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
  /* 玻璃体：实底画在 padding-box，受光描边画在 border-box——渐变描边不占额外布局，
     顶部亮、往下渐暗，模拟顶光打在玻璃截面上的边缘亮度 */
  border: 1px solid transparent;
  background:
    linear-gradient(var(--glass-fill), var(--glass-fill)) padding-box,
    linear-gradient(to bottom, var(--glass-rim-hi), var(--glass-rim-lo) 70%) border-box;
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  box-shadow:
    var(--glass-shadow),
    inset 0 1px 0 var(--glass-sheen),
    inset 0 10px 18px -12px var(--glass-sheen);
}

@media (prefers-reduced-transparency: reduce) {
  .dock {
    background: var(--surface);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-color: var(--line);
    box-shadow: var(--shadow-float);
  }
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
   z-index 压到内容下面（dock 是 fixed + blur 的层叠上下文，-1 恰落在玻璃底之上） */
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
