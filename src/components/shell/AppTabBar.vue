<script setup lang="ts">
/**
 * AppTabBar — Floating pill-shaped bottom navigation.
 * HarmonyOS 沉浸光感 spec: Thin-tier glass capsule floating above content,
 * active tab has filled accent pill indicator behind icon+label.
 */
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();

const tabs = [
  { path: "/", label: "首页", icon: "home" },
  { path: "/sports", label: "运动", icon: "sports" },
  { path: "/ai", label: "AI", icon: "ai" },
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

const activeIndex = computed(() => {
  const idx = tabs.findIndex((t) => isActive(t.path));
  return idx >= 0 ? idx : 0;
});
</script>

<template>
  <nav class="tab-bar-wrap safe-area-bottom">
    <div class="tab-bar">
      <button
        v-for="(tab, idx) in tabs"
        :key="tab.path"
        class="tab-item"
        :class="{ 'is-active': isActive(tab.path) }"
        @click="navigate(tab.path)"
      >
        <span class="tab-indicator" aria-hidden="true" />
        <span class="tab-icon">
          <i v-if="tab.icon === 'home'" class="bi bi-house" style="font-size:22px"></i>
          <i v-else-if="tab.icon === 'sports'" class="bi bi-activity" style="font-size:22px"></i>
          <i v-else-if="tab.icon === 'ai'" class="bi bi-stars" style="font-size:22px"></i>
          <i v-else class="bi bi-person-circle" style="font-size:22px"></i>
        </span>
        <span class="tab-label">{{ tab.label }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.tab-bar-wrap {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  padding: 0 var(--space-3) calc(env(safe-area-inset-bottom, 0px) + var(--space-3));
  pointer-events: none;
}

.tab-bar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: var(--space-1);
  height: var(--pill-bar-height);
  padding: 4px;
  border-radius: var(--pill-bar-radius);
  background: var(--pill-bar-bg);
  -webkit-backdrop-filter: blur(var(--pill-bar-blur)) saturate(180%);
  backdrop-filter: blur(var(--pill-bar-blur)) saturate(180%);
  box-shadow: var(--pill-bar-shadow);
  border: 1px solid var(--material-thin-border);
  width: 100%;
  max-width: 360px;
}

.tab-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 var(--space-1);
  color: var(--bg-600);
  background: transparent;
  border: none;
  border-radius: calc(var(--pill-bar-radius) - 6px);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-immersive),
    transform var(--dur-fast) var(--ease-immersive);
  -webkit-tap-highlight-color: transparent;
}

.tab-item:active {
  transform: scale(0.92);
}

.tab-indicator {
  position: absolute;
  inset: 0;
  border-radius: calc(var(--pill-bar-radius) - 6px);
  background: transparent;
  transition: background var(--dur-fast) var(--ease-immersive);
  z-index: 0;
}

.tab-icon {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  transition: transform var(--dur-fast) var(--ease-immersive);
}

.tab-label {
  position: relative;
  z-index: 1;
  font-size: 11px;
  font-weight: var(--fw-medium);
  line-height: 1;
  white-space: nowrap;
  transition: color var(--dur-fast) var(--ease-immersive);
}

.tab-item.is-active {
  color: var(--color-primary-text);
}

.tab-item.is-active .tab-indicator {
  background: var(--color-warm);
}

.tab-item.is-active .tab-icon {
  transform: scale(1.05);
}

/* Larger screens: pill bar narrower */
@media (min-width: 768px) {
  .tab-bar {
    max-width: 320px;
  }
}
</style>
