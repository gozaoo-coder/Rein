import { defineStore } from "pinia";
import { ref } from "vue";
import type { CardConfig, CardLayout } from "@/types/card";

export const useCardLayoutStore = defineStore("cardLayout", () => {
  const layout = ref<CardLayout>({
    cards: [],
    columns: 4,
  });

  function setLayout(newLayout: CardLayout) {
    layout.value = newLayout;
  }

  function addCard(card: CardConfig) {
    layout.value.cards.push(card);
    persistLayout();
  }

  function removeCard(cardId: string) {
    layout.value.cards = layout.value.cards.filter((c) => c.id !== cardId);
    persistLayout();
  }

  function moveCard(fromIndex: number, toIndex: number) {
    const cards = layout.value.cards;
    const [moved] = cards.splice(fromIndex, 1);
    cards.splice(toIndex, 0, moved);
    persistLayout();
  }

  function updateCard(cardId: string, updates: Partial<CardConfig>) {
    const card = layout.value.cards.find((c) => c.id === cardId);
    if (card) {
      Object.assign(card, updates);
      persistLayout();
    }
  }

  function persistLayout() {
    try {
      localStorage.setItem("rein-card-layout", JSON.stringify(layout.value));
    } catch {
      // storage full or unavailable
    }
  }

  function loadLayout() {
    try {
      const saved = localStorage.getItem("rein-card-layout");
      if (saved) {
        layout.value = JSON.parse(saved);
      }
    } catch {
      // corrupted data
    }
  }

  return {
    layout,
    setLayout,
    addCard,
    removeCard,
    moveCard,
    updateCard,
    persistLayout,
    loadLayout,
  };
});
