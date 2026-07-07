import { ref, onMounted } from "vue";
import type { SafeAreaInsets } from "@/types";

/**
 * 安全区域适配 — 处理异形屏（刘海、挖孔、灵动岛等）
 * 通过 CSS env() + JS fallback 双重保障
 */
export function useSafeArea() {
  const insets = ref<SafeAreaInsets>({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });

  onMounted(() => {
    // 从 CSS 环境变量读取安全区域
    const style = getComputedStyle(document.documentElement);
    insets.value = {
      top: parseInt(style.getPropertyValue("--safe-area-top")) || 0,
      right: parseInt(style.getPropertyValue("--safe-area-right")) || 0,
      bottom: parseInt(style.getPropertyValue("--safe-area-bottom")) || 0,
      left: parseInt(style.getPropertyValue("--safe-area-left")) || 0,
    };
  });

  return { insets };
}
