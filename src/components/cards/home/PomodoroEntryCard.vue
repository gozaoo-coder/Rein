<script setup lang="ts">
/**
 * PomodoroEntryCard — 番茄钟入口卡片
 *
 * 点击打开番茄钟页面/窗口（桌面端创建新窗口，移动端/Web 路由跳转）。
 * 展示今日已完成番茄数。
 * 1x1 / 2x1 / 1x2 / 2x2
 */
import { computed } from "vue";
import type { CardSize } from "@/types/card";
import { openPomodoro } from "@/composables/usePomodoroWindow";
import { usePomodoroStore } from "@/stores/pomodoroStore";

defineProps<{ size: CardSize }>();

const pomodoroStore = usePomodoroStore();

const todayCompleted = computed(() => pomodoroStore.todayCompleted);
</script>

<template>
  <div
    class="home-card clean-card pomo-entry-card"
    :class="`home-card--${size}`"
    @click="openPomodoro"
  >
    <!-- 1x1：仅图标，极简 -->
    <div v-if="size === '1x1'" class="mini">
      <i class="bi bi-clock pomo-icon"></i>
    </div>

    <!-- 2x1：左图标 + 标题 + 今日数 -->
    <div v-else-if="size === '2x1'" class="row-2">
      <span class="title-icon title-icon--danger">
        <i class="bi bi-clock" style="font-size:12px"></i>
      </span>
      <div class="row-text">
        <span class="card-title">番茄钟</span>
        <span class="count-text">今日 {{ todayCompleted }} 个</span>
      </div>
    </div>

    <!-- 1x2：纵向——图标、标题、数 -->
    <div v-else-if="size === '1x2'" class="col-2">
      <span class="title-icon title-icon--danger">
        <i class="bi bi-clock" style="font-size:14px"></i>
      </span>
      <span class="card-title">番茄钟</span>
      <div class="count-stack">
        <span class="count-num">{{ todayCompleted }}</span>
        <span class="count-label">今日完成</span>
      </div>
    </div>

    <!-- 2x2：头部 + 大数字 + 标签 + 提示 -->
    <template v-else>
      <div class="card-head">
        <span class="title-icon title-icon--danger">
          <i class="bi bi-clock" style="font-size:14px"></i>
        </span>
        <span class="card-title">番茄钟</span>
      </div>
      <div class="big-stack">
        <span class="big-num">{{ todayCompleted }}</span>
        <span class="big-label">今日完成</span>
      </div>
      <div class="hint">点击开始专注</div>
    </template>
  </div>
</template>

<style scoped>
.pomo-entry-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  text-align: left;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive);
}
.pomo-entry-card:active { transform: scale(0.98); }
.pomo-entry-card:hover { box-shadow: var(--shadow-card-hover); }

/* 1x1：紧凑内边距 */
.home-card--1x1 {
  padding: var(--space-2);
  gap: var(--space-1);
  align-items: center;
  justify-content: center;
}

.mini {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pomo-icon {
  font-size: 22px;
  color: var(--danger-500);
  line-height: 1;
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
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
.title-icon--danger { background: var(--danger-500); }

.card-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 2x1：横向 */
.row-2 {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 0;
}
.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.count-text {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  line-height: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
}
.col-2 .card-title {
  font-size: var(--text-md);
}
.count-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.count-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--danger-500);
  line-height: 1;
}
.count-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

/* 2x2：大数字 */
.big-stack {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: 0;
}
.big-num {
  font-size: 48px;
  font-weight: var(--fw-bold);
  color: var(--danger-500);
  line-height: 1;
}
.big-label {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  text-align: center;
  line-height: 1;
}
</style>
