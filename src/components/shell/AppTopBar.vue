<script setup lang="ts">
/**
 * AppTopBar — Page header.
 * Phone: transparent bg, large bold title, outline circle + button.
 * Pad/Desktop: glass-ultra-thin sticky bar.
 */
import { computed } from "vue";
import { useBreakpoint } from "@/composables/useBreakpoint";
import { useRoute } from "vue-router";

const { mode } = useBreakpoint();
const route = useRoute();

const isPhone = computed(() => mode.value === "phone");

const pageTitle = computed(() => {
  const map: Record<string, string> = {
    "/": "健康",
    "/sports": "运动",
    "/ai": "AI",
    "/profile": "我的",
  };
  return map[route.path] || "Rein";
});

const emit = defineEmits<{
  (e: "action"): void;
}>();
</script>

<template>
  <header
    class="app-top-bar safe-area-top"
    :class="{ 'top-bar-phone': isPhone, 'top-bar-glass': !isPhone }"
  >
    <div class="top-bar-inner">
      <h1 class="top-bar-title" :class="{ 'title-phone': isPhone }">
        {{ pageTitle }}
      </h1>
      <button
        v-if="pageTitle === '健康' || pageTitle === '运动'"
        class="top-bar-add"
        :class="{ 'add-phone': isPhone, 'add-glass': !isPhone }"
        aria-label="添加"
        @click="emit('action')"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-top-bar {
  position: relative;
  z-index: 50;
  flex-shrink: 0;
}

.top-bar-glass {
  position: sticky;
  top: 0;
  background: var(--material-ultra-thin-bg);
  -webkit-backdrop-filter: blur(var(--material-ultra-thin-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-ultra-thin-blur)) saturate(180%);
  border-bottom: 1px solid var(--color-divider);
}

.top-bar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 var(--space-5);
}

.top-bar-phone .top-bar-inner {
  height: 56px;
  padding: 0 var(--space-5);
}

.top-bar-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  letter-spacing: -0.01em;
  margin: 0;
}

.title-phone {
  font-size: var(--text-3xl);
  font-weight: var(--fw-bold);
  letter-spacing: -0.03em;
}

/* + Button — phone: outline circle */
.top-bar-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  border: 2px solid var(--color-text);
  color: var(--color-text);
  background: transparent;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    opacity var(--dur-fast) var(--ease-immersive),
    background-color var(--dur-fast) var(--ease-immersive);
}

.top-bar-add:active {
  transform: scale(0.9);
  opacity: 0.6;
}

/* + Button — glass: solid brand */
.add-glass {
  width: 32px;
  height: 32px;
  border: none;
  background: var(--color-primary);
  color: var(--color-primary-text);
  border-radius: var(--radius-full);
}
</style>
