<script setup lang="ts">
/**
 * UrgentTodoCard — 紧急待办（今日截止未完成）
 *
 * 1x1: 数量徽章 + 警告图标
 * 2x1: "紧急 X 项" + 首项标题
 * 2x2: 最多 4 条带警告图标 + 标题 + 时间
 */
import { computed } from "vue";
import { useTodoStore } from "@/stores/todoStore";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useTodoStore();

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const items = computed(() =>
  store.todayItems.filter((t) => !t.done && t.dueDate === todayKey()),
);
const count = computed(() => items.value.length);
const first = computed(() => items.value[0]);
const list = computed(() => items.value.slice(0, 4));

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
</script>

<template>
  <div
    class="home-card clean-card urg-card"
    :class="`home-card--${size}`"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--danger">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 0 0-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
        </svg>
      </span>
      <span class="card-title">紧急待办</span>
    </div>

    <!-- 1x1 -->
    <div v-if="size === '1x1'" class="mini">
      <span class="title-icon title-icon--danger">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 0 0-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
        </svg>
      </span>
      <div class="mini-num">{{ count }}</div>
      <div class="mini-label">紧急</div>
    </div>

    <!-- 2x1 -->
    <div v-else-if="size === '2x1'" class="row-2">
      <div class="big-num">
        <span class="num">{{ count }}</span>
        <span class="unit">项</span>
      </div>
      <div class="sub-text">
        <span class="sub-label">紧急</span>
        <span v-if="first" class="first-title">{{ first.title }}</span>
        <span v-else class="empty-text">暂无紧急事项</span>
      </div>
    </div>

    <!-- 2x2 -->
    <div v-else class="list">
      <div class="row-head">
        <div class="big-num">
          <span class="num">{{ count }}</span>
          <span class="unit">项紧急</span>
        </div>
      </div>
      <div v-if="list.length" class="item-list">
        <div v-for="item in list" :key="item.id" class="item">
          <svg class="alert" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 0 0-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
          </svg>
          <span class="item-title">{{ item.title }}</span>
          <span class="item-time">{{ fmtTime(item.createdAt) }}</span>
        </div>
      </div>
      <div v-else class="empty">暂无紧急事项</div>
    </div>
  </div>
</template>

<style scoped>
.urg-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  text-align: left;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive);
}
.urg-card:active { transform: scale(0.98); }
.urg-card:hover { box-shadow: var(--shadow-card-hover); }

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  color: #fff;
}
.title-icon--danger { background: var(--danger-500); }

.card-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.mini {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
}
.mini-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--danger-500);
  line-height: 1;
}
.mini-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.row-2 {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-1);
}
.big-num {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--danger-500);
  line-height: 1;
}
.unit {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.sub-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sub-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.first-title {
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: var(--fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-text {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}
.row-head {
  display: flex;
  align-items: center;
}
.item-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-height: 0;
}
.item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.alert {
  flex-shrink: 0;
}
.item-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-time {
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}
</style>
