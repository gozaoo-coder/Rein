<script setup lang="ts">
/**
 * HomeCardGrid — 显式网格布局 + FLIP 动画 + 拖拽悬停预览
 *
 * 布局：每张卡有显式 (col, row)，由 useGridLayout packer 计算。
 *   - 不回填空隙：gap 保留
 *   - 调整尺寸：保持当前位置
 *   - 拖拽：悬停 0.5s 显示"顶开"预览，松手落入预览位置
 *
 * 动画：anime.js v4 createLayout（AutoLayout）实现 FLIP——record() 记录旧位置，
 * DOM 更新后 animate() 自动播放从旧到新的过渡；reduced-motion 时跳过 animate。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createLayout, type AutoLayout } from "animejs";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import { useAnime } from "@/composables/useAnime";
import { CARD_REGISTRY, CARD_SIZE_MAP, type CardConfig, type CardSize } from "@/types/card";
import {
  packLayout,
  pointerToCell,
  gridRowCount,
  type PlacedCard,
} from "@/composables/useGridLayout";
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

const GAP = 12;
const ROW_H = 88;

// ===== anime.js v4 集成 =====
const { spring, reduced } = useAnime(gridRef);
let layout: AutoLayout | null = null;

// ===== 拖拽状态（声明在 computed 之前，避免 TDZ） =====
const dragState = ref<{
  cardId: string;
  startIdx: number;
  startX: number;
  startY: number;
  ghostX: number;
  ghostY: number;
  active: boolean;
  pointerId: number;
} | null>(null);

const hoverCell = ref<{ col: number; row: number } | null>(null);
let hoverTimer: number | null = null;
const HOVER_MS = 500;
const ghostEl = ref<HTMLElement | null>(null);

// ===== 布局计算 =====

/** 当前布局位置（排除拖动中的卡） */
const placed = computed<PlacedCard[]>(() => {
  const excludeId = dragState.value?.active ? dragState.value.cardId : undefined;
  return packLayout(cards.value, excludeId);
});

/** 预览布局（悬停 0.5s 后计算的"顶开"效果） */
const previewPlaced = ref<PlacedCard[] | null>(null);

/** 实际渲染用的位置：有预览用预览，否则用 placed */
const renderPlaced = computed<PlacedCard[]>(() => {
  if (previewPlaced.value) return previewPlaced.value;
  return placed.value;
});

const positions = computed(() => {
  const map = new Map<string, PlacedCard>();
  for (const p of renderPlaced.value) {
    map.set(p.card.id, p);
  }
  return map;
});

const rowCount = computed(() => gridRowCount(renderPlaced.value));

function gridStyle(pos: PlacedCard): Record<string, string> {
  return {
    gridColumn: `${pos.col} / ${pos.col + pos.cols}`,
    gridRow: `${pos.row} / ${pos.row + pos.rows}`,
  };
}

// ===== FLIP 动画（anime.js v4 createLayout） =====

/**
 * 触发一次 FLIP 过渡：
 *   1. record() 记录当前（旧）布局快照——必须在 DOM 更新前调用
 *   2. 等待 DOM 更新（nextTick）
 *   3. animate() 自动从旧快照过渡到新位置
 * 拖动中跳过（预览动画由 CSS 处理）；reduced-motion 时仅 record 跳过 animate。
 */
function runFlip() {
  if (!layout) return;
  if (dragState.value?.active) return; // 拖动中不 FLIP
  layout.record();
  if (reduced.value) return; // 降级：跳过动画，DOM 直接跳到新位置
  nextTick(() => {
    layout?.animate({ ease: spring("card"), duration: 400 });
  });
}

// 监听位置变化触发 FLIP
watch(
  () => renderPlaced.value.map((p) => `${p.card.id}:${p.col},${p.row}`).join("|"),
  () => runFlip(),
);

// ===== 拖拽换位（含 0.5s 悬停预览） =====

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
  };
}

function docPointerMove(e: PointerEvent) {
  if (resizeState.value) {
    onResizePointerMove(e);
    return;
  }

  const ds = dragState.value;
  if (!ds || e.pointerId !== ds.pointerId) return;

  const dx = e.clientX - ds.startX;
  const dy = e.clientY - ds.startY;
  const dist = Math.hypot(dx, dy);

  if (!ds.active) {
    if (dist > 8) {
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

  // 计算悬停 cell
  if (gridRef.value) {
    const cell = pointerToCell(e.clientX, e.clientY, gridRef.value, GAP);
    if (cell) {
      if (!hoverCell.value || hoverCell.value.col !== cell.col || hoverCell.value.row !== cell.row) {
        hoverCell.value = cell;
        // 悬停 cell 变化 → 重置预览
        previewPlaced.value = null;
        if (hoverTimer !== null) clearTimeout(hoverTimer);
        const card = cards.value.find((c) => c.id === ds.cardId);
        if (card) {
          const m = CARD_SIZE_MAP[card.size];
          const clampedCol = Math.max(1, Math.min(cell.col, 4 - m.cols + 1));
          hoverTimer = window.setTimeout(() => {
            // 计算顶开预览
            previewPlaced.value = packLayout(cards.value, ds.cardId, {
              id: ds.cardId,
              col: clampedCol,
              row: cell.row,
              cols: m.cols,
              rows: m.rows,
            });
            hoverTimer = null;
          }, HOVER_MS);
        }
      }
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
  if (resizeState.value && e.pointerId === resizeState.value.pointerId) {
    onResizePointerUp(e);
    return;
  }

  const ds = dragState.value;
  if (!ds || e.pointerId !== ds.pointerId) return;

  if (hoverTimer !== null) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }

  if (ds.active) {
    // 有预览 → 提交位置；否则尝试简单放置
    if (hoverCell.value) {
      const card = cards.value.find((c) => c.id === ds.cardId);
      if (card) {
        const m = CARD_SIZE_MAP[card.size];
        const col = Math.max(1, Math.min(hoverCell.value.col, 4 - m.cols + 1));
        store.placeCardAt(ds.cardId, col, hoverCell.value.row);
      }
    }
  }

  previewPlaced.value = null;
  hoverCell.value = null;
  removeGhost();
  document.body.style.userSelect = "";
  document.body.style.touchAction = "";
  try {
    const cell = cellRefs.value[ds.startIdx];
    cell?.releasePointerCapture?.(e.pointerId);
  } catch { /* noop */ }
  dragState.value = null;
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

// ===== 拖拽调整大小 =====
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
  const gap = GAP;
  const cellW = gridRect ? (gridRect.width - gap * 3) / 4 : 80;
  const cellH = ROW_H;

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
  if (!rs || e.pointerId !== rs.pointerId) return;

  const dx = e.clientX - rs.startX;
  const dy = e.clientY - rs.startY;

  const deltaCols = Math.round(dx / (rs.cellW + rs.gap));
  const deltaRows = Math.round(dy / (rs.cellH + rs.gap));

  const targetCols = Math.max(1, Math.min(4, rs.startCols + deltaCols));
  const targetRows = Math.max(1, Math.min(4, rs.startRows + deltaRows));

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
      runFlip();
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
  // 创建 AutoLayout：children 选择器匹配模板里的 .card-cell
  if (gridRef.value) {
    layout = createLayout(gridRef.value, {
      children: ".card-cell",
      properties: ["x", "y", "width", "height"],
    });
    layout.record(); // 记录初始布局
  }

  window.addEventListener("pointermove", docPointerMove, { passive: true });
  window.addEventListener("pointerup", docPointerUp);
  window.addEventListener("pointercancel", docPointerUp);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", docPointerMove);
  window.removeEventListener("pointerup", docPointerUp);
  window.removeEventListener("pointercancel", docPointerUp);
  removeGhost();
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  // createLayout 不自动注册到 useAnime 的 scope，需手动 revert 清理
  layout?.revert();
  layout = null;
});

// ===== 长按进入编辑模式 =====
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

// ===== 删除 =====
function deleteCard(card: CardConfig, e: Event) {
  e.stopPropagation();
  runFlip();
  store.removeCard(card.id);
}

function isDragging(id: string) {
  return dragState.value?.active && dragState.value.cardId === id;
}

function isResizePreview(card: CardConfig) {
  return resizeState.value?.cardId === card.id ? resizeState.value.previewSize : null;
}

/** 拖拽预览中的放置占位（半透明轮廓） */
const dropPlaceholder = computed(() => {
  if (!dragState.value?.active || !hoverCell.value) return null;
  const card = cards.value.find((c) => c.id === dragState.value!.cardId);
  if (!card) return null;
  const m = CARD_SIZE_MAP[card.size];
  const col = Math.max(1, Math.min(hoverCell.value.col, 4 - m.cols + 1));
  return { col, row: hoverCell.value.row, cols: m.cols, rows: m.rows };
});
</script>

<template>
  <div
    ref="gridRef"
    class="card-grid"
    :class="{
      'is-editing': editMode,
      'is-previewing': !!previewPlaced,
    }"
    :style="{ gridAutoRows: ROW_H + 'px' }"
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
      }"
      :style="positions.has(card.id) ? gridStyle(positions.get(card.id)!) : undefined"
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

    <!-- 拖拽放置占位（顶开预览的空位轮廓） -->
    <div
      v-if="dropPlaceholder && !previewPlaced"
      class="drop-placeholder"
      :style="{
        gridColumn: `${dropPlaceholder.col} / ${dropPlaceholder.col + dropPlaceholder.cols}`,
        gridRow: `${dropPlaceholder.row} / ${dropPlaceholder.row + dropPlaceholder.rows}`,
      }"
    />

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

/* 预览过渡由 createLayout 接管，不再需要 CSS transition */
.card-cell {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  border-radius: var(--radius-lg);
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1),
              grid-column 0.3s cubic-bezier(0.34, 1.56, 0.64, 1),
              grid-row 0.3s cubic-bezier(0.34, 1.56, 0.64, 1),
              opacity 0.2s;
}

.card-grid.is-editing .card-cell {
  touch-action: none;
  cursor: grab;
}

.card-grid.is-editing .card-cell:active {
  cursor: grabbing;
}

.card-cell.is-dragging {
  opacity: 0.2;
  transform: scale(0.96);
  pointer-events: none;
}

.card-cell > :deep(.home-card),
.card-cell > :deep(.three-ring-card) {
  width: 100%;
  height: 100%;
}

/* 拖拽放置占位 */
.drop-placeholder {
  border-radius: var(--radius-lg);
  border: 2px dashed var(--color-warm);
  background: rgba(255, 149, 0, 0.06);
  pointer-events: none;
  animation: pulse-placeholder 1s ease-in-out infinite;
  z-index: 0;
}

@keyframes pulse-placeholder {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.9; }
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
