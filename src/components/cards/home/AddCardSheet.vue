<script setup lang="ts">
/**
 * AddCardSheet — 添加卡片半模态面板
 *
 * - 搜索框过滤
 * - 列出所有支持卡片类型 + 可选尺寸
 * - 点击加入主页
 */
import { computed, ref } from "vue";
import { CARD_REGISTRY, CARD_SIZE_MAP, type CardSize, type CardType } from "@/types/card";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";

const emit = defineEmits<{ close: [] }>();

const store = useCardLayoutStore();
const query = ref("");

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

function addCard(type: CardType, size: CardSize) {
  store.addCard(type, size);
  emit("close");
}

function sizeLabel(size: CardSize): string {
  const m = CARD_SIZE_MAP[size];
  return `${m.cols}×${m.rows}`;
}
</script>

<template>
  <div class="sheet-mask" @click.self="emit('close')">
    <div class="add-sheet clean-card">
      <div class="sheet-handle" />
      <div class="sheet-header">
        <h3 class="sheet-title">添加卡片</h3>
        <button class="close-btn" @click="emit('close')" aria-label="关闭">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>

      <!-- 搜索框 -->
      <div class="search-wrap">
        <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input v-model="query" type="text" placeholder="搜索卡片" class="search-input" />
      </div>

      <!-- 卡片列表 -->
      <div class="card-list">
        <div v-for="meta in filtered" :key="meta.type" class="card-entry">
          <div class="entry-info">
            <div class="entry-icon" :style="{ background: meta.accent }">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path :d="meta.icon" />
              </svg>
            </div>
            <div class="entry-text">
              <div class="entry-title">{{ meta.title }}</div>
              <div class="entry-desc">{{ meta.description }}</div>
            </div>
          </div>
          <div class="entry-sizes">
            <button
              v-for="s in meta.sizes"
              :key="s"
              class="size-chip"
              @click="addCard(meta.type, s)"
            >
              {{ sizeLabel(s) }}
            </button>
          </div>
        </div>
      </div>
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
  max-height: 75vh;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-4) var(--space-5) var(--space-6);
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
}

.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sheet-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.close-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 12px;
  color: var(--color-text-tertiary);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 10px 12px 10px 36px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
}

.search-input:focus {
  border-color: var(--color-warm);
  background: var(--bg-50);
}

.card-list {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
  min-height: 0;
}

.card-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.entry-info {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}

.entry-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
}

.entry-text {
  min-width: 0;
}

.entry-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.entry-desc {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

.entry-sizes {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.size-chip {
  padding: 4px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-warm);
  background: var(--warm-50);
  color: var(--color-warm);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}

.size-chip:active {
  background: var(--color-warm);
  color: #fff;
}
</style>
