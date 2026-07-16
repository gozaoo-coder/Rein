<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAnime } from "@/composables/useAnime";

type SheetDetent = "medium" | "large";

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title?: string;
    showBack?: boolean;
    detents?: SheetDetent[];
    defaultDetent?: SheetDetent;
  }>(),
  {
    title: "",
    showBack: false,
    detents: () => ["medium", "large"] as SheetDetent[],
    defaultDetent: "medium",
  },
);

const emit = defineEmits<{
  close: [];
  back: [];
  "update:visible": [v: boolean];
}>();

const currentDetent = ref<SheetDetent>(props.defaultDetent);
const dragState = ref<{
  active: boolean;
  startY: number;
  startDetent: SheetDetent;
  offset: number;
} | null>(null);

const sheetEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
const maskEl = ref<HTMLElement | null>(null);
// 延迟移除：visible 变 false 时先播退场动画，onComplete 再卸载 DOM
const internalVisible = ref(props.visible);

const isDesktop = ref(false);
let resizeObserver: ResizeObserver | null = null;

const { animate, enter, exit, spring } = useAnime();

function updateViewport() {
  isDesktop.value = window.innerWidth >= 600;
}

onMounted(() => {
  updateViewport();
  resizeObserver = new ResizeObserver(updateViewport);
  resizeObserver.observe(document.documentElement);
  if (props.visible) {
    document.body.style.overflow = "hidden";
    nextTick(() => playEnter());
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});

function playEnter() {
  if (maskEl.value) {
    enter(maskEl.value, "fade", { duration: 250 });
  }
  if (sheetEl.value) {
    if (isDesktop.value) {
      enter(sheetEl.value, "popIn", { springName: "smooth", duration: 300 });
    } else {
      enter(sheetEl.value, "sheetUp", { springName: "sheet", duration: 420 });
    }
  }
}

async function playExit(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (maskEl.value) {
    tasks.push(exit(maskEl.value, "fade", { duration: 250 }));
  }
  if (sheetEl.value) {
    if (isDesktop.value) {
      tasks.push(exit(sheetEl.value, "popIn", { springName: "smooth", duration: 300 }));
    } else {
      tasks.push(exit(sheetEl.value, "sheetUp", { springName: "sheet", duration: 420 }));
    }
  }
  await Promise.all(tasks);
}

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      currentDetent.value = props.defaultDetent;
      document.body.style.overflow = "hidden";
      internalVisible.value = true;
      await nextTick();
      playEnter();
    } else {
      document.body.style.overflow = "";
      await playExit();
      internalVisible.value = false;
    }
  },
);

watch(
  () => props.defaultDetent,
  (d) => {
    if (props.visible) currentDetent.value = d;
  },
);

const hasLarge = computed(() => props.detents.includes("large"));
const hasMedium = computed(() => props.detents.includes("medium"));

const sheetStyle = computed(() => {
  if (isDesktop.value) {
    return {};
  }
  const drag = dragState.value;
  if (drag?.active) {
    return {
      transform: `translateY(${drag.offset}px)`,
      transition: "none",
    };
  }
  // 非拖拽时让 anime 完全接管 transform，不设 transition
  return {};
});

// 标记拖拽结束导致的 detent 变化，避免 watch 重复触发归零动画
let suppressDetentWatch = false;

watch(currentDetent, () => {
  if (suppressDetentWatch) return;
  if (dragState.value?.active) return;
  if (!sheetEl.value) return;
  animate(sheetEl.value, { translateY: 0, ease: spring("sheet"), duration: 420 });
});

function contentAtTop(): boolean {
  const el = contentEl.value;
  if (!el) return true;
  return el.scrollTop <= 0;
}

function contentAtBottom(): boolean {
  const el = contentEl.value;
  if (!el) return true;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
}

function contentScrollable(): boolean {
  const el = contentEl.value;
  if (!el) return false;
  return el.scrollHeight > el.clientHeight + 1;
}

function onHandlePointerDown(e: PointerEvent) {
  startDrag(e);
}

function onHeaderPointerDown(e: PointerEvent) {
  if ((e.target as HTMLElement).closest("button")) return;
  startDrag(e);
}

function startDrag(e: PointerEvent) {
  if (isDesktop.value) return;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  dragState.value = {
    active: true,
    startY: e.clientY,
    startDetent: currentDetent.value,
    offset: 0,
  };
}

function onPointerMove(e: PointerEvent) {
  const ds = dragState.value;
  if (!ds?.active) return;
  const dy = e.clientY - ds.startY;
  if (dy < 0 && currentDetent.value === "large" && !hasLarge) {
    ds.offset = 0;
    return;
  }
  if (dy > 40 && currentDetent.value === "medium" && !hasMedium) {
    ds.offset = dy;
    return;
  }
  ds.offset = dy;
}

function onPointerUp(e: PointerEvent) {
  const ds = dragState.value;
  if (!ds?.active) return;
  const dy = e.clientY - ds.startY;
  const target = e.currentTarget as HTMLElement;
  target.releasePointerCapture?.(e.pointerId);
  const currentOffset = ds.offset;
  dragState.value = null;

  const threshold = 60;
  if (dy > threshold * 1.8) {
    emit("close");
    emit("update:visible", false);
    return;
  }

  // detent 切换由 onPointerUp 统一归零，抑制 watch 重复 animate
  suppressDetentWatch = true;
  if (dy < -threshold && ds.startDetent === "medium" && hasLarge.value) {
    currentDetent.value = "large";
  } else if (dy > threshold && ds.startDetent === "large" && hasMedium.value) {
    currentDetent.value = "medium";
  } else {
    currentDetent.value = ds.startDetent;
  }
  nextTick(() => {
    suppressDetentWatch = false;
  });

  // anime 接管归零：用 [currentOffset, 0] 显式 from，避免 Vue 移除 inline transform 后跳跃
  if (sheetEl.value) {
    animate(sheetEl.value, {
      translateY: [currentOffset, 0],
      ease: spring("sheet"),
      duration: 420,
    });
  }
}

function onContentWheel(e: WheelEvent) {
  if (isDesktop.value) return;
  const el = contentEl.value;
  if (!el) return;
  const atTop = contentAtTop();
  const atBottom = contentAtBottom();
  if (e.deltaY < 0 && atTop && currentDetent.value === "medium" && hasLarge.value) {
    e.preventDefault();
    currentDetent.value = "large";
  } else if (e.deltaY > 0 && atTop && currentDetent.value === "medium") {
    e.preventDefault();
    emit("close");
    emit("update:visible", false);
  } else if (e.deltaY > 0 && atBottom && currentDetent.value === "large") {
    // bounce, do nothing
  }
}

function onMaskClick() {
  emit("close");
  emit("update:visible", false);
}

function onBack() {
  emit("back");
}

function onClose() {
  emit("close");
  emit("update:visible", false);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="internalVisible"
      ref="maskEl"
      class="bs-mask"
      :class="{ 'bs-mask--desktop': isDesktop }"
      @click.self="onMaskClick"
    >
      <div
        ref="sheetEl"
        class="bs-sheet clean-card"
        :class="[
          `bs-sheet--${currentDetent}`,
          { 'bs-sheet--desktop': isDesktop },
        ]"
        :style="sheetStyle"
      >
        <div
          class="bs-handle-area"
          @pointerdown="onHandlePointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <div class="bs-handle" />
        </div>

        <div
          class="bs-header"
          @pointerdown="onHeaderPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <div class="bs-header-left">
            <button v-if="showBack" class="bs-icon-btn" @click="onBack" aria-label="返回">
              <i class="bi bi-chevron-left" style="font-size:18px"></i>
            </button>
            <h3 class="bs-title">{{ title }}</h3>
          </div>
          <button class="bs-icon-btn bs-close" @click="onClose" aria-label="关闭">
            <i class="bi bi-x-lg" style="font-size:16px"></i>
          </button>
        </div>

        <div
          ref="contentEl"
          class="bs-content"
          @wheel="onContentWheel"
        >
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.bs-mask {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.bs-sheet {
  width: 100%;
  max-width: 480px;
  background: var(--bg-50);
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  touch-action: none;
}

.bs-sheet--medium {
  height: 60vh;
  max-height: 60vh;
}

.bs-sheet--large {
  height: calc(100vh - 40px - env(safe-area-inset-top, 0px));
  max-height: calc(100vh - 40px - env(safe-area-inset-top, 0px));
}

.bs-handle-area {
  flex-shrink: 0;
  padding: var(--space-2) 0 var(--space-1);
  display: flex;
  justify-content: center;
  cursor: grab;
}

.bs-handle {
  width: 40px;
  height: 4px;
  background: var(--bg-300);
  border-radius: var(--radius-full);
}

.bs-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-4) var(--space-3);
  cursor: grab;
  user-select: none;
}

.bs-header-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.bs-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bs-icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: background 0.15s;
}

.bs-icon-btn:active {
  transform: scale(0.92);
  background: var(--bg-300);
}

.bs-close {
  margin-left: auto;
}

.bs-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: 0 var(--space-4) var(--space-5);
}

/* Desktop centered dialog mode */
.bs-mask--desktop {
  align-items: center;
}

.bs-sheet--desktop {
  width: 480px;
  max-width: 90vw;
  min-height: 320px;
  max-height: 90vh;
  height: 560px;
  border-radius: var(--radius-2xl);
}

.bs-sheet--desktop.bs-sheet--large {
  height: 90vh;
  max-height: 90vh;
}
</style>
