<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { House, User } from 'lucide-vue-next'

import { useFeaturesStore } from '@/stores/features'
import type { NavContribution } from '@/plugins'

/**
 * 桌面三窗格壳 · 左侧导航轨：替代底部 TabBar，提供一级/常用页直达。
 * 除「总览」与末位的「我」外，条目全部来自插件层（关掉课表模块，这一格就消失）。
 */
const CORE_ITEMS: NavContribution[] = [
  { route: 'home', label: '总览', icon: House, surfaces: ['rail'], order: 0 },
]

const features = useFeaturesStore()
const items = computed(() => [...CORE_ITEMS, ...features.nav('rail')].sort((a, b) => a.order - b.order))

const route = useRoute()
</script>

<template>
  <nav class="rail glass-surface glass-edge-r" aria-label="主导航">
    <button class="logo" aria-label="Rein 主页" title="总览" @click="$router.push({ name: 'home' })" />
    <div class="navs col">
      <RouterLink
        v-for="it in items"
        :key="it.route"
        :to="{ name: it.route }"
        class="ric"
        :class="{ on: route.name === it.route }"
        :aria-label="it.label"
        :title="it.label"
      >
        <component :is="it.icon" :size="21" :stroke-width="route.name === it.route ? 2.2 : 1.9" />
      </RouterLink>
    </div>
    <RouterLink
      :to="{ name: 'me' }"
      class="ric me"
      :class="{ on: route.name === 'me' }"
      aria-label="我"
      title="我"
    >
      <User :size="21" :stroke-width="route.name === 'me' ? 2.2 : 1.9" />
    </RouterLink>
  </nav>
</template>

<style scoped>
/* 材质走全局那一份 .glass-surface（受光边 + 内顶高光 + 投影 + 超高的光学层），
   这里只给几何。原先是一份手写的 --surface-translucent + blur(20px)：与其余玻璃
   各写一套的代价是**档位升级要改两遍**，而超高档正是靠改令牌整套升级的。
   glass-edge-r：只保留靠内那一条描边 —— 左边贴着屏幕边缘，画框就是在边上多一条亮线。 */
.rail {
  width: 64px;
  flex: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 18px 0 20px;
  z-index: 50;
}

.logo {
  width: 26px;
  height: 26px;
  flex: none;
  margin-bottom: 22px;
  border-radius: 8px;
  background: conic-gradient(from 210deg, var(--c-intake), var(--c-exercise), var(--c-balance), var(--c-intake));
}

.navs {
  gap: 6px;
}

.ric {
  width: 42px;
  height: 42px;
  border-radius: var(--radius-m);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  text-decoration: none;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}

.ric:hover {
  color: var(--text-1);
}

.ric.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.me {
  margin-top: auto;
}
</style>
