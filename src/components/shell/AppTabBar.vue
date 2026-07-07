<script setup lang="ts">
const tabs = [
  { path: "/", label: "健康", icon: "heart" },
  { path: "/sports", label: "运动", icon: "activity" },
  { path: "/ai", label: "AI", icon: "sparkles" },
  { path: "/profile", label: "我的", icon: "user" },
];
</script>

<template>
  <nav class="app-tab-bar glass-surface safe-area-bottom">
    <router-link
      v-for="tab in tabs"
      :key="tab.path"
      :to="tab.path"
      class="tab-item"
    >
      <span class="tab-icon">
        <!-- Heart -->
        <svg v-if="tab.icon === 'heart'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
        <!-- Activity -->
        <svg v-else-if="tab.icon === 'activity'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="5" r="3" />
          <path d="M12 8v4M8 12l-2 6M16 12l2 6M7 19h10" />
        </svg>
        <!-- Sparkles -->
        <svg v-else-if="tab.icon === 'sparkles'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 3-1.5 4.5-3 6l-1 1v3h-6v-3l-1-1c-1.5-1.5-3-3-3-6a7 7 0 0 1 7-7z" />
          <line x1="9" y1="21" x2="15" y2="21" />
        </svg>
        <!-- User -->
        <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        </svg>
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
  font-size: 10px;
  text-decoration: none;
  transition: color 0.2s ease;
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
