<script setup lang="ts">
/**
 * TodayTodoCard — 今日待办卡
 *
 * 1x1: 圆环 + 百分比
 * 2x1: 圆环 + X/Y 已完成
 * 2x2: 圆环 + 最多 3 条预览（可切换完成状态）
 */
import { computed } from "vue";
import { useTodoStore } from "@/stores/todoStore";
import type { CardSize } from "@/types/card";
import type { TodoPriority } from "@/types/todo";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useTodoStore();

const total = computed(() => store.todayItems.length);
const doneCount = computed(() => store.todayItems.filter((t) => t.done).length);
const progress = computed(() => (total.value === 0 ? 0 : doneCount.value / total.value));

const previewItems = computed(() =>
  store.todayItems
    .slice()
    .sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority))
    .slice(0, 3),
);

function priorityWeight(p: TodoPriority): number {
  return p === "high" ? 3 : p === "normal" ? 2 : 1;
}

function onToggle(id: string, e: Event) {
  e.stopPropagation();
  store.toggleDone(id);
}

const C = 2 * Math.PI * 16;
const dashOffset = computed(() => C - progress.value * C);
const pctText = computed(() =>
  total.value === 0 ? "0" : Math.round(progress.value * 100) + "%",
);
</script>

<template>
  <div
    class="home-card clean-card todo-card"
    :class="`home-card--${size}`"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--orange">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 11 12 14 22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      </span>
      <span class="card-title">今日待办</span>
    </div>

    <div class="body" :class="{ 'body--center': size === '1x1' }">
      <div class="ring">
        <svg width="64" height="64" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="16" fill="none" stroke="var(--bg-200)" stroke-width="4" />
          <circle
            cx="20" cy="20" r="16" fill="none"
            stroke="var(--color-warm)" stroke-width="4"
            stroke-linecap="round"
            :stroke-dasharray="C"
            :stroke-dashoffset="dashOffset"
            :style="{
              transform: 'rotate(-90deg)',
              transformOrigin: '20px 20px',
              transition: 'stroke-dashoffset .4s var(--ease-immersive)',
            }"
          />
          <text x="20" y="23" text-anchor="middle" font-size="9" font-weight="700" fill="var(--color-text)">
            {{ pctText }}
          </text>
        </svg>
      </div>

      <div v-if="size === '2x1'" class="count-text">
        <span class="count-num">{{ doneCount }}/{{ total }}</span>
        <span class="count-label">已完成</span>
      </div>

      <div v-if="size === '2x2' && previewItems.length" class="preview-list">
        <div v-for="item in previewItems" :key="item.id" class="preview-item">
          <button
            class="cb"
            :class="{ 'is-done': item.done }"
            @click="onToggle(item.id, $event)"
            :aria-label="item.done ? '标记未完成' : '标记完成'"
          >
            <svg v-if="item.done" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
          <span class="preview-title" :class="{ 'is-done': item.done }">{{ item.title }}</span>
        </div>
      </div>
      <div v-else-if="size === '2x2' && total === 0" class="empty">今天还没有待办</div>
    </div>
  </div>
</template>

<style scoped>
.todo-card {
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
.todo-card:active { transform: scale(0.98); }
.todo-card:hover { box-shadow: var(--shadow-card-hover); }

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
.title-icon--orange { background: var(--icon-orange); }

.card-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.body {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 0;
}
.body--center {
  flex-direction: column;
  justify-content: center;
}

.ring { flex-shrink: 0; }

.count-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.count-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.count-label {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.preview-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.preview-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.cb {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1.6px solid var(--bg-400);
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.cb.is-done {
  background: var(--success-500);
  border-color: var(--success-500);
}

.preview-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-title.is-done {
  color: var(--color-text-tertiary);
  text-decoration: line-through;
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
