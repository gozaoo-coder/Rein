import { ref, onMounted, onUnmounted } from "vue";
import type { BreakpointMode } from "@/types";

const BREAKPOINTS = {
  phone: 767,
  pad: 1023,
} as const;

export function useBreakpoint() {
  const mode = ref<BreakpointMode>("desktop");

  function detect(): BreakpointMode {
    const w = window.innerWidth;
    if (w <= BREAKPOINTS.phone) return "phone";
    if (w <= BREAKPOINTS.pad) return "pad";
    return "desktop";
  }

  let timer: ReturnType<typeof setTimeout>;

  function onResize() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      mode.value = detect();
    }, 100);
  }

  onMounted(() => {
    mode.value = detect();
    window.addEventListener("resize", onResize);
  });

  onUnmounted(() => {
    window.removeEventListener("resize", onResize);
    clearTimeout(timer);
  });

  return { mode };
}
