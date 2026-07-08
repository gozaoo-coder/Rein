<script setup lang="ts">
/**
 * AppTopBar — HarmonyOS 沉浸光感 sticky header.
 * Ultra_Thin glass tier that tints content beneath; supports large title,
 * circular icon actions (registered via useTopBar composable).
 */
import { computed } from "vue";
import { useBreakpoint } from "@/composables/useBreakpoint";
import { useRoute } from "vue-router";
import { useTopBar } from "@/composables/useTopBar";

const { mode } = useBreakpoint();
const route = useRoute();
const { actions } = useTopBar();

const isPhone = computed(() => mode.value === "phone");

const pageTitle = computed(() => {
  const p = route.path;
  if (p === "/") return "首页";
  if (p.startsWith("/sports")) return "运动";
  if (p.startsWith("/ai")) return "AI";
  if (p.startsWith("/profile")) return "我的";
  if (p.startsWith("/todo")) return "待办";
  if (p.startsWith("/health/water")) return "饮水";
  if (p.startsWith("/health/food")) return "饮食";
  if (p.startsWith("/health/bmi")) return "身体数据";
  if (p.startsWith("/health/metrics")) return "健康概览";
  if (p.startsWith("/health")) return "健康";
  return "Rein";
});
</script>

<template>
  <header
    class="app-top-bar safe-area-top"
    :class="{ 'top-bar-phone': isPhone }"
  >
    <div class="top-bar-inner">
      <h1 class="top-bar-title" :class="{ 'title-phone': isPhone }">
        {{ pageTitle }}
      </h1>
      <div class="top-bar-actions" v-if="actions.length > 0">
        <button
          v-for="a in actions"
          :key="a.id"
          class="top-bar-icon-btn"
          :aria-label="a.label"
          @click="a.onClick()"
        >
          <i :class="['bi', `bi-${a.icon}`]" style="font-size:20px"></i>
        </button>
      </div>
    </div>
    <div v-if="$slots.default" class="top-bar-extra">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.app-top-bar {
  position: sticky;
  top: 0;
  z-index: 50;
  flex-shrink: 0;
  background: var(--material-ultra-thin-bg);
  -webkit-backdrop-filter: blur(var(--material-ultra-thin-blur)) var(--glass-blur-saturate);
  backdrop-filter: blur(var(--material-ultra-thin-blur)) var(--glass-blur-saturate);
  border-bottom: 1px solid transparent;
  transition: background var(--dur-halo) var(--ease-immersive),
              border-color var(--dur-halo) var(--ease-immersive);
}

.top-bar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 var(--space-5);
}

.top-bar-phone .top-bar-inner {
  height: 52px;
}

.top-bar-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  letter-spacing: -0.01em;
  margin: 0;
  line-height: var(--lh-tight);
}

.title-phone {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  letter-spacing: -0.03em;
}

.top-bar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.top-bar-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.55);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: var(--color-text);
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    background-color var(--dur-fast) var(--ease-immersive),
    opacity var(--dur-fast) var(--ease-immersive);
  padding: 0;
}

.top-bar-icon-btn:active {
  transform: scale(0.9);
  background: rgba(255, 255, 255, 0.8);
  opacity: 0.8;
}

.top-bar-extra {
  padding: 0 var(--space-5) var(--space-3);
}
</style>
