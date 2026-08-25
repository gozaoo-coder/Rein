import { onBeforeUnmount, ref, type Ref } from 'vue'

/**
 * 响应式媒体查询：返回布尔 ref，随查询匹配变化更新（SSR 无需考虑，本体 Tauri）。
 */
export function useMediaQuery(query: string): Ref<boolean> {
  const mq = window.matchMedia(query)
  const matches = ref(mq.matches)
  const onChange = (e: MediaQueryListEvent): void => {
    matches.value = e.matches
  }
  mq.addEventListener('change', onChange)
  onBeforeUnmount(() => mq.removeEventListener('change', onChange))
  return matches
}
