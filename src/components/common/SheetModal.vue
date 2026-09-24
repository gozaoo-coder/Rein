<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

/**
 * iOS 风格底部抽屉：毛玻璃遮罩 + 弹簧曲线滑入，进出同路径。
 * 术语约定：
 *  - 定位高度：抽屉吸附的档位高度（占屏幕高度的 20% / 40% / 90%）；
 *  - 组件高度：面板当前实际高度（拖动中瞬时变化，松手吸附回定位档位）；
 *  - 滚动高度：内容区可滚动的高度（scrollHeight - clientHeight）；
 *  - 下扔关闭：快速向下扔出（速度达标）或在最小档继续下拉越过关闭线，直接关闭抽屉。
 */
type SnapLevel = 'small' | 'medium' | 'large'

/** 定位高度档位（占屏幕高度的比例） */
const SNAP_RATIOS: Record<SnapLevel, number> = { small: 0.2, medium: 0.4, large: 0.9 }
const SNAP_ORDER: SnapLevel[] = ['small', 'medium', 'large']
/** 轻拂判定速度（px/ms）：超过则朝拂动方向跳一档；在最小档向下拂视为下扔关闭 */
const FLICK_V = 0.35
/** 快速下扔关闭速度（px/ms）：达到即视为把抽屉「扔出去」，任意档位直接关闭 */
const DISMISS_V = 0.5
/** 越过最小档后的橡皮筋阻尼系数：跟随手指的位移比例（越小越紧） */
const RUBBER = 0.4
/** 越过最小档继续下拉、阻尼后面板高度低于最小档此距离（px）时松手即关闭 */
const DISMISS_PULL = 36

/** 打开中的抽屉栈：Esc 只关最上层，嵌套弹层（智能添加 → 编辑器）逐层退出 */
const sheetStack: ((e: KeyboardEvent) => void)[] = []

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    /** 打开时应用的初始定位高度档位 */
    initialSnap?: SnapLevel
  }>(),
  { initialSnap: 'medium' },
)

const emit = defineEmits<{ close: [] }>()

/* ---------- 定位高度与组件高度 ---------- */
const viewportH = ref(window.innerHeight)
const snap = ref<SnapLevel>('medium')
/** 拖动中的组件高度；null = 静止，吸附在定位档位上 */
const dragHeight = ref<number | null>(null)
const dragging = ref(false)
/** 下扔关闭进行中：面板保持松手高度播离场动画，结束后才清 dragHeight */
let dismissing = false
/** 拖动末段垂直速度（px/ms，正=向下拖）：松手时用于轻拂跳档 */
let velY = 0
let lastY = 0
let lastT = 0

function trackVelocity(y: number): void {
  const t = performance.now()
  if (t > lastT) velY = (y - lastY) / (t - lastT)
  lastY = y
  lastT = t
}

const minH = computed(() => Math.round(SNAP_RATIOS.small * viewportH.value))
const maxH = computed(() => Math.round(SNAP_RATIOS.large * viewportH.value))
const snapHeight = computed(() => Math.round(SNAP_RATIOS[snap.value] * viewportH.value))
const panelHeight = computed(() => dragHeight.value ?? snapHeight.value)
const snapPct = computed(() => Math.round(SNAP_RATIOS[snap.value] * 100))

/** 拖动中的组件高度：越过最小档后施加橡皮筋阻尼，可继续下拉进入关闭区 */
function dampedH(h: number): number {
  if (h >= minH.value) return Math.min(maxH.value, h)
  return Math.max(minH.value * 0.4, minH.value - (minH.value - h) * RUBBER)
}

/** 离目标组件高度最近的定位档位 */
function nearestLevel(h: number): SnapLevel {
  let best: SnapLevel = SNAP_ORDER[0]
  let bestDist = Infinity
  for (const lv of SNAP_ORDER) {
    const dist = Math.abs(SNAP_RATIOS[lv] * viewportH.value - h)
    if (dist < bestDist) {
      bestDist = dist
      best = lv
    }
  }
  return best
}

/** 松手瞬间速度：距上次 move 超 100ms 视为已停手，陈旧速度归零防误关 */
function releaseVelocity(): number {
  return performance.now() - lastT <= 100 ? velY : 0
}

/** 下扔关闭：面板保持松手高度直接播离场下滑，dragHeight 延后到离场动画结束再清 */
function dismiss(): void {
  dismissing = true
  dragging.value = false
  velY = 0
  emit('close')
}

/** 松手吸附：快速下扔/拉过关闭线 → 直接关闭；轻拂朝拂动方向跳档；否则吸最近档 */
function settle(h: number): void {
  const v = releaseVelocity()
  const best = nearestLevel(h)
  const thrownOut =
    v > DISMISS_V || // 任意档位快速下扔
    (v > FLICK_V && best === 'small') || // 已在最小档还向下拂
    (h < minH.value - DISMISS_PULL && Math.abs(v) <= FLICK_V) // 拉过橡皮筋关闭线后松手
  if (thrownOut) {
    dismiss()
    return
  }
  if (Math.abs(v) > FLICK_V) {
    const dir = v < 0 ? 1 : -1 // 上拂（velY<0）= 扩张
    snap.value = SNAP_ORDER[Math.min(SNAP_ORDER.length - 1, Math.max(0, SNAP_ORDER.indexOf(best) + dir))]!
  } else {
    snap.value = best
  }
  velY = 0
}

function onViewportResize(): void {
  viewportH.value = window.innerHeight
}
window.addEventListener('resize', onViewportResize)

/** Esc 关闭：仅响应栈顶抽屉，嵌套弹层逐层退出 */
function onEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (sheetStack[sheetStack.length - 1] !== onEsc) return
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      // 栈深 0→1 才锁背景滚动；嵌套打开/关闭不互相干扰
      if (sheetStack.length === 0) document.documentElement.style.overflow = 'hidden'
      sheetStack.push(onEsc)
      snap.value = props.initialSnap // 每次打开回到初始定位档位
      dragHeight.value = null
      dismissing = false
    } else {
      const i = sheetStack.indexOf(onEsc)
      if (i >= 0) sheetStack.splice(i, 1)
      if (sheetStack.length === 0) document.documentElement.style.overflow = ''
      teardownGesture()
    }
  },
)

/* ---------- 拖动条：自由拖动 → 松手吸附最近档位 ---------- */
const handleEl = ref<HTMLElement>()
let handleStartY = 0
let handleStartH = 0

function onHandleDown(e: PointerEvent): void {
  dragging.value = true
  handleStartY = e.clientY
  handleStartH = snapHeight.value
  dragHeight.value = handleStartH
  velY = 0
  lastY = e.clientY
  lastT = performance.now()
  try {
    handleEl.value?.setPointerCapture(e.pointerId)
  } catch {
    /* 指针可能已失效（极端时序/合成事件），拖拽仍沿元素事件继续 */
  }
}

function onHandleMove(e: PointerEvent): void {
  if (!dragging.value || dragHeight.value === null) return
  trackVelocity(e.clientY)
  dragHeight.value = dampedH(handleStartH + (handleStartY - e.clientY))
}

function onHandleUp(): void {
  if (!dragging.value) return
  settle(dragHeight.value ?? snapHeight.value)
  if (!dismissing) {
    dragging.value = false
    dragHeight.value = null
  }
}

function onHandleKey(e: KeyboardEvent): void {
  const i = SNAP_ORDER.indexOf(snap.value)
  if (e.key === 'ArrowUp' && i < SNAP_ORDER.length - 1) snap.value = SNAP_ORDER[i + 1]
  else if (e.key === 'ArrowDown' && i > 0) snap.value = SNAP_ORDER[i - 1]
  else return
  e.preventDefault()
}

/* ---------- 内容区滚动顺序：先调定位高度，后滚动 ----------
   上拖：未到最大档且内容溢出 → 跟随手指扩高，到顶后剩余位移转为内容滚动；
   下拖：内容已在顶部 → 先缩高；否则交还原生滚动。
   触摸手势在首个 move 决策并 preventDefault 锁定接管；判定为原生滚动的
   手势立即移除监听，保证合成器滚动与动量不受影响。 */
const bodyEl = ref<HTMLElement>()
type GestureMode = 'undecided' | 'resize' | 'native'
let gestureActive = false
let mode: GestureMode = 'undecided'
let handoff = false // 扩高到顶后已转入内容滚动
let startX = 0
let startY = 0
let startH = 0
let startScrollTop = 0

function contentOverflow(): boolean {
  const el = bodyEl.value
  return !!el && el.scrollHeight > el.clientHeight + 1
}

function beginGesture(x: number, y: number): void {
  gestureActive = true
  mode = 'undecided'
  handoff = false
  startX = x
  startY = y
  startH = panelHeight.value
  startScrollTop = bodyEl.value?.scrollTop ?? 0
  velY = 0
  lastY = y
  lastT = performance.now()
}

/** 由位移方向决策本手势归属：调整定位高度 or 原生滚动 */
function decideMode(dx: number, dy: number): GestureMode {
  if (mode !== 'undecided') return mode
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 2) return 'undecided'
  if (Math.abs(dx) > Math.abs(dy)) {
    mode = 'native' // 横向手势不干预
  } else if (dy < 0) {
    mode = startH < maxH.value && contentOverflow() ? 'resize' : 'native'
  } else {
    // 已在最小档也接管：继续下拉进入橡皮筋关闭区（松手判定见 settle）
    mode = startScrollTop <= 0 ? 'resize' : 'native'
  }
  if (mode === 'resize') dragging.value = true
  return mode
}

/** resize 模式：跟随手指调整组件高度；扩到最大档后把剩余位移转成内容滚动 */
function applyResize(dy: number): void {
  const el = bodyEl.value
  if (!el) return
  const rawH = startH - dy
  if (!handoff && dy < 0 && rawH >= maxH.value) handoff = true
  if (handoff) {
    dragHeight.value = maxH.value
    // 只有超出最大档的剩余位移才计入滚动，避免转滚动瞬间内容跳变
    const overscroll = startH - dy - maxH.value
    const maxScroll = el.scrollHeight - el.clientHeight
    el.scrollTop = Math.min(maxScroll, Math.max(startScrollTop + overscroll, 0))
  } else {
    dragHeight.value = dampedH(rawH)
  }
}

function endGesture(): void {
  if (!gestureActive) return
  gestureActive = false
  if (mode === 'resize') settle(dragHeight.value ?? snapHeight.value)
  if (!dismissing) {
    dragging.value = false
    dragHeight.value = null
  }
  mode = 'undecided'
  handoff = false
}

function onTouchStart(e: TouchEvent): void {
  if (!props.open || gestureActive || e.touches.length !== 1) return
  beginGesture(e.touches[0].clientX, e.touches[0].clientY)
  window.addEventListener('touchmove', onTouchMove, { passive: false })
  window.addEventListener('touchend', onTouchEnd)
  window.addEventListener('touchcancel', onTouchEnd)
}

function onTouchMove(e: TouchEvent): void {
  const t = e.touches[0]
  if (!t || !gestureActive) return
  const dx = t.clientX - startX
  const dy = t.clientY - startY
  if (decideMode(dx, dy) !== 'resize') {
    // 原生滚动：摘掉监听，滚动完全交还浏览器（保住动量）
    window.removeEventListener('touchmove', onTouchMove)
    return
  }
  trackVelocity(t.clientY)
  applyResize(dy)
  e.preventDefault()
}

function onTouchEnd(): void {
  window.removeEventListener('touchmove', onTouchMove)
  window.removeEventListener('touchend', onTouchEnd)
  window.removeEventListener('touchcancel', onTouchEnd)
  endGesture()
}

function onBodyPointerDown(e: PointerEvent): void {
  if (e.pointerType !== 'mouse' || !props.open || gestureActive) return
  beginGesture(e.clientX, e.clientY)
  // 注意：这里不能 setPointerCapture —— 一旦捕获，拖拽期间的 pointerup/click 会被
  // 重定向到 .body，正文里的按钮（智能添加的生成/清空等）将永远收不到 click。
  // 捕获延迟到「判定为扩高/缩高手势」那一刻（onBodyPointerMove 里）。
}

function onBodyPointerMove(e: PointerEvent): void {
  if (!gestureActive) return
  const dy = e.clientY - startY
  if (decideMode(e.clientX - startX, dy) === 'resize') {
    try {
      bodyEl.value?.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已释放等竞态可忽略 */
    }
    trackVelocity(e.clientY)
    applyResize(dy)
  }
}

function teardownGesture(): void {
  window.removeEventListener('touchmove', onTouchMove)
  window.removeEventListener('touchend', onTouchEnd)
  window.removeEventListener('touchcancel', onTouchEnd)
  gestureActive = false
  dragging.value = false
  // 不清 dragHeight：下扔关闭时要保持松手高度播离场动画，统一由 onAfterLeave 复位
  mode = 'undecided'
  handoff = false
}

/** 离场动画结束：此刻清拖动高度已不可见，一并复位下扔关闭标记 */
function onAfterLeave(): void {
  dismissing = false
  dragHeight.value = null
}

/** 内容滚动容器：外部（如全课抽屉）需要它做「滚到当前项」定位 */
defineExpose({ bodyEl })

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
  const i = sheetStack.indexOf(onEsc)
  if (i >= 0) sheetStack.splice(i, 1)
  if (sheetStack.length === 0) document.documentElement.style.overflow = ''
  teardownGesture()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="backdrop">
      <div v-if="open" class="backdrop" aria-hidden="true" @click="emit('close')" />
    </Transition>
    <Transition name="sheet" @after-leave="onAfterLeave">
      <section
        v-if="open"
        class="panel"
        :class="{ 'is-dragging': dragging }"
        :style="{ height: `${panelHeight}px` }"
        role="dialog"
        :aria-label="title"
      >
        <!-- 拖动条：整条热区可拖拽/键盘调档 -->
        <div
          ref="handleEl"
          class="grabber-zone"
          role="slider"
          tabindex="0"
          aria-label="抽屉高度"
          aria-orientation="vertical"
          :aria-valuemin="20"
          :aria-valuemax="90"
          :aria-valuenow="snapPct"
          @pointerdown="onHandleDown"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
          @keydown="onHandleKey"
        >
          <div class="grabber" />
        </div>
        <header class="head">
          <h2>{{ title }}</h2>
          <div class="actions row center">
            <slot name="action" />
            <button class="close" aria-label="关闭" @click="emit('close')">
              <X :size="15" :stroke-width="2.5" />
            </button>
          </div>
        </header>
        <div
          ref="bodyEl"
          class="body"
          @touchstart="onTouchStart"
          @pointerdown="onBodyPointerDown"
          @pointermove="onBodyPointerMove"
          @pointerup="endGesture"
          @pointercancel="endGesture"
        >
          <!-- 超范围平移层：到边拖动时内容整体位移（system/rubberScroll 只写 transform，不改布局） -->
          <div class="rubber-layer" data-rubber-content>
            <slot />
          </div>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: var(--scrim);
}

.panel {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--frame-max);
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: var(--shadow-float);
  /* 松手吸附 / 窗口尺寸变化时，组件高度平滑回到定位档位 */
  transition: height 320ms var(--ease-sheet);
}

.panel.is-dragging {
  transition: none;
  user-select: none;
}

.grabber-zone {
  position: relative;
  flex: none;
  display: flex;
  justify-content: center;
  padding: 9px 0 5px;
  cursor: grab;
  touch-action: none;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
}

/* 视觉不变，伪元素把触控热区向上下各扩 10px */
.grabber-zone::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -10px;
  bottom: -10px;
}

.grabber-zone:active {
  cursor: grabbing;
}

.grabber-zone:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.grabber {
  width: 36px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--line-strong);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 18px 6px;
  flex: none;
}

.head .actions {
  gap: 8px;
  flex: none;
}

.head h2 {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-headline);
  font-weight: 700;
}

.close {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 垂直手势交给组件决策（先调高度后滚动），横向不拦截 */
  touch-action: pan-y;
  overscroll-behavior: contain;
  padding: 4px 18px calc(20px + var(--safe-bottom));
}

/* 进出同路径：都走底部 */
.backdrop-enter-active,
.backdrop-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.backdrop-enter-from,
.backdrop-leave-to {
  opacity: 0;
}

.sheet-enter-active {
  transition: transform var(--dur-sheet) var(--ease-sheet);
}

/* 双类压过 .panel.is-dragging 的 transition:none：下扔关闭发生在拖拽中，
   元素带着 is-dragging 进入离场（v-if 切走后 class 不再 diff），若被清零
   Vue 会判定 0 时长并跳过滑出动画 */
.panel.sheet-leave-active {
  transition: transform 280ms var(--ease-sheet);
}
.sheet-enter-from,
.sheet-leave-to {
  transform: translate(-50%, 105%);
}
</style>
