<script setup lang="ts">
/**
 * ToolboxPage — 百宝箱网格页
 *
 * - 3 列玻璃卡片网格，置顶项优先展示
 * - 长按拖拽换位（pointer-based，移动端友好）
 * - 点击跳转；右上角图钉切换置顶
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useToolboxStore } from "@/stores/toolboxStore";
import { useToast } from "@/composables/useToast";

const router = useRouter();
const store = useToolboxStore();
const toast = useToast();

const entries = computed(() => store.orderedEntries);

/** 拖拽状态（长按触发） */
const dragKey = ref<string | null>(null);
const dragFromIndex = ref(-1);
const dragOverIndex = ref(-1);
const liftY = ref(0);
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressStart = { x: 0, y: 0, key: "", idx: -1 };
const LONG_PRESS_MS = 280;
const MOVE_CANCEL_PX = 10;

function onPointerDown(e: PointerEvent, idx: number, key: string) {
  // 仅主键触发
  if (e.button !== undefined && e.button !== 0) return;
  pressStart = { x: e.clientX, y: e.clientY, key, idx };
  // 在 setTimeout 前捕获元素引用（事件派发结束后 currentTarget 会变为 null）
  const target = e.currentTarget as HTMLElement | null;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    dragKey.value = key;
    dragFromIndex.value = idx;
    dragOverIndex.value = idx;
    liftY.value = 0;
    // 长按触感：轻微震动反馈（移动端）
    if (navigator.vibrate) navigator.vibrate(10);
    // 捕获指针，确保 move/up 都能收到
    target?.setPointerCapture?.(e.pointerId);
  }, LONG_PRESS_MS);
}

function onPointerMove(e: PointerEvent) {
  if (pressTimer) {
    const dx = Math.abs(e.clientX - pressStart.x);
    const dy = Math.abs(e.clientY - pressStart.y);
    if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    return;
  }
  if (!dragKey.value) return;
  liftY.value = e.clientY - pressStart.y;
  // 找到指针下方的卡片索引
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  const card = el?.closest("[data-idx]") as HTMLElement | null;
  if (card) {
    const i = Number(card.dataset.idx);
    if (!Number.isNaN(i) && i !== dragOverIndex.value) {
      dragOverIndex.value = i;
    }
  }
}

function onPointerUp(e: PointerEvent, idx: number) {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
    // 未触发长按 = 点击 → 跳转
    navigate(idx);
    return;
  }
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  if (dragKey.value && dragFromIndex.value >= 0 && dragOverIndex.value >= 0) {
    if (dragFromIndex.value !== dragOverIndex.value) {
      store.moveItem(dragFromIndex.value, dragOverIndex.value);
    }
  }
  dragKey.value = null;
  dragFromIndex.value = -1;
  dragOverIndex.value = -1;
  liftY.value = 0;
}

function onPointerCancel() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  dragKey.value = null;
  dragFromIndex.value = -1;
  dragOverIndex.value = -1;
  liftY.value = 0;
}

function navigate(idx: number) {
  const entry = entries.value[idx];
  if (entry) router.push(entry.path).catch(() => {});
}

function togglePin(e: Event, key: string) {
  e.stopPropagation();
  store.togglePin(key);
}

function reset() {
  store.reset();
  toast.success("已恢复默认布局");
}

onMounted(() => {
  void store.load();
});
onBeforeUnmount(onPointerCancel);
</script>

<template>
  <div class="toolbox-page" @pointermove="onPointerMove" @pointerup="onPointerUp($event, -1)">
    <section class="intro">
      <div class="intro-text">
        <div class="intro-title">百宝箱</div>
        <div class="intro-sub">长按卡片可拖拽排序，点击图钉置顶</div>
      </div>
      <button class="reset-btn" @click="reset">
        <i class="bi bi-arrow-counterclockwise" style="font-size:16px"></i>
        重置
      </button>
    </section>

    <section class="grid">
      <button
        v-for="(entry, idx) in entries"
        :key="entry.key"
        class="tb-card clean-card clean-card--interactive"
        :class="{
          pinned: entry.pinned,
          'is-dragging': dragKey === entry.key,
          'is-drop-target': dragKey !== null && dragOverIndex === idx && dragKey !== entry.key,
        }"
        :data-idx="idx"
        @pointerdown="onPointerDown($event, idx, entry.key)"
        @pointerup="onPointerUp($event, idx)"
        @pointercancel="onPointerCancel"
      >
        <button
          class="pin-badge"
          :class="{ active: entry.pinned }"
          @pointerdown.stop
          @click="togglePin($event, entry.key)"
          :aria-label="entry.pinned ? '取消置顶' : '置顶'"
        >
          <i :class="['bi', entry.pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle']" style="font-size:14px"></i>
        </button>

        <div class="tb-glow" />

        <div class="tb-icon icon-circle" :class="`icon-circle--${entry.accent}`">
          <i :class="['bi', `bi-${entry.icon}`]" style="font-size:22px"></i>
        </div>
        <div class="tb-label">{{ entry.label }}</div>

        <div v-if="dragKey === entry.key" class="drag-hint" :style="{ transform: `translateY(${liftY}px)` }">
          <i class="bi bi-grip-vertical" style="font-size:14px"></i>
        </div>
      </button>
    </section>

    <!-- 拖拽占位说明 -->
    <div v-if="dragKey" class="drag-tip">
      <i class="bi bi-arrows-move" style="font-size:16px"></i>
      拖到目标位置释放
    </div>
  </div>
</template>

<style scoped>
.toolbox-page {
  padding: 0 0 var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  touch-action: pan-y;
}

.intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1);
}
.intro-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.intro-sub {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.reset-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  flex-shrink: 0;
}
.reset-btn:active {
  transform: scale(0.96);
  opacity: 0.8;
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}

.tb-card {
  position: relative;
  padding: var(--space-4) var(--space-2) var(--space-3);
  border: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 104px;
  overflow: hidden;
  text-align: center;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  touch-action: none;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive),
    opacity var(--dur-fast) var(--ease-immersive);
}

.tb-card.pinned {
  border: 1px solid var(--warm-200);
  background: linear-gradient(180deg, var(--warm-50, rgba(255, 200, 120, 0.12)) 0%, var(--card-bg) 60%);
}

.tb-card.is-dragging {
  opacity: 0.55;
  transform: scale(1.04);
  z-index: 10;
  box-shadow: var(--shadow-card-hover);
}
.tb-card.is-drop-target {
  box-shadow: 0 0 0 2px var(--color-warm);
}

.tb-glow {
  position: absolute;
  top: -30px;
  right: -30px;
  width: 90px;
  height: 90px;
  background: radial-gradient(circle, var(--glow-orange, rgba(255, 140, 58, 0.25)), transparent 70%);
  pointer-events: none;
  opacity: 0.6;
}

.pin-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2;
  padding: 0;
}
.pin-badge.active {
  color: var(--color-warm);
}

.tb-icon {
  position: relative;
  z-index: 1;
}

.tb-label {
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  line-height: 1.2;
  position: relative;
  z-index: 1;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.drag-hint {
  position: absolute;
  bottom: 4px;
  right: 6px;
  color: var(--color-warm);
  pointer-events: none;
}

.drag-tip {
  position: fixed;
  bottom: calc(var(--pill-bar-height) + env(safe-area-inset-bottom, 0px) + var(--space-5));
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--radius-full);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  z-index: 60;
  box-shadow: var(--shadow-card-hover);
  pointer-events: none;
}

@media (min-width: 768px) {
  .grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
</style>
