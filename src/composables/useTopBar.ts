import { reactive } from "vue";

export interface TopBarAction {
  id: string;
  icon: string;
  label: string;
  onClick: () => void;
}

const state = reactive({
  actions: [] as TopBarAction[],
});

export function useTopBar() {
  function setActions(actions: TopBarAction[]) {
    state.actions = [...actions];
  }
  function clearActions() {
    state.actions = [];
  }
  return { actions: state.actions, setActions, clearActions };
}

export const ICONS = {
  edit: "pencil-square",
  done: "check-lg",
  plus: "plus-lg",
  history: "clock-history",
  share: "share",
  config: "gear-fill",
} as const;

export type IconName = keyof typeof ICONS;
