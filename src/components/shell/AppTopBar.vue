<script setup lang="ts">
defineProps<{
  title?: string;
}>();

const emit = defineEmits<{
  (e: "add"): void;
}>();
</script>

<template>
  <header class="app-top-bar safe-area-top">
    <div class="top-bar-inner">
      <h1 class="top-bar-title">{{ title || 'Rein' }}</h1>
      <button class="top-bar-action" aria-label="添加" @click="emit('add')">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-top-bar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur));
  backdrop-filter: blur(var(--glass-blur));
  border-bottom: 1px solid var(--color-divider);
}

.top-bar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 var(--space-5);
  max-width: 100%;
}

.top-bar-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text);
}

.top-bar-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  background: var(--color-primary);
  color: var(--color-primary-text);
  transition: opacity 0.2s ease;
}

.top-bar-action:active {
  opacity: 0.7;
}
</style>
