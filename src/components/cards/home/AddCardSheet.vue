<script setup lang="ts">
import { computed, ref } from "vue";
import { CARD_REGISTRY, CARD_SIZE_MAP, type CardSize, type CardType } from "@/types/card";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import HomeCardRenderer from "./HomeCardRenderer.vue";

const emit = defineEmits<{ close: [] }>();

const store = useCardLayoutStore();
const query = ref("");
const selectedType = ref<CardType | null>(null);

const allEntries = computed(() => {
  return (Object.keys(CARD_REGISTRY) as CardType[]).map((t) => CARD_REGISTRY[t]);
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return allEntries.value;
  return allEntries.value.filter(
    (m) => m.title.toLowerCase().includes(q) || m.description.toLowerCase().includes(q),
  );
});

const addedTypes = computed(() => new Set(store.layout.cards.map((c) => c.type)));

function pickType(type: CardType) {
  if (CARD_REGISTRY[type].sizes.length === 1) {
    addCard(type, CARD_REGISTRY[type].defaultSize);
  } else {
    selectedType.value = type;
  }
}

function addCard(type: CardType, size: CardSize) {
  store.addCard(type, size);
  emit("close");
}

function sizeLabel(size: CardSize): string {
  const m = CARD_SIZE_MAP[size];
  return `${m.cols}×${m.rows}`;
}

function previewCard(type: CardType, size: CardSize) {
  return { id: "preview", type, size } as const;
}

function spanStyle(size: CardSize) {
  const m = CARD_SIZE_MAP[size];
  return {
    gridColumn: `span ${m.cols}`,
    gridRow: `span ${m.rows}`,
  };
}
</script>

<template>
  <div class="sheet-mask" @click.self="emit('close')">
    <div class="add-sheet clean-card">
      <div class="sheet-handle" />
      <div class="sheet-header">
        <h3 class="sheet-title">{{ selectedType ? '选择尺寸' : '添加卡片' }}</h3>
        <div class="header-actions">
          <button v-if="selectedType" class="back-btn" @click="selectedType = null" aria-label="返回">
            <i class="bi bi-chevron-left" style="font-size:18px"></i>
          </button>
          <button class="close-btn" @click="emit('close')" aria-label="关闭">
            <i class="bi bi-x-lg" style="font-size:18px"></i>
          </button>
        </div>
      </div>

      <template v-if="!selectedType">
        <div class="search-wrap">
          <i class="bi bi-search search-icon" style="font-size:14px"></i>
          <input v-model="query" type="text" placeholder="搜索卡片" class="search-input" />
        </div>

        <div class="preview-grid">
          <div
            v-for="meta in filtered"
            :key="meta.type"
            class="preview-cell"
            :class="{ 'is-added': addedTypes.has(meta.type) }"
            :style="spanStyle(meta.defaultSize)"
            @click="pickType(meta.type)"
          >
            <div class="preview-label-bar">
              <span class="preview-icon" :style="{ background: meta.accent }">
                <i :class="['bi', `bi-${meta.icon}`]" style="font-size:12px;color:#fff"></i>
              </span>
              <span class="preview-title">{{ meta.title }}</span>
              <span v-if="addedTypes.has(meta.type)" class="added-badge">已添加</span>
              <span v-else-if="meta.sizes.length > 1" class="size-hint">
                <i class="bi bi-chevron-right" style="font-size:10px"></i>
              </span>
            </div>
            <div class="preview-card-wrap">
              <HomeCardRenderer :card="previewCard(meta.type, meta.defaultSize)" />
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="size-desc">{{ CARD_REGISTRY[selectedType].description }}</div>
        <div class="size-grid">
          <button
            v-for="s in CARD_REGISTRY[selectedType].sizes"
            :key="s"
            class="size-option"
            @click="addCard(selectedType, s)"
          >
            <div class="size-preview" :style="spanStyle(s)">
              <div class="size-placeholder" :style="{ background: CARD_REGISTRY[selectedType].accent + '22' }">
                <i :class="['bi', `bi-${CARD_REGISTRY[selectedType].icon}`]" :style="{ fontSize: '20px', color: CARD_REGISTRY[selectedType].accent }"></i>
              </div>
            </div>
            <span class="size-name">{{ sizeLabel(s) }}</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 320;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.add-sheet {
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-3) var(--space-4) var(--space-5);
  background: var(--bg-50);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  animation: sheet-up 0.3s var(--ease-out);
}

@keyframes sheet-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

.sheet-handle {
  width: 40px;
  height: 4px;
  background: var(--bg-300);
  border-radius: var(--radius-full);
  margin: 0 auto var(--space-1);
  flex-shrink: 0;
}

.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.sheet-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.header-actions {
  display: flex;
  gap: var(--space-1);
}

.back-btn,
.close-btn {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.back-btn:active,
.close-btn:active {
  transform: scale(0.92);
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--color-text-tertiary);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 8px 10px 8px 32px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
}

.search-input:focus {
  border-color: var(--color-warm);
  background: var(--bg-50);
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: 70px;
  gap: 8px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  flex: 1;
  min-height: 0;
  padding-bottom: var(--space-2);
  align-content: start;
}

.preview-cell {
  position: relative;
  border-radius: var(--radius-lg);
  background: var(--bg-100);
  border: 2px solid transparent;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.15s;
  display: flex;
  flex-direction: column;
  padding: 6px;
}

.preview-cell:active {
  transform: scale(0.97);
  border-color: var(--color-warm);
}

.preview-cell.is-added {
  opacity: 0.6;
}

.preview-label-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  flex-shrink: 0;
}

.preview-icon {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.preview-title {
  font-size: 10px;
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.added-badge {
  font-size: 9px;
  color: var(--success-600);
  background: var(--success-50);
  padding: 1px 4px;
  border-radius: 4px;
  flex-shrink: 0;
}

.size-hint {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.preview-card-wrap {
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  transform: scale(0.9);
  transform-origin: top left;
  width: 111%;
  height: 111%;
  pointer-events: none;
}

.preview-card-wrap :deep(.home-card) {
  width: 100% !important;
  height: 100% !important;
}

.size-desc {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  text-align: center;
  flex-shrink: 0;
}

.size-grid {
  display: flex;
  gap: var(--space-3);
  justify-content: center;
  flex-wrap: wrap;
  flex: 1;
  align-content: center;
}

.size-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  background: var(--bg-100);
  border: 2px solid transparent;
  border-radius: var(--radius-lg);
  padding: var(--space-3);
  cursor: pointer;
  transition: all 0.15s;
}

.size-option:active {
  transform: scale(0.95);
  border-color: var(--color-warm);
}

.size-preview {
  display: grid;
  grid-template-columns: repeat(4, 18px);
  grid-auto-rows: 18px;
  gap: 3px;
}

.size-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  width: 100%;
  height: 100%;
}

.size-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
</style>
