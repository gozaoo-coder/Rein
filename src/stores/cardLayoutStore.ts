/**
 * cardLayoutStore — 主页卡片布局 store
 *
 * - 卡片实例 CRUD
 * - 拖拽换位 / 调整尺寸
 * - 显式网格位置 (col, row) 持久化，保留空隙不回填
 * - 三环数据源配置
 * - 持久化到 Tauri storage（useStorage 桥）
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { DEFAULT_GRID_COLUMNS, packLayout } from "@/composables/useGridLayout";
import type { CardConfig, CardLayout, CardSize, CardType, RingDataSource } from "@/types/card";
import { CARD_REGISTRY, CARD_SIZE_MAP, DEFAULT_RINGS } from "@/types/card";
import { pushChange, registerSyncEntity } from "@/composables/useSyncBridge";

const LAYOUT_KEY = "home-card-layout";
const LAYOUT_REC_ID = "layout";

function genId(): string {
  return `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 默认布局：三环 + 健康概览 + 今日待办 + 最近运动 */
function defaultLayout(): CardLayout {
  return {
    cards: [
      { id: genId(), type: "three-ring", size: "4x2", col: 1, row: 1 },
      { id: genId(), type: "health-overview", size: "2x2", col: 1, row: 3 },
      { id: genId(), type: "today-todo", size: "2x2", col: 3, row: 3 },
      { id: genId(), type: "recent-workout", size: "4x2", col: 1, row: 5 },
    ],
    columns: 4,
    rings: [...DEFAULT_RINGS],
  };
}

/** 给没有显式位置的卡分配位置（packer 自动） */
function ensurePositions(cards: CardConfig[]): void {
  const placed = packLayout(cards);
  for (const p of placed) {
    if (p.card.col === undefined || p.card.row === undefined) {
      p.card.col = p.col;
      p.card.row = p.row;
    }
  }
}

export const useCardLayoutStore = defineStore("cardLayout", () => {
  const layout = ref<CardLayout>(defaultLayout());
  const loaded = ref(false);

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<CardLayout>(LAYOUT_KEY);
    if (stored && Array.isArray(stored.cards) && stored.cards.length > 0) {
      if (!stored.rings || stored.rings.length !== 3) {
        stored.rings = [...DEFAULT_RINGS];
      }
      const hasThreeRing = stored.cards.some((c) => c.type === "three-ring");
      if (!hasThreeRing) {
        const hoIdx = stored.cards.findIndex((c) => c.type === "health-overview");
        if (hoIdx >= 0) {
          stored.cards[hoIdx].size = "2x2";
          stored.cards.splice(hoIdx, 0, { id: genId(), type: "three-ring", size: "4x2", col: 1, row: 1 });
        } else {
          stored.cards.unshift({ id: genId(), type: "three-ring", size: "4x2", col: 1, row: 1 });
        }
      }
      // 给老数据（无 col/row）分配位置
      ensurePositions(stored.cards);
      layout.value = stored;
    }
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    await writeJSON(LAYOUT_KEY, layout.value);
    void pushChange(LAYOUT_KEY, LAYOUT_REC_ID, layout.value);
  }

  function addCard(type: CardType, size?: CardSize, atIndex?: number): CardConfig {
    const meta = CARD_REGISTRY[type];
    const card: CardConfig = {
      id: genId(),
      type,
      size: size ?? meta.defaultSize,
    };
    if (atIndex !== undefined && atIndex >= 0 && atIndex <= layout.value.cards.length) {
      layout.value.cards.splice(atIndex, 0, card);
    } else {
      layout.value.cards.push(card);
    }
    // 重新 pack 并写入位置
    reassignPositions();
    void persist();
    return card;
  }

  function removeCard(id: string): void {
    layout.value.cards = layout.value.cards.filter((c) => c.id !== id);
    reassignPositions();
    void persist();
  }

  /** 重新计算所有卡的位置（保留已有显式位置，冲突推后） */
  function reassignPositions(columns: number = DEFAULT_GRID_COLUMNS): void {
    const placed = packLayout(layout.value.cards, undefined, undefined, columns);
    for (const p of placed) {
      p.card.col = p.col;
      p.card.row = p.row;
    }
  }

  function moveCard(fromIndex: number, toIndex: number): void {
    const cards = layout.value.cards;
    if (fromIndex < 0 || fromIndex >= cards.length) return;
    const clampedTo = Math.max(0, Math.min(toIndex, cards.length - 1));
    if (fromIndex === clampedTo) return;
    const [moved] = cards.splice(fromIndex, 1);
    cards.splice(clampedTo, 0, moved);
    reassignPositions();
    void persist();
  }

  /** 移动到指定位置（插入，原位置删除） */
  function moveCardTo(fromId: string, toIndex: number): void {
    const fromIdx = layout.value.cards.findIndex((c) => c.id === fromId);
    if (fromIdx < 0) return;
    const cards = layout.value.cards;
    const [moved] = cards.splice(fromIdx, 1);
    const clampedTo = Math.max(0, Math.min(toIndex, cards.length));
    cards.splice(clampedTo, 0, moved);
    reassignPositions();
    void persist();
  }

  /**
   * 将卡片放置到指定网格 cell (col, row)。
   * 其他卡被推开（向下/向右），通过 packer 解决冲突。
   *
   * @param columns 当前网格列数（宽型窗口为 8，默认 4）
   */
  function placeCardAt(cardId: string, col: number, row: number, columns: number = DEFAULT_GRID_COLUMNS): void {
    const card = layout.value.cards.find((c) => c.id === cardId);
    if (!card) return;
    const m = CARD_SIZE_MAP[card.size];
    card.col = Math.max(1, Math.min(col, columns - m.cols + 1));
    card.row = Math.max(1, row);
    reassignPositions(columns);
    void persist();
  }

  function resizeCard(id: string, size: CardSize, columns: number = DEFAULT_GRID_COLUMNS): void {
    const card = layout.value.cards.find((c) => c.id === id);
    if (!card) return;
    const meta = CARD_REGISTRY[card.type];
    if (!meta.sizes.includes(size)) return;
    card.size = size;
    // 调整尺寸时保持当前位置（clamp col 使其不越界）
    const m = CARD_SIZE_MAP[size];
    if (card.col) {
      card.col = Math.max(1, Math.min(card.col, columns - m.cols + 1));
    }
    reassignPositions(columns);
    void persist();
  }

  function updateCardProps(id: string, props: Record<string, any>): void {
    const card = layout.value.cards.find((c) => c.id === id);
    if (!card) return;
    card.props = { ...card.props, ...props };
    void persist();
  }

  /** 设置三环数据源（3 个，可重复） */
  function setRings(rings: RingDataSource[]): void {
    if (rings.length !== 3) return;
    layout.value.rings = [...rings];
    void persist();
  }

  function resetToDefault(): void {
    layout.value = defaultLayout();
    void persist();
  }

  const rings = computed(() => layout.value.rings);

  return {
    layout,
    rings,
    loaded,
    load,
    addCard,
    removeCard,
    moveCard,
    moveCardTo,
    placeCardAt,
    resizeCard,
    updateCardProps,
    setRings,
    resetToDefault,
    reassignPositions,
    applyRemote,
  };
});

/** 远端同步应用：card-layout 单条（id="layout"），整体替换 */
async function applyRemote(_id: string, payload: unknown, deleted: boolean): Promise<void> {
  if (deleted) return;
  const store = useCardLayoutStore();
  const incoming = payload as CardLayout;
  if (!incoming || !Array.isArray(incoming.cards)) return;
  store.layout = incoming;
  await writeJSON(LAYOUT_KEY, store.layout);
}

registerSyncEntity<CardLayout>({ kind: LAYOUT_KEY, applyRemote });

