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

// ===== Drag reorder (document-level pointer events) =====
const dragState = ref<{
  cardId: string;
  startIdx: number;
  startX: number;
  startY: number;
  ghostX: number;
  ghostY: number;
  active: boolean;
  pointerId: number;
  longPressTimer: number | null;
} | null>(null);
const dropIndex = ref<number | null>(null);
const ghostEl = ref<HTMLElement | null>(null);
const animating = ref(false);

function clearLongPress(ds: NonNullable<typeof dragState.value>) {
  if (ds.longPressTimer !== null) {
    clearTimeout(ds.longPressTimer);
    ds.longPressTimer = null;
  }
}

function onCardPointerDown(e: PointerEvent, card: CardConfig, idx: number) {
  if (!props.editMode) return;
  if (e.button !== undefined && e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest(".card-delete") || target.closest(".card-resize")) return;
  const cellEl = cellRefs.value[idx];
  if (!cellEl) return;

  cellEl.setPointerCapture(e.pointerId);
  dragState.value = {
    cardId: card.id,
    startIdx: idx,
    startX: e.clientX,
    startY: e.clientY,
    ghostX: 0,
    ghostY: 0,
    active: false,
    pointerId: e.pointerId,
    longPressTimer: null,
  };
}

function docPointerMove(e: PointerEvent) {
  // Resize takes priority
  if (resizeState.value) {
    onResizePointerMove(e);
    return;
  }

  const ds = dragState.value;
  if (!ds) return;
  if (e.pointerId !== ds.pointerId) return;

  const dx = e.clientX - ds.startX;
  const dy = e.clientY - ds.startY;
  const dist = Math.hypot(dx, dy);

  if (!ds.active) {
    if (dist > 8) {
      ds.active = true;
      clearLongPress(ds);
      createGhost(ds.cardId);
      document.body.style.userSelect = "none";
      document.body.style.touchAction = "none";
      dropIndex.value = ds.startIdx;
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
    const targetIdx = cellRefs.value.indexOf(cellEl);
    if (targetIdx >= 0 && targetIdx !== dropIndex.value) {
      dropIndex.value = targetIdx;
    }
  }

  // Auto-scroll
  const scroller = document.querySelector(".app-main") as HTMLElement | null;
  if (scroller) {
    if (e.clientY > window.innerHeight - 120) {
      scroller.scrollBy({ top: 16 });
    } else if (e.clientY < 100) {
      scroller.scrollBy({ top: -16 });
    }
  }
}

function docPointerUp(e: PointerEvent) {
  // Resize end
  if (resizeState.value && e.pointerId === resizeState.value.pointerId) {
    onResizePointerUp(e);
    return;
  }

  const ds = dragState.value;
  if (!ds || e.pointerId !== ds.pointerId) return;

  clearLongPress(ds);

  if (ds.active && dropIndex.value !== null && dropIndex.value !== ds.startIdx) {
    animating.value = true;
    store.moveCardTo(ds.cardId, dropIndex.value);
    nextTick(() => {
      setTimeout(() => { animating.value = false; }, 280);
    });
  }

  removeGhost();
  document.body.style.userSelect = "";
  document.body.style.touchAction = "";
  try {
    const cell = cellRefs.value[ds.startIdx];
    cell?.releasePointerCapture?.(e.pointerId);
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
  ghost.style.transform = "scale(1.04) rotate(1.5deg)";
  ghost.style.opacity = "0.92";
  ghost.style.transition = "none";
  ghost.style.boxShadow = "0 16px 48px rgba(0,0,0,0.25)";
  ghost.style.borderRadius = "var(--radius-lg)";
  ghost.style.overflow = "hidden";
  ghost.querySelectorAll(".card-delete, .card-resize").forEach((el) => el.remove());
  document.body.appendChild(ghost);
  ghostEl.value = ghost;
}

function updateGhostPosition(dx: number, dy: number) {
  if (!ghostEl.value) return;
  ghostEl.value.style.transform = `translate(${dx}px, ${dy}px) scale(1.04) rotate(1.5deg)`;
}

function removeGhost() {
  if (ghostEl.value) {
    ghostEl.value.remove();
    ghostEl.value = null;
  }
}

// ===== Drag-to-resize (document-level pointer events) =====
const resizeState = ref<{
  cardId: string;
  startX: number;
  startY: number;
  startCols: number;
  startRows: number;
  cellW: number;
  cellH: number;
  gap: number;
  previewSize: CardSize | null;
  pointerId: number;
} | null>(null);

function onResizePointerDown(e: PointerEvent, card: CardConfig, idx: number) {
  e.stopPropagation();
  e.preventDefault();
  if (!props.editMode) return;
  if (e.button !== undefined && e.button !== 0) return;

  const handle = e.currentTarget as HTMLElement;
  handle.setPointerCapture(e.pointerId);

  const m = CARD_SIZE_MAP[card.size];
  const gridEl = gridRef.value;
  const gridRect = gridEl?.getBoundingClientRect();
  const gap = 12;
  const cellW = gridRect ? (gridRect.width - gap * 3) / 4 : 80;
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
    gap,
    previewSize: card.size,
    pointerId: e.pointerId,
  };
}

function onResizePointerMove(e: PointerEvent) {
  const rs = resizeState.value;
  if (!rs) return;
  if (e.pointerId !== rs.pointerId) return;

  const dx = e.clientX - rs.startX;
  const dy = e.clientY - rs.startY;

  const deltaCols = Math.round(dx / (rs.cellW + rs.gap));
  const deltaRows = Math.round(dy / (rs.cellH + rs.gap));

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
  if (e.pointerId !== rs.pointerId) return;

  if (rs.previewSize) {
    const card = cards.value.find((c) => c.id === rs.cardId);
    if (card && rs.previewSize !== card.size) {
      store.resizeCard(rs.cardId, rs.previewSize);
    }
  }
  try {
    const handle = e.currentTarget as HTMLElement | null;
    handle?.releasePointerCapture?.(e.pointerId);
  } catch { /* noop */ }
  resizeState.value = null;
}

// ===== Document-level listeners =====
onMounted(() => {
  window.addEventListener("pointermove", docPointerMove, { passive: true });
  window.addEventListener("pointerup", docPointerUp);
  window.addEventListener("pointercancel", docPointerUp);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", docPointerMove);
  window.removeEventListener("pointerup", docPointerUp);
  window.removeEventListener("pointercancel", docPointerUp);
  removeGhost();
});

// ===== Long-press to enter edit mode =====
const lpTimer = ref<number | null>(null);
const lpStart = ref<{ x: number; y: number } | null>(null);
const LP_MS = 500;
const LP_DIST = 10;

function onGridPointerDown(e: PointerEvent) {
  if (props.editMode) return;
  if (e.button !== undefined && e.button !== 0) return;
  lpStart.value = { x: e.clientX, y: e.clientY };
  lpTimer.value = window.setTimeout(() => {
    emit("enter-edit");
    lpTimer.value = null;
    lpStart.value = null;
  }, LP_MS);
}

function onGridPointerMove(e: PointerEvent) {
  if (!lpStart.value || lpTimer.value === null) return;
  const d = Math.hypot(e.clientX - lpStart.value.x, e.clientY - lpStart.value.y);
  if (d > LP_DIST) {
    clearTimeout(lpTimer.value);
    lpTimer.value = null;
  }
}

function onGridPointerUp() {
  if (lpTimer.value !== null) {
    clearTimeout(lpTimer.value);
    lpTimer.value = null;
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
</script>

<template>
  <div
    ref="gridRef"
    class="card-grid"
    :class="{
      'is-editing': editMode,
      'is-animating': animating,
    }"
    @pointerdown="onGridPointerDown"
    @pointermove="onGridPointerMove"
    @pointerup="onGridPointerUp"
    @pointercancel="onGridPointerUp"
  >
    <div
      v-for="(card, idx) in cards"
      :key="card.id"
      :ref="(el) => setCellRef(el as HTMLElement | null, idx)"
      class="card-cell"
      :class="{
        'is-dragging': isDragging(card.id),
        'is-drop-before': editMode && dropIndex === idx && dragState?.active && dragState.startIdx !== idx && idx <= dragState.startIdx,
        'is-drop-after': editMode && dropIndex === idx && dragState?.active && dragState.startIdx !== idx && idx > dragState.startIdx,
      }"
      :style="gridSpan(isResizePreview(card) || card.size)"
      @pointerdown="editMode && onCardPointerDown($event, card, idx)"
      @click="!editMode && !dragState?.active && emit('click', card)"
    >
      <template v-if="editMode">
        <button class="card-delete" @click="deleteCard(card, $event)" aria-label="删除卡片">
          <i class="bi bi-x-lg" style="font-size:10px"></i>
        </button>

        <button
          class="card-resize"
          :class="{ 'is-resizing': resizeState?.cardId === card.id }"
          @pointerdown="onResizePointerDown($event, card, idx)"
          aria-label="拖拽调整大小"
        >
          <i class="bi bi-arrows-angle-expand" style="font-size:12px"></i>
        </button>
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
  gap: var(--space-3);
}

.card-grid.is-animating .card-cell {
  transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1),
              grid-column 0.28s cubic-bezier(0.34, 1.56, 0.64, 1),
              grid-row 0.28s cubic-bezier(0.34, 1.56, 0.64, 1),
              opacity 0.2s;
}

.card-cell {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  border-radius: var(--radius-lg);
  transition: transform 0.2s var(--ease-immersive), opacity 0.2s;
}

.card-grid.is-editing .card-cell {
  touch-action: none;
  cursor: grab;
}

.card-grid.is-editing .card-cell:active {
  cursor: grabbing;
}

.card-cell.is-dragging {
  opacity: 0.25;
  transform: scale(0.96);
}

.card-cell.is-drop-before {
  transform: translateX(calc(var(--space-3) + 4px));
}
.card-cell.is-drop-after {
  transform: translateX(calc(-1 * (var(--space-3) + 4px)));
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
  width: 28px;
  height: 28px;
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
}

.card-resize.is-resizing {
  transform: scale(1.2);
}

.grid-empty {
  grid-column: span 4;
  text-align: center;
  padding: var(--space-6);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}
</style>
