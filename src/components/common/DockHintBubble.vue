<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'

/**
 * 指向型气泡：贴着某个锚点元素弹出的一张小卡片，底部带一个小箭头指向它。
 *
 * 几何：`position: absolute` 落在**容器**（底栏 `.dock`）内 —— 于是它随 Dock 一起被
 * 收放、天然受 --frame-max 横向收口，不需要 Teleport；`bottom: calc(100% + 8px)` 让它
 * 悬在锚点上方，箭头朝下指着按钮。锚点横向位置由 JS 量出：气泡尽量让箭头正落在按钮中心
 * 上方，越出容器则整体钳回、箭头跟着内收（始终指得着）。
 *
 * 非模态：`role="dialog"` 但不遮罩、不抢焦点，两枚文字按钮自己可点可 Tab。
 */
const props = defineProps<{
  open: boolean
  /** 指向的目标元素（这里是底栏左钮） */
  anchor: HTMLElement | null
  /** 定位参照容器（底栏 `.dock`），气泡是它的绝对定位子元素 */
  container: HTMLElement | null
  title: string
  body: string
  /** 标题左侧的小图标（当前左钮模块的图标），对应参考设计的 icon + 标题行 */
  icon?: Component
}>()

const emit = defineEmits<{
  close: []
  dismiss: []
}>()

/** 箭头离气泡左缘的默认位置：气泡左缘 = 按钮中心往左收这么些，主体向右展开 */
const ARROW_INSET = 26
/** 箭头钳制在气泡内的最小边距（含箭头半径，避免贴死圆角） */
const ARROW_PAD = 18

const bubbleEl = ref<HTMLElement | null>(null)
const pos = ref<{ left: number; arrowX: number } | null>(null)

async function layout(): Promise<void> {
  await nextTick()
  const a = props.anchor
  const c = props.container
  const b = bubbleEl.value
  if (!a || !c || !b) return
  const ar = a.getBoundingClientRect()
  const cr = c.getBoundingClientRect()
  const bw = b.offsetWidth
  if (bw <= 0) return
  const buttonCx = ar.left - cr.left + ar.width / 2 // 按钮中心（相对容器）
  const left = Math.max(0, Math.min(buttonCx - ARROW_INSET, cr.width - bw))
  const arrowX = Math.max(ARROW_PAD, Math.min(buttonCx - left, bw - ARROW_PAD))
  pos.value = { left, arrowX }
}

const posStyle = computed<Record<string, string>>((): Record<string, string> => {
  if (!pos.value) return { visibility: 'hidden' } // 首帧未量到 → 先藏，避免 (0,0) 闪现
  return {
    left: `${Math.round(pos.value.left)}px`,
    '--arrow-x': `${Math.round(pos.value.arrowX)}px`,
  }
})

function onViewportChange(): void {
  if (props.open) void layout()
}

watch(
  () => props.open,
  (open) => {
    if (open) void layout()
    else pos.value = null
  },
)

onMounted(() => {
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('orientationchange', onViewportChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('orientationchange', onViewportChange)
})
</script>

<template>
  <Transition name="dock-hint">
    <div
      v-if="open"
      ref="bubbleEl"
      class="dock-hint"
      data-hint="dock-left"
      role="dialog"
      aria-modal="false"
      :aria-label="title"
      :style="posStyle"
    >
      <div class="dock-hint__head">
        <span v-if="icon" class="dock-hint__icon" aria-hidden="true">
          <component :is="icon" :size="15" />
        </span>
        <span class="dock-hint__title">{{ title }}</span>
      </div>
      <p class="dock-hint__body">{{ body }}</p>
      <div class="dock-hint__actions">
        <button type="button" class="dock-hint__btn pressable" @click="emit('close')">
          我知道了
        </button>
        <button type="button" class="dock-hint__btn pressable" @click="emit('dismiss')">
          不再提醒
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.dock-hint {
  position: absolute;
  bottom: calc(100% + 8px);
  z-index: 1;
  box-sizing: border-box;
  width: max-content;
  max-width: min(300px, calc(100vw - 32px));
  padding: 12px 14px;
  border-radius: var(--radius-l);
  border: 0.5px solid var(--line);
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-card);
}

/* 下指小箭头：旋转 45° 的方块，只留朝下的两条边描边，与气泡同底色拼成一只尾巴 */
.dock-hint::after {
  content: '';
  position: absolute;
  left: var(--arrow-x, 26px);
  bottom: -6px;
  width: 12px;
  height: 12px;
  background: var(--surface);
  border-right: 0.5px solid var(--line);
  border-bottom: 0.5px solid var(--line);
  border-bottom-right-radius: 2px;
  transform: translateX(-50%) rotate(45deg);
}

.dock-hint__head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.dock-hint__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--radius-xs);
  background: var(--surface-2);
  color: var(--text-2);
}

.dock-hint__title {
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-1);
}

.dock-hint__body {
  margin: 6px 0 0;
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-2);
}

.dock-hint__actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 10px;
}

.dock-hint__btn {
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--accent-strong);
  font-size: var(--fs-footnote);
  font-weight: 600;
  cursor: pointer;
}

/* 入场：淡入 + 轻微下沉；离场瞬时淡出。禁动档下只留透明度变化 */
.dock-hint-enter-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.dock-hint-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}

.dock-hint-enter-from {
  opacity: 0;
  transform: translateY(4px) scale(0.97);
}

.dock-hint-leave-to {
  opacity: 0;
}

html[data-motion='off'] .dock-hint-enter-from {
  transform: none;
}
</style>
