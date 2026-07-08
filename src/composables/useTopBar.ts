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
    // 原地修改：保持 AppTopBar 解构拿到的数组引用有效，触发 length 响应
    state.actions.splice(0, state.actions.length, ...actions);
  }
  function clearActions() {
    state.actions.splice(0, state.actions.length);
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
