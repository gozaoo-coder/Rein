<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

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

const isDesktop = ref(false);
let resizeObserver: ResizeObserver | null = null;

function updateViewport() {
  isDesktop.value = window.innerWidth >= 600;
}

onMounted(() => {
  updateViewport();
  resizeObserver = new ResizeObserver(updateViewport);
  resizeObserver.observe(document.documentElement);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});

watch(
  () => props.visible,
  (v) => {
    if (v) {
      currentDetent.value = props.defaultDetent;
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
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
  const offset = drag?.offset ?? 0;
  return {
    transform: `translateY(${offset}px)`,
    transition: drag?.active ? "none" : "transform 0.35s var(--ease-out)",
  };
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
  dragState.value = null;

  const threshold = 60;
  if (dy > threshold * 1.8) {
    emit("close");
    emit("update:visible", false);
    return;
  }

  if (dy < -threshold && ds.startDetent === "medium" && hasLarge.value) {
    currentDetent.value = "large";
    return;
  }
  if (dy > threshold && ds.startDetent === "large" && hasMedium.value) {
    currentDetent.value = "medium";
    return;
  }
  currentDetent.value = ds.startDetent;
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
      v-if="visible"
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
  animation: bs-fade 0.25s ease-out;
}

@keyframes bs-fade {
  from { opacity: 0; }
  to { opacity: 1; }
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
  animation: bs-slide-up 0.3s var(--ease-out);
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

@keyframes bs-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
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
  animation: bs-pop 0.25s var(--ease-out);
}

@keyframes bs-pop {
  from {
    transform: scale(0.92);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.bs-sheet--desktop.bs-sheet--large {
  height: 90vh;
  max-height: 90vh;
}
</style>
