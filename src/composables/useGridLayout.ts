/**
 * useGridLayout — 显式网格布局引擎
 *
 * - 尊重每张卡的显式 (col, row)，冲突时向后推
 * - 不回填已有空隙（gap 保留）
 * - 支持 "插入到指定 cell 并推开他人" 的预览计算
 */
import { computed, type Ref } from "vue";
import { CARD_SIZE_MAP, type CardConfig, type CardSize } from "@/types/card";

export interface CellPos {
  col: number; // 1-based
  row: number; // 1-based
}

export interface PlacedCard {
  card: CardConfig;
  col: number;
  row: number;
  cols: number;
  rows: number;
}

const COLUMNS = 4;

/** 占位表：Set<"row,col"> */
function makeOccupied(): Set<string> {
  return new Set();
}

function mark(occ: Set<string>, col: number, row: number, cols: number, rows: number): void {
  for (let r = row; r < row + rows; r++) {
    for (let c = col; c < col + cols; c++) {
      occ.add(`${r},${c}`);
    }
  }
}

function isFree(occ: Set<string>, col: number, row: number, cols: number, rows: number): boolean {
  for (let r = row; r < row + rows; r++) {
    for (let c = col; c < col + cols; c++) {
      if (c > COLUMNS) return false;
      if (occ.has(`${r},${c}`)) return false;
    }
  }
  return true;
}

/**
 * 从 (startRow, startCol) 起向前扫描第一个可用位置
 * 不回填：cursor 只前进
 */
function findNextFree(
  occ: Set<string>,
  startRow: number,
  startCol: number,
  cols: number,
  rows: number,
): CellPos {
  let r = startRow;
  let c = startCol;
  while (true) {
    if (c + cols - 1 > COLUMNS) {
      r++;
      c = 1;
      continue;
    }
    if (isFree(occ, c, r, cols, rows)) {
      return { col: c, row: r };
    }
    c++;
    if (c + cols - 1 > COLUMNS) {
      r++;
      c = 1;
    }
  }
}

/**
 * 核心 packer：尊重显式位置，冲突向后推，不回填
 *
 * @param cards 卡片列表（按顺序）
 * @param excludeId 排除的卡 id（拖动中的卡，不参与布局）
 * @param override 可选：覆盖某张卡的位置（用于预览）
 */
export function packLayout(
  cards: CardConfig[],
  excludeId?: string,
  override?: { id: string; col: number; row: number; cols: number; rows: number },
): PlacedCard[] {
  const occ = makeOccupied();
  const result: PlacedCard[] = [];

  // 先放 override（拖拽预览中的卡）
  if (override && override.id !== excludeId) {
    const card = cards.find((c) => c.id === override.id);
    if (card) {
      const m = CARD_SIZE_MAP[card.size];
      const cols = override.cols;
      const rows = override.rows;
      const col = Math.max(1, Math.min(override.col, COLUMNS - cols + 1));
      const row = Math.max(1, override.row);
      // 标记 override 占位（即使与他人冲突，强制占）
      mark(occ, col, row, cols, rows);
    }
  }

  for (const card of cards) {
    if (card.id === excludeId) continue;
    if (override && card.id === override.id) {
      const m = CARD_SIZE_MAP[card.size];
      const cols = override.cols;
      const rows = override.rows;
      const col = Math.max(1, Math.min(override.col, COLUMNS - cols + 1));
      const row = Math.max(1, override.row);
      result.push({ card, col, row, cols, rows });
      continue;
    }

    const m = CARD_SIZE_MAP[card.size];
    let col = card.col ?? 1;
    let row = card.row ?? 1;
    col = Math.max(1, Math.min(col, COLUMNS - m.cols + 1));
    row = Math.max(1, row);

    // 尝试显式位置，冲突则找下一个空位
    if (!isFree(occ, col, row, m.cols, m.rows)) {
      const free = findNextFree(occ, row, col, m.cols, m.rows);
      col = free.col;
      row = free.row;
    }

    mark(occ, col, row, m.cols, m.rows);
    result.push({ card, col, row, cols: m.cols, rows: m.rows });
  }

  return result;
}

/** 计算网格总行数 */
export function gridRowCount(placed: PlacedCard[]): number {
  let max = 0;
  for (const p of placed) {
    max = Math.max(max, p.row + p.rows - 1);
  }
  return max;
}

/** 将 pointer 坐标转为网格 cell（1-based col, row） */
export function pointerToCell(
  clientX: number,
  clientY: number,
  gridEl: HTMLElement,
  gap: number,
): CellPos | null {
  const rect = gridEl.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }
  const cellW = (rect.width - gap * (COLUMNS - 1)) / COLUMNS;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const col = Math.min(COLUMNS, Math.max(1, Math.floor(x / (cellW + gap)) + 1));
  const row = Math.max(1, Math.floor(y / (88 + gap)) + 1);
  return { col, row };
}

export function useGridLayout(cards: Ref<CardConfig[]>) {
  const placed = computed(() => packLayout(cards.value));

  const positions = computed(() => {
    const map = new Map<string, PlacedCard>();
    for (const p of placed.value) {
      map.set(p.card.id, p);
    }
    return map;
  });

  const rowCount = computed(() => gridRowCount(placed.value));

  return { placed, positions, rowCount };
}

export { COLUMNS as GRID_COLUMNS };

export function sizeToDims(size: CardSize): { cols: number; rows: number } {
  return CARD_SIZE_MAP[size];
}
