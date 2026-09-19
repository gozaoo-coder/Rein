<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { House, User } from 'lucide-vue-next'

import { useFeaturesStore } from '@/stores/features'
import type { NavContribution } from '@/plugins'

/**
 * 底部标签导航：内核页固定在两端（主页 / 我），中间条目来自插件层——
 * 关掉「运动」模块，页签里就不会再有运动这一格。
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
  <nav class="tabbar">
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
.tabbar {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--frame-max);
  height: calc(var(--tabbar-h) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  display: flex;
  z-index: 60;
  background: var(--surface-translucent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-top: 0.5px solid var(--line);
}

@media (prefers-reduced-transparency: reduce) {
  .tabbar {
    background: var(--surface);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

.tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 600;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-standard);
}

.tab.active {
  color: var(--accent);
}
</style>
