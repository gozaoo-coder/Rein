<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
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

const gridRef = ref<HTMLElement | null>(null);
const cellRefs = ref<HTMLElement[]>([]);

function setCellRef(el: HTMLElement | null, idx: number) {
  if (el) cellRefs.value[idx] = el;
}

// ===== Drag reorder (pointer-based, works for touch+mouse) =====
const dragState = ref<{
  cardId: string;
  startX: number;
  startY: number;
  ghostX: number;
  ghostY: number;
  active: boolean;
  pointerId: number;
} | null>(null);
const dropIndex = ref<number | null>(null);
const ghostEl = ref<HTMLElement | null>(null);

function onCardPointerDown(e: PointerEvent, card: CardConfig, idx: number) {
  if (!props.editMode) return;
  const target = e.target as HTMLElement;
  if (target.closest(".card-delete") || target.closest(".card-resize")) return;
  const cellEl = cellRefs.value[idx];
  if (!cellEl) return;

  cellEl.setPointerCapture(e.pointerId);
  dragState.value = {
    cardId: card.id,
    startX: e.clientX,
    startY: e.clientY,
    ghostX: 0,
    ghostY: 0,
    active: false,
    pointerId: e.pointerId,
  };
}

function onCardPointerMove(e: PointerEvent) {
  const ds = dragState.value;
  if (!ds) return;
  const dx = e.clientX - ds.startX;
  const dy = e.clientY - ds.startY;
  const dist = Math.hypot(dx, dy);

  if (!ds.active) {
    if (dist > 6) {
      ds.active = true;
      createGhost(ds.cardId);
      document.body.style.userSelect = "none";
      document.body.style.touchAction = "none";
    } else {
      return;
    }
  }

  ds.ghostX = dx;
  ds.ghostY = dy;
  updateGhostPosition(dx, dy);

  const elBelow = document.elementFromPoint(e.clientX, e.clientY);
  const cellEl = elBelow?.closest(".card-cell") as HTMLElement | null;
  if (cellEl && gridRef.value?.contains(cellEl)) {
    const idx = cellRefs.value.indexOf(cellEl);
    if (idx >= 0) dropIndex.value = idx;
  }

  if (e.clientY > window.innerHeight - 100) {
    const scroller = document.querySelector(".app-main") as HTMLElement | null;
    scroller?.scrollBy({ top: 20 });
  } else if (e.clientY < 120) {
    const scroller = document.querySelector(".app-main") as HTMLElement | null;
    scroller?.scrollBy({ top: -20 });
  }
}

function onCardPointerUp(e: PointerEvent) {
  const ds = dragState.value;
  if (!ds) return;

  if (ds.active && dropIndex.value !== null) {
    store.moveCardTo(ds.cardId, dropIndex.value);
  }

  removeGhost();
  document.body.style.userSelect = "";
  document.body.style.touchAction = "";
  try {
    (e.target as HTMLElement)?.releasePointerCapture?.(e.pointerId);
  } catch { /* noop */ }
  dragState.value = null;
  dropIndex.value = null;
}

function createGhost(cardId: string) {
  const idx = cards.value.findIndex((c) => c.id === cardId);
  const src = cellRefs.value[idx];
  if (!src) return;
  const rect = src.getBoundingClientRect();
  const ghost = src.cloneNode(true) as HTMLElement;
  ghost.classList.add("drag-ghost");
  ghost.style.position = "fixed";
  ghost.style.left = rect.left + "px";
  ghost.style.top = rect.top + "px";
  ghost.style.width = rect.width + "px";
  ghost.style.height = rect.height + "px";
  ghost.style.zIndex = "9999";
  ghost.style.pointerEvents = "none";
  ghost.style.transform = "scale(1.05)";
  ghost.style.opacity = "0.9";
  ghost.style.transition = "none";
  ghost.style.boxShadow = "0 12px 32px rgba(0,0,0,0.2)";
  ghost.querySelectorAll(".card-delete, .card-resize").forEach((el) => el.remove());
  document.body.appendChild(ghost);
  ghostEl.value = ghost;
}

function updateGhostPosition(dx: number, dy: number) {
  if (!ghostEl.value) return;
  ghostEl.value.style.transform = `translate(${dx}px, ${dy}px) scale(1.05)`;
}

function removeGhost() {
  if (ghostEl.value) {
    ghostEl.value.remove();
    ghostEl.value = null;
  }
}

// ===== Drag-to-resize (corner handle drag) =====
const resizeState = ref<{
  cardId: string;
  startX: number;
  startY: number;
  startCols: number;
  startRows: number;
  cellW: number;
  cellH: number;
  previewSize: CardSize | null;
  pointerId: number;
} | null>(null);

function onResizePointerDown(e: PointerEvent, card: CardConfig, idx: number) {
  e.stopPropagation();
  e.preventDefault();
  if (!props.editMode) return;
  const cellEl = cellRefs.value[idx];
  if (!cellEl) return;

  cellEl.setPointerCapture(e.pointerId);
  const m = CARD_SIZE_MAP[card.size];
  const gap = 12;
  const gridRect = gridRef.value?.getBoundingClientRect();
  const cellW = gridRect ? (gridRect.width - gap * 3) / 4 : cellEl.offsetWidth / m.cols;
  const firstCell = cellRefs.value[0];
  const cellH = firstCell ? firstCell.offsetHeight : 88;

  resizeState.value = {
    cardId: card.id,
    startX: e.clientX,
    startY: e.clientY,
    startCols: m.cols,
    startRows: m.rows,
    cellW,
    cellH,
    previewSize: card.size,
    pointerId: e.pointerId,
  };
}

function onResizePointerMove(e: PointerEvent) {
  const rs = resizeState.value;
  if (!rs) return;
  const dx = e.clientX - rs.startX;
  const dy = e.clientY - rs.startY;

  const deltaCols = Math.round(dx / (rs.cellW + 12));
  const deltaRows = Math.round(dy / (rs.cellH + 12));

  let targetCols = Math.max(1, Math.min(4, rs.startCols + deltaCols));
  let targetRows = Math.max(1, Math.min(4, rs.startRows + deltaRows));

  const card = cards.value.find((c) => c.id === rs.cardId);
  if (!card) return;
  const meta = CARD_REGISTRY[card.type];
  let best: CardSize = card.size;
  let bestDist = Infinity;
  for (const s of meta.sizes) {
    const sm = CARD_SIZE_MAP[s];
    const d = Math.abs(sm.cols - targetCols) + Math.abs(sm.rows - targetRows) * 1.5;
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  rs.previewSize = best;
}

function onResizePointerUp(e: PointerEvent) {
  const rs = resizeState.value;
  if (!rs) return;
  if (rs.previewSize) {
    store.resizeCard(rs.cardId, rs.previewSize);
  }
  try {
    (e.target as HTMLElement)?.releasePointerCapture?.(e.pointerId);
  } catch { /* noop */ }
  resizeState.value = null;
}

// ===== Long-press to enter edit mode (non-edit mode) =====
const longPressTimer = ref<number | null>(null);
const lpStart = ref<{ x: number; y: number } | null>(null);
const LP_MS = 450;
const LP_DIST = 8;

function onTouchStart(e: PointerEvent) {
  if (props.editMode) return;
  lpStart.value = { x: e.clientX, y: e.clientY };
  longPressTimer.value = window.setTimeout(() => {
    emit("enter-edit");
    longPressTimer.value = null;
  }, LP_MS);
}

function onTouchMove(e: PointerEvent) {
  if (!lpStart.value || !longPressTimer.value) return;
  const d = Math.hypot(e.clientX - lpStart.value.x, e.clientY - lpStart.value.y);
  if (d > LP_DIST) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
}

function onTouchEnd() {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
  lpStart.value = null;
}

// ===== Delete =====
function deleteCard(card: CardConfig, e: Event) {
  e.stopPropagation();
  store.removeCard(card.id);
}

// ===== Grid span =====
function gridSpan(size: CardSize): { gridColumn: string; gridRow: string } {
  const m = CARD_SIZE_MAP[size];
  return {
    gridColumn: `span ${m.cols}`,
    gridRow: `span ${m.rows}`,
  };
}

function isDragging(id: string) {
  return dragState.value?.active && dragState.value.cardId === id;
}

function isResizePreview(card: CardConfig) {
  return resizeState.value?.cardId === card.id ? resizeState.value.previewSize : null;
}

onBeforeUnmount(() => {
  removeGhost();
  if (longPressTimer.value) clearTimeout(longPressTimer.value);
});
</script>

<template>
  <div
    ref="gridRef"
    class="card-grid"
    :class="{ 'is-editing': editMode }"
    @pointerdown="onTouchStart"
    @pointermove="onTouchMove"
    @pointerup="onTouchEnd"
    @pointercancel="onTouchEnd"
  >
    <div
      v-for="(card, idx) in cards"
      :key="card.id"
      :ref="(el) => setCellRef(el as HTMLElement | null, idx)"
      class="card-cell"
      :class="{
        'is-dragging': isDragging(card.id),
        'is-drop-target': dropIndex === idx && dragState?.active,
      }"
      :style="gridSpan(isResizePreview(card) || card.size)"
      @pointerdown="editMode && onCardPointerDown($event, card, idx)"
      @pointermove="editMode && onCardPointerMove($event)"
      @pointerup="editMode && onCardPointerUp($event)"
      @pointercancel="editMode && onCardPointerUp($event)"
      @click="!editMode && !dragState?.active && emit('click', card)"
    >
      <template v-if="editMode">
        <button class="card-delete" @click="deleteCard(card, $event)" aria-label="删除卡片">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <div
          class="card-resize"
          :class="{ 'is-resizing': resizeState?.cardId === card.id }"
          @pointerdown="onResizePointerDown($event, card, idx)"
          @pointermove="onResizePointerMove($event)"
          @pointerup="onResizePointerUp($event)"
          @pointercancel="onResizePointerUp($event)"
          aria-label="拖拽调整大小"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22 22 L22 16 A6 6 0 0 0 16 22 Z M22 22 L16 22 A6 6 0 0 0 22 16 Z" />
          </svg>
          <span v-if="resizeState?.cardId === card.id && resizeState.previewSize" class="resize-label">
            {{ resizeState.previewSize }}
          </span>
        </div>
      </template>

      <HomeCardRenderer :card="card" @click="!editMode && !dragState?.active && emit('click', card)" />
    </div>

    <div v-if="cards.length === 0" class="grid-empty">
      <p>暂无卡片，点击编辑添加</p>
    </div>
  </div>
</template>

<style scoped>
.card-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: 88px;
  gap: var(--space-3);
  width: 100%;
  position: relative;
  touch-action: pan-y;
}

.card-grid.is-editing {
  gap: var(--space-4);
}

.card-grid.is-editing .card-cell {
  cursor: grab;
  position: relative;
  border-radius: var(--radius-lg);
  transition: transform 0.2s var(--ease-immersive), outline-color 0.2s;
}

.card-grid.is-editing .card-cell:active {
  cursor: grabbing;
}

.card-cell {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  transition: transform 0.2s var(--ease-immersive), opacity 0.2s;
}

.card-grid.is-editing .card-cell {
  touch-action: none;
}

.card-cell.is-dragging {
  opacity: 0.3;
}

.card-cell.is-drop-target {
  outline: 2px dashed var(--color-warm);
  outline-offset: 2px;
  border-radius: var(--radius-lg);
}

.card-cell > :deep(.home-card),
.card-cell > :deep(.three-ring-card) {
  width: 100%;
  height: 100%;
}

.card-delete {
  position: absolute;
  top: -8px;
  left: -8px;
  z-index: 10;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--danger-500);
  color: #fff;
  border: 2px solid var(--bg-50);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(232, 64, 38, 0.4);
  padding: 0;
  transition: transform 0.15s;
}

.card-delete:active {
  transform: scale(0.9);
}

.card-resize {
  position: absolute;
  bottom: -8px;
  right: -8px;
  z-index: 10;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--color-warm);
  color: #fff;
  border: 2px solid var(--bg-50);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: nwse-resize;
  box-shadow: 0 2px 12px rgba(255, 102, 51, 0.4);
  padding: 0;
  touch-action: none;
  transition: transform 0.15s;
  flex-direction: column;
  gap: 0;
}

.card-resize.is-resizing {
  transform: scale(1.2);
}

.resize-label {
  position: absolute;
  bottom: -20px;
  right: 0;
  font-size: 9px;
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  background: var(--bg-50);
  padding: 1px 4px;
  border-radius: 4px;
  white-space: nowrap;
}

.grid-empty {
  grid-column: span 4;
  text-align: center;
  padding: var(--space-6);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}
</style>
