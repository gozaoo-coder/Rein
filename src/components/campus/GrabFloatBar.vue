<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CheckCircle2, ChevronRight, Loader2, TriangleAlert, Zap } from 'lucide-vue-next'

import { grabStatusMeta, useCourseSelectStore } from '@/stores/courseSelect'

/**
 * 抢课悬浮条 —— 全应用常驻的「抢课监视器」。
 *
 * 引擎本来就在应用启动时自己跑（`grab.rs` 的后台线程 + 落库的任务单），
 * 所以「一打开软件就检查要不要开始抢课」这件事**本来就是成立的** ——
 * 缺的只是**看得见**：任务单此前只在选课页里露脸，用户得先点进去才知道现在什么情况。
 *
 * 这条浮条补的就是那一眼：
 * - 有任务在排队 → 到点前显示倒计时，到点后显示「正在开抢」；
 * - 抢到了 / 出事了 → 短暂停留后自己消失（成功让人安心，失败要能看见）；
 * - 点一下进选课页看全部任务。
 *
 * 放在**顶部**而不是底部，是刻意的：底部已经挤了运动条、录音条、语音条三条浮条，
 * 再塞一条必然打架；而且监视器的语义就是「抬头看一眼」，顶部更符合这个直觉。
 */
const store = useCourseSelectStore()
const route = useRoute()
const router = useRouter()

const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  // 订阅放在这里而不是选课页：这样无论用户从哪个页面启动 App，监视器都在看着
  await store.attachGrab()
  tick = setInterval(() => { now.value = Date.now() }, 1000)
})

onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
})

/** 已经在选课页就没必要再浮一条（那里的面板信息更全） */
const onSelectPage = computed(() => route.name === 'campus-course-select')

const actives = computed(() => store.activeTasks)

/** 有结果但还没被用户看到 —— 停一会儿再收，别让「抢到了」悄悄溜走 */
const justFinished = ref<{ label: string; ok: boolean; at: number } | null>(null)
const SEEN_MS = 12_000

/** 盯住任务状态变化：刚变成终态的那一条值得单独报一次 */
let lastTerminal = new Set<number>()
function watchTerminal(): void {
  const terminal = store.grabTasks.filter(
    (t) => t.status === 'success' || t.status === 'failed' || t.status === 'conflict',
  )
  for (const t of terminal) {
    if (lastTerminal.has(t.id)) continue
    lastTerminal.add(t.id)
    const name = t.courseName || t.lessonName || `教学班 ${t.id}`
    justFinished.value = {
      label:
        t.status === 'success'
          ? `已抢到《${name}》`
          : t.status === 'conflict'
            ? `《${name}》时间冲突，需办免听`
            : `《${name}》未能抢到`,
      ok: t.status === 'success',
      at: Date.now(),
    }
  }
  // 任务被清掉后，id 集合也要跟着收，否则重新加入同 id 的任务不会再报
  if (terminal.length < lastTerminal.size) {
    lastTerminal = new Set(terminal.map((t) => t.id))
  }
}

/* ---------------- 窗口开放 ----------------
 * 「窗口开了」是这套系统里唯一值得**跨页面**播报的事件：抢课窗口只开几小时，
 * 而大一在窗口开放前连课都查不到，没有任何任务可以排。
 */
const windowNotice = ref<{ label: string; at: number } | null>(null)
const WINDOW_SEEN_MS = 30_000
/** 上一次看到的状态：只在「没开 → 开了」那一下报，反复推同一份快照不该反复弹 */
let sawOpenWindow = false
let sawFirstProbe = false

function watchWindowOpen(): void {
  const snap = store.grab
  // 第一次探测只建立基线：那时「批次已存在」不是新闻
  if (!sawFirstProbe) {
    if (snap?.probedAt == null) return
    sawFirstProbe = true
    sawOpenWindow = (snap.turns ?? []).some((t) => t.allowEnter)
    return
  }
  const open = (snap?.turns ?? []).filter((t) => t.allowEnter)
  if (open.length && !sawOpenWindow) {
    sawOpenWindow = true
    windowNotice.value = {
      label: `选课窗口已开放：${open.map((t) => t.name ?? t.id).join('、')}`,
      at: Date.now(),
    }
  } else if (!open.length) {
    sawOpenWindow = false
  }
}

/**
 * 引擎每推一份新快照就过一遍。
 *
 * 之前这里只在 setup 里裸调了一次 `watchTerminal()` —— 那是「挂载那一刻恰好是终态」
 * 才会报，之后抢到了也不会响。改成跟着快照走才对得上它的注释。
 */
watch(
  () => store.grab,
  () => {
    watchTerminal()
    watchWindowOpen()
  },
  { immediate: true },
)

/** 最急的那条任务：倒计时按它算 */
const lead = computed(() => {
  const list = actives.value
  if (!list.length) return null
  return [...list].sort((a, b) => {
    const fa = a.fireAt ?? Number.MAX_SAFE_INTEGER
    const fb = b.fireAt ?? Number.MAX_SAFE_INTEGER
    return fa - fb
  })[0]!
})

/**
 * 倒计时**只认引擎算好的那个时刻**（`GrabState.nextFireAt`）。
 *
 * 早先这里是自己在任务行里找「最早的 fireAt」，于是和面板上的倒计时会互相打架；
 * 而且碰到「窗口还没公布」的任务（`fireAt` 是 `i64::MAX` 那种哨兵值）时，
 * 算出来是一串天文数字。引擎那边已经算过一遍了 —— 它还知道时钟偏差与提前量，
 * 界面不该再算第二遍。
 */
const countdown = computed(() => {
  const ms = store.fireInMs(now.value)
  if (ms == null || ms <= 0) return ''
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
})

/** 倒计时只剩几秒就该用「马上要开始了」的语气 */
const imminent = computed(() => {
  const ms = store.fireInMs(now.value)
  return ms != null && ms <= 60_000
})

const finishedFresh = computed(() => {
  const f = justFinished.value
  if (!f) return null
  return Date.now() - f.at < SEEN_MS ? f : null
})

/** 依赖 `now` 才会每秒重算 —— 否则这条提示出来就不会自己消失了 */
const windowFresh = computed(() => {
  const w = windowNotice.value
  if (!w) return null
  return now.value - w.at < WINDOW_SEEN_MS ? w : null
})

const show = computed(() => {
  if (onSelectPage.value) return false
  if (windowFresh.value) return true
  if (finishedFresh.value) return true
  return actives.value.length > 0 || !!store.grabError
})

const tone = computed(() => {
  if (store.grabError) return 'bad'
  if (windowFresh.value) return 'ok'
  if (finishedFresh.value) return finishedFresh.value.ok ? 'ok' : 'bad'
  return 'run'
})

const text = computed(() => {
  if (store.grabError) return '抢课引擎已暂停'
  // 窗口开放优先于任务播报：那一刻用户最该做的是进去排课
  if (windowFresh.value) return windowFresh.value.label
  if (finishedFresh.value) return finishedFresh.value.label
  const n = actives.value.length
  const t = lead.value
  if (!t) return ''
  const name = t.courseName || t.lessonName || '课程'
  if (countdown.value) {
    return imminent.value
      ? `马上开抢 · 《${name}》 · ${countdown.value}`
      : `待开抢 · 《${name}》 · ${countdown.value}`
  }
  const meta = grabStatusMeta(t)
  return n > 1 ? `${name} 等 ${n} 门 · ${meta.label}` : `${name} · ${meta.label}`
})

function open(): void {
  void router.push({ name: 'campus-course-select' })
}
</script>

<template>
  <Transition name="hud">
    <!-- 整条浮条**不再是**一个按钮：它压在页头之上横跨大半屏，装在兜里误触一下就跳页。
         现在是「一块会播报的状态条 + 一个明确的『去看』按钮」——
         既让读屏能读到（role=status），也不会再躺着中枪 -->
    <div v-if="show" class="hud glass-surface" :class="tone" role="status" :aria-label="`抢课监视：${text}`">
      <span class="dot" :class="{ pulse: tone === 'run' }" />
      <Zap v-if="tone === 'run'" :size="14" class="ico" />
      <CheckCircle2 v-else-if="tone === 'ok'" :size="14" class="ico" />
      <TriangleAlert v-else :size="14" class="ico" />
      <span class="txt">{{ text }}</span>
      <Loader2 v-if="tone === 'run' && !countdown" :size="13" class="spin" />
      <button class="go" type="button" aria-label="查看抢课任务" @click="open">
        <ChevronRight :size="15" />
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.hud {
  position: fixed;
  top: calc(var(--safe-top) + 8px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 80;
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: min(calc(var(--frame-max) - 24px), calc(100vw - 24px));
  padding: 8px 12px;
  border-radius: var(--radius-full);
  color: var(--text-1);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.hud:active {
  transform: translateX(-50%) scale(0.97);
}

.txt {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-caption);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.ico {
  flex: none;
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.hud.ok .dot {
  background: var(--ok);
}

.hud.bad .dot {
  background: var(--danger);
}

.hud.ok .ico {
  color: var(--ok);
}

.hud.bad .ico {
  color: var(--danger);
}

.hud.run .ico {
  color: var(--accent);
}

.dot.pulse {
  animation: hud-pulse 1.1s ease-in-out infinite;
}

@keyframes hud-pulse {
  50% {
    opacity: 0.25;
  }
}

.spin {
  flex: none;
  color: var(--accent);
  animation: hud-spin 1.1s linear infinite;
}

@keyframes hud-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 「去看」是浮条里**唯一**的按钮：命中区撑到 44×44（浮条本身才 33px 高），
   这样它既好点，又不会像整条浮条那样在兜里被误触 */
.go {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-3);
}

.go::after {
  content: '';
  position: absolute;
  inset: -9px;
}

.go:active {
  background: var(--surface-2);
}

/* 进出：从顶部滑入，别用缩放——它是「降下来的一条」，不是弹出来的 */
.hud-enter-active,
.hud-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-out);
}

.hud-enter-from,
.hud-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-14px);
}

@media (prefers-reduced-motion: reduce) {
  .dot.pulse,
  .spin {
    animation-duration: 3s;
  }
}
</style>
