<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  Ban,
  Check,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-vue-next'

import GrabTaskEditSheet from '@/components/campus/GrabTaskEditSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { grabStatusMeta, idOf, useCourseSelectStore } from '@/stores/courseSelect'
import type { CourseSelectLesson, GrabTask } from '@/types'

/**
 * 抢课任务（管理面）。
 *
 * 为什么要有这一页：任务单在选课页只是**仪表盘的一部分** —— 它按志愿组渲染、
 * 和倒计时抢位置，抢完之后「哪些没抢到、为什么没抢到、要不要重排」在那儿
 * 得翻着看。这里把它们一屏摊开，并且能编辑、能删。
 *
 * 状态分组按「**用户此刻该做什么**」来切，不按引擎的内部状态名切：
 *   进行中（含重试中）→ 什么都不用做，等
 *   已抢到           → 去课表确认
 *   没抢到           → 要么重排、要么放弃
 */
const store = useCourseSelectStore()
const toast = useToast()

/** 官方选课页（含令牌）—— 需办免听的课只能在那里办 */
const entryUrl = computed(() => store.status?.entryUrl ?? '')

onMounted(() => {
  void store.attachGrab()
})
onBeforeUnmount(() => {
  store.detachGrab()
})

/* ---------------- 分组 ---------------- */
const tasks = computed(() => store.grabTasks)
const won = computed(() => tasks.value.filter((t) => t.status === 'success'))
/** 进行中：引擎正在动它（排队中 / 出手了 / 被暂停） */
const running = computed(() =>
  tasks.value.filter((t) => t.status === 'waiting' || t.status === 'running' || t.status === 'paused'),
)
/**
 * 没抢到。**排序按「要不要你动手」**：被教务拒的、需办免听的排前面 ——
 * 那两条是「停在那里等你做点什么」的；失败与已取消只是记录。
 */
const lost = computed(() => {
  const rank = (t: GrabTask) =>
    t.status === 'needs_ai' ? 0 : t.status === 'conflict' ? 1 : t.status === 'failed' ? 2 : 3
  return tasks.value
    .filter((t) => t.status === 'failed' || t.status === 'conflict' || t.status === 'needs_ai' || t.status === 'cancelled')
    .sort((a, b) => rank(a) - rank(b))
})

const summary = computed(() => {
  if (!tasks.value.length) return '还没有任务'
  const bits = [`共 ${tasks.value.length} 条`]
  if (running.value.length) bits.push(`进行中 ${running.value.length}`)
  if (won.value.length) bits.push(`已抢到 ${won.value.length}`)
  if (lost.value.length) bits.push(`没抢到 ${lost.value.length}`)
  return bits.join(' · ')
})

/**
 * 行的标题 —— 与任务行/结果行同一条规矩。
 *
 * `lessonName` 里存的是「这个班怎么和同门课其他班区分」（项目名优先）：
 * 体育课 8 个项目的课程名全都叫「大学体育1」，只写课程名，用户认不出哪条是羽毛球。
 */
function title(t: GrabTask): string {
  const course = t.courseName?.trim()
  const label = t.lessonName?.trim()
  if (!course) return label || `教学班 ${idOf(t.lessonId)}`
  if (!label || label === course || label.startsWith(course)) return course
  return `${course} · ${label}`
}

/** 这一秒为什么没在动 / 到底怎么了 —— 引擎的 `lastMessage` 是教务的原话，优先说它 */
function why(t: GrabTask): string {
  if (t.status === 'paused') return '已暂停 —— 引擎不会动它'
  const wait = (t.nextAt ?? 0) - now.value
  if ((t.status === 'waiting' || t.status === 'running') && wait > 0) {
    return wait < 1000 ? '马上重试' : wait < 60_000 ? `${Math.ceil(wait / 1000)} 秒后重试` : `${Math.ceil(wait / 60_000)} 分钟后重试`
  }
  const msg = t.lastMessage?.trim() ?? ''
  // 教务那句话如果只是在复述徽标，就不必再说一遍（同 GrabResult 的规矩）
  return msg && msg !== grabStatusMeta(t).label ? msg : ''
}

/** 行副信息：课程号 · 教师 · 已尝试 N 次 */
function facts(t: GrabTask): string {
  const bits: string[] = []
  if (t.courseCode) bits.push(t.courseCode)
  if (t.teacher) bits.push(t.teacher)
  if (t.attempts > 0) bits.push(`已尝试 ${t.attempts} 次`)
  if (t.groupKey && t.priority) bits.push(`第 ${t.priority} 志愿`)
  return bits.join(' · ')
}

const now = ref(Date.now())
let ticker: number | null = null
onMounted(() => {
  ticker = window.setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  if (ticker != null) window.clearInterval(ticker)
})

/* ---------------- 行操作 ---------------- */
const busy = ref(false)

async function act(id: number, action: 'pause' | 'cancel' | 'retry' | 'remove'): Promise<void> {
  try {
    await store.taskAction(id, action)
    if (action === 'remove') toast.toast('已移除这条任务')
    if (action === 'retry') toast.toast('已重新排队')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '操作失败')
  }
}

/** 移除是两步的：这些行是「抢到了什么」的唯一本地记录，一次误触就删掉不值 */
const pendingRemove = ref<number | null>(null)
let removeTimer: number | null = null

function askRemove(id: number): void {
  if (removeTimer != null) window.clearTimeout(removeTimer)
  if (pendingRemove.value === id) {
    pendingRemove.value = null
    void act(id, 'remove')
    return
  }
  pendingRemove.value = id
  removeTimer = window.setTimeout(() => (pendingRemove.value = null), 4000)
}

/* ---------------- 改设置并重排 ----------------
 * 任务里只存了「提交要用的那几样」，够重建一个教学班对象。
 * `lessonName` 要原样带上：它就是任务行上那个区分标签（项目名优先），
 * 丢掉它重排之后任务行会退回成一门共有的课程名，又认不出来了。
 */
const editing = ref<GrabTask | null>(null)

function lessonOf(t: GrabTask): CourseSelectLesson {
  return {
    id: t.lessonId,
    course: { code: t.courseCode ?? null, nameZh: t.courseName ?? null, credits: t.credits ?? null },
    teachers: t.teacher ? [{ nameZh: t.teacher }] : [],
    lessonName: t.lessonName ?? null,
    scheduleGroups: [],
  }
}

async function onSaveEdit(payload: {
  mode: 'predicate' | 'direct'
  virtualCost: number
  priority: number
}): Promise<void> {
  const t = editing.value
  if (!t || busy.value) return
  busy.value = true
  try {
    // 先撤掉旧的再排新的：不留一条已取消的垃圾在列表里（引擎里 remove 是无状态守卫的纯删除）
    await store.taskAction(t.id, 'remove')
    await store.enqueue([lessonOf(t)], {
      mode: payload.mode,
      virtualCost: payload.virtualCost > 0 ? payload.virtualCost : null,
      scheduleGroupId: t.scheduleGroupId ?? null,
      groupKey: t.groupKey ?? null,
      groupName: t.groupName ?? null,
      priority: payload.priority,
      turnId: t.turnId,
    })
    editing.value = null
    toast.toast('已按新设置重新排队')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '重排失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="抢课任务" :subtitle="summary" back>
      <template #action>
        <button
          v-if="running.some((t) => t.status !== 'paused')"
          class="hdr-btn"
          aria-label="全部暂停"
          title="全部暂停"
          @click="store.pauseAll()"
        >
          <Pause :size="19" />
        </button>
        <button
          v-else-if="running.length"
          class="hdr-btn"
          aria-label="全部恢复"
          title="全部恢复"
          @click="store.resumeAll()"
        >
          <Play :size="19" />
        </button>
      </template>
    </PageHeader>

    <EmptyState
      v-if="!tasks.length"
      :icon="ListChecks"
      title="还没有抢课任务"
      hint="在选课页挑一门课加入抢课，或者写一条抢课计划 —— 之后它们都会出现在这里。"
    >
      <template #action>
        <RouterLink :to="{ name: 'campus-course-select' }" class="cta">去选课</RouterLink>
      </template>
    </EmptyState>

    <template v-else>
      <!-- 引擎级故障：这一页也要说，否则用户只会看到一串「不动」的任务 -->
      <p v-if="store.grabError" class="fault" role="status">
        <Ban :size="14" />
        <span>{{ store.grabError }}</span>
      </p>

      <!-- 进行中 -->
      <section v-if="running.length" class="card">
        <h2 class="head">
          <Play :size="14" />
          进行中
          <span class="cnt num">{{ running.length }}</span>
        </h2>
        <ul class="list">
          <li v-for="t in running" :key="t.id" class="row task" :class="grabStatusMeta(t).tone">
            <span class="col flex-1 body">
              <span class="line1">
                <b class="name">{{ title(t) }}</b>
                <span class="chip" :class="grabStatusMeta(t).tone">{{ grabStatusMeta(t).label }}</span>
              </span>
              <span v-if="facts(t)" class="meta">{{ facts(t) }}</span>
              <span v-if="why(t)" class="meta">{{ why(t) }}</span>
            </span>
            <span class="ops">
              <button
                v-if="t.status === 'paused'"
                class="op"
                aria-label="恢复"
                title="恢复"
                @click="act(t.id, 'retry')"
              >
                <Play :size="14" />
              </button>
              <button v-else class="op" aria-label="暂停" title="暂停" @click="act(t.id, 'pause')">
                <Pause :size="14" />
              </button>
              <button class="op" aria-label="取消" title="取消" @click="act(t.id, 'cancel')">
                <Ban :size="14" />
              </button>
            </span>
          </li>
        </ul>
      </section>

      <!-- 已抢到 -->
      <section v-if="won.length" class="card">
        <h2 class="head">
          <CheckCircle2 :size="14" />
          已抢到
          <span class="cnt num">{{ won.length }}</span>
        </h2>
        <ul class="list">
          <li v-for="t in won" :key="t.id" class="row task ok">
            <span class="col flex-1 body">
              <span class="line1">
                <b class="name">{{ title(t) }}</b>
                <span class="chip ok">已抢到</span>
              </span>
              <span v-if="facts(t)" class="meta">{{ facts(t) }}</span>
            </span>
            <span class="ops">
              <button
                class="op"
                :class="{ danger: pendingRemove === t.id }"
                :title="pendingRemove === t.id ? '再点一次确认移除' : '移除'"
                :aria-label="pendingRemove === t.id ? '确认移除' : '移除'"
                @click="askRemove(t.id)"
              >
                <Check v-if="pendingRemove === t.id" :size="14" />
                <Trash2 v-else :size="14" />
              </button>
            </span>
          </li>
        </ul>
        <p class="foot-hint">抢到不等于课表里有 —— 回选课页「把结果同步到课表」。</p>
      </section>

      <!-- 没抢到 -->
      <section v-if="lost.length" class="card">
        <h2 class="head">
          <RotateCcw :size="14" />
          没抢到
          <span class="cnt num">{{ lost.length }}</span>
        </h2>
        <ul class="list">
          <li v-for="t in lost" :key="t.id" class="row task" :class="grabStatusMeta(t).tone">
            <span class="col flex-1 body">
              <span class="line1">
                <b class="name">{{ title(t) }}</b>
                <span class="chip" :class="grabStatusMeta(t).tone">{{ grabStatusMeta(t).label }}</span>
              </span>
              <span v-if="facts(t)" class="meta">{{ facts(t) }}</span>
              <span v-if="why(t)" class="meta">{{ why(t) }}</span>
            </span>
            <span class="ops">
              <!-- 需办免听的重试没有意义（引擎说得很清楚：得先去教务办免听），
                   所以那一行的第一个动作换成「去办理」——那才是它的下一步 -->
              <a
                v-if="t.status === 'conflict' && entryUrl"
                class="op"
                :href="entryUrl"
                target="_blank"
                rel="noreferrer"
                aria-label="去教务办理免听"
                title="去教务办理免听"
              >
                <ExternalLink :size="14" />
              </a>
              <button v-else class="op" aria-label="重试" title="重新排队，按现有节奏再抢" @click="act(t.id, 'retry')">
                <RotateCcw :size="14" />
              </button>
              <button class="op" aria-label="改设置并重排" title="改设置并重排" @click="editing = t">
                <Settings2 :size="14" />
              </button>
              <button
                class="op"
                :class="{ danger: pendingRemove === t.id }"
                :title="pendingRemove === t.id ? '再点一次确认移除' : '移除'"
                :aria-label="pendingRemove === t.id ? '确认移除' : '移除'"
                @click="askRemove(t.id)"
              >
                <Check v-if="pendingRemove === t.id" :size="14" />
                <Trash2 v-else :size="14" />
              </button>
            </span>
          </li>
        </ul>
      </section>

      <div class="bulk">
        <button class="link" @click="store.clearFinished()">
          <CheckCircle2 :size="13" /> 清掉已结束的 {{ won.length + lost.length }} 条
        </button>
        <RouterLink :to="{ name: 'campus-course-select' }" class="link">
          去选课页
        </RouterLink>
      </div>

      <!-- 引擎处理不了的那些（教务改了接口/参数），交给 AI 是唯一有用的下一步 -->
      <p class="hint">
        <Sparkles :size="13" />
        <span>
          卡在「请求被拒」这类引擎自己修不了的问题上时，把现场交给 AI 去教务那边核对
          <RouterLink :to="{ name: 'campus-course-select' }" class="inline-link">（在选课页底部）</RouterLink>。
        </span>
      </p>
    </template>

    <GrabTaskEditSheet
      :open="!!editing"
      :task="editing"
      :busy="busy"
      @close="editing = null"
      @save="onSaveEdit"
    />
  </div>
</template>

<style scoped>
.page {
  padding: 0 var(--page-pad-x) var(--page-pad-bottom);
}

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
  gap: 6px;
  font-size: var(--fs-callout);
  font-weight: 700;
  color: var(--text-1);
  margin-bottom: 6px;
}

.head svg {
  color: var(--accent);
}

.cnt {
  margin-left: auto;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
}

.row + .row {
  border-top: 0.5px solid var(--line);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.name {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
  overflow-wrap: anywhere;
}

/* 终态行压暗：已经结束的事不该和还在抢的争注意力 */
.task.ok .name,
.task.bad .name,
.task.idle .name {
  color: var(--text-2);
}

.meta {
  font-size: var(--fs-micro);
  line-height: 1.45;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}

.chip.run {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.chip.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.chip.warn {
  color: var(--warn-strong);
  background: var(--warn-soft);
}

.chip.bad {
  color: var(--danger-strong);
  background: var(--danger-soft);
}

.chip.idle {
  color: var(--text-2);
  background: var(--surface-2);
}

.ops {
  flex: none;
  display: flex;
  align-items: center;
  /* 14px：每颗按钮命中区外扩 7px 后正好相接，谁也不偷谁的边缘 */
  gap: 14px;
}

.op {
  position: relative;
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

/* 命中区撑到 44×44，视觉尺寸不动 —— 这一页上「移除」紧挨着「重试」，拇指最容易点错 */
.op::after {
  content: '';
  position: absolute;
  inset: -7px;
}

.op:active {
  transform: scale(0.9);
}

.op.danger {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.foot-hint {
  margin-top: 8px;
  font-size: var(--fs-micro);
  color: var(--text-2);
  line-height: 1.5;
}

.fault {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-caption);
  color: var(--warn-strong);
  background: var(--warn-soft);
  border-radius: var(--radius-m);
  padding: 9px 11px;
  margin-bottom: 14px;
  line-height: 1.45;
}

.bulk {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 2px 0;
}

.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent-strong);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: var(--fs-micro);
  color: var(--text-2);
  line-height: 1.5;
  margin-top: 12px;
}

.hint svg {
  flex: none;
  margin-top: 2px;
}

.inline-link {
  color: var(--accent-strong);
  font-weight: 600;
}

.cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: 9px 22px;
}
</style>
