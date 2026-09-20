<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CalendarDays, ListTodo, Plus, Sparkles } from 'lucide-vue-next'

import { useMediaQuery } from '@/composables/useMediaQuery'
import { useToast } from '@/composables/useToast'
import { useScheduleUndo } from '@/composables/useScheduleUndo'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { DESKTOP_MIN } from '@/config/domain'
import { autoSchedule, type Placement } from '@/ai/autoSchedule'
import { useModelsStore } from '@/stores/models'
import { useTodoStore } from '@/stores/todo'
import CanvasTimeline from '@/components/todo/CanvasTimeline.vue'
import DailyRitual from '@/components/todo/DailyRitual.vue'
import DayDetailPanel from '@/components/todo/DayDetailPanel.vue'
import AllTodoList from '@/components/todo/AllTodoList.vue'
import WeekSummary from '@/components/todo/WeekSummary.vue'
import WeekTimeline from '@/components/todo/WeekTimeline.vue'
import { addDays, fmtDateCn, nowMin, todayStr, weekDates } from '@/utils/date'
import { busyIntervals, freeGaps } from '@/utils/schedule'
import type { Todo, TodoSubtask } from '@/types'
import TodoEditorSheet from '@/components/todo/TodoEditorSheet.vue'
import CourseDetailSheet from '@/components/campus/CourseDetailSheet.vue'

/**
 * 今日画布：待办与日程熔成一条时间轴。
 * - 画布 = 未安排池 + 单日时间轴 + 详情联动（桌面右栏 / 移动端直接进编辑抽屉）；
 * - 智能排程 = AI 建议 → 幽灵块预览 → 用户确认落库（L2 契约），无模型走启发式；
 * - 周 = 周选择 + 周回顾；清单 = 全部待办分组列表。
 */
const store = useTodoStore()
const models = useModelsStore()
const { toast } = useToast()
const { applyMove, applyMoves } = useScheduleUndo()
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

type Segment = 'canvas' | 'week' | 'list'
const segment = ref<Segment>('canvas')
const canvasDate = ref(todayStr())
const today = todayStr()

/* ---------- 数据 ---------- */

onMounted(async () => {
  await store.loadAll()
  maybeOpenRitual()
})

const dayTodos = computed(() => store.allTodos.filter((t) => t.date === canvasDate.value))
const scheduled = computed(() => dayTodos.value.filter((t) => t.startMin != null))
const pool = computed(() => dayTodos.value.filter((t) => t.startMin == null && t.status !== 'done'))
const doneCount = computed(() => dayTodos.value.filter((t) => t.status === 'done').length)

/* ---------- 周时间线数据 ---------- */

const weekSet = new Set(weekDates(today))
const weekScheduled = computed(() =>
  store.allTodos.filter((t) => t.date != null && weekSet.has(t.date) && t.startMin != null),
)
const weekUnscheduled = computed(() =>
  store.allTodos.filter((t) => t.date != null && weekSet.has(t.date) && t.startMin == null && t.status !== 'done'),
)

const headTitle = computed(() =>
  segment.value === 'canvas' ? fmtDateCn(canvasDate.value) : segment.value === 'week' ? '本周' : '全部待办',
)
const headSub = computed(() => {
  if (segment.value === 'list') return '按日期分组'
  if (segment.value === 'week') return '本周时间线 · 长按块可跨天改时'
  return `${doneCount.value}/${dayTodos.value.length} 已完成 · 未安排 ${pool.value.length}`
})

function shiftDay(n: number): void {
  canvasDate.value = addDays(canvasDate.value, n)
}

/* ---------- 选中与编辑 ---------- */

const selectedId = ref<number | null>(null)
const selectedTodo = computed<Todo | null>(
  () => store.allTodos.find((t) => t.id === selectedId.value) ?? null,
)
const editorOpen = ref(false)
const editorTarget = computed<Todo | null>(
  () => store.allTodos.find((t) => t.id === (editorId.value ?? -1)) ?? null,
)
const editorId = ref<number | null>(null)
const addOpen = ref(false)

/** 课表派生行是只读投影：点开的是课程详情，不是待办编辑器（见 CourseDetailSheet）。
 *  与 editorTarget 同理按 id 派生 —— 存对象快照的话，打卡后面板读到的还是旧对象。 */
const courseId = ref<number | null>(null)
const course = computed<Todo | null>(
  () => store.allTodos.find((t) => t.id === (courseId.value ?? -1)) ?? null,
)
const courseOpen = ref(false)

function openCourse(t: Todo): void {
  selectedId.value = t.id
  courseId.value = t.id
  courseOpen.value = true
}

function onSelect(t: Todo): void {
  if (t.courseSessionId != null) {
    openCourse(t)
    return
  }
  selectedId.value = t.id
  if (!isDesktop.value) {
    editorId.value = t.id
    editorOpen.value = true
  }
}

function onToggle(t: Todo): void {
  clearGhosts()
  void store.toggle(t)
}

function onMove(t: Todo, startMin: number): void {
  clearGhosts()
  void applyMove(t, { date: canvasDate.value, startMin })
}

/** 直开编辑抽屉（周段无详情右栏；画布卡片右下角编辑钮同入口）：课程派生行转只读详情 */
function openEditor(t: Todo): void {
  if (t.courseSessionId != null) {
    openCourse(t)
    return
  }
  selectedId.value = t.id
  editorId.value = t.id
  editorOpen.value = true
}

function onWeekMove(t: Todo, date: string, startMin: number): void {
  clearGhosts()
  void applyMove(t, { date, startMin })
}

function onWeekDaySelect(d: string): void {
  canvasDate.value = d
  segment.value = 'canvas'
}

function onWeekAdd(d: string): void {
  canvasDate.value = d
  addOpen.value = true
}

async function onSubtasks(next: TodoSubtask[]): Promise<void> {
  const t = selectedTodo.value
  if (!t) return
  await store.update({ ...t, subtasks: next.length ? next : null })
}

function editSelected(): void {
  editorId.value = selectedId.value
  editorOpen.value = true
}

async function removeSelected(): Promise<void> {
  const t = selectedTodo.value
  if (!t) return
  await store.remove(t)
  selectedId.value = null
}

/* ---------- 未安排池：点击快排 + 拖入时间轴 ---------- */

const tlWrap = ref<HTMLElement | null>(null)
const tlComp = ref<InstanceType<typeof CanvasTimeline> | null>(null)
const dropMin = ref<number | null>(null)
const chipDrag = ref<Todo | null>(null)

/** 把未安排事项放进"现在之后"的第一个装得下的空档 */
async function placeInNextGap(t: Todo): Promise<void> {
  const busy = busyIntervals(scheduled.value, canvasDate.value)
  const from = canvasDate.value === today ? Math.max(nowMin(), 6 * 60) : 6 * 60
  const gaps = freeGaps(busy, from, 22 * 60)
  const dur = t.durationMin ?? 30
  const gap = gaps.find((g) => g.end - g.start >= dur)
  if (!gap) {
    toast('今天 22 点前没有装得下的空档了')
    return
  }
  const at = `${String(Math.floor(gap.start / 60)).padStart(2, '0')}:${String(gap.start % 60).padStart(2, '0')}`
  await applyMove(t, { date: canvasDate.value, startMin: gap.start }, `已排到 ${at}`)
}

function onChipDown(e: PointerEvent, t: Todo): void {
  if (e.button !== 0) return
  const el = e.currentTarget as HTMLElement
  // **捕获失败不能带走整个拖拽**：合成指针、指针已失效等边缘会抛 NotFoundError，
  // 而这里没有捕获也能靠元素自身的 pointermove 继续（画布那边就是这么办的）。
  // 曾经这里少了个 try，于是「捕获一失败，池卡片就完全拖不动」。
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    /* 无有效指针：拖拽沿元素事件继续 */
  }
  chipDrag.value = t
  chipStart = { x: e.clientX, y: e.clientY }
  chipMoved = false
}

let chipStart = { x: 0, y: 0 }
let chipMoved = false

function onChipMove(e: PointerEvent): void {
  const t = chipDrag.value
  if (!t) return
  if (!chipMoved && Math.hypot(e.clientX - chipStart.x, e.clientY - chipStart.y) < 6) return
  chipMoved = true
  const sc = tlWrap.value?.querySelector('.scroll') as HTMLElement | null
  const wrap = tlWrap.value?.getBoundingClientRect()
  const ppm = tlComp.value?.getPxPerMin() ?? 0.5
  if (!sc || !wrap) return
  if (e.clientX < wrap.left || e.clientX > wrap.right || e.clientY < wrap.top || e.clientY > wrap.bottom) {
    dropMin.value = null
    return
  }
  const min = (e.clientY - wrap.top + sc.scrollTop) / ppm
  dropMin.value = Math.max(0, Math.min(1435, Math.round(min / 5) * 5))
}

async function onChipUp(): Promise<void> {
  const t = chipDrag.value
  const min = dropMin.value
  chipDrag.value = null
  dropMin.value = null
  if (t && chipMoved && min != null) {
    await applyMove(t, { date: canvasDate.value, startMin: min })
  }
}

/* ---------- 智能排程（AI 建议 → 确认 → 落库） ---------- */

const aiRunning = ref(false)
/** AI 排程流式进度（已安排 N/M 项），运行中显示在排程按钮上 */
const aiProgress = ref('')
const ghosts = ref<{ todo: Todo; startMin: number }[]>([])
const aiReason = ref('')
const aiSource = ref<'ai' | 'heuristic'>('heuristic')

function clearGhosts(): void {
  if (ghosts.value.length) ghosts.value = []
}

async function runSchedule(): Promise<void> {
  if (aiRunning.value || !pool.value.length) return
  clearGhosts()
  aiRunning.value = true
  aiProgress.value = ''
  try {
    if (!models.loaded) await models.load()
    const from = canvasDate.value === today ? Math.max(nowMin(), 6 * 60) : 6 * 60
    const res = await autoSchedule(
      pool.value,
      scheduled.value,
      canvasDate.value,
      from,
      models.defaultModel(),
      (n, total) => (aiProgress.value = `已排 ${n}/${total} 项`),
    )
    const byId = new Map(pool.value.map((t) => [t.id, t]))
    ghosts.value = res.placements
      .filter((p: Placement) => byId.has(p.id))
      .map((p) => ({ todo: byId.get(p.id)!, startMin: p.startMin }))
    aiReason.value = res.reason
    aiSource.value = res.source
    if (!ghosts.value.length) toast('今天装不下更多安排了，试试改天或减时长')
  } finally {
    aiRunning.value = false
  }
}

async function applyGhosts(): Promise<void> {
  const list = ghosts.value
  ghosts.value = []
  const items: { todo: Todo; date: string | null; startMin: number | null }[] = []
  for (const g of list) {
    const cur = store.allTodos.find((t) => t.id === g.todo.id)
    if (cur) items.push({ todo: cur, date: canvasDate.value, startMin: g.startMin })
  }
  await applyMoves(items, `已排入 ${items.length} 项，可拖动微调`)
}

/* ---------- 每日规划仪式 ---------- */

const ritualOpen = ref(false)

const ritualCandidates = computed(() => {
  const inbox = store.allTodos.filter((t) => t.date === null && t.status !== 'done')
  const overdue = store.allTodos.filter(
    (t) => t.date !== null && t.date < today && t.status !== 'done',
  )
  return [...inbox, ...overdue, ...pool.value]
})

function maybeOpenRitual(): void {
  const key = `rein.ritual.${today}`
  if (localStorage.getItem(key)) return
  if (!ritualCandidates.value.length) return
  ritualOpen.value = true
}

function closeRitual(): void {
  localStorage.setItem(`rein.ritual.${today}`, '1')
  ritualOpen.value = false
}

async function onRitualConfirm(ids: number[], mode: 'ai' | 'manual'): Promise<void> {
  closeRitual()
  for (const id of ids) {
    const t = store.allTodos.find((x) => x.id === id)
    if (!t) continue
    const next: Todo = { ...t, date: t.date === null || t.date < today ? today : t.date }
    if (next.date === today && next.startMin != null && t.date === null) next.startMin = null
    if (t.date !== today) await store.update(next)
  }
  if (mode === 'ai') await runSchedule()
  else toast('已加入今天，拖进时间轴安排时间')
}
</script>

<template>
  <div class="page">
    <PageHeader :title="headTitle" :subtitle="headSub" back>
      <template #action>
        <button class="hdr-btn" aria-label="添加待办" @click="addOpen = true">
          <Plus :size="20" />
        </button>
      </template>
    </PageHeader>

    <!-- 视图切换 + 智能排程 -->
    <div class="toolbar row">
      <div class="segrow" role="tablist" aria-label="视图">
        <button role="tab" class="seg" :class="{ on: segment === 'canvas' }" :aria-selected="segment === 'canvas'" data-testid="seg-canvas" @click="segment = 'canvas'">
          <CalendarDays :size="14" /> 画布
        </button>
        <button role="tab" class="seg" :class="{ on: segment === 'week' }" :aria-selected="segment === 'week'" data-testid="seg-week" @click="segment = 'week'">
          周
        </button>
        <button role="tab" class="seg" :class="{ on: segment === 'list' }" :aria-selected="segment === 'list'" data-testid="seg-list" @click="segment = 'list'">
          <ListTodo :size="14" /> 清单
        </button>
      </div>
      <button
        v-if="segment === 'canvas'"
        class="ai-btn"
        :disabled="aiRunning || !pool.length"
        data-testid="ai-schedule"
        @click="runSchedule"
      >
        <Sparkles :size="14" /> {{ aiRunning ? aiProgress || '排程中…' : '智能排程' }}
      </button>
    </div>

    <!-- ═══ 画布 ═══ -->
    <template v-if="segment === 'canvas'">
      <div class="dateline row between">
        <button class="daynav" aria-label="前一天" @click="shiftDay(-1)">‹</button>
        <span class="num dlabel">{{ canvasDate === today ? '今天' : fmtDateCn(canvasDate) }}</span>
        <button class="daynav" aria-label="后一天" @click="shiftDay(1)">›</button>
      </div>

      <!-- 未安排池 -->
      <section class="pool" data-testid="pool">
        <header class="row between poolh">
          <b>未安排</b>
          <span class="hint">拖进时间轴，或点卡片快排</span>
        </header>
        <div class="chips">
          <button
            v-for="t in pool"
            :key="t.id"
            class="pchip"
            :class="{ sel: selectedId === t.id, drag: chipDrag?.id === t.id }"
            :data-title="t.title"
            @pointerdown="onChipDown($event, t)"
            @pointermove="onChipMove"
            @pointerup="onChipUp"
            @pointercancel="onChipUp"
            @click="!chipMoved && onSelect(t)"
          >
            <i class="pdot" />{{ t.title }}
            <em v-if="t.durationMin" class="num">{{ t.durationMin }} 分钟</em>
          </button>
          <p v-if="!pool.length" class="pool-empty">池子空了 — 该安排的都安排上了。</p>
        </div>
      </section>

      <!-- 智能排程确认条 -->
      <section v-if="ghosts.length" class="confirm" data-testid="ai-confirm">
        <p class="cr">
          <b>{{ aiSource === 'ai' ? 'AI 建议' : '规则排程' }}</b>
          {{ aiReason }}
        </p>
        <div class="row gap">
          <button class="cbtn ghost" @click="clearGhosts">取消</button>
          <button class="cbtn primary" data-testid="ai-apply" @click="applyGhosts">应用（{{ ghosts.length }}）</button>
        </div>
      </section>

      <!-- 时间轴 + 详情（桌面右栏，移动端点击块进编辑抽屉） -->
      <div class="cgrid" :class="{ wide: isDesktop && selectedTodo }">
        <div ref="tlWrap" class="tlwrap">
          <CanvasTimeline
            ref="tlComp"
            :date="canvasDate"
            :todos="scheduled"
            :ghosts="ghosts"
            :drop-min="dropMin"
            :selected-id="selectedId"
            :compact="!isDesktop"
            data-testid="canvas-timeline"
            @select="onSelect"
            @edit="openEditor"
            @toggle="onToggle"
            @move="onMove"
          />
        </div>
        <DayDetailPanel
          v-if="isDesktop"
          :todo="selectedTodo"
          @toggle="selectedTodo && onToggle(selectedTodo)"
          @edit="editSelected"
          @remove="removeSelected"
          @place="selectedTodo && placeInNextGap(selectedTodo)"
          @subtasks="onSubtasks"
        />
      </div>
    </template>

    <!-- ═══ 周 ═══ -->
    <template v-else-if="segment === 'week'">
      <section class="card">
        <WeekTimeline
          :todos="weekScheduled"
          :unscheduled="weekUnscheduled"
          :selected-id="selectedId"
          @select="openEditor"
          @toggle="onToggle"
          @move="onWeekMove"
          @day-select="onWeekDaySelect"
          @add="onWeekAdd"
        />
      </section>
      <WeekSummary />
    </template>

    <!-- ═══ 清单 ═══ -->
    <template v-else>
      <AllTodoList />
    </template>

    <DailyRitual :open="ritualOpen" :candidates="ritualCandidates" @close="closeRitual" @confirm="onRitualConfirm" />
    <TodoEditorSheet :open="editorOpen" :todo="editorTarget" :date="canvasDate" @close="editorOpen = false" />
    <CourseDetailSheet
      :open="courseOpen"
      :todo="course"
      @close="courseOpen = false"
      @toggle="onToggle"
    />
    <SmartAddSheet :open="addOpen" :date="canvasDate" @close="addOpen = false" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.toolbar {
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.segrow {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.seg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 13px;
  border-radius: var(--radius-s);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.seg.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.ai-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 15px;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-footnote);
  font-weight: 700;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 4px 14px rgba(0, 0, 0, 0.12);
}

.ai-btn:disabled {
  opacity: 0.45;
  box-shadow: none;
}

.dateline {
  margin: 0 0 8px;
}

.daynav {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface);
  border: 0.5px solid var(--line);
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
}

.dlabel {
  font-size: var(--fs-footnote);
  font-weight: 650;
  color: var(--text-2);
}

.pool {
  background: var(--surface);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-m);
  padding: 10px 14px 12px;
  margin-bottom: 12px;
}

.poolh b {
  font-size: var(--fs-footnote);
}

.poolh .hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  min-height: 20px;
}

.pchip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  border: 0.5px solid var(--line);
  font-size: var(--fs-footnote);
  font-weight: 550;
  touch-action: none;
  cursor: grab;
}

.pchip:active {
  cursor: grabbing;
}

.pchip.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.pchip.drag {
  opacity: 0.55;
  transform: scale(1.03);
}

.pdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.pchip em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.pool-empty {
  font-size: var(--fs-footnote);
  color: var(--text-3);
  padding: 4px 0;
}

.confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--accent-soft);
  border-radius: var(--radius-m);
  padding: 10px 14px;
  margin-bottom: 12px;
}

.confirm .cr {
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-1);
}

.confirm b {
  color: var(--accent);
  margin-right: 6px;
}

.gap {
  gap: 8px;
}

.cbtn {
  padding: 7px 14px;
  border-radius: var(--radius-full);
  font-size: var(--fs-footnote);
  font-weight: 700;
}

.cbtn.ghost {
  color: var(--text-2);
}

.cbtn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.cgrid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

.cgrid.wide {
  grid-template-columns: 1fr 292px;
}

.tlwrap {
  min-width: 0;
}

/* 画布时间轴默认高度（.scroll 撑起） */
.tlwrap :deep(.ctl .scroll) {
  height: min(62vh, 620px);
}

@media (max-width: 1099px) {
  .tlwrap :deep(.ctl .scroll) {
    height: 56vh;
  }
}
</style>
