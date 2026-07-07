import { ref } from "vue";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import type { CardConfig } from "@/types/card";

export function useCardEditor() {
  const isEditing = ref(false);
  const layoutStore = useCardLayoutStore();

  function enterEditMode() {
    isEditing.value = true;
  }

  function exitEditMode() {
    isEditing.value = false;
  }

  function toggleEditMode() {
    isEditing.value = !isEditing.value;
  }

  function saveLayout() {
    layoutStore.persistLayout();
    exitEditMode();
  }

  function removeCard(cardId: string) {
    layoutStore.removeCard(cardId);
  }

  function moveCard(fromIndex: number, toIndex: number) {
    layoutStore.moveCard(fromIndex, toIndex);
  }

  function addCard(card: CardConfig) {
    layoutStore.addCard(card);
  }

  return {
    isEditing,
    enterEditMode,
    exitEditMode,
    toggleEditMode,
    saveLayout,
    removeCard,
    moveCard,
    addCard,
  };
}
