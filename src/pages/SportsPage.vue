<script setup lang="ts">
import { onMounted, ref } from "vue"
import { useRouter } from "vue-router"
import CardGrid from "@/components/cards/CardGrid.vue"
import { useCardEditor } from "@/composables/useCardEditor"
import { useCardLayoutStore } from "@/stores/cardLayoutStore"
import type { CardConfig } from "@/types/card"

const router = useRouter()
const { isEditing, toggleEditMode, saveLayout } = useCardEditor()
const layoutStore = useCardLayoutStore()

const sportModes = ref([
  { key: "running", label: "跑步", icon: "run" },
  { key: "walking", label: "步行", icon: "walk" },
  { key: "cycling", label: "骑行", icon: "cycle" },
  { key: "swimming", label: "游泳", icon: "swim" },
  { key: "yoga", label: "瑜伽", icon: "yoga" },
  { key: "strength", label: "力量", icon: "strength" },
  { key: "hiit", label: "HIIT", icon: "hiit" },
  { key: "stretching", label: "拉伸", icon: "stretch" },
])

const defaultSportCards: CardConfig[] = [
  {
    id: "sport-running",
    component: "RunningCard",
    size: "1x1",
    editable: true,
    glow: "primary",
    props: { distance: 5.2, pace: "5'30\"", calories: 320 },
  },
  {
    id: "sport-cycling",
    component: "CyclingCard",
    size: "1x1",
    editable: true,
    glow: "accent",
    props: { distance: 15.8, speed: 22.5, time: "42:10" },
  },
  {
    id: "sport-yoga",
    component: "YogaCard",
    size: "1x1",
    editable: true,
    glow: "warning",
    props: { duration: 45, calories: 180 },
  },
  {
    id: "sport-strength",
    component: "StrengthCard",
    size: "1x1",
    editable: true,
    glow: "danger",
    props: { totalSets: 24, totalReps: 168 },
  },
  {
    id: "sport-my-courses",
    component: "MyCoursesCard",
    size: "2x1",
    editable: true,
    glow: "success",
    props: {
      courses: [
        { name: "晨跑5km", duration: "30min" },
        { name: "核心力量", duration: "20min" },
        { name: "拉伸恢复", duration: "15min" },
      ],
    },
  },
]

onMounted(() => {
  if (layoutStore.layout.cards.length === 0) {
    layoutStore.setLayout({ cards: defaultSportCards, columns: 4 })
  }
})

function onCardClick(cardId: string) {
  if (cardId === "sport-strength") {
    router.push("/workout")
  }
}

function onStartMode(modeKey: string) {
  if (modeKey === "strength") {
    router.push("/workout")
  }
}

function onAddCard() {
  // placeholder: open card picker
}

function onManageCourses() {
  // placeholder: navigate to course management
}
</script>

<template>
  <div class="sports-page" :class="{ 'edit-mode': isEditing }">
    <CardGrid @card-click="onCardClick" />

    <!-- Sport action buttons (fixed below grid, always visible) -->
    <div class="sport-actions-section">
      <div class="sport-actions-scroll">
        <button
          v-for="mode in sportModes"
          :key="mode.key"
          class="sport-action-btn"
          @click="onStartMode(mode.key)"
        >
          <span class="action-icon">
            <!-- Running -->
            <svg v-if="mode.icon === 'run'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="5" r="2" />
              <path d="M7 21l3-7 3 3 4-5-2-1-2.5 3-2.5-3-3 7z" />
            </svg>
            <!-- Walking -->
            <svg v-else-if="mode.icon === 'walk'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="13" cy="4" r="2" />
              <path d="M9 21l2-8 3 2v6" />
              <path d="M14 11l-4-3-2 2" />
            </svg>
            <!-- Cycling -->
            <svg v-else-if="mode.icon === 'cycle'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="5.5" cy="17.5" r="3.5" />
              <circle cx="18.5" cy="17.5" r="3.5" />
              <path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5V14l-3-3 4-3 2 3h2" />
            </svg>
            <!-- Swimming -->
            <svg v-else-if="mode.icon === 'swim'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 20c2-1 4-1 6 0s4 1 6 0 4-1 6 0" />
              <path d="M2 16c2-1 4-1 6 0s4 1 6 0 4-1 6 0" />
              <circle cx="12" cy="8" r="2" />
              <path d="M10 8l-2 4h8l-2-4" />
            </svg>
            <!-- Yoga -->
            <svg v-else-if="mode.icon === 'yoga'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="4" r="2" />
              <path d="M12 6v6" />
              <path d="M8 14l4 2 4-2" />
              <path d="M6 18h12" />
              <path d="M6 21l6-3 6 3" />
            </svg>
            <!-- Strength -->
            <svg v-else-if="mode.icon === 'strength'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6.5 6.5h11v11h-11z" />
              <path d="M3 9.5v5" />
              <path d="M21 9.5v5" />
              <rect x="6.5" y="3" width="11" height="3" rx="1" />
              <rect x="6.5" y="18" width="11" height="3" rx="1" />
            </svg>
            <!-- HIIT -->
            <svg v-else-if="mode.icon === 'hiit'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <!-- Stretching -->
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="5" r="2" />
              <path d="M12 7v5" />
              <path d="M8 20l4-8 4 8" />
            </svg>
          </span>
          <span class="action-label">{{ mode.label }}</span>
        </button>

        <button class="sport-action-btn manage-btn" @click="onManageCourses">
          <span class="action-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </span>
          <span class="action-label">管理课程</span>
        </button>
      </div>
    </div>

    <!-- Edit toolbar -->
    <div v-if="isEditing" class="edit-toolbar">
      <button class="edit-btn edit-btn-primary" @click="saveLayout">完成</button>
      <button class="edit-btn edit-btn-secondary" @click="onAddCard">添加卡片</button>
    </div>
  </div>
</template>

<style scoped>
.sports-page {
  padding: 0 0 calc(24px + env(safe-area-inset-bottom, 0px));
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 100%;
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

/* Sport actions section */
.sport-actions-section {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-divider);
  flex-shrink: 0;
}

.sport-actions-scroll {
  display: flex;
  gap: var(--space-4);
  overflow-x: auto;
  padding: var(--space-2) var(--space-4) var(--space-4);
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.sport-actions-scroll::-webkit-scrollbar {
  display: none;
}

.sport-action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  width: 60px;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: opacity 0.2s ease;
}

.sport-action-btn:active {
  opacity: 0.6;
}

.action-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--brand-500);
  color: white;
}

.manage-btn .action-icon {
  background: var(--bg-200);
  color: var(--color-text-secondary);
}

.action-label {
  font-size: 11px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

/* Edit toolbar */
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
  padding-top: env(safe-area-inset-top, 0px);
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
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
