<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronRight, Layers, Pencil } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { CATEGORY_META } from '@/config/domain'
import { minToHHmm, nowMin, todayStr } from '@/utils/date'
import { durationOf as durOfShared, layoutDayBlocks } from '@/utils/timelineLayout'
import type { Todo } from '@/types'

/**
 * 单日画布时间轴：0-24 时连续刻度，块按 date+startMin+durationMin 定位。
 * - 左侧 48px 刻度栏，块区从 56px 起，不遮挡时间轴；时间跨度块上方标起点、下方标终点；
 * - 重叠块贪心分列：≤2 列并排；≥3 列收成「叠层卡」（全宽卡面 + 底层错位条 + 计数徽标，
 *   点开底部清单逐条勾选/定位），避免窄列把标题挤成省略号；
 * - 卡面控件按角分配：右下角「编辑」钮（所有块与叠层卡）emit edit 交父级开抽屉，
 *   叠层卡右上角「展开 +N」钮开同时段清单；两钮 pointerdown 即 stop，绝不进拖拽管线；
 * - 块内标题顶对齐、按块宽折行、按块高截行（行数上限 --blk-lines 由块高折算），
 *   放不下才在行末省略，不单行居中也不出现半行裁切；
 * - 点按选中、长按 320ms 武装后才可拖拽改位（防误触，武装后每 5 分钟吸附）；
 * - 拿起/放下走弹性过渡（右移让位/放大/浮影），跟手的 top 位移不过渡、不延迟；
 * - 外部拖入（未安排池）经 dropMin 显示落点线，落库由父级完成；
 * - Ctrl+滚轮缩放；过去未完成块降透明；现在线只锚定今天。
 */
const props = withDefaults(
  defineProps<{
    date: string
    /** 该日已排程的待办（date+startMin 均有值，由父级过滤） */
    todos: Todo[]
    /** AI 排程预览（未落库的幽灵块） */
    ghosts?: { todo: Todo; startMin: number }[]
    /** 外部拖入时的落点指示（距 00:00 分钟数），null = 无 */
    dropMin?: number | null
    selectedId?: number | null
    compact?: boolean
  }>(),
  { ghosts: () => [], dropMin: null, selectedId: null, compact: false },
)

const emit = defineEmits<{
  select: [todo: Todo]
  toggle: [todo: Todo]
  move: [todo: Todo, startMin: number]
  edit: [todo: Todo]
}>()

const DEFAULT_PX = 56
const MIN_PX = 18
const MAX_PX = 104

/** .tt 行高与卡片纵向内边距（px）：按块高折算可完整显示的行数，须与样式保持一致 */
const TT_LINE_H = 17
const TT_LINE_H_COMPACT = 16
const CARD_PAD_Y = 8

const px = ref(props.compact ? 30 : DEFAULT_PX)
const scroller = ref<HTMLElement | null>(null)

const totalPx = computed(() => 24 * px.value)
const pxPerMin = computed(() => px.value / 60)

const hours = computed(() => {
  const step = px.value >= 42 ? 1 : 2
  const out: { min: number; label: string }[] = []
  for (let h = 0; h <= 24; h += step) out.push({ min: h * 60, label: `${String(h).padStart(2, '0')}:00` })
  return out
})

const isToday = computed(() => props.date === todayStr())
/** 现在分钟数：30s 轮询刷新，长驻页面时红线不走位 */
const nowMin_ = ref(nowMin())
let nowTimer: number | null = null
const nowTop = computed(() => nowMin_.value * pxPerMin.value)

/** 「现在」标签与整点刻度碰撞时隐藏该刻度，避免红线盖在背景时间上 */
function labelMasked(min: number): boolean {
  return isToday.value && Math.abs(min * pxPerMin.value - nowTop.value) < 16
}

/* ---------- 布局：重叠贪心分列；≥3 列收成叠层卡 ---------- */

const durOf = durOfShared

interface Laid {
  t: Todo
  top: number
  h: number
  col: number
  cols: number
}

/** ≥3 条同时段的叠层簇：卡面展示 front，其余收进底部清单 */
interface Stack {
  key: string
  items: Todo[]
  top: number
  front: Todo
  /** 除卡面外的条数（徽标 +N） */
  extra: number
  /** 底层错位条的颜色（按后续条目的分类色，最多 2 条） */
  under: string[]
  h: number
}

const minBlkH = computed(() => (props.compact ? 17 : 22))

/**
 * 叠层卡最小高度：卡面要同时容下右上「展开」与右下「编辑」两枚控件，
 * 即 纵向内边距 ×2 + 展开钮 + 间隙 + 编辑钮（普通块只有右下编辑钮，现有最小高度已够）。
 * 数值须与样式里 .stk-card 内边距 / .stk-more 高度 / .edit 尺寸保持一致。
 */
const minStackH = computed(() => (props.compact ? 35 : 42))

/** 用户在清单里点选某条 → 置顶为卡面（会话内状态，跨日/重载自然失效） */
const frontByStack = ref(new Map<string, number>())

const stackKey = (items: Todo[]): string => `${items[0]!.id}-${items.length}`

const layout = computed(() => layoutDayBlocks(props.todos))

const laid = computed(() =>
  layout.value.blocks.map((b) => ({
    t: b.todo,
    top: b.startMin * pxPerMin.value,
    h: Math.max(minBlkH.value, b.durationMin * pxPerMin.value),
    col: b.col,
    cols: b.cols,
  })),
)

const stacks = computed(() =>
  layout.value.stacks.map((s) => {
    const sorted = [...s.items].sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0) || a.id - b.id)
    return {
      key: `${sorted[0]!.id}-${sorted.length}`,
      items: sorted,
      top: sorted[0]!.startMin! * pxPerMin.value,
      front: frontOf(sorted),
      extra: sorted.length - 1,
      under: sorted
        .filter((t) => t.id !== sorted[0]!.id)
        .slice(0, 2)
        .map((t) => CATEGORY_META[t.category].colorVar),
      h: Math.max(minStackH.value, durOf(sorted[0]!) * pxPerMin.value),
    }
  }),
)

/** 叠层簇的卡面项：用户点选置顶的优先（未完成），否则最早未完成，兜底最早 */
function frontOf(items: Todo[]): Todo {
  const pinnedId = frontByStack.value.get(stackKey(items))
  const pinned = pinnedId != null ? items.find((t) => t.id === pinnedId) : undefined
  if (pinned && pinned.status !== 'done') return pinned
  return items.find((t) => t.status !== 'done') ?? items[0]!
}

const ghostLaid = computed(() =>
  props.ghosts.map((g) => ({
    todo: g.todo,
    startMin: g.startMin,
    top: g.startMin * pxPerMin.value,
    h: Math.max(props.compact ? 17 : 22, durOf(g.todo) * pxPerMin.value),
  })),
)

/** 块高 → 可完整显示的标题行数（至少 1 行；再放不下由 line-clamp 在行末省略） */
function linesFor(h: number): number {
  return Math.max(1, Math.floor((h - CARD_PAD_Y) / (props.compact ? TT_LINE_H_COMPACT : TT_LINE_H)))
}

/** 块定位（外层只管坐标与手势，卡片视觉在 .blk-card）：fit-content 收窄，列宽作上限；拖拽中实时跟手 */
function blkStyle(b: Laid): Record<string, string> {
  const dragging = drag.value?.armed && drag.value.todo.id === b.t.id
  const top = dragging ? drag.value!.curMin * pxPerMin.value : b.top
  return {
    top: `${top}px`,
    height: `${b.h}px`,
    left: `${(b.col / b.cols) * 100}%`,
    maxWidth: `calc(${100 / b.cols}% - 4px)`,
    '--blk-cat': `var(${CATEGORY_META[b.t.category].colorVar})`,
    '--blk-lines': `${linesFor(b.h)}`,
  }
}

/* ---------- 滚动 / 缩放 ---------- */

function zoom(factor: number): void {
  px.value = Math.min(Math.max(px.value * factor, MIN_PX), MAX_PX)
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  zoom(e.deltaY > 0 ? 1 / 1.15 : 1.15)
}

/** 锚定：今天看"现在"附近，其它日子看第一个安排或 8 点 */
function scrollToAnchor(): void {
  const el = scroller.value
  if (!el) return
  const first = props.todos.reduce<number | null>(
    (acc, t) => (acc == null || t.startMin! < acc ? t.startMin! : acc),
    null,
  )
  const target = isToday.value ? nowMin() - 75 : (first ?? 8 * 60) - 60
  nextTick(() => {
    el.scrollTop = Math.max(0, Math.min(target * pxPerMin.value, totalPx.value - el.clientHeight))
  })
}

defineExpose({ scrollToAnchor, getPxPerMin: () => pxPerMin.value })

/* ---------- 块拖拽改位：长按武装后才可拖（防点按/滚动误触） ---------- */

/*
 * 块上手势优先级（高 → 低）：
 * 1. 控件：勾选钮 / 叠层展开钮，pointerdown 即 stop，绝不进入拖拽管线；
 * 2. 原生滚动：未武装阶段的位移归滚动，pointercancel（浏览器接管）只清理、绝不当点按；
 * 3. 拖拽：长按 320ms 武装后才可拖，期间 preventDefault 屏蔽滚动；
 * 4. 点按：仅 pointerup 正常结束、未武装、未超抖动距离（aborted）时选中。
 */
interface DragState {
  todo: Todo
  grabMin: number
  curMin: number
  /** 长按已武装：之后指针移动才改位 */
  armed: boolean
  /** 武装后指针实际移动过（松手判定 move） */
  moved: boolean
  /** 未武装时已超抖动距离（滚动/滑走）：作废，松手不再选中 */
  aborted: boolean
}

const LONGPRESS_MS = 320
const ARM_CANCEL_PX = 10

const drag = ref<DragState | null>(null)
let pressTimer: number | null = null
let downX = 0
let downY = 0

function clearPress(): void {
  if (pressTimer != null) {
    window.clearTimeout(pressTimer)
    pressTimer = null
  }
}

/** 收尾：清定时器与触摸拦截，返回本次手势状态（无则 null） */
function releaseDrag(): DragState | null {
  const d = drag.value
  clearPress()
  drag.value = null
  window.removeEventListener('touchmove', onTouchMove)
  return d
}

/** 武装后阻止浏览器把触摸手势判成滚动（否则 pointercancel 会掐断拖拽） */
function onTouchMove(e: TouchEvent): void {
  if (drag.value?.armed) e.preventDefault()
}

function onBlockDown(e: PointerEvent, t: Todo): void {
  if (t.status === 'done' || e.button !== 0) return
  const el = scroller.value
  if (!el) return
  // 课表派生行（courseSessionId 非空）是只读投影：标题/时间/地点都由课表同步生成，
  // 只能回课表配置页改。这里只关掉「长按武装」这一步 —— 点选与抛滚手势全部照旧，
  // 长按则什么都不发生，比整体禁用更不容易误触。
  const readonly = t.courseSessionId != null
  const rect = el.getBoundingClientRect()
  const pointerMin = (e.clientY - rect.top + el.scrollTop) / pxPerMin.value
  drag.value = { todo: t, grabMin: pointerMin - t.startMin!, curMin: t.startMin!, armed: false, moved: false, aborted: false }
  downX = e.clientX
  downY = e.clientY
  // 合成指针 / 指针已失效等边缘会抛 NotFoundError：吞掉即可，只影响出界跟踪
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 无有效指针：拖拽沿元素事件继续 */
  }
  clearPress()
  pressTimer = window.setTimeout(() => {
    pressTimer = null
    if (!drag.value || readonly) return
    drag.value.armed = true
    try { navigator.vibrate?.(8) } catch { /* 设备不支持则无感 */ }
  }, LONGPRESS_MS)
  window.addEventListener('touchmove', onTouchMove, { passive: false })
}

function onBlockMove(e: PointerEvent): void {
  const d = drag.value
  const el = scroller.value
  if (!d || !el) return
  if (!d.armed) {
    // 未武装的移动是普通手势（滚动/滑走）：超抖动距离即放弃长按并作废点按
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > ARM_CANCEL_PX) {
      clearPress()
      d.aborted = true
    }
    return
  }
  d.moved = true
  const rect = el.getBoundingClientRect()
  const pointerMin = (e.clientY - rect.top + el.scrollTop) / pxPerMin.value
  const dur = durOf(d.todo)
  d.curMin = Math.round(Math.max(0, Math.min(pointerMin - d.grabMin, 1440 - dur)) / 5) * 5
}

function onBlockUp(): void {
  const d = releaseDrag()
  if (!d) return
  if (d.moved) emit('move', d.todo, d.curMin)
  else if (!d.armed && !d.aborted) emit('select', d.todo)
  // 武装后原地松手 / 已作废手势：无动作，避免误开详情
}

/** pointercancel（浏览器接管滚动、多指等）：只清理，绝不当点按 */
function onBlockCancel(): void {
  releaseDrag()
}

/** 拖拽中的实时起点（其余情况返回落库值） */
const liveStart = (t: Todo, fallback: number) =>
  drag.value?.armed && drag.value.todo.id === t.id ? drag.value.curMin : fallback

/* ---------- 叠层簇：卡面拖拽/勾选复用块逻辑，点按开底部清单 ---------- */

/** 叠层卡定位：拖拽中跟手（卡面项的当前分钟） */
function stkStyle(s: Stack): Record<string, string> {
  const dragging = drag.value?.armed && drag.value.todo.id === s.front.id
  return {
    top: `${dragging ? drag.value!.curMin * pxPerMin.value : s.top}px`,
    height: `${s.h}px`,
    '--blk-cat': `var(${CATEGORY_META[s.front.category].colorVar})`,
    '--blk-lines': `${linesFor(s.h)}`,
  }
}

const activeStackKey = ref<string | null>(null)
const stackOpen = ref(false)
const activeStack = computed(() => stacks.value.find((s) => s.key === activeStackKey.value) ?? null)

function openStack(s: Stack): void {
  activeStackKey.value = s.key
  stackOpen.value = true
}

/** 清单点选：置顶为卡面并冒泡选中（详情抽屉由父级打开） */
function pickStackItem(t: Todo): void {
  if (activeStack.value) frontByStack.value.set(activeStack.value.key, t.id)
  stackOpen.value = false
  emit('select', t)
}

function onStackUp(s: Stack): void {
  const d = releaseDrag()
  if (d?.moved) emit('move', d.todo, d.curMin)
  else if (d && !d.armed && !d.aborted) openStack(s)
}

onMounted(() => {
  scrollToAnchor()
  nowTimer = window.setInterval(() => {
    nowMin_.value = nowMin()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (nowTimer != null) window.clearInterval(nowTimer)
  clearPress()
  drag.value = null
  window.removeEventListener('touchmove', onTouchMove)
})
</script>

<template>
  <div class="ctl" :class="{ compact }" @wheel="onWheel">
    <div ref="scroller" class="scroll" data-testid="canvas-scroll">
      <div class="inner" :style="{ height: `${totalPx}px` }">
        <template v-for="h in hours" :key="h.min">
          <span v-show="!labelMasked(h.min)" class="hlab num" :style="{ top: `${h.min * pxPerMin}px` }">{{ h.label }}</span>
          <i class="hline" :style="{ top: `${h.min * pxPerMin}px` }" />
        </template>

        <!-- 现在线（仅今天） -->
        <div v-if="isToday" class="nowline" :style="{ top: `${nowTop}px` }">
          <span class="nowtag num">现在</span>
        </div>

        <!-- 外部拖入落点指示：位移走 transform（top 恒 0），短过渡平滑 5min 吸附台阶 -->
        <div v-if="dropMin != null" class="dropline" :style="{ transform: `translateY(${dropMin * pxPerMin}px)` }" />

        <!-- 待办块区：整体右移让出左侧刻度栏，块上标起点、下标终点 -->
        <div class="blocks">
          <div
            v-for="b in laid"
            :key="b.t.id"
            class="blk"
            :class="{
              done: b.t.status === 'done',
              sel: selectedId === b.t.id,
              past: isToday && b.t.startMin! + durOf(b.t) < nowMin_ && b.t.status !== 'done',
              dragging: drag?.armed && drag.todo.id === b.t.id,
            }"
            :style="blkStyle(b)"
            :data-title="b.t.title"
            @pointerdown="onBlockDown($event, b.t)"
            @pointermove="onBlockMove"
            @pointerup="onBlockUp"
            @pointercancel="onBlockCancel"
            @contextmenu.prevent
          >
            <span class="bmin bmin-start num" :class="{ live: drag?.armed && drag.todo.id === b.t.id }">{{ minToHHmm(liveStart(b.t, b.t.startMin!)) }}</span>
            <div class="blk-card">
              <button
                class="ck"
                :aria-label="b.t.status === 'done' ? '标记未完成' : '标记完成'"
                @pointerdown.stop
                @click.stop="emit('toggle', b.t)"
              />
              <div class="body">
                <span class="tt">{{ b.t.title }}</span>
              </div>
              <button
                class="edit"
                :aria-label="`编辑 ${b.t.title}`"
                @pointerdown.stop
                @click.stop="emit('edit', b.t)"
              >
                <Pencil :size="9" :stroke-width="2.6" />
              </button>
            </div>
            <span class="bmin bmin-end num" :class="{ live: drag?.armed && drag.todo.id === b.t.id }">{{ minToHHmm(liveStart(b.t, b.t.startMin!) + durOf(b.t)) }}</span>
          </div>

          <!-- 叠层簇：≥3 条同时段，卡面展示 front，点开清单处理其余 -->
          <div
            v-for="s in stacks"
            :key="`s-${s.key}`"
            class="stk"
            :class="{ dragging: drag?.armed && drag.todo.id === s.front.id }"
            :style="stkStyle(s)"
            :data-title="`${s.items.length} 项同时段日程`"
            @pointerdown="onBlockDown($event, s.front)"
            @pointermove="onBlockMove"
            @pointerup="onStackUp(s)"
            @pointercancel="onBlockCancel"
            @contextmenu.prevent
          >
            <span class="bmin bmin-start num" :class="{ live: drag?.armed && drag.todo.id === s.front.id }">{{ minToHHmm(liveStart(s.front, s.front.startMin!)) }}</span>
            <i
              v-for="(cv, i) in s.under"
              :key="i"
              class="stk-under"
              :style="{ background: `color-mix(in srgb, var(${cv}) 14%, var(--surface))`, transform: `translateY(${(i + 1) * (compact ? 3 : 4)}px)` }"
            />
            <div
              class="stk-card"
              :class="{ done: s.front.status === 'done', sel: selectedId === s.front.id }"
            >
              <button
                class="ck"
                :aria-label="s.front.status === 'done' ? '标记未完成' : '标记完成'"
                @pointerdown.stop
                @click.stop="emit('toggle', s.front)"
              />
              <div class="body">
                <span class="tt">{{ s.front.title }}</span>
              </div>
              <div class="card-acts">
                <button class="stk-more" :aria-label="`展开同时段 ${s.items.length} 项日程`" @pointerdown.stop @click.stop="openStack(s)">
                  <Layers :size="11" :stroke-width="2.4" />
                  +{{ s.extra }}
                </button>
                <button
                  class="edit"
                  :aria-label="`编辑 ${s.front.title}`"
                  @pointerdown.stop
                  @click.stop="emit('edit', s.front)"
                >
                  <Pencil :size="9" :stroke-width="2.6" />
                </button>
              </div>
            </div>
            <span class="bmin bmin-end num" :class="{ live: drag?.armed && drag.todo.id === s.front.id }">{{ minToHHmm(liveStart(s.front, s.front.startMin!) + durOf(s.front)) }}</span>
          </div>

          <!-- AI 排程预览（幽灵块） -->
          <div
            v-for="g in ghostLaid"
            :key="`g-${g.todo.id}`"
            class="blk ghost"
            :style="{ top: `${g.top}px`, height: `${g.h}px`, left: '0%', maxWidth: '100%', '--blk-lines': `${linesFor(g.h)}` }"
          >
            <div class="body">
              <b class="num">{{ minToHHmm(g.startMin) }}</b>
              <span class="tt">{{ g.todo.title }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 同时段清单：叠层簇展开，逐条勾选或定位 -->
    <SheetModal :open="stackOpen" :title="`同时段 ${activeStack?.items.length ?? 0} 项安排`" @close="stackOpen = false">
      <ul class="stk-list">
        <li v-for="t in activeStack?.items ?? []" :key="t.id">
          <i class="dot" :style="{ background: `var(${CATEGORY_META[t.category].colorVar})` }" />
          <span class="num stk-time">{{ minToHHmm(t.startMin!) }}</span>
          <button
            class="ck"
            :aria-label="t.status === 'done' ? '标记未完成' : '标记完成'"
            @click="emit('toggle', t)"
          />
          <button class="stk-row" @click="pickStackItem(t)">
            <span class="tt" :class="{ done: t.status === 'done' }">{{ t.title }}</span>
            <ChevronRight :size="13" class="t-3" />
          </button>
        </li>
      </ul>
      <p class="stk-hint t-3">点条目在画布上置顶并查看详情；勾选直接完成。</p>
    </SheetModal>
  </div>
</template>

<style scoped>
.ctl {
  position: relative;
  border-radius: var(--radius-m);
  background: var(--surface);
  border: 0.5px solid var(--line);
  overflow: hidden;
}

.scroll {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
}

.inner {
  position: relative;
  margin: 0 10px 0 0;
}

.hlab {
  position: absolute;
  left: 0;
  width: 40px;
  text-align: right;
  transform: translateY(-6px);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.hline {
  position: absolute;
  left: 48px;
  right: 0;
  height: 0.5px;
  background: var(--line);
}

.nowline {
  position: absolute;
  left: 48px;
  right: 0;
  height: 0;
  border-top: 1.5px solid var(--danger);
  z-index: 2;
}

.nowline::before {
  content: '';
  position: absolute;
  left: -4px;
  top: -3.5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}

.nowtag {
  position: absolute;
  left: -44px;
  top: -9px;
  width: 40px;
  text-align: right;
  font-size: 10px;
  font-weight: 700;
  color: var(--danger);
  background: var(--surface);
  border-radius: var(--radius-full);
  padding: 1px 0;
}

.dropline {
  position: absolute;
  left: 48px;
  right: 6px;
  top: 0;
  height: 0;
  border-top: 2px dashed var(--accent);
  z-index: 3;
  /* 位置由 transform 提供：过渡平滑吸附台阶，进场淡入 */
  transition: transform var(--dur-fast) var(--ease-standard);
  animation: dropline-in var(--dur-fast) var(--ease-standard);
}

@keyframes dropline-in {
  from {
    opacity: 0;
  }
}

/* 块区：右移让出左侧 48px 刻度栏 + 8px 间隙，永不遮挡时间标签 */
.blocks {
  position: absolute;
  left: 56px;
  right: 6px;
  top: 0;
  bottom: 0;
}

.blk {
  position: absolute;
  /* 收窄包裹内容（列宽为上限，超长标题省略） */
  width: fit-content;
  max-width: 100%;
  cursor: grab;
  z-index: 1;
  /* 长按拖拽与原生文本选择/长按菜单互斥，手势归拖拽管线 */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  /* 拿起/放下：右移让位走弹性过渡；跟手的 top 不在列表里（直接操纵不延迟） */
  transition:
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-fast) var(--ease-standard);
}

.blk-card {
  /* 流内撑满父级高度（父 .blk fit-content 靠它量宽；absolute 子元素不参与 shrink-to-fit） */
  height: 100%;
  display: flex;
  /* 顶对齐：标题从块顶向下折行铺开，不悬浮居中 */
  align-items: flex-start;
  gap: 7px;
  padding: 4px 8px;
  border-radius: var(--radius-s);
  overflow: hidden;
  background: color-mix(in srgb, var(--blk-cat) 15%, var(--surface));
  /* 边缘区分：分类色描边 + 轻投影（与卡片系组件同一配方） */
  border: 0.5px solid color-mix(in srgb, var(--blk-cat) 38%, var(--line));
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text-1) 9%, transparent);
  transition:
    box-shadow var(--dur-fast) var(--ease-standard),
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-fast) var(--ease-standard);
}

.blk:hover .blk-card {
  box-shadow: var(--shadow-card);
}

.blk.sel .blk-card {
  box-shadow: 0 0 0 2px var(--accent);
}

/* 起止时间标记：上方起点、下方终点；拖拽中高亮为实时时间 */
.bmin {
  position: absolute;
  left: 2px;
  font-size: 10px;
  line-height: 1;
  font-weight: 600;
  color: var(--text-3);
  pointer-events: none;
  white-space: nowrap;
  /* 起止标记拖拽中高亮为实时时间：颜色跟上抬起节奏 */
  transition: color var(--dur-fast) var(--ease-standard);
}

.bmin-start {
  top: -13px;
}

.bmin-end {
  top: calc(100% + 2px);
}

.bmin.live {
  color: var(--accent);
  font-weight: 750;
}

.blk.dragging {
  z-index: 4;
  /* 拖起时整体右移让出原位：不遮挡左侧时间轴与底层块，读得清起点 */
  transform: translateX(12px);
}

.blk.dragging .blk-card {
  opacity: 0.88;
  box-shadow: var(--shadow-float);
  transform: scale(1.02);
  cursor: grabbing;
}

.blk.done {
  opacity: 0.45;
}

.blk.done .tt {
  text-decoration: line-through;
}

/* 已过时刻未完成：整体降透明（现在线之后的"还剩下"保持满格） */
.blk.past {
  opacity: 0.55;
}

.ck {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  background: transparent;
  padding: 0;
}

.ck:hover {
  border-color: var(--ok);
  background: color-mix(in srgb, var(--ok) 18%, transparent);
}

.body {
  display: flex;
  /* 幽灵块里时间与标题同行：基线对齐首行；块内单标题时无感 */
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.tt {
  font-size: var(--fs-footnote);
  font-weight: 550;
}

/* 画布块内标题：顶对齐、按块宽折行、按块高截行（--blk-lines 由块高折算），放不下才省略 */
.blk-card .tt,
.stk-card .tt,
.blk.ghost .tt {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--blk-lines, 1);
  overflow: hidden;
  line-height: var(--blk-lh, 17px);
  overflow-wrap: break-word;
}

/* 勾选框与首行光学对齐（首行行高 17px，勾选框 14px） */
.blk-card .ck,
.stk-card .ck {
  margin-top: 2px;
}

/* 幽灵块：AI 预览，虚线描边；出现淡入（预览生成是瞬时状态切换，不该闪现） */
.blk.ghost {
  border: 1.5px dashed var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-s);
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 4px 8px;
  overflow: hidden;
  cursor: default;
  z-index: 2;
  animation: ghost-in var(--dur-base) var(--ease-standard);
}

@keyframes ghost-in {
  from {
    opacity: 0;
    transform: scale(0.97);
  }
}

.blk.ghost .body b {
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--text-2);
}

/* ---------- 叠层簇（≥3 条同时段） ---------- */

.stk {
  position: absolute;
  left: 0;
  width: 100%;
  z-index: 2;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  /* 与 .blk 同配方：拿起右移/放下归位走弹性过渡 */
  transition: transform var(--dur-base) var(--ease-spring);
}

.stk.dragging {
  z-index: 4;
  transform: translateX(12px);
}

/* 底层错位条：按后续条目的分类色淡染，向下错位露出「还有几张」 */
.stk-under {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 0;
  height: 100%;
  border-radius: var(--radius-s);
  pointer-events: none;
}

.stk-card {
  position: relative;
  display: flex;
  /* 与 .blk-card 同配方：顶对齐铺开 */
  align-items: flex-start;
  gap: 7px;
  height: 100%;
  padding: 4px 8px;
  border-radius: var(--radius-s);
  /* 卡面必须不透明：底层错位条（.stk-under）铺在卡面之后，透出来会让卡面看着发灰发虚 */
  background: color-mix(in srgb, var(--blk-cat) 15%, var(--surface));
  border: 0.5px solid color-mix(in srgb, var(--blk-cat) 38%, var(--line));
  overflow: hidden;
  cursor: grab;
  box-shadow: 0 1px 4px color-mix(in srgb, var(--text-1) 8%, transparent);
  transition:
    box-shadow var(--dur-fast) var(--ease-standard),
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-fast) var(--ease-standard);
}

.stk-card:hover {
  box-shadow: var(--shadow-card);
}

.stk-card.sel {
  box-shadow: 0 0 0 2px var(--accent);
}

.stk.dragging .stk-card {
  opacity: 0.85;
  box-shadow: var(--shadow-float);
  cursor: grabbing;
}

.stk-card.done {
  opacity: 0.45;
}

.stk-card.done .tt {
  text-decoration: line-through;
}

.stk-more {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  /* 高度写死：叠层卡最小高度按「展开钮 + 编辑钮」折算（见 minStackH），不能随字号浮动 */
  height: 18px;
  padding: 0 8px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--text-2);
  white-space: nowrap;
}

.stk-more:active {
  transform: scale(0.96);
}

/* 卡面右侧控件列：右上「展开本簇」、右下「编辑」，两块控件各占一行 */
.card-acts {
  flex: none;
  margin-left: auto;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  gap: 2px;
}

/* 卡片右下角编辑钮：与勾选钮同档尺寸（紧凑再缩一档），最小块高也放得下 */
.edit {
  flex: none;
  align-self: flex-end;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
  color: var(--text-2);
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.edit:hover {
  background: color-mix(in srgb, var(--text-1) 16%, transparent);
  color: var(--text-1);
}

.edit svg {
  width: 9px;
  height: 9px;
}

/* 同时段清单 */
.stk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}

.stk-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.stk-time {
  flex: none;
  min-width: 40px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.stk-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 4px;
  text-align: left;
  font: inherit;
  color: inherit;
}

.stk-row .tt {
  font-size: var(--fs-subhead);
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stk-row .tt.done {
  color: var(--text-3);
  text-decoration: line-through;
}

.stk-hint {
  margin-top: 10px;
  font-size: var(--fs-micro);
}

.compact {
  /* 紧凑画布标题行高 16px（linesFor 同步折算行数上限） */
  --blk-lh: 16px;
}

.compact .stk-more {
  height: 14px;
  padding: 0 6px;
}

.compact .edit {
  width: 11px;
  height: 11px;
}

.compact .edit svg {
  width: 8px;
  height: 8px;
}

.compact .tt {
  font-size: var(--fs-caption);
}

.compact .bmin {
  font-size: 9px;
}

.compact .ck {
  width: 11px;
  height: 11px;
}
</style>
