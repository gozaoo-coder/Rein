<script setup lang="ts">
/**
 * HealthPage — 首页（可编辑卡片网格）
 *
 * - HomeCardGrid：4 列网格，1x1/2x1/2x2/4x2 卡片
 * - 编辑模式：长按卡片 或 点击右上角"编辑主页"（笔图标）
 * - 三环数据源可在 HealthOverviewCard 上点击 → RingDataPickerSheet
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import HomeCardGrid from "@/components/cards/home/HomeCardGrid.vue";
import AddCardSheet from "@/components/cards/home/AddCardSheet.vue";
import RingDataPickerSheet from "@/components/cards/home/RingDataPickerSheet.vue";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useTodoStore } from "@/stores/todoStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import type { CardConfig } from "@/types/card";

const router = useRouter();
const cardLayout = useCardLayoutStore();
const health = useHealthDataStore();
const todo = useTodoStore();
const stats = useWorkoutStatsStore();

const editMode = ref(false);
const showAddSheet = ref(false);
const showRingSheet = ref(false);

onMounted(async () => {
  await Promise.all([
    cardLayout.load(),
    health.load(),
    todo.load(),
    stats.load(),
  ]);
});

function toggleEdit() {
  editMode.value = !editMode.value;
  if (!editMode.value) {
    showAddSheet.value = false;
  }
}

function onCardClick(card: CardConfig) {
  // 三环数据源：HealthOverviewCard 点击 → 打开 RingDataPickerSheet
  if (card.type === "health-overview") {
    showRingSheet.value = true;
    return;
  }
  // 其他卡片：跳转对应详情页
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
        </svg>
        <span>三环数据</span>
      </button>
      <button class="tool-btn tool-btn--primary" @click="showAddSheet = true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>添加卡片</span>
      </button>
      <button class="tool-btn tool-btn--done" @click="toggleEdit">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span>完成</span>
      </button>
    </div>

    <!-- 右上角编辑入口（非编辑模式可见） -->
    <button v-else class="edit-fab" @click="toggleEdit" aria-label="编辑主页">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>

    <!-- 卡片网格 -->
    <HomeCardGrid
      :edit-mode="editMode"
      @click="onCardClick"
      @enter-edit="editMode = true"
    />
  </div>

  <!-- 添加卡片 -->
  <AddCardSheet v-if="showAddSheet" @close="showAddSheet = false" />

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

.tool-btn--done {
  background: var(--success-500);
  color: #fff;
}

/* 编辑入口 FAB（笔图标） */
.edit-fab {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 5;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.7);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.15s;
}

.edit-fab:active {
  transform: scale(0.9);
}
</style>
