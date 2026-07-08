<script setup lang="ts">
import { computed } from "vue";
import { useTodoStore } from "@/stores/todoStore";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useTodoStore();

const items = computed(() => store.urgentItems);
const count = computed(() => items.value.length);
const first = computed(() => items.value[0]);
const list = computed(() => items.value.slice(0, 4));
const isCompact = computed(() => props.size === "1x1" || props.size === "2x1");

function fmtTime(item: { dueTime?: string; startTime?: string }): string {
  return item.dueTime ?? item.startTime ?? "";
}
</script>

<template>
  <div
    class="home-card clean-card urg-card"
    :class="[`home-card--${size}`, { 'is-compact': isCompact }]"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--danger">
        <i class="bi bi-exclamation-triangle-fill" style="font-size:12px"></i>
      </span>
      <span class="card-title">紧急待办</span>
    </div>

    <div v-if="size === '1x1'" class="mini">
      <div class="mini-num">{{ count }}</div>
      <div class="mini-label">紧急</div>
    </div>

    <div v-else-if="size === '2x1'" class="row-2">
      <div class="big-num">
        <span class="num">{{ count }}</span>
        <span class="unit">项紧急</span>
      </div>
      <span v-if="first" class="first-title">{{ first.title }}</span>
      <span v-else class="empty-text">暂无</span>
    </div>

    <div v-else class="list">
      <div class="row-head">
        <div class="big-num">
          <span class="num">{{ count }}</span>
          <span class="unit">项紧急</span>
        </div>
      </div>
      <div v-if="list.length" class="item-list">
        <div v-for="item in list" :key="item.id" class="item">
          <i class="bi bi-exclamation-triangle-fill alert" style="font-size:14px;color:var(--danger-500)"></i>
          <span class="item-title">{{ item.title }}</span>
          <span v-if="fmtTime(item)" class="item-time">{{ fmtTime(item) }}</span>
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
.urg-card:active { transform: scale(0.98); }
.urg-card:hover { box-shadow: var(--shadow-card-hover); }

.urg-card.is-compact {
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
  color: var(--danger-500);
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
.alert {
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
.item-time {
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--danger-500);
  font-weight: var(--fw-semibold);
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
