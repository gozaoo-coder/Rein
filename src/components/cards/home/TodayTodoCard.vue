<script setup lang="ts">
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

const isCompact = computed(() => props.size === "1x1" || props.size === "2x1");
const ringR = computed(() => (props.size === "1x1" ? 14 : props.size === "2x1" ? 13 : 16));
const C = computed(() => 2 * Math.PI * ringR.value);
const dashOffset = computed(() => C.value - progress.value * C.value);
const pctText = computed(() =>
  total.value === 0 ? "0" : Math.round(progress.value * 100) + "%",
);
const pctFontSize = computed(() => (props.size === "1x1" ? 8 : props.size === "2x1" ? 8 : 9));
const ringSize = computed(() => ringR.value * 2 + 8);
</script>

<template>
  <div
    class="home-card clean-card todo-card"
    :class="[`home-card--${size}`, { 'is-compact': isCompact }]"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--orange">
        <i class="bi bi-check-lg" style="font-size:14px"></i>
      </span>
      <span class="card-title">今日待办</span>
    </div>

    <div class="body" :class="{ 'body--center': size === '1x1', 'body--row': size === '2x1' }">
      <div class="ring">
        <svg :width="ringSize" :height="ringSize" :viewBox="`0 0 ${ringR * 2 + 8} ${ringR * 2 + 8}`">
          <circle :cx="ringR + 4" :cy="ringR + 4" :r="ringR" fill="none" stroke="var(--bg-200)" :stroke-width="size === '2x1' ? 3 : 4" />
          <circle
            :cx="ringR + 4" :cy="ringR + 4" :r="ringR" fill="none"
            stroke="var(--color-warm)" :stroke-width="size === '2x1' ? 3 : 4"
            stroke-linecap="round"
            :stroke-dasharray="C"
            :stroke-dashoffset="dashOffset"
            :style="{
              transform: 'rotate(-90deg)',
              transformOrigin: `${ringR + 4}px ${ringR + 4}px`,
              transition: 'stroke-dashoffset .4s var(--ease-immersive)',
            }"
          />
          <text :x="ringR + 4" :y="ringR + 4 + pctFontSize / 3" text-anchor="middle" :font-size="pctFontSize" font-weight="700" fill="var(--color-text)">
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
            <i v-if="item.done" class="bi bi-check-lg" style="font-size:10px;color:#fff"></i>
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
.todo-card:active { transform: scale(0.98); }
.todo-card:hover { box-shadow: var(--shadow-card-hover); }

.todo-card.is-compact {
  padding: var(--space-2) var(--space-3);
  gap: var(--space-1);
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.is-compact .card-head {
  gap: 4px;
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
.title-icon--orange { background: var(--icon-orange); }

.card-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 0;
}
.body--center {
  justify-content: center;
}
.body--row {
  flex-direction: row;
}

.ring { flex-shrink: 0; }

.count-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.count-num {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.count-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.preview-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  min-height: 0;
}

.preview-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.cb {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.4px solid var(--bg-400);
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
  font-size: var(--text-xs);
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
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
</style>
