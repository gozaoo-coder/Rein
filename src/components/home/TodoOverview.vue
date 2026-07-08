<script setup lang="ts">
/**
 * TodoOverview — 首页"今日待办"总览卡
 *
 * 展示今日待办进度 + 最多 3 条预览，整卡点击跳转 /todo。
 * 复用 clean-card / icon-circle 设计语言。
 */
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useTodoStore } from "@/stores/todoStore";
import type { TodoPriority } from "@/types/todo";

const router = useRouter();
const store = useTodoStore();

const todayItems = computed(() => store.todayItems);
const total = computed(() => todayItems.value.length);
const doneCount = computed(() => todayItems.value.filter((t) => t.done).length);
const pending = computed(() => total.value - doneCount.value);
const progress = computed(() => (total.value === 0 ? 0 : doneCount.value / total.value));

/** 预览最多 3 条未完成 */
const previewItems = computed(() =>
  todayItems.value
    .filter((t) => !t.done)
    .sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority))
    .slice(0, 3),
);

function priorityWeight(p: TodoPriority): number {
  return p === "high" ? 3 : p === "normal" ? 2 : 1;
}

function goTodo() {
  router.push("/todo");
}

function fmtCount(): string {
  if (total.value === 0) return "暂无";
  if (pending.value === 0) return "全部完成";
  return `${pending.value} 项待办`;
}
</script>

<template>
  <button class="todo-overview clean-card clean-card--interactive" @click="goTodo">
    <!-- Header -->
    <div class="ov-header">
      <div class="ov-title-wrap">
        <div class="icon-circle icon-circle--orange">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </div>
        <div class="ov-title-text">
          <div class="ov-title">今日待办</div>
          <div class="ov-sub">{{ fmtCount() }}</div>
        </div>
      </div>
      <div class="ov-progress-ring" :aria-label="`完成 ${doneCount}/${total}`">
        <svg width="40" height="40" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="16" fill="none" stroke="var(--bg-200)" stroke-width="4" />
          <circle
            cx="20" cy="20" r="16" fill="none"
            stroke="var(--color-warm)" stroke-width="4"
            stroke-linecap="round"
            :stroke-dasharray="100.5"
            :stroke-dashoffset="100.5 - progress * 100.5"
            :style="{ transform: 'rotate(-90deg)', transformOrigin: '20px 20px', transition: 'stroke-dashoffset .4s var(--ease-immersive)' }"
          />
          <text x="20" y="24" text-anchor="middle" font-size="11" font-weight="600" fill="var(--color-text)">
            {{ total === 0 ? '0' : Math.round(progress * 100) + '%' }}
          </text>
        </svg>
      </div>
    </div>

    <!-- Preview list -->
    <div v-if="previewItems.length" class="ov-list">
      <div v-for="item in previewItems" :key="item.id" class="ov-item">
        <span class="ov-checkbox" :class="{ 'is-done': item.done }" aria-hidden="true">
          <svg v-if="item.done" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        <span class="ov-item-title">{{ item.title }}</span>
        <span v-if="item.priority === 'high'" class="ov-priority ov-priority--high" />
        <span v-else-if="item.priority === 'normal'" class="ov-priority ov-priority--normal" />
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="ov-empty">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
      <span>{{ total === 0 ? '今天还没有待办' : '今日待办已全部完成' }}</span>
    </div>

    <!-- Footer -->
    <div class="ov-footer">
      <span class="ov-stat">{{ doneCount }}/{{ total }} 已完成</span>
      <span class="ov-link">
        查看全部
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </div>
  </button>
</template>

<style scoped>
.todo-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  text-align: left;
  width: 100%;
}

.ov-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.ov-title-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  flex: 1;
}

.ov-title-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ov-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.ov-sub {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.ov-progress-ring {
  flex-shrink: 0;
}

.ov-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ov-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-100);
}

.ov-checkbox {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1.6px solid var(--bg-400);
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
}

.ov-checkbox.is-done {
  background: var(--success-500);
  border-color: var(--success-500);
}

.ov-item-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-md);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-priority {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.ov-priority--high { background: var(--danger-500); }
.ov-priority--normal { background: var(--warning-500); }

.ov-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}

.ov-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-divider);
}

.ov-stat {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}

.ov-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--text-sm);
  color: var(--color-warm);
  font-weight: var(--fw-semibold);
}
</style>
