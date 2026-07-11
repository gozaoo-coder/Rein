<script setup lang="ts">
/**
 * PomodoroQuickStartCard — 快速专注卡片
 *
 * 整张卡片为触发按钮，点击立即启动番茄钟并打开页面/窗口。
 * 1x1 / 2x1 / 1x2 / 2x2
 */
import { computed } from "vue";
import type { CardSize } from "@/types/card";
import { openPomodoro } from "@/composables/usePomodoroWindow";
import { usePomodoroStore } from "@/stores/pomodoroStore";

const props = defineProps<{ size: CardSize }>();

const pomodoroStore = usePomodoroStore();

const isVertical = computed(() => props.size === "1x1" || props.size === "1x2");

async function onStart() {
  pomodoroStore.start();
  await openPomodoro();
}
</script>

<template>
  <button
    type="button"
    class="home-card clean-card pomo-quick-card"
    :class="[`home-card--${size}`, { 'pomo-quick-card--vertical': isVertical }]"
    @click="onStart"
  >
    <!-- 1x1：大播放图标，极简 -->
    <div v-if="size === '1x1'" class="mini">
      <i class="bi bi-play-circle-fill pomo-play"></i>
    </div>

    <!-- 2x1：图标 + 标题 + 副标题 -->
    <div v-else-if="size === '2x1'" class="row-2">
      <i class="bi bi-play-circle-fill pomo-play"></i>
      <div class="row-text">
        <span class="card-title">快速专注</span>
        <span class="card-sub">25分钟</span>
      </div>
    </div>

    <!-- 1x2：纵向——图标、标题、副标题 -->
    <div v-else-if="size === '1x2'" class="col-2">
      <i class="bi bi-play-circle-fill pomo-play"></i>
      <span class="card-title">快速专注</span>
      <span class="card-sub">25分钟</span>
    </div>

    <!-- 2x2：头部 + 大按钮 + 提示 -->
    <template v-else>
      <div class="card-head">
        <span class="title-icon title-icon--warm">
          <i class="bi bi-play-fill" style="font-size:12px"></i>
        </span>
        <span class="card-title">快速专注</span>
      </div>
      <div class="big-circle">
        <i class="bi bi-play-circle-fill"></i>
      </div>
      <div class="hint">点击即刻开始</div>
    </template>
  </button>
</template>

<style scoped>
.pomo-quick-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3);
  text-align: left;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border: none;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive);
}
.pomo-quick-card:active { transform: scale(0.98); }
.pomo-quick-card:hover { box-shadow: var(--shadow-card-hover); }

/* 1x1：紧凑内边距，居中 */
.home-card--1x1 {
  padding: var(--space-2);
  gap: var(--space-1);
}

.mini {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pomo-play {
  font-size: 24px;
  color: var(--color-warm);
  line-height: 1;
}

/* 2x1：横向 */
.row-2 {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 0;
  width: 100%;
}
.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.card-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-sub {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  line-height: 1;
}

/* 1x2：纵向 */
.col-2 {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 0;
  width: 100%;
}
.col-2 .pomo-play {
  font-size: 32px;
}

/* 2x2：大圆形按钮 */
.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  align-self: stretch;
}
.title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  color: #fff;
}
.title-icon--warm { background: var(--color-warm); }

.big-circle {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}
.big-circle .bi {
  font-size: 56px;
  color: var(--color-warm);
  line-height: 1;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.08));
}

.hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  text-align: center;
  line-height: 1;
}
</style>
