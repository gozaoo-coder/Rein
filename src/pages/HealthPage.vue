<script setup lang="ts">
/**
 * HealthPage — 首页（可编辑卡片网格）
 *
 * - HomeCardGrid：4 列网格，1x1/2x1/2x2/4x2 卡片
 * - 编辑模式：长按卡片 或 点击右上角"编辑主页"（笔图标）
 * - 三环数据源可在 HealthOverviewCard 上点击 → RingDataPickerSheet
 */
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import HomeCardGrid from "@/components/cards/home/HomeCardGrid.vue";
import AddCardSheet from "@/components/cards/home/AddCardSheet.vue";
import RingDataPickerSheet from "@/components/cards/home/RingDataPickerSheet.vue";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useTodoStore } from "@/stores/todoStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useTopBar, ICONS } from "@/composables/useTopBar";
import type { CardConfig } from "@/types/card";

const router = useRouter();
const cardLayout = useCardLayoutStore();
const health = useHealthDataStore();
const todo = useTodoStore();
const stats = useWorkoutStatsStore();
const { setActions, clearActions } = useTopBar();

const editMode = ref(false);
const showAddSheet = ref(false);
const showRingSheet = ref(false);

function syncTopBar() {
  if (editMode.value) {
    setActions([
      { id: "done", icon: ICONS.done, label: "完成", onClick: toggleEdit },
    ]);
  } else {
    setActions([
      { id: "edit", icon: ICONS.edit, label: "编辑主页", onClick: toggleEdit },
    ]);
  }
}

onMounted(async () => {
  syncTopBar();
  await Promise.all([
    cardLayout.load(),
    health.load(),
    todo.load(),
    stats.load(),
  ]);
});

onUnmounted(() => {
  clearActions();
});

watch(editMode, () => {
  syncTopBar();
});

function toggleEdit() {
  editMode.value = !editMode.value;
  if (!editMode.value) {
    showAddSheet.value = false;
  }
}

function onCardClick(card: CardConfig) {
  if (card.type === "three-ring") {
    showRingSheet.value = true;
    return;
  }
  if (card.type === "health-overview") {
    void router.push("/health/metrics");
    return;
  }
  switch (card.type) {
    case "today-todo":
    case "important-todo":
    case "urgent-todo":
      void router.push("/todo");
      break;
    case "recent-workout":
      void router.push("/sports");
      break;
    case "water-record":
      void router.push("/health/water");
      break;
    case "food-record":
      void router.push("/health/food");
      break;
  }
}

</script>

<template>
  <div class="home-page" :class="{ 'is-editing': editMode }">
    <!-- 编辑模式工具栏 -->
    <div v-if="editMode" class="edit-toolbar clean-card">
      <button class="tool-btn" @click="showRingSheet = true">
        <i class="bi bi-bullseye" style="font-size:18px"></i>
        <span>三环数据</span>
      </button>
      <button class="tool-btn tool-btn--primary" @click="showAddSheet = true">
        <i class="bi bi-plus-lg" style="font-size:18px"></i>
        <span>添加卡片</span>
      </button>
    </div>

    <!-- 卡片网格 -->
    <HomeCardGrid
      :edit-mode="editMode"
      @click="onCardClick"
      @enter-edit="editMode = true"
    />
  </div>

  <!-- 添加卡片 -->
  <AddCardSheet v-model:visible="showAddSheet" @close="showAddSheet = false" />

  <!-- 三环数据源 -->
  <RingDataPickerSheet v-if="showRingSheet" @close="showRingSheet = false" />
</template>

<style scoped>
.home-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  position: relative;
}

.home-page.is-editing {
  padding-top: var(--space-2);
}

/* 编辑工具栏 */
.edit-toolbar {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-full);
  align-self: stretch;
  background: var(--bg-50);
  box-shadow: var(--shadow-card);
  animation: toolbar-down 0.25s var(--ease-out);
}

@keyframes toolbar-down {
  from { transform: translateY(-12px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.tool-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: var(--radius-full);
  border: none;
  background: var(--bg-100);
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}

.tool-btn:active {
  transform: scale(0.96);
}

.tool-btn--primary {
  background: var(--color-warm);
  color: #fff;
}
</style>
