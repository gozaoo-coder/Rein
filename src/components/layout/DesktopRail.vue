<script setup lang="ts">
import { useRoute } from 'vue-router'
import { Dumbbell, House, ListTodo, PiggyBank, Sparkles, Timer, User, Utensils } from 'lucide-vue-next'

/** 桌面三窗格壳 · 左侧导航轨：替代底部 TabBar，提供一级/常用页直达。 */
const items = [
  { name: 'home', label: '总览', icon: House },
  { name: 'nutrition', label: '营养', icon: Utensils },
  { name: 'sports', label: '运动', icon: Dumbbell },
  { name: 'focus', label: '专注', icon: Timer },
  { name: 'todos', label: '待办', icon: ListTodo },
  { name: 'ledger', label: '记账', icon: PiggyBank },
  { name: 'ai', label: 'AI', icon: Sparkles },
] as const

const route = useRoute()
</script>

<template>
  <nav class="rail" aria-label="主导航">
    <button class="logo" aria-label="Rein 主页" title="总览" @click="$router.push({ name: 'home' })" />
    <div class="navs col">
      <RouterLink
        v-for="it in items"
        :key="it.name"
        :to="{ name: it.name }"
        class="ric"
        :class="{ on: route.name === it.name }"
        :aria-label="it.label"
        :title="it.label"
      >
        <component :is="it.icon" :size="21" :stroke-width="route.name === it.name ? 2.2 : 1.9" />
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
.rail {
  width: 64px;
  flex: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 18px 0 20px;
  background: var(--surface-translucent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-right: 0.5px solid var(--line);
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
