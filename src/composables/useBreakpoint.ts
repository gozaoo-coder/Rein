import { ref, computed, onMounted, onUnmounted } from "vue";

export type BreakpointMode = "phone" | "pad" | "desktop";

export function useBreakpoint() {
  const width = ref(window.innerWidth);

  const mode = computed<BreakpointMode>(() => {
    if (width.value < 768) return "phone";
    if (width.value < 1200) return "pad";
    return "desktop";
  });

  let rafId: number | null = null;

  function onResize() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      width.value = window.innerWidth;
    });
  }

  onMounted(() => window.addEventListener("resize", onResize, { passive: true }));
  onUnmounted(() => {
    window.removeEventListener("resize", onResize);
    if (rafId) cancelAnimationFrame(rafId);
  });

  return { width, mode };
}
