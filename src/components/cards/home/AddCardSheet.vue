<script setup lang="ts">
import { computed, ref } from "vue";
import { CARD_REGISTRY, CARD_SIZE_MAP, type CardSize, type CardType } from "@/types/card";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import HomeCardRenderer from "./HomeCardRenderer.vue";
import BottomSheet from "@/components/ui/BottomSheet.vue";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ close: []; "update:visible": [v: boolean] }>();

const store = useCardLayoutStore();
const query = ref("");

const allEntries = computed(() => {
  return (Object.keys(CARD_REGISTRY) as CardType[]).map((t) => ({
    meta: CARD_REGISTRY[t],
    type: t,
  }));
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return allEntries.value;
  return allEntries.value.filter(
    (e) => e.meta.title.toLowerCase().includes(q) || e.meta.description.toLowerCase().includes(q),
  );
});

const addedTypes = computed(() => new Set(store.layout.cards.map((c) => c.type)));

function addCard(type: CardType, size: CardSize) {
  store.addCard(type, size);
  onClose();
}

function previewCard(type: CardType, size: CardSize) {
  return { id: "preview", type, size } as const;
}

function onClose() {
  emit("update:visible", false);
  emit("close");
}

const CELL_BASE = 78;
const GAP = 8;

function sizeStyle(size: CardSize) {
  const m = CARD_SIZE_MAP[size];
  const w = m.cols * CELL_BASE + (m.cols - 1) * GAP;
  const h = m.rows * CELL_BASE + (m.rows - 1) * GAP;
  return {
    width: `${w}px`,
    height: `${h}px`,
    flexShrink: "0",
  };
}
</script>

<template>
  <BottomSheet
    :visible="visible"
    title="添加卡片"
    :detents="['large']"
    default-detent="large"
    @update:visible="(v) => { if (!v) onClose() }"
    @close="onClose"
  >
    <div class="add-card-body">
      <div class="search-wrap">
        <i class="bi bi-search search-icon" style="font-size:14px"></i>
        <input v-model="query" type="text" placeholder="搜索卡片" class="search-input" />
      </div>

      <div class="card-type-list">
        <div
          v-for="entry in filtered"
          :key="entry.type"
          class="card-type-group"
        >
          <div class="type-header">
            <span class="type-icon" :style="{ background: entry.meta.accent }">
              <i :class="['bi', `bi-${entry.meta.icon}`]" style="font-size:13px;color:#fff"></i>
            </span>
            <span class="type-title">{{ entry.meta.title }}</span>
            <span class="type-desc">{{ entry.meta.description }}</span>
            <span v-if="addedTypes.has(entry.type)" class="type-added-dot" title="已添加" />
          </div>
          <div class="size-row">
            <button
              v-for="sz in entry.meta.sizes"
              :key="sz"
              class="size-preview-card"
              :style="sizeStyle(sz)"
              @click="addCard(entry.type, sz)"
            >
              <HomeCardRenderer :card="previewCard(entry.type, sz)" />
              <span class="size-tag">{{ CARD_SIZE_MAP[sz].cols }}×{{ CARD_SIZE_MAP[sz].rows }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.add-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.search-icon {
  position: absolute;
  left: 12px;
  color: var(--color-text-tertiary);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding: 10px 12px 10px 34px;
  border: none;
  border-radius: var(--radius-full);
  font-size: var(--text-sm);
  background: var(--bg-200);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
}
.search-input:focus {
  background: var(--bg-100);
}

.card-type-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
}

.card-type-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.type-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-1);
}
.type-icon {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.type-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.type-desc {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.type-added-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success);
  flex-shrink: 0;
}

.size-row {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  overflow-y: hidden;
  padding: var(--space-1);
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.size-row::-webkit-scrollbar { display: none; }

.size-preview-card {
  position: relative;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  transition: transform 0.15s var(--ease-immersive);
}
.size-preview-card:active {
  transform: scale(0.96);
}
.size-preview-card :deep(.home-card) {
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
}
.size-tag {
  position: absolute;
  bottom: 4px;
  right: 4px;
  font-size: 9px;
  font-weight: var(--fw-bold);
  color: var(--color-text-tertiary);
  background: rgba(255,255,255,0.85);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  padding: 1px 5px;
  border-radius: var(--radius-full);
  pointer-events: none;
}
</style>
