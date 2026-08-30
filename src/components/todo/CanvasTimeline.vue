<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronRight, Layers } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { CATEGORY_META } from '@/config/domain'
import { minToHHmm, nowMin, todayStr } from '@/utils/date'
import type { Todo } from '@/types'

/**
 * 单日画布时间轴：0-24 时连续刻度，块按 date+startMin+durationMin 定位。
 * - 重叠块贪心分列：≤2 列并排；≥3 列收成「叠层卡」（全宽卡面 + 底层错位条 + 计数徽标，
 *   点开底部清单逐条勾选/定位），避免窄列把标题挤成省略号；
 * - 点按选中、拖拽改位（阈值 6px，防误触）；
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
}>()

const DEFAULT_PX = 56
const MIN_PX = 18
const MAX_PX = 104
const DRAG_THRESHOLD = 6

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

const durOf = (t: Todo) => t.durationMin ?? 30

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

/** 用户在清单里点选某条 → 置顶为卡面（会话内状态，跨日/重载自然失效） */
const frontByStack = ref(new Map<string, number>())

const stackKey = (items: Todo[]): string => `${items[0]!.id}-${items.length}`

const layout = computed(() => {
  const items = [...props.todos].sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0) || a.id - b.id)
  const columns: Laid[] = []
  const stacks: Stack[] = []
  let cluster: { t: Todo; end: number }[] = []
  let clusterEnd = -1

  const flush = () => {
    if (!cluster.length) return
    const colEnds: number[] = []
    const assigned: { t: Todo; end: number; col: number }[] = []
    for (const c of cluster) {
      let col = colEnds.findIndex((e) => e <= c.t.startMin!)
      if (col === -1) {
        colEnds.push(c.end)
        col = colEnds.length - 1
      } else {
        colEnds[col] = c.end
      }
      assigned.push({ ...c, col })
    }
    if (colEnds.length <= 2) {
      for (const a of assigned) {
        columns.push({
          t: a.t,
          top: a.t.startMin! * pxPerMin.value,
          h: Math.max(minBlkH.value, durOf(a.t) * pxPerMin.value),
          col: a.col,
          cols: colEnds.length,
        })
      }
    } else {
      const sorted = assigned
        .sort((x, y) => (x.t.startMin ?? 0) - (y.t.startMin ?? 0) || x.t.id - y.t.id)
        .map((a) => a.t)
      const front = frontOf(sorted)
      stacks.push({
        key: stackKey(sorted),
        items: sorted,
        top: sorted[0]!.startMin! * pxPerMin.value,
        front,
        extra: sorted.length - 1,
        under: sorted
          .filter((t) => t.id !== front.id)
          .slice(0, 2)
          .map((t) => CATEGORY_META[t.category].colorVar),
        h: Math.max(minBlkH.value, durOf(front) * pxPerMin.value),
      })
    }
    cluster = []
    clusterEnd = -1
  }

  for (const t of items) {
    const end = t.startMin! + durOf(t)
    if (cluster.length && t.startMin! >= clusterEnd) flush()
    cluster.push({ t, end })
    clusterEnd = Math.max(clusterEnd, end)
  }
  flush()
  return { columns, stacks }
})

const laid = computed(() => layout.value.columns)
const stacks = computed(() => layout.value.stacks)

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

/** 块定位：拖拽中实时跟手（按列分摊宽度） */
function blkStyle(b: Laid): Record<string, string> {
  const dragging = drag.value?.moved && drag.value.todo.id === b.t.id
  const top = dragging ? drag.value!.curMin * pxPerMin.value : b.top
  return {
    top: `${top}px`,
    height: `${b.h}px`,
    left: `${(b.col / b.cols) * 88}%`,
    width: `calc(${88 / b.cols}% - 4px)`,
    background: `color-mix(in srgb, var(${CATEGORY_META[b.t.category].colorVar}) 15%, var(--surface))`,
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

/* ---------- 块拖拽改位 ---------- */

interface DragState {
  todo: Todo
  grabMin: number
  curMin: number
  moved: boolean
}

const drag = ref<DragState | null>(null)
let startY = 0

function onBlockDown(e: PointerEvent, t: Todo): void {
  if (t.status === 'done' || e.button !== 0) return
  const el = scroller.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const pointerMin = (e.clientY - rect.top + el.scrollTop) / pxPerMin.value
  drag.value = { todo: t, grabMin: pointerMin - t.startMin!, curMin: t.startMin!, moved: false }
  startY = e.clientY
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onBlockMove(e: PointerEvent): void {
  const d = drag.value
  const el = scroller.value
  if (!d || !el) return
  if (!d.moved && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return
  d.moved = true
  const rect = el.getBoundingClientRect()
  const pointerMin = (e.clientY - rect.top + el.scrollTop) / pxPerMin.value
  const dur = durOf(d.todo)
  d.curMin = Math.round(Math.max(0, Math.min(pointerMin - d.grabMin, 1440 - dur)) / 5) * 5
}

function onBlockUp(): void {
  const d = drag.value
  drag.value = null
  if (d?.moved) emit('move', d.todo, d.curMin)
  else if (d) emit('select', d.todo)
}

const dragTime = (t: Todo, fallback: number) =>
  drag.value?.moved && drag.value.todo.id === t.id ? drag.value.curMin : fallback

/* ---------- 叠层簇：卡面拖拽/勾选复用块逻辑，点按开底部清单 ---------- */

/** 叠层卡定位：拖拽中跟手（卡面项的当前分钟） */
function stkStyle(s: Stack): Record<string, string> {
  const dragging = drag.value?.moved && drag.value.todo.id === s.front.id
  return {
    top: `${dragging ? drag.value!.curMin * pxPerMin.value : s.top}px`,
    height: `${s.h}px`,
    background: `color-mix(in srgb, var(${CATEGORY_META[s.front.category].colorVar}) 15%, var(--surface))`,
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
  const d = drag.value
  drag.value = null
  if (d?.moved) emit('move', d.todo, d.curMin)
  else if (d) openStack(s)
}

onMounted(() => {
  scrollToAnchor()
  nowTimer = window.setInterval(() => {
    nowMin_.value = nowMin()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (nowTimer != null) window.clearInterval(nowTimer)
  drag.value = null
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

        <!-- 外部拖入落点指示 -->
        <div v-if="dropMin != null" class="dropline" :style="{ top: `${dropMin * pxPerMin}px` }" />

        <!-- 待办块 -->
        <div
          v-for="b in laid"
          :key="b.t.id"
          class="blk"
          :class="{
            done: b.t.status === 'done',
            sel: selectedId === b.t.id,
            past: isToday && b.t.startMin! + durOf(b.t) < nowMin_ && b.t.status !== 'done',
            dragging: drag?.moved && drag.todo.id === b.t.id,
          }"
          :style="blkStyle(b)"
          :data-title="b.t.title"
          @pointerdown="onBlockDown($event, b.t)"
          @pointermove="onBlockMove"
          @pointerup="onBlockUp"
          @pointercancel="onBlockUp"
        >
          <button
            class="ck"
            :aria-label="b.t.status === 'done' ? '标记未完成' : '标记完成'"
            @pointerdown.stop
            @click.stop="emit('toggle', b.t)"
          />
          <div class="body">
            <b v-if="b.h >= 26" class="num">{{ minToHHmm(dragTime(b.t, b.t.startMin!)) }}</b>
            <span class="tt">{{ b.t.title }}</span>
          </div>
        </div>

        <!-- 叠层簇：≥3 条同时段，卡面展示 front，点开清单处理其余 -->
        <div
          v-for="s in stacks"
          :key="`s-${s.key}`"
          class="stk"
          :class="{ dragging: drag?.moved && drag.todo.id === s.front.id }"
          :style="stkStyle(s)"
          :data-title="`${s.items.length} 项同时段日程`"
          @pointerdown="onBlockDown($event, s.front)"
          @pointermove="onBlockMove"
          @pointerup="onStackUp(s)"
          @pointercancel="onStackUp(s)"
        >
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
              <b v-if="s.h >= 26" class="num">{{ minToHHmm(dragTime(s.front, s.front.startMin!)) }}</b>
              <span class="tt">{{ s.front.title }}</span>
            </div>
            <button class="stk-more" :aria-label="`展开同时段 ${s.items.length} 项日程`" @pointerdown.stop @click.stop="openStack(s)">
              <Layers :size="11" :stroke-width="2.4" />
              +{{ s.extra }}
            </button>
          </div>
        </div>

        <!-- AI 排程预览（幽灵块） -->
        <div
          v-for="g in ghostLaid"
          :key="`g-${g.todo.id}`"
          class="blk ghost"
          :style="{ top: `${g.top}px`, height: `${g.h}px`, left: '0%', width: '88%' }"
        >
          <div class="body">
            <b class="num">{{ minToHHmm(g.startMin) }}</b>
            <span class="tt">{{ g.todo.title }}</span>
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
  height: 0;
  border-top: 2px dashed var(--accent);
  z-index: 3;
}

.blk {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border-radius: var(--radius-s);
  overflow: hidden;
  cursor: grab;
  transition: box-shadow var(--dur-fast) var(--ease-standard);
  z-index: 1;
}

.blk:hover {
  box-shadow: var(--shadow-card);
}

.blk.sel {
  box-shadow: 0 0 0 2px var(--accent);
}

.blk.dragging {
  opacity: 0.85;
  box-shadow: var(--shadow-float);
  cursor: grabbing;
  z-index: 4;
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
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.body b {
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--text-2);
  flex: none;
}

.tt {
  font-size: var(--fs-footnote);
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 幽灵块：AI 预览，虚线描边 */
.blk.ghost {
  border: 1.5px dashed var(--accent);
  background: var(--accent-soft) !important;
  cursor: default;
  z-index: 2;
}

/* ---------- 叠层簇（≥3 条同时段） ---------- */

.stk {
  position: absolute;
  left: 0;
  width: 88%;
  z-index: 2;
}

.stk.dragging {
  z-index: 4;
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
  align-items: center;
  gap: 7px;
  height: 100%;
  padding: 4px 8px;
  border-radius: var(--radius-s);
  border: 0.5px solid var(--line);
  overflow: hidden;
  cursor: grab;
  box-shadow: 0 1px 4px color-mix(in srgb, var(--text-1) 8%, transparent);
  transition: box-shadow var(--dur-fast) var(--ease-standard);
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
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
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

.compact .stk-more {
  padding: 2px 6px;
}

.compact .tt {
  font-size: var(--fs-caption);
}

.compact .ck {
  width: 11px;
  height: 11px;
}
</style>
