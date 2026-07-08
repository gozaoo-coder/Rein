/**
 * cardLayoutStore — 主页卡片布局 store
 *
 * - 卡片实例 CRUD
 * - 拖拽换位 / 调整尺寸
 * - 三环数据源配置
 * - 持久化到 Tauri storage（useStorage 桥）
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { readJSON, writeJSON } from "@/composables/useStorage";
import type { CardConfig, CardLayout, CardSize, CardType, RingDataSource } from "@/types/card";
import { CARD_REGISTRY, DEFAULT_RINGS } from "@/types/card";

const LAYOUT_KEY = "home-card-layout";

function genId(): string {
  return `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 默认布局：健康概览 + 今日待办 + 最近运动 */
function defaultLayout(): CardLayout {
  return {
    cards: [
      { id: genId(), type: "health-overview", size: "2x2" },
      { id: genId(), type: "today-todo", size: "2x2" },
      { id: genId(), type: "recent-workout", size: "4x2" },
    ],
    columns: 4,
    rings: [...DEFAULT_RINGS],
  };
}

export const useCardLayoutStore = defineStore("cardLayout", () => {
  const layout = ref<CardLayout>(defaultLayout());
  const loaded = ref(false);

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<CardLayout>(LAYOUT_KEY);
    if (stored && Array.isArray(stored.cards) && stored.cards.length > 0) {
      // 兼容性：补全 rings 字段
      if (!stored.rings || stored.rings.length !== 3) {
        stored.rings = [...DEFAULT_RINGS];
      }
      layout.value = stored;
    }
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    await writeJSON(LAYOUT_KEY, layout.value);
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
    void persist();
    return card;
  }

  function removeCard(id: string): void {
    layout.value.cards = layout.value.cards.filter((c) => c.id !== id);
    void persist();
  }

  function moveCard(fromIndex: number, toIndex: number): void {
    const cards = layout.value.cards;
    if (fromIndex < 0 || fromIndex >= cards.length) return;
    const clampedTo = Math.max(0, Math.min(toIndex, cards.length - 1));
    if (fromIndex === clampedTo) return;
    const [moved] = cards.splice(fromIndex, 1);
    cards.splice(clampedTo, 0, moved);
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
    void persist();
  }

  function resizeCard(id: string, size: CardSize): void {
    const card = layout.value.cards.find((c) => c.id === id);
    if (!card) return;
    const meta = CARD_REGISTRY[card.type];
    if (!meta.sizes.includes(size)) return;
    card.size = size;
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
    resizeCard,
    updateCardProps,
    setRings,
    resetToDefault,
  };
});
