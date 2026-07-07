<script setup lang="ts">
/**
 * AppTabBar — Bottom navigation.
 * Phone/Pad: fixed bottom bar, 4 tabs, active = warm orange.
 * Desktop: hidden (sidebar navigation).
 */
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();

const tabs = [
  { path: "/", label: "健康", icon: "health" },
  { path: "/sports", label: "运动", icon: "sports" },
  { path: "/devices", label: "设备", icon: "devices" },
  { path: "/profile", label: "我的", icon: "profile" },
];

function isActive(path: string) {
  if (path === "/") return route.path === "/";
  return route.path.startsWith(path);
}

function navigate(path: string) {
  if (route.path !== path) {
    router.push(path).catch(() => {});
  }
}
</script>

<template>
  <nav class="app-tab-bar safe-area-bottom">
    <button
      v-for="tab in tabs"
      :key="tab.path"
      class="tab-item"
      :class="{ active: isActive(tab.path) }"
      @click="navigate(tab.path)"
    >
      <span class="tab-icon">
        <!-- Health: ring -->
        <svg v-if="tab.icon === 'health'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <circle cx="12" cy="12" r="8" />
        </svg>
        <!-- Sports: running figure -->
        <svg v-else-if="tab.icon === 'sports'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="15" cy="5" r="2" />
          <path d="M10 21l2-6 3 2 3-5-3-1-3 3-3-1-3 5z" />
          <path d="M7 14l2-2" />
        </svg>
        <!-- Devices: watch -->
        <svg v-else-if="tab.icon === 'devices'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="6" width="12" height="12" rx="3" />
          <path d="M9 6V4M15 6V4M9 20v-2M15 20v-2" />
        </svg>
        <!-- Profile: person -->
        <svg v-else width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-1a7 7 0 0 1 14 0v1" />
        </svg>
      </span>
      <span class="tab-label">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.app-tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
  display: flex;
  align-items: flex-start;
  justify-content: space-around;
  height: 64px;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background: rgba(255, 255, 255, 0.95);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 1;
  height: 100%;
  color: var(--bg-500);
  font-size: var(--text-xs);
  text-decoration: none;
  background: none;
  border: none;
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-immersive);
  padding: 0;
}

.tab-item.active {
  color: var(--color-warm);
}

.tab-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
}

.tab-label {
  line-height: 1;
  font-size: var(--text-xs);
}
</style>
