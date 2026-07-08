<script setup lang="ts">
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
const isCompact = computed(() => props.size === "1x1" || props.size === "2x1");
</script>

<template>
  <div
    class="home-card clean-card imp-card"
    :class="[`home-card--${size}`, { 'is-compact': isCompact }]"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--warning">
        <i class="bi bi-star-fill" style="font-size:12px"></i>
      </span>
      <span class="card-title">重要待办</span>
    </div>

    <div v-if="size === '1x1'" class="mini">
      <div class="mini-num">{{ count }}</div>
      <div class="mini-label">重要</div>
    </div>

    <div v-else-if="size === '2x1'" class="row-2">
      <div class="big-num">
        <span class="num">{{ count }}</span>
        <span class="unit">项重要</span>
      </div>
      <span v-if="first" class="first-title">{{ first.title }}</span>
      <span v-else class="empty-text">暂无</span>
    </div>

    <div v-else class="list">
      <div class="row-head">
        <div class="big-num">
          <span class="num">{{ count }}</span>
          <span class="unit">项重要</span>
        </div>
      </div>
      <div v-if="list.length" class="item-list">
        <div v-for="item in list" :key="item.id" class="item">
          <i class="bi bi-star-fill star" style="font-size:14px;color:var(--warning-500)"></i>
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
.imp-card:active { transform: scale(0.98); }
.imp-card:hover { box-shadow: var(--shadow-card-hover); }

.imp-card.is-compact {
  padding: var(--space-2) var(--space-3);
  gap: var(--space-1);
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
.title-icon--warning { background: var(--warning-500); }

.card-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mini {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
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
  gap: 2px;
  min-height: 0;
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
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.first-title {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-text {
  font-size: var(--text-xs);
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
  padding: var(--space-1) var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.star {
  flex-shrink: 0;
}
.item-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
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
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
</style>
