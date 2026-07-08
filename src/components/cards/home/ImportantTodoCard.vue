<script setup lang="ts">
/**
 * ImportantTodoCard — 重要待办（高优先级未完成）
 *
 * 1x1: 数量徽章 + 星图标
 * 2x1: "重要 X 项" + 首项标题
 * 2x2: 最多 4 条带星图标 + 标题
 */
import { computed } from "vue";
import { useTodoStore } from "@/stores/todoStore";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useTodoStore();

const items = computed(() =>
  store.todayItems.filter((t) => !t.done && t.priority === "high"),
);
const count = computed(() => items.value.length);
const first = computed(() => items.value[0]);
const list = computed(() => items.value.slice(0, 4));
</script>

<template>
  <div
    class="home-card clean-card imp-card"
    :class="`home-card--${size}`"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      </span>
      <span class="card-title">重要待办</span>
    </div>

    <!-- 1x1 -->
    <div v-if="size === '1x1'" class="mini">
      <span class="title-icon title-icon--warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      </span>
      <div class="mini-num">{{ count }}</div>
      <div class="mini-label">重要</div>
    </div>

    <!-- 2x1 -->
    <div v-else-if="size === '2x1'" class="row-2">
      <div class="big-num">
        <span class="num">{{ count }}</span>
        <span class="unit">项</span>
      </div>
      <div class="sub-text">
        <span class="sub-label">重要</span>
        <span v-if="first" class="first-title">{{ first.title }}</span>
        <span v-else class="empty-text">暂无重要事项</span>
      </div>
    </div>

    <!-- 2x2 -->
    <div v-else class="list">
      <div class="row-head">
        <div class="big-num">
          <span class="num">{{ count }}</span>
          <span class="unit">项重要</span>
        </div>
      </div>
      <div v-if="list.length" class="item-list">
        <div v-for="item in list" :key="item.id" class="item">
          <svg class="star" width="16" height="16" viewBox="0 0 24 24" fill="var(--warning-500)" stroke="var(--warning-500)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
          <span class="item-title">{{ item.title }}</span>
        </div>
      </div>
      <div v-else class="empty">暂无重要事项</div>
    </div>
  </div>
</template>

<style scoped>
.imp-card {
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
.imp-card:active { transform: scale(0.98); }
.imp-card:hover { box-shadow: var(--shadow-card-hover); }

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
.title-icon--warning { background: var(--warning-500); }

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
  color: var(--warning-500);
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
  color: var(--warning-500);
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
.star {
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

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}
</style>
