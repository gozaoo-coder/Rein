<script setup lang="ts">
/**
 * AppTabBar — Bottom floating navigation.
 * Material: Thin (HarmonyOS spec: bottom floating component).
 */
import ReinIcon from "@/components/ui/ReinIcon.vue";

const tabs = [
  { path: "/", label: "健康", icon: "heart" as const },
  { path: "/sports", label: "运动", icon: "activity" as const },
  { path: "/ai", label: "AI", icon: "sparkles" as const },
  { path: "/profile", label: "我的", icon: "user" as const },
];
</script>

<template>
  <nav class="app-tab-bar glass-thin safe-area-bottom">
    <router-link
      v-for="tab in tabs"
      :key="tab.path"
      :to="tab.path"
      class="tab-item"
    >
      <span class="tab-icon">
        <ReinIcon :name="tab.icon" :size="22" />
      </span>
      <span class="tab-label">{{ tab.label }}</span>
    </router-link>
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
  border-top: 1px solid var(--color-divider);
}

.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 1;
  height: 100%;
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-immersive);
}

.tab-item.router-link-active {
  color: var(--color-primary);
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
}
</style>
