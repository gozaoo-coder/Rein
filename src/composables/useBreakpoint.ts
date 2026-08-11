import { onMounted, onUnmounted, ref } from "vue";

const WIDE_QUERY = "(min-width: 760px)";

export function useBreakpoint() {
  const isWide = ref(false);
  let mq: MediaQueryList | null = null;

  function update(e?: MediaQueryListEvent) {
    isWide.value = e ? e.matches : mq!.matches;
  }

  onMounted(() => {
    mq = window.matchMedia(WIDE_QUERY);
    update();
    mq.addEventListener("change", update);
  });

  onUnmounted(() => {
    mq?.removeEventListener("change", update);
  });

  return isWide;
}

export function isWideNow(): boolean {
  return window.matchMedia(WIDE_QUERY).matches;
}
