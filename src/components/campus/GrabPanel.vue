<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  Layers,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Stethoscope,
  Trash2,
  Zap,
} from 'lucide-vue-next'

import GrabResult from '@/components/campus/GrabResult.vue'
import { campusService } from '@/services/campusService'
import { grabStatusMeta, idOf, useCourseSelectStore } from '@/stores/courseSelect'
import type { GrabPreflight, GrabTask } from '@/types'
import { askAiForGrabRescue } from '@/utils/campusAi'

/**
 * 抢课任务单面板 —— 引擎的仪表盘。
 *
 * 这里要回答三个问题，且必须在**不盯着屏幕**时也能一眼答上：
 * 1. 现在在抢什么？（任务行 + 状态标签）
 * 2. 什么时候出手？（倒计时，按服务器时钟校正）
 * 3. 出事了吗？（引擎级故障横幅 / 任务失败原因）
 *
 * **没有在抢的时候，它整体让位给 [`GrabResult`]** —— 那一刻用户要的不是「过程」，
 * 而是「拿到了什么、还欠什么、现在做什么」（见那个组件的说明）。
 *
 * 倒计时每秒刷一次：它只是个显示，真正的开火时刻在 Rust 那边，
 * 界面卡了、页面切走了都不影响抢课 —— 所以这里用本地定时器完全够用。
 */
const store = useCourseSelectStore()
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

/* ---------------- 起飞前自检 ----------------
 *
 * 抢课最贵的一种失败是「**以为在抢，其实早就放弃了**」：名单没拉到、计划一个班都没匹配上、
 * 时钟没测准、窗口已经过去 —— 这些在任务列表里都长得像「在等待」。
 * 所以这里给一个按钮，把每一件「行不行」连同证据一次摆出来。
 *
 * 它是**按需触发**的（会打几次网络，和预览一个量级），不自动跑：
 * 自动跑就等于每分钟替用户做一次全量体检，而绝大多数时候他只想看一眼进度。
 */
const preflight = ref<GrabPreflight | null>(null)
const preflightBusy = ref(false)

async function runPreflight(): Promise<void> {
  if (preflightBusy.value) return
  preflightBusy.value = true
  try {
    preflight.value = await campusService.grabPreflight()
  } catch (e) {
    preflight.value = {
      ok: false,
      items: [],
      summary: e instanceof Error ? e.message : '体检失败',
    }
  } finally {
    preflightBusy.value = false
  }
}

/**
 * 页面级的几件事实由页面传进来（服务器时钟、上次刷新时刻、对时偏差、账号、当前窗口）。
 *
 * 为什么不在这里自己算：这些值每一秒都在变，而页面已经在算它们了 —— 复制一份
 * 就是给「同一件事两种说法」再开一条路（这块板上已经吃过一次这个亏）。
 */
const props = withDefaults(
  defineProps<{
    /** 教务服务器时间（已在页面里按采样时刻线性推进到当下） */
    clock?: string
    /** 上一次自动刷新的时刻 */
    refreshedAt?: string
    /** 对时偏差告警，空串表示没有值得说的偏差 */
    skew?: string
    /** 「张伟 20231001」 */
    account?: string
    /** 当前批次的窗口：「07-31 10:00 → 09-30 23:00」 */
    windowText?: string
  }>(),
  { clock: '', refreshedAt: '', skew: '', account: '', windowText: '' },
)

onMounted(() => {
  tick = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
})

const tasks = computed(() => store.grabTasks)
const actives = computed(() => store.activeTasks)
const paused = computed(() => tasks.value.filter((t) => t.status === 'paused'))
/** 未结束的排前面，已结束的沉底（后端已经排好序，这里只负责分组渲染） */
const finished = computed(() =>
  tasks.value.filter(
    (t) =>
      t.status === 'success' ||
      t.status === 'failed' ||
      t.status === 'conflict' ||
      t.status === 'cancelled' ||
      // 被教务拒绝的也是「这一轮的结局」：引擎已经停手，它该出现在结果里，
      // 而不是留在任务单上看着像还在抢
      t.status === 'needs_ai',
  ),
)

/**
 * 结束态：没有在抢的、也没有被暂停的，但手上有已结束的记录 —— 这时该显示**结果**。
 *
 * 判定里必须有「也没有被暂停的」：全部暂停时 `actives` 同样是空的，
 * 但那些任务还没结束（用户随时会恢复），把它们盖在结果面板下就看不见了。
 */
const resultMode = computed(
  () => actives.value.length === 0 && paused.value.length === 0 && finished.value.length > 0,
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

/**
 * T-0 前后这块板要**换形态**，而不是只换个数字。
 *
 * 一个 12:34 的倒计时和 00:07 的倒计时长得一样，但它们是完全不同的两件事：
 * 前者是等待，后者是「下一秒就出手」。形态（底色、脉冲、数字颜色）就是用来
 * 让人从余光里也能分辨这一点 —— 尤其这块板会成为首屏第一眼看到的东西。
 */
const stageHot = computed(() => {
  if (countdown.value === '正在开抢') return true
  const ms = store.fireInMs(now.value)
  return ms != null && ms <= 10_000
})

/**
 * 给读屏的播报：**只报关键节点**。
 *
 * 可见的那个大数字挂的是 `aria-hidden` —— 它每秒都在变，读屏会跟着念一整晚。
 * 按 5 分钟 / 1 分钟 / 10 秒 / 开抢 四档播报，既听得见关键进展，又不吵。
 */
const spoken = computed(() => {
  const ms = store.fireInMs(now.value)
  if (ms == null) return ''
  if (ms <= 0) return '正在开抢'
  const s = Math.ceil(ms / 1000)
  if (s <= 10) return `还有 ${s} 秒开抢`
  if (s <= 60) return '不到一分钟就要开抢'
  if (s <= 300) return '还有五分钟就要开抢'
  return ''
})

/**
 * **阶段陈述**：这块板上最重要的一句话。
 *
 * 它回答的是「现在到底在发生什么」—— 而这恰恰是原先最含糊的地方：
 * 状态散在倒计时、徽标、空态和跨页浮条四处，用户得自己拼。
 * 一句人话 + 一个必要时才出现的倒计时，比四个各自为政的指示器都管用。
 */
const phaseText = computed(() => {
  if (store.grabError) return '引擎停了 —— 先处理上面的问题'
  if (store.rejectedTasks.length) return '有请求被教务拒了（参数错误），已交给 AI 排查'
  if (resultMode.value) return ''
  if (!hasAny.value) return listening.value ? '正在盯着选课窗口' : '还没有排队的课程'
  if (actives.value.some((t) => (t.attempts ?? 0) > 0 || (t.polls ?? 0) > 0)) {
    return '已经出手了'
  }
  if (actives.value.some((t) => t.awaitWindow && !t.windowWall)) {
    return '已排好，等教务公布窗口'
  }
  if (countdown.value === '正在开抢') return '正在开抢'
  if (actives.value.length && actives.value.every((t) => t.fireAt != null)) {
    return '已排好，等窗口开了就出手'
  }
  return '正在按节奏重试'
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

/**
 * 「这一秒为什么没在打」——等待中的任务要有这句话。
 *
 * 引擎被拒之后会让那个候选先退开一会儿（冷却），把机会交给组里下一个候选
 * （见 Rust 侧 `REJECT_COOLDOWN_MS` / `group_lead`）。界面上如果只写「待开抢」，
 * 用户看到的就是「它明明该在抢却一动不动」—— 而真相是「它在按冷却排队」。
 */
function waitText(t: GrabTask): string {
  if (t.status !== 'waiting' && t.status !== 'running') return ''
  const ms = (t.nextAt ?? 0) - now.value
  if (ms <= 0) return ''
  if (ms < 1000) return '马上重试'
  const s = Math.ceil(ms / 1000)
  return s < 60 ? `${s} 秒后重试` : `${Math.ceil(s / 60)} 分钟后重试`
}

/** 一行副标题：课程号 · 第几次尝试 · 什么时候再动 · 教务最近说了什么 */
function detail(t: GrabTask): string {
  const bits: string[] = []
  if (t.courseCode) bits.push(t.courseCode)
  if (t.attempts > 0) bits.push(`已尝试 ${t.attempts} 次`)
  const wait = waitText(t)
  if (wait) bits.push(wait)
  if (t.lastMessage) bits.push(t.lastMessage)
  return bits.join(' · ')
}

async function act(id: number, action: 'pause' | 'cancel' | 'retry' | 'remove'): Promise<void> {
  await store.taskAction(id, action)
}

/**
 * 行上那枚徽标：**引擎级故障时一律改成「引擎已停」**。
 *
 * 会话失效时后端只是把任务降速重排（`status` 仍是 waiting），所以行内会继续挂着蓝色的
 * 「待开抢 / 排队中」—— 而它此刻根本不会开火。同一个状态在浮条上叫「已暂停」、
 * 在行内叫「待开抢」、实际是「每分钟重试一次」，三种说法里只有一种是真的。
 */
function chipOf(t: GrabTask): { label: string; tone: string } {
  if (store.grabError && (t.status === 'waiting' || t.status === 'running')) {
    return { label: '引擎已停', tone: 'bad' }
  }
  return grabStatusMeta(t)
}

/**
 * 移除是**两步**的：这些行是「抢到了什么」的唯一本地记录，
 * 一次误触就把它删掉不值 —— 尤其它离「重试 / 取消」只有 4px。
 */
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
/**
 * 「它还在盯着」这句话必须**只在该说的时候说**。
 *
 * 判据是引擎真的在报数：`alive`（线程活着）+ 最近一次窗口探测足够新。
 * 早先这里只看 `probedAt != null` —— 那是「历史上探测过一次」，
 * 引擎停了、会话掉了它都还是真，等于在安慰用户。
 */
const listening = computed(() => {
  const g = store.grab
  if (!g || !g.alive) return false
  return g.probedAt != null && now.value - g.probedAt < 3 * 60_000
})

/**
 * 交给 AI 排查：把现场（引擎故障原文、任务卡在哪一步、计划解析状态、批次窗口）压成一段话递过去，
 * 由 AI 决定是重登、重排、改节奏，还是去教务那边看原始响应。
 *
 * 为什么要有这个入口：引擎能自己处理的失败都已经自己处理了（重试、退避、会话自愈），
 * 剩下它处理不了的 —— 教务改了接口、文案换了、批次规则变了 —— 恰恰是人最不知道从哪下手的那类。
 */
function handToAi(): void {
  askAiForGrabRescue(store.grab)
}
</script>

<template>
  <!-- 没有任务但**引擎在监听**时也要显示：大一新生在窗口开放前没有任何任务可排，
       「它正在盯着窗口」就是他唯一能看到的进展（早先这块只在出错时才渲染，等于没说） -->
  <section v-if="hasAny || store.grabError || listening || props.clock" class="card grab" :class="{ hot: stageHot }">
    <header class="head">
      <span class="row title">
        <Zap :size="15" class="bolt" />
        <b>抢课</b>
        <span v-if="actives.length" class="live num">{{ actives.length }} 个进行中</span>
        <span v-if="!store.grab?.alive && (hasAny || listening)" class="chip bad">引擎没在跑</span>
      </span>

      <!-- 主数字：这是整页最该一眼看到的东西。倒计时**只有真的存在时**才出现 ——
           没有值得等的时刻就不摆一个数字在那儿 -->
      <template v-if="countdown">
        <span class="cd-label t-3">距出手</span>
        <p class="cd-big num" :class="{ live: countdown === '正在开抢' }" aria-hidden="true">
          {{ countdown }}
        </p>
      </template>

      <!-- 一句话阶段：先说「现在在发生什么」，再给「还有多久」 -->
      <p class="phase" role="status" :class="{ lede: !countdown }">
        {{ phaseText || (listening ? '正在盯着选课窗口' : '等你安排要抢的课') }}
      </p>

      <!-- 副信息：教务的钟、上次刷新、当前窗口、账号，全部降级成这一行小字。
           抢课对时全靠教务的钟，但它不该比「还有多久出手」更抢眼 -->
      <p class="facts t-3">
        <span class="num">教务服务器时间 {{ props.clock || '—' }}</span>
        <span v-if="props.refreshedAt">· 上次刷新 {{ props.refreshedAt }}</span>
        <span v-if="props.windowText">· 窗口 {{ props.windowText }}</span>
        <span v-if="props.account">· {{ props.account }}</span>
      </p>

      <p class="engine t-3">
        <ShieldAlert :size="12" />
        引擎跑在 App 进程里：App 被划掉或清理后就不再出手
      </p>

      <!-- 起飞前自检：一行按钮 + 逐项结果。它回答的是「现在这套配置真能抢到吗」，
           而不是「任务跑到哪一步了」—— 那两件事在出问题时长得一样 -->
      <div class="preflight">
        <button class="pf-go" type="button" :disabled="preflightBusy" @click="runPreflight">
          <Stethoscope :size="13" />
          {{ preflightBusy ? '正在体检…' : '起飞前自检' }}
        </button>
        <span v-if="preflight" class="pf-sum" :class="preflight.ok ? 'ok' : 'bad'">
          {{ preflight.summary }}
        </span>
      </div>
      <ul v-if="preflight?.items.length" class="pf-list">
        <li v-for="it in preflight.items" :key="it.key + it.label" :class="it.ok ? 'ok' : 'bad'">
          <span class="pf-mark" aria-hidden="true">{{ it.ok ? '✓' : '✕' }}</span>
          <span class="col">
            <b>{{ it.label }}</b>
            <em class="t-3">{{ it.detail }}</em>
          </span>
        </li>
      </ul>

      <p v-if="props.skew" class="warn" role="status">
        <AlertTriangle :size="14" /> {{ props.skew }}
      </p>

      <!-- 读屏专用：只有跨档才说话（可见的大数字是 aria-hidden 的） -->
      <span class="sr" aria-live="polite">{{ spoken }}</span>
    </header>

    <!-- 引擎级故障：会话失效这类问题必须显眼 -->
    <p v-if="store.grabError" class="fault" role="status">
      <AlertTriangle :size="14" />
      <span>{{ store.grabError }}</span>
      <button class="fix" type="button" @click="handToAi">交给 AI 排查</button>
      <RouterLink :to="{ name: 'campus-settings' }" class="fix">去重登</RouterLink>
    </p>

    <!-- **参数错误**：教务拒了这条请求 —— 重试不会改变结果，引擎已经停手。
         这里要说清「为什么停了」并给出唯一有用的下一步（交 AI / 重新解析），
         而不是让用户对着一个不动的任务反复点重试。 -->
    <div v-if="store.rejectedTasks.length" class="rejected" role="status">
      <p class="rl">
        <Ban :size="14" />
        <span>
          教务拒绝了 {{ store.rejectedTasks.length }} 条请求（参数错误）——
          <b>重试不会成功</b>，引擎已停手，等 AI 查明教务现在要什么参数
        </span>
      </p>
      <p class="why t-3">{{ store.rejectedTasks[0]!.lastMessage }}</p>
      <div class="row acts">
        <button class="fix" type="button" @click="handToAi">交给 AI 排查</button>
        <button
          class="fix"
          type="button"
          @click="store.rejectedTasks.forEach((t) => act(t.id, 'retry'))"
        >
          重新排队试试
        </button>
      </div>
    </div>

    <p v-if="!hasAny" class="t-3 empty">
      还没有排队的课程。
      <span v-if="listening" class="listen">{{ listenText }}</span>
    </p>

    <!-- 结束态：没有在抢的了 —— 把「结果」顶上来。此刻「正在抢什么」已经没有内容，
         而用户（多半是睡醒的人）要的是「拿到了什么、还欠什么、现在做什么」 -->
    <GrabResult
      v-else-if="resultMode"
      :tasks="finished"
      @retry="(id: number) => act(id, 'retry')"
      @clean="store.clearFinished()"
    />

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

        <li v-else class="task" :class="chipOf(row.t).tone">
          <div class="col flex-1 body">
            <div class="row line1">
              <span v-if="row.t.groupKey" class="ord num">第 {{ row.t.priority ?? '?' }}</span>
              <span class="name">{{ title(row.t) }}</span>
              <span class="chip" :class="chipOf(row.t).tone">{{ chipOf(row.t).label }}</span>
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
              :class="{ danger: pendingRemove === row.t.id }"
              :title="pendingRemove === row.t.id ? '再点一次确认移除' : '移除'"
              :aria-label="pendingRemove === row.t.id ? '确认移除' : '移除'"
              @click="askRemove(row.t.id)"
            >
              <Check v-if="pendingRemove === row.t.id" :size="14" />
              <Trash2 v-else :size="14" />
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
      <button v-else-if="paused.length" class="link" @click="store.resumeAll()">全部恢复</button>
      <!-- 结束态下清理由结果面板负责（那里是两步确认的），这里不再给第二个入口 -->
      <button v-if="finished.length && !resultMode" class="link t-3" @click="store.clearFinished()">
        <CheckCircle2 :size="13" /> 清掉已结束的 {{ finished.length }} 条
      </button>
      <!-- 常驻入口：引擎能自己处理的失败都自己处理了，剩下处理不了的那些才需要人喊 AI -->
      <button class="link ai" type="button" @click="handToAi">
        <Sparkles :size="13" /> 交给 AI 排查
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
  flex-direction: column;
  gap: 3px;
  margin-bottom: 10px;
}

.title {
  display: flex;
  align-items: center;
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
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: 1px 8px;
}

/* 阶段陈述：这块板上最该被读到的一行 —— 15px 正文级，而不是 12px 的元信息 */
.phase {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.4;
}

/* 没有倒计时时，这句话就是主角：抬到 headline 级 */
.phase.lede {
  font-size: var(--fs-headline);
}

/* 那句「距出手」的小标签：说明下面这个数字是什么 */
.cd-label {
  font-size: var(--fs-micro);
  margin-top: 2px;
}

/* 主数字：整页最大的字。倒计时是决定成败的那个量，它比教务的钟更该抢眼 ——
   早先这里是 15px/--text-2，比旁边的钟还弱，正好把权重放反了 */
.cd-big {
  font-size: var(--fs-display-s);
  font-weight: 700;
  letter-spacing: -0.5px;
  line-height: 1.05;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.cd-big.live {
  font-size: var(--fs-display-m);
  color: var(--accent-strong);
  animation: pulse 1.4s ease-in-out infinite;
}

/* 副信息：一行小字，允许折行；它们是背景事实，不该跟主数字抢注意力 */
.facts,
.engine {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0 6px;
  font-size: var(--fs-micro);
  line-height: 1.6;
}

.engine {
  gap: 0 4px;
}

/* 起飞前自检：按钮与逐项结果。刻意做成「一行小字 + 一个按钮」的份量 ——
   它是出事时才会去看的东西，不该跟倒计时抢注意力 */
.preflight {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  margin-top: 2px;
}

.pf-go {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill, 999px);
  background: transparent;
  color: var(--text-2);
  font-size: var(--fs-micro);
  cursor: pointer;
}

.pf-go:disabled {
  opacity: 0.6;
  cursor: default;
}

.pf-sum {
  font-size: var(--fs-micro);
}

.pf-sum.ok {
  color: var(--ok, var(--accent-strong));
}

.pf-sum.bad {
  color: var(--danger, #c0392b);
}

.pf-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pf-list li {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.pf-list li .col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pf-list li em {
  font-style: normal;
  word-break: break-word;
}

.pf-mark {
  flex: none;
  width: 1em;
  text-align: center;
}

.pf-list li.ok .pf-mark {
  color: var(--ok, var(--accent-strong));
}

.pf-list li.bad .pf-mark {
  color: var(--danger, #c0392b);
}

/* T-0 前后换形态：整块板染色 + 描边，余光里也能看出「正在出手」 */
.grab.hot {
  background: var(--accent-soft);
  box-shadow: var(--shadow-card), inset 0 0 0 1px var(--accent);
}

/* 读屏专用文本：可见的那个大数字每秒都变，不能让它当 live region */
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes pulse {
  50% {
    opacity: 0.45;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cd.hot {
    animation: none;
  }
}

/* 对时偏差告警：教务的钟与本机差得太多时说一句，抢课一律以教务时间为准 */
.warn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-micro);
  color: var(--warn-strong);
  line-height: 1.4;
  margin-top: 4px;
}

.fault {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-micro);
  color: var(--warn-strong);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border-radius: var(--radius-m);
  padding: 8px 10px;
  margin-bottom: 10px;
  line-height: 1.45;
}

.fix {
  font-weight: 700;
  color: var(--accent-strong);
  margin-left: auto;
}

/* 被教务拒绝的请求：警告色但**给出路**（交 AI / 重新排队），不做成死路一条的红条 */
.rejected {
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border-radius: var(--radius-m);
  padding: 8px 10px;
  margin-bottom: 10px;
}

.rl {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--fs-micro);
  color: var(--warn-strong);
  line-height: 1.45;
}

.why {
  font-size: var(--fs-micro);
  margin-top: 4px;
  line-height: 1.45;
  word-break: break-word;
}

.rejected .acts {
  gap: 14px;
  margin-top: 6px;
}

/* 这一块里的按钮有自己的排布，别继承 .fix 的「推到右边」 */
.rejected .fix {
  margin-left: 0;
  min-height: 32px;
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
  color: var(--accent-strong);
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

/* 组内的行往右缩一格，一眼看出「这些是一伙的」。
   2px 等于没缩 —— 组头与成员在视觉上连成一片，志愿组的边界只能靠读文字才知道。 */
.squad + .task {
  padding-left: 14px;
}

.ord {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--accent-strong);
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
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.chip.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.chip.warn {
  color: var(--warn-strong);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}

.chip.bad {
  color: var(--danger-strong);
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
  /* 16px 而不是 12px：每个按钮的命中区外扩 7px，相邻两个才不会互相压住
     （重合成 14px 时「取消」会偷走「暂停」的边缘，那比按钮小更糟） */
  gap: 16px;
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

/* 命中区撑到 44×44，但视觉尺寸不动 —— 这几个按钮是时间压力下最容易点错的那排，
   视觉上放大它们会挤掉任务行里的信息，扩命中区则两全（手机上是拇指在点）。
   间距同时从 4px 放到 12px：命中区外扩 7px 后相邻两个不会互相压住 —— 否则
   「取消」会偷走「暂停」右边缘那几像素，那比按钮小更糟。 */
.op::after {
  content: '';
  position: absolute;
  inset: -7px;
}

.op.danger {
  background: var(--danger-soft);
  color: var(--danger-strong);
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
  color: var(--accent-strong);
}

.link.t-3 {
  color: var(--text-3);
}

/* AI 排障入口：平时不抢注意力（和「全部暂停」同档），出问题时它才是最有用的那个。
   `margin-left: auto` 把它推到右侧，与左边的操作分开，避免误点。 */
.link.ai {
  margin-left: auto;
  color: var(--accent-strong);
}
</style>
