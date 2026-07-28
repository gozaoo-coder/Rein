import { computed, ref, type ComputedRef, type Ref } from "vue";

export type BreakpointMode = "phone" | "pad" | "desktop";

/**
 * useBreakpoint — 全局共享的响应式断点
 *
 * 单例实现：window resize 监听器全局只注册一次（rAF 节流），
 * 所有组件共享同一份 width/mode，避免每个调用方各自挂监听。
 *
 * mode 采用 debounce 稳定策略：拖动窗口时 width 实时更新，
 * 但 mode 仅在 resize 停止 150ms 后才切换，避免在 768/1200px
 * 边界抖动导致下游布局（AppShell 侧栏切换、HomeCardGrid 列数
 * 切换、anime.js FLIP 动画）频繁触发堆积卡死。
 */
const width = ref(typeof window !== "undefined" ? window.innerWidth : 375);
/** debounced 稳定宽度：仅 resize 停止后更新，用于派生 mode */
const stableWidth = ref(width.value);

const mode: ComputedRef<BreakpointMode> = computed(() => {
  if (stableWidth.value < 768) return "phone";
  if (stableWidth.value < 1200) return "pad";
  return "desktop";
});

let rafId: number | null = null;
let listening = false;
let modeDebounceTimer: number | null = null;
const MODE_DEBOUNCE_MS = 150;

function onResize() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    width.value = window.innerWidth;
    rafId = null;
    // mode 切换加 debounce：避免拖动窗口时在 768/1200px 边界抖动，
    // 导致下游（AppShell 侧栏 v-if、HomeCardGrid cols、FLIP 动画）堆积
    if (modeDebounceTimer !== null) clearTimeout(modeDebounceTimer);
    modeDebounceTimer = window.setTimeout(() => {
      stableWidth.value = width.value;
      modeDebounceTimer = null;
    }, MODE_DEBOUNCE_MS);
  });
}

function ensureListener() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("resize", onResize, { passive: true });
  listening = true;
}

// 模块加载即注册（应用生命周期内常驻，无需卸载）
ensureListener();

export function useBreakpoint(): {
  width: Ref<number>;
  mode: ComputedRef<BreakpointMode>;
} {
  return { width, mode };
}
