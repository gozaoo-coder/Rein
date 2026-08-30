<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts } = useToast()
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast">{{ t.text }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 26px + var(--wbar-reserve, 0px));
  z-index: 120;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.toast {
  background: rgba(250, 250, 250, 0.92);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: #1d1d1f;
  font-size: var(--fs-footnote);
  font-weight: 600;
  padding: 10px 20px;
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-float);
  white-space: nowrap;
}

@media (prefers-color-scheme: dark) {
  .toast {
    background: rgba(58, 58, 60, 0.94);
    color: #f5f5f7;
  }
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-standard);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
