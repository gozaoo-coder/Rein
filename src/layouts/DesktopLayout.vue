<script setup lang="ts">
import AppShell from "@/components/shell/AppShell.vue";
</script>

<template>
  <AppShell>
    <template #sidebar>
      <nav class="sidebar">
        <div class="sidebar-brand">
          <span class="sidebar-logo">R</span>
          <span class="sidebar-title">Rein</span>
        </div>
        <ul class="sidebar-nav">
          <li>
            <router-link to="/" class="sidebar-link">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              <span>健康</span>
            </router-link>
          </li>
          <li>
            <router-link to="/sports" class="sidebar-link">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="5" r="3" />
                <path d="M12 8v4M8 12l-2 6M16 12l2 6M7 19h10" />
              </svg>
              <span>运动</span>
            </router-link>
          </li>
          <li>
            <router-link to="/ai" class="sidebar-link">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a7 7 0 0 1 7 7c0 3-1.5 4.5-3 6l-1 1v3h-6v-3l-1-1c-1.5-1.5-3-3-3-6a7 7 0 0 1 7-7z" />
                <line x1="9" y1="21" x2="15" y2="21" />
              </svg>
              <span>AI</span>
            </router-link>
          </li>
          <li>
            <router-link to="/profile" class="sidebar-link">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="8" r="4" />
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              </svg>
              <span>我的</span>
            </router-link>
          </li>
        </ul>
      </nav>
    </template>
    <template #content>
      <router-view />
    </template>
  </AppShell>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: 240px;
  height: 100%;
  padding: var(--space-6) var(--space-4);
  background: var(--color-bg-elevated);
  border-right: 1px solid var(--color-divider);
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-8);
}

.sidebar-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: var(--color-primary-text);
  font-weight: 700;
  font-size: 16px;
}

.sidebar-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
}

.sidebar-nav {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.sidebar-link {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: 15px;
  transition: all 0.2s ease;
  text-decoration: none;
}

.sidebar-link:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
  text-decoration: none;
}

.sidebar-link.router-link-active {
  background: var(--brand-500);
  color: var(--brand-50);
}
</style>
