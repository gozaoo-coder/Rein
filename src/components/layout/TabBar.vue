<script setup lang="ts">
import { useRoute } from 'vue-router'
import { Dumbbell, House, Sparkles, User } from 'lucide-vue-next'

/** 底部标签导航 · 固定四个一级页面（与 router.ts 一一对应） */
const items = [
  { name: 'home', label: '主页', icon: House },
  { name: 'sports', label: '运动', icon: Dumbbell },
  { name: 'ai', label: 'AI', icon: Sparkles },
  { name: 'me', label: '我', icon: User },
] as const

const route = useRoute()
</script>

<template>
  <nav class="tabbar">
    <RouterLink
      v-for="it in items"
      :key="it.name"
      :to="{ name: it.name }"
      class="tab"
      :class="{ active: route.name === it.name }"
    >
      <component :is="it.icon" :size="22" :stroke-width="route.name === it.name ? 2.4 : 1.9" />
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
