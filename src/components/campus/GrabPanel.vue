<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Layers,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Zap,
} from 'lucide-vue-next'

import { grabStatusMeta, idOf, useCourseSelectStore } from '@/stores/courseSelect'
import type { GrabTask } from '@/types'

/**
 * 抢课任务单面板 —— 引擎的仪表盘。
 *
 * 这里要回答三个问题，且必须在**不盯着屏幕**时也能一眼答上：
 * 1. 现在在抢什么？（任务行 + 状态标签）
 * 2. 什么时候出手？（倒计时，按服务器时钟校正）
 * 3. 出事了吗？（引擎级故障横幅 / 任务失败原因）
 *
 * 倒计时每秒刷一次：它只是个显示，真正的开火时刻在 Rust 那边，
 * 界面卡了、页面切走了都不影响抢课 —— 所以这里用本地定时器完全够用。
 */
const store = useCourseSelectStore()
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  tick = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
})

const tasks = computed(() => store.grabTasks)
const actives = computed(() => store.activeTasks)
/** 未结束的排前面，已结束的沉底（后端已经排好序，这里只负责分组渲染） */
const finished = computed(() =>
  tasks.value.filter((t) => t.status === 'success' || t.status === 'failed' || t.status === 'conflict' || t.status === 'cancelled'),
)

const rows = computed<RenderRow[]>(() => {
  const out: RenderRow[] = []
  for (const g of squads.value) {
    out.push({ kind: 'head', key: g.key, name: g.name, lead: leading(g) })
    for (const m of g.members) out.push({ kind: 'task', t: m })
  }
  for (const t of loose.value) out.push({ kind: 'task', t })
  return out
})

const hasAny = computed(() => tasks.value.length > 0)

/** 距下一次开火的倒计时文案 */
const countdown = computed(() => {
  const ms = store.fireInMs(now.value)
  if (ms == null) return ''
  if (ms <= 0) return '正在开抢'
  return formatCountdown(ms)
})

function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function title(t: GrabTask): string {
  return t.courseName || t.lessonName || `教学班 ${idOf(t.lessonId)}`
}

/** 一行副标题：课程号 · 第几次尝试 · 教务最近说了什么 */
function detail(t: GrabTask): string {
  const bits: string[] = []
  if (t.courseCode) bits.push(t.courseCode)
  if (t.attempts > 0) bits.push(`已尝试 ${t.attempts} 次`)
  if (t.lastMessage) bits.push(t.lastMessage)
  return bits.join(' · ')
}

async function act(id: number, action: 'pause' | 'cancel' | 'retry' | 'remove'): Promise<void> {
  await store.taskAction(id, action)
}

/* ---------------- 志愿组 ----------------
 * 组内是**互斥备选**：一次只主攻当前志愿，中选后其余自动取消。所以组要看成一个
 * 整体来渲染 —— 散在列表里的话，「为什么第 2 志愿一直不动」就没人答得上来。
 */
const squads = computed(() => {
  const byKey = new Map<string, { key: string; name: string; members: GrabTask[] }>()
  for (const t of tasks.value) {
    const k = t.groupKey?.trim()
    if (!k) continue
    const g = byKey.get(k) ?? { key: k, name: t.groupName?.trim() || '志愿组', members: [] }
    g.members.push(t)
    byKey.set(k, g)
  }
  for (const g of byKey.values()) g.members.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  return [...byKey.values()]
})

/** 不在任何组里的任务，照旧平铺 */
const loose = computed(() => tasks.value.filter((t) => !t.groupKey?.trim()))

/** 渲染行：组头 + 组成员，然后是散任务。展平之后模板里只有一份任务行 */
type RenderRow =
  | { kind: 'head'; key: string; name: string; lead: GrabTask | null }
  | { kind: 'task'; t: GrabTask }

/** 组里正在出手的那个。终态/暂停的成员不在场上，别把它们当成「当前志愿」 */
function leading(g: { members: GrabTask[] }): GrabTask | null {
  return (
    g.members.find(
      (m) =>
        !m.heldBy &&
        m.status !== 'success' &&
        m.status !== 'failed' &&
        m.status !== 'conflict' &&
        m.status !== 'cancelled' &&
        m.status !== 'paused',
    ) ?? null
  )
}

/** 被压住的是在等第几志愿 —— 直接说出序号，别让人自己数 */
function waitingOn(t: GrabTask): string {
  const holder = tasks.value.find((x) => x.id === t.heldBy)
  return holder ? `等第 ${holder.priority ?? '?'} 志愿` : '待命'
}

/* ---------------- 窗口监听 ----------------
 * 没有任务时这块也不是空的：引擎只要账号在、开关开着，就在每分钟问「窗口开了没」。
 * 大一新生在窗口开放前没有任何任务可排，这条就是他唯一能看到的进展。
 */
const listenedTurns = computed(() => store.grab?.turns ?? [])
const listenText = computed(() => {
  const open = listenedTurns.value.filter((t) => t.allowEnter)
  if (open.length) return `窗口已开放：${open.map((t) => t.name ?? t.id).join('、')}`
  if (listenedTurns.value.length) {
    return `已发现 ${listenedTurns.value.length} 个批次，但还不能进入`
  }
  return '正在监听选课窗口…'
})
const listening = computed(() => store.grab?.probedAt != null)
</script>

<template>
  <section v-if="hasAny || store.grabError" class="card grab">
    <header class="head">
      <span class="row title">
        <Zap :size="15" class="bolt" />
        <b>抢课任务</b>
        <span v-if="actives.length" class="live num">{{ actives.length }} 个进行中</span>
      </span>
      <span v-if="countdown" class="cd num" :class="{ hot: countdown === '正在开抢' }">
        <Clock :size="13" />{{ countdown }}
      </span>
    </header>

    <!-- 引擎级故障：会话失效这类问题必须显眼 -->
    <p v-if="store.grabError" class="fault">
      <AlertTriangle :size="14" />
      <span>{{ store.grabError }}</span>
      <RouterLink :to="{ name: 'campus-settings' }" class="fix">去重登</RouterLink>
    </p>

    <p v-if="!hasAny" class="t-3 empty">
      还没有排队的课程。
      <span v-if="listening" class="listen">{{ listenText }}</span>
    </p>

    <ul v-else class="list">
      <template v-for="row in rows" :key="row.kind === 'head' ? `h-${row.key}` : row.t.id">
        <!-- 志愿组头：把「谁在抢、谁在等」一次说清 -->
        <li v-if="row.kind === 'head'" class="squad">
          <Layers :size="13" />
          <b>{{ row.name }}</b>
          <span class="t-3">
            {{ row.lead ? `第 ${row.lead.priority ?? '?'} 志愿在抢` : '等待接手' }}
          </span>
        </li>

        <li v-else class="task" :class="grabStatusMeta(row.t).tone">
          <div class="col flex-1 body">
            <div class="row line1">
              <span v-if="row.t.groupKey" class="ord num">第 {{ row.t.priority ?? '?' }}</span>
              <span class="name">{{ title(row.t) }}</span>
              <span class="chip" :class="grabStatusMeta(row.t).tone">{{ grabStatusMeta(row.t).label }}</span>
              <span v-if="row.t.heldBy" class="chip idle">{{ waitingOn(row.t) }}</span>
            </div>
            <p v-if="detail(row.t)" class="meta t-3">{{ detail(row.t) }}</p>
          </div>

          <div class="row ops">
            <button
              v-if="row.t.status === 'waiting' || row.t.status === 'running'"
              class="op"
              title="暂停"
              aria-label="暂停"
              @click="act(row.t.id, 'pause')"
            >
              <Pause :size="14" />
            </button>
            <button
              v-else-if="row.t.status === 'paused'"
              class="op"
              title="恢复"
              aria-label="恢复"
              @click="act(row.t.id, 'retry')"
            >
              <Play :size="14" />
            </button>
            <button
              v-else-if="row.t.status === 'failed' || row.t.status === 'conflict'"
              class="op"
              title="重试"
              aria-label="重试"
              @click="act(row.t.id, 'retry')"
            >
              <RotateCcw :size="14" />
            </button>
            <button
              v-if="row.t.status === 'success' || row.t.status === 'cancelled'"
              class="op"
              title="移除"
              aria-label="移除"
              @click="act(row.t.id, 'remove')"
            >
              <Trash2 :size="14" />
            </button>
            <button
              v-else
              class="op"
              title="取消"
              aria-label="取消"
              @click="act(row.t.id, 'cancel')"
            >
              <Ban :size="14" />
            </button>
          </div>
        </li>
      </template>
    </ul>

    <footer v-if="hasAny" class="foot">
      <button v-if="actives.length" class="link" @click="store.pauseAll()">全部暂停</button>
      <button v-else-if="tasks.some((t) => t.status === 'paused')" class="link" @click="store.resumeAll()">
        全部恢复
      </button>
      <button v-if="finished.length" class="link t-3" @click="store.clearFinished()">
        <CheckCircle2 :size="13" /> 清掉已结束的 {{ finished.length }} 条
      </button>
    </footer>
  </section>
</template>

<style scoped>
.card {
  background: var(--surface);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
  padding: 14px 16px;
  margin-bottom: 14px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.title {
  gap: 6px;
  font-size: var(--fs-callout);
  color: var(--text-1);
}

.bolt {
  color: var(--accent);
}

.live {
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: 1px 8px;
}

.cd {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
}

.cd.hot {
  color: var(--accent);
}

.cd.hot :deep(svg) {
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cd.hot :deep(svg) {
    animation: none;
  }
}

.fault {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-micro);
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border-radius: var(--radius-m);
  padding: 8px 10px;
  margin-bottom: 10px;
  line-height: 1.45;
}

.fix {
  font-weight: 700;
  color: var(--accent);
  margin-left: auto;
}

.empty {
  font-size: var(--fs-caption);
  padding: 6px 0;
}

/* 窗口监听：没有任务时也要让人看到「它还在盯着」，否则关掉页面就等于什么都没发生 */
.listen {
  display: block;
  margin-top: 4px;
  font-size: var(--fs-micro);
  color: var(--accent);
}

.list {
  display: flex;
  flex-direction: column;
}

/* 志愿组头：浅色小标题，不抢任务行的注意力 */
.squad {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0 4px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.squad b {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
}

.squad svg {
  color: var(--accent);
}

/* 组内的行往右缩一格，一眼看出「这些是一伙的」 */
.squad + .task {
  padding-left: 2px;
}

.ord {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: 1px 7px;
}

.task {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
}

.task + .task {
  border-top: 0.5px solid var(--line);
}

.body {
  min-width: 0;
  gap: 2px;
}

.line1 {
  gap: 6px;
  min-width: 0;
}

.name {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.meta {
  font-size: var(--fs-micro);
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
}

.chip.run {
  color: var(--accent);
  background: var(--accent-soft);
}

.chip.ok {
  color: var(--ok);
  background: var(--ok-soft);
}

.chip.warn {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}

.chip.bad {
  color: var(--danger);
  background: var(--danger-soft);
}

/* 终态行压暗：已经结束的事不该和正在抢的争注意力 */
.task.ok .name,
.task.bad .name,
.task.idle .name {
  color: var(--text-2);
}

.ops {
  flex: none;
  gap: 4px;
}

.op {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.op:active {
  transform: scale(0.9);
}

.foot {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding-top: 10px;
  margin-top: 4px;
  border-top: 0.5px solid var(--line);
}

.link {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
}

.link.t-3 {
  color: var(--text-3);
}
</style>
