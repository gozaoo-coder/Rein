<script setup lang="ts">
/**
 * HomeCardGrid — 主页卡片网格
 *
 * - 4 列基础网格，卡片按 size 跨格
 * - 编辑模式：长按或外部触发进入
 *   - 左上角红色叉叉：删除
 *   - 右下角橙色弧形：点击循环切换尺寸
 *   - 拖拽换位：HTML5 drag API
 * - 拖拽至底部自动滚动
 */
import { computed, nextTick, onMounted, ref } from "vue";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import { CARD_REGISTRY, CARD_SIZE_MAP, type CardConfig, type CardSize } from "@/types/card";
import HomeCardRenderer from "./HomeCardRenderer.vue";

const props = defineProps<{
  editMode: boolean;
}>();

const emit = defineEmits<{
  click: [card: CardConfig];
  "enter-edit": [];
}>();

const store = useCardLayoutStore();

const cards = computed(() => store.layout.cards);

// ===== 拖拽换位 =====
const draggingId = ref<string | null>(null);
const dragOverIndex = ref<number | null>(null);

function onDragStart(e: DragEvent, card: CardConfig) {
  if (!props.editMode) return;
  draggingId.value = card.id;
  e.dataTransfer?.setData("text/plain", card.id);
  e.dataTransfer!.effectAllowed = "move";
}

function onDragOver(e: DragEvent, index: number) {
  if (!props.editMode || !draggingId.value) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  dragOverIndex.value = index;

  // 拖至底部自动滚动
  const y = e.clientY;
  const h = window.innerHeight;
  if (y > h - 80) {
    scrollContainer()?.scrollBy({ top: 30, behavior: "smooth" });
  }
}

function onDrop(e: DragEvent, index: number) {
  if (!props.editMode) return;
  e.preventDefault();
  const fromId = draggingId.value;
  if (!fromId) return;
  store.moveCardTo(fromId, index);
  draggingId.value = null;
  dragOverIndex.value = null;
}

function onDragEnd() {
  draggingId.value = null;
  dragOverIndex.value = null;
}

// ===== 尺寸切换（点击右下角弧形 handle） =====
function cycleSize(card: CardConfig) {
  const meta = CARD_REGISTRY[card.type];
  const sizes = meta.sizes;
  const currentIdx = sizes.indexOf(card.size);
  const nextIdx = (currentIdx + 1) % sizes.length;
  store.resizeCard(card.id, sizes[nextIdx]);
}

// ===== 删除 =====
function deleteCard(card: CardConfig) {
  store.removeCard(card.id);
}

// ===== 长按进入编辑模式 =====
const longPressTimer = ref<number | null>(null);
const LONG_PRESS_MS = 500;

function onTouchStart(card: CardConfig) {
  if (props.editMode) return;
  longPressTimer.value = window.setTimeout(() => {
    emitEditModeRequest();
  }, LONG_PRESS_MS);
}

function onTouchEnd() {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
}

function emitEditModeRequest() {
  emit("enter-edit");
}

function scrollContainer(): HTMLElement | null {
  return document.querySelector(".app-main");
}

// ===== 网格跨度计算 =====
function gridSpan(size: CardSize): { gridColumn: string; gridRow: string } {
  const m = CARD_SIZE_MAP[size];
  return {
    gridColumn: `span ${m.cols}`,
    gridRow: `span ${m.rows}`,
  };
}
</script>

<template>
  <div class="card-grid" :class="{ 'is-editing': editMode }">
    <div
      v-for="(card, idx) in cards"
      :key="card.id"
      class="card-cell"
      :class="{
        'is-dragging': draggingId === card.id,
        'is-drop-target': dragOverIndex === idx,
      }"
      :style="gridSpan(card.size)"
      :draggable="editMode"
      @dragstart="onDragStart($event, card)"
      @dragover="onDragOver($event, idx)"
      @drop="onDrop($event, idx)"
      @dragend="onDragEnd"
      @touchstart="onTouchStart(card)"
      @touchend="onTouchEnd"
      @touchmove="onTouchEnd"
      @click="!editMode && emit('click', card)"
    >
      <!-- 编辑模式遮罩 + 控件 -->
      <template v-if="editMode">
        <!-- 左上角删除按钮 -->
        <button
          class="card-delete"
          @click.stop="deleteCard(card)"
          aria-label="删除卡片"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <!-- 右下角橙色弧形尺寸 handle -->
        <button
          class="card-resize"
          @click.stop="cycleSize(card)"
          :aria-label="`切换尺寸 ${card.size}`"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M22 22 L22 14 A8 8 0 0 0 14 22 Z" fill="currentColor" />
          </svg>
          <span class="resize-label">{{ card.size }}</span>
        </button>
      </template>

      <!-- 卡片内容 -->
      <HomeCardRenderer :card="card" @click="!editMode && emit('click', card)" />
    </div>

    <!-- 空态 -->
    <div v-if="cards.length === 0" class="grid-empty">
      <p>暂无卡片，点击编辑添加</p>
    </div>
  </div>
</template>

<style scoped>
.card-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: 90px;
  gap: var(--space-3);
  width: 100%;
  position: relative;
}

.card-grid.is-editing {
  /* 编辑模式：轻微抖动 + 放大间距 */
  gap: var(--space-4);
}

.card-grid.is-editing .card-cell {
  animation: card-wobble 2s ease-in-out infinite;
  cursor: grab;
  position: relative;
  border-radius: var(--radius-lg);
  outline: 2px dashed transparent;
  transition: outline-color 0.2s;
}

.card-grid.is-editing .card-cell:active {
  cursor: grabbing;
}

@keyframes card-wobble {
  0%, 100% { transform: rotate(-0.4deg); }
  50% { transform: rotate(0.4deg); }
}

.card-cell {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  transition: transform 0.2s var(--ease-immersive), opacity 0.2s;
}

.card-cell.is-dragging {
  opacity: 0.4;
  transform: scale(0.95);
}

.card-cell.is-drop-target {
  outline-color: var(--color-warm);
}

.card-cell > :deep(.home-card) {
  width: 100%;
  height: 100%;
}

/* 删除按钮 */
.card-delete {
  position: absolute;
  top: -8px;
  left: -8px;
  z-index: 10;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--danger-500);
  color: #fff;
  border: 2px solid var(--bg-50);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(232, 64, 38, 0.4);
  transition: transform 0.15s;
}

.card-delete:active {
  transform: scale(0.9);
}

/* 尺寸 handle（橙色弧形） */
.card-resize {
  position: absolute;
  bottom: -8px;
  right: -8px;
  z-index: 10;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-warm);
  color: #fff;
  border: 2px solid var(--bg-50);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(255, 102, 51, 0.4);
  transition: transform 0.15s;
  flex-direction: column;
  gap: 0;
  padding: 0;
}

.card-resize:active {
  transform: scale(0.9);
}

.resize-label {
  font-size: 8px;
  font-weight: var(--fw-bold);
  line-height: 1;
  margin-top: -2px;
}

.grid-empty {
  grid-column: span 4;
  text-align: center;
  padding: var(--space-6);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}
</style>
