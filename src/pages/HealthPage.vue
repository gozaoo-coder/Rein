<script setup lang="ts">
import { onMounted, computed, defineAsyncComponent } from "vue"
import CardGrid from "@/components/cards/CardGrid.vue"
import { useCardEditor } from "@/composables/useCardEditor"
import { useCardLayoutStore } from "@/stores/cardLayoutStore"
import type { CardConfig } from "@/types/card"

const { isEditing, toggleEditMode, saveLayout } = useCardEditor()
const layoutStore = useCardLayoutStore()

const defaultHealthCards: CardConfig[] = [
  {
    id: "health-steps",
    component: "StepsCard",
    size: "1x1",
    editable: true,
    props: { steps: 8432, goal: 10000 },
  },
  {
    id: "health-calories",
    component: "CaloriesCard",
    size: "1x1",
    editable: true,
    props: { burned: 486, goal: 600 },
  },
  {
    id: "health-heart-rate",
    component: "HeartRateCard",
    size: "1x1",
    editable: true,
    props: { bpm: 72, status: "normal" },
  },
  {
    id: "health-sleep",
    component: "SleepCard",
    size: "1x1",
    editable: true,
    props: { hours: 7.5, quality: "good" },
  },
  {
    id: "health-weekly-summary",
    component: "WeeklySummaryCard",
    size: "2x2",
    editable: true,
    props: {
      data: [
        { day: "一", value: 65 },
        { day: "二", value: 80 },
        { day: "三", value: 45 },
        { day: "四", value: 90 },
        { day: "五", value: 70 },
        { day: "六", value: 95 },
        { day: "日", value: 55 },
      ],
    },
  },
  {
    id: "health-hydration",
    component: "HydrationCard",
    size: "1x1",
    editable: true,
    props: { current: 6, target: 8 },
  },
]

onMounted(() => {
  if (layoutStore.layout.cards.length === 0) {
    layoutStore.setLayout({ cards: defaultHealthCards, columns: 4 })
  }
})

function onCardClick(_cardId: string) {
  // placeholder: navigate to detail
}

function onAddCard() {
  // placeholder: open card picker
}
</script>

<template>
  <div class="health-page" :class="{ 'edit-mode': isEditing }">
    <CardGrid @card-click="onCardClick" />

    <!-- Edit mode toggle (floating) -->
    <button v-if="!isEditing" class="edit-toggle" @click="toggleEditMode">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    </button>

    <!-- Edit toolbar -->
    <div v-if="isEditing" class="edit-toolbar">
      <button class="edit-btn edit-btn-primary" @click="saveLayout">完成</button>
      <button class="edit-btn edit-btn-secondary" @click="onAddCard">添加卡片</button>
    </div>
  </div>
</template>

<style scoped>
.health-page {
  padding: 0;
  position: relative;
}

.edit-mode .app-top-bar,
.edit-mode .app-tab-bar {
  transform: translateY(-100%);
  opacity: 0;
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.edit-mode .app-tab-bar {
  transform: translateY(100%);
}

.edit-toggle {
  position: fixed;
  top: 64px;
  right: var(--space-4);
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  border: var(--glass-border);
  box-shadow: var(--shadow-md);
  color: var(--color-text-secondary);
  transition: opacity 0.2s ease;
}

.edit-toggle:active {
  opacity: 0.6;
}

.edit-toolbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 var(--space-5);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  border-bottom: 1px solid var(--color-divider);
  z-index: 200;
}

.edit-btn {
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-full);
  font-size: 15px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: opacity 0.2s ease;
}

.edit-btn:active {
  opacity: 0.7;
}

.edit-btn-primary {
  background: var(--brand-500);
  color: var(--brand-50);
}

.edit-btn-secondary {
  background: var(--bg-200);
  color: var(--color-text);
}
</style>
