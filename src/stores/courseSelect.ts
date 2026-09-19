import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { campusService, onGrabState } from '@/services/campusService'
import type {
  CourseSelectLesson,
  CourseSelectStatus,
  CourseSelectTurn,
  GrabAction,
  GrabSettings,
  GrabState,
  GrabTargetInput,
  GrabTask,
  LessonQuery,
} from '@/types'

/** 轮询节奏与 SPA 一致：每 2 秒一次、最多 10 次（约 20 秒） */
const POLL_INTERVAL_MS = 2000
const POLL_MAX = 10

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 教学班 id 转成路径/参数能用的字符串（后端是不透明值） */
export function idOf(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * 选课域 store。
 *
 * 与 `stores/campus` 分开：那边是课表（读 `campus_sessions`），这边是选课窗口
 * （打 `course-selection-api`），两者的生命周期与失败模式都不一样，
 * 混在一个 store 里会让「课表好好的但选课令牌过期了」这类状态互相污染。
 *
 * **抢课不由这个 store 驱动。** 引擎跑在 Rust 后台线程里（见 `modules/campus/grab.rs`），
 * 这里只做两件事：把任务单读出来显示、把用户的意图发下去。页面关掉，抢课照常进行 ——
 * 这既是有意的设计，也是抢课唯一说得通的做法（窗口往往在用户没盯着屏幕的时候开）。
 *
 * 因此这里的 `grab` 状态有**两个来源**：进页面时 `loadGrab()` 拉一次，
 * 之后全靠 `campus://grab` 事件推送更新。两者同形，所以渲染逻辑只有一份。
 */
export const useCourseSelectStore = defineStore('courseSelect', () => {
  const status = ref<CourseSelectStatus | null>(null)
  const loading = ref(false)
  const error = ref('')

  /** 当前进入的批次 */
  const activeTurn = ref<CourseSelectTurn | null>(null)
  const lessons = ref<CourseSelectLesson[]>([])
  const lessonsLoading = ref(false)
  const keyword = ref('')

  /** 正在提交的教学班 id（防止连点重复提交） */
  const submitting = ref<string | null>(null)
  /** 最近一次提交的进度文案（「已提交，等待教务处理…」这类） */
  const progress = ref('')

  /* ---------------- 抢课任务单 ---------------- */
  const grab = ref<GrabState | null>(null)
  const grabSettings = ref<GrabSettings | null>(null)
  const grabBusy = ref(false)
  /** 订阅取消函数。页面卸载时必须调用，否则事件会重复派发 */
  let unlisten: (() => void) | null = null

  const turns = computed(() => status.value?.turns ?? [])
  const hasTurn = computed(() => turns.value.length > 0)
  const serverTime = computed(() => status.value?.serverTime ?? '')

  const grabTasks = computed<GrabTask[]>(() => grab.value?.tasks ?? [])
  /** 正在抢的任务（未结束、未暂停） */
  const activeTasks = computed(() =>
    grabTasks.value.filter((t) => t.status === 'waiting' || t.status === 'running'),
  )
  const hasGrabWork = computed(() => activeTasks.value.length > 0)

  /** 引擎在跑但教务会话掉了 —— 这类故障要显眼地告诉用户去重登 */
  const grabError = computed(() => grab.value?.lastError ?? '')

  /**
   * 距下一次开火还有多久（毫秒）。
   *
   * 直接用后端算好的 `nextFireAt`：墙上时间换算掺了服务器时钟偏差与提前量，
   * 前端再实现一遍必然会漂 —— 那条换算只该有一份。
   */
  function fireInMs(now = Date.now()): number | null {
    const at = grab.value?.nextFireAt
    if (at == null) return null
    return Math.max(0, at - now)
  }

  /** 本地时间与教务服务器时间的偏差（秒）。优先用引擎实测值，它更准也更新。 */
  const clockSkewSec = computed(() => {
    const measured = grab.value?.skewSec
    if (measured != null) return measured
    const t = status.value?.serverTime
    if (!t) return null
    // 教务给的是 `2026-09-17 07:07:57`，按本地时区解析即可（同一台机器上对时）
    const parsed = new Date(t.replace(' ', 'T'))
    if (Number.isNaN(parsed.getTime())) return null
    return Math.round((parsed.getTime() - Date.now()) / 1000)
  })

  /** 某个教学班是否已经在抢课任务单里（按钮据此变成「已加入」） */
  function taskFor(lesson: CourseSelectLesson): GrabTask | null {
    const want = idOf(lesson.id)
    return (
      grabTasks.value.find(
        (t) => idOf(t.lessonId) === want && t.status !== 'cancelled',
      ) ?? null
    )
  }

  async function loadStatus(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      status.value = await campusService.courseSelectStatus()
      // 原来进入的批次如果已经不在列表里（窗口关了），退回列表
      if (activeTurn.value && !turns.value.some((t) => idOf(t.id) === idOf(activeTurn.value!.id))) {
        activeTurn.value = null
        lessons.value = []
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '获取选课状态失败'
      status.value = null
    } finally {
      loading.value = false
    }
  }

  function enterTurn(turn: CourseSelectTurn): void {
    activeTurn.value = turn
    lessons.value = []
    keyword.value = ''
  }

  function leaveTurn(): void {
    activeTurn.value = null
    lessons.value = []
    progress.value = ''
  }

  /**
   * 查询教学班。
   *
   * 教务的查询表单里，**课程名、教学班名、教师是三个独立字段**
   * （`courseNameOrCode` / `lessonNameOrCode` / `teacherNameOrCode`，
   * 见 SPA 的 `catchSearch`），而我们的界面只有一个搜索框。
   * 所以同一个关键词**三个字段都发** —— 只发其中一个会让「搜课程名」这类
   * 最常见的用法悄悄搜不到（课程名与教学班名在教务那边本来就不是一回事）。
   */
  async function loadLessons(): Promise<void> {
    const turn = activeTurn.value
    if (!turn) return
    lessonsLoading.value = true
    try {
      const kw = keyword.value.trim()
      const query: LessonQuery = kw
        ? {
            courseNameOrCode: kw,
            lessonNameOrCode: kw,
            teacherNameOrCode: kw,
            sortField: 'lessonAssoc',
            sortType: 'ASC',
          }
        : {}
      lessons.value = await campusService.courseSelectLessons(idOf(turn.id), query)
    } finally {
      lessonsLoading.value = false
    }
  }

  /**
   * 一键选课：提交 → 按 SPA 的节奏轮询结果。
   *
   * 这是「我现在就想要」的一次性动作；要**自动反复抢**请走 [`enqueue`]，
   * 那条路在 Rust 后台跑，关掉页面也继续。
   */
  async function apply(
    lesson: CourseSelectLesson,
    opts?: { virtualCost?: number | null; scheduleGroupId?: unknown },
  ): Promise<string> {
    const turn = activeTurn.value
    if (!turn) return '请先进入选课批次'

    const lid = idOf(lesson.id)
    if (!lid) return '这门课没有教学班编号，无法提交'
    submitting.value = lid
    progress.value = '正在提交…'
    try {
      const ticket = await campusService.courseSelectApply(idOf(turn.id), lesson.id, {
        virtualCost: opts?.virtualCost ?? null,
        scheduleGroupId: opts?.scheduleGroupId ?? null,
      })
      progress.value = '教务处理中…'

      for (let i = 0; i < POLL_MAX; i++) {
        const r = await campusService.courseSelectResult(ticket.requestId)
        if (!r.pending) {
          if (r.success) {
            await loadLessons()
            return '选课成功'
          }
          if (r.needAttend) {
            return '与已选课程时间冲突，需要在教务网页端办理免听'
          }
          return r.message || '选课未成功，教务未说明原因'
        }
        await sleep(POLL_INTERVAL_MS)
      }
      return '教务迟迟没有返回结果，请稍后到官方选课页确认'
    } finally {
      submitting.value = null
      progress.value = ''
    }
  }

  /* ---------------- 抢课 ---------------- */

  /** 进页面拉一次任务单，然后订阅引擎推送。 */
  async function attachGrab(): Promise<void> {
    await refreshGrab()
    if (!unlisten) unlisten = await onGrabState((s) => { grab.value = s })
  }

  function detachGrab(): void {
    unlisten?.()
    unlisten = null
  }

  async function refreshGrab(): Promise<void> {
    try {
      grab.value = await campusService.grabState()
    } catch {
      /* 拉不到就先这样：没有任务单不等于出错，事件推来时会补上 */
    }
  }

  async function loadGrabSettings(): Promise<void> {
    try {
      grabSettings.value = await campusService.grabSettingsGet()
    } catch {
      /* 设置读不到就用后端默认值，界面留空即可 */
    }
  }

  /**
   * 把课程加入抢课任务单。
   *
   * `windowWall` 从批次的精确区间里取（`selectDateTimeRange` 优先，退化到开窗区间）。
   * 取不到就传 null —— 引擎会进入「等窗口」状态，每分钟去问一次，**不会盲撞**：
   * 盲撞出来的「不在选课时间」会被判成终态，等于预设白费。
   *
   * `groupKey` 给了就是**志愿组**：同组互斥，只会中一个。批量加入时志愿序按
   * 数组顺序从 `priority` 起递增 —— 一次选中多个教学班排成 1/2/3 志愿是最常见的用法。
   */
  async function enqueue(
    lessonsToGrab: CourseSelectLesson[],
    opts?: {
      mode?: 'predicate' | 'direct'
      virtualCost?: number | null
      scheduleGroupId?: unknown
      groupKey?: string | null
      groupName?: string | null
      priority?: number
    },
  ): Promise<number> {
    const turn = activeTurn.value
    if (!turn) throw new Error('请先进入选课批次')
    if (!lessonsToGrab.length) return 0

    const inSquad = !!opts?.groupKey
    const base = opts?.priority ?? 1
    const targets: GrabTargetInput[] = lessonsToGrab.map((l, i) => ({
      lessonId: l.id,
      lessonName: null,
      courseName: l.course?.nameZh ?? l.course?.nameEn ?? null,
      courseCode: l.course?.code ?? null,
      teacher: teacherText(l),
      credits: l.course?.credits ?? null,
      virtualCost: opts?.virtualCost ?? null,
      // 只有单个教学班时才有「这一门的上课小组」可选；批量加入时用默认组
      scheduleGroupId: opts?.scheduleGroupId ?? null,
      groupKey: opts?.groupKey ?? null,
      groupName: opts?.groupName ?? null,
      priority: inSquad ? base + i : 0,
    }))

    grabBusy.value = true
    try {
      const ids = await campusService.grabEnqueue({
        turnId: idOf(turn.id),
        turnName: turn.name ?? null,
        targets,
        mode: opts?.mode ?? 'predicate',
        windowWall: turnWindow(turn).start,
        windowEndWall: turnWindow(turn).end,
      })
      await refreshGrab()
      return ids.length
    } finally {
      grabBusy.value = false
    }
  }

  async function taskAction(taskId: number, action: GrabAction): Promise<void> {
    await campusService.grabTaskAction(taskId, action)
    await refreshGrab()
  }

  async function clearFinished(): Promise<number> {
    const n = await campusService.grabClearFinished()
    await refreshGrab()
    return n
  }

  async function pauseAll(): Promise<void> {
    await campusService.grabPauseAll()
    await refreshGrab()
  }

  async function resumeAll(): Promise<void> {
    await campusService.grabResumeAll()
    await refreshGrab()
  }

  async function saveGrabSettings(next: GrabSettings): Promise<void> {
    grabSettings.value = await campusService.grabSettingsSet(next)
  }

  return {
    status,
    loading,
    error,
    activeTurn,
    lessons,
    lessonsLoading,
    keyword,
    submitting,
    progress,
    grab,
    grabSettings,
    grabBusy,
    turns,
    hasTurn,
    serverTime,
    clockSkewSec,
    grabTasks,
    activeTasks,
    hasGrabWork,
    grabError,
    loadStatus,
    enterTurn,
    leaveTurn,
    loadLessons,
    apply,
    attachGrab,
    detachGrab,
    refreshGrab,
    loadGrabSettings,
    enqueue,
    taskAction,
    clearFinished,
    pauseAll,
    resumeAll,
    saveGrabSettings,
    taskFor,
    fireInMs,
  }
})

/* ---------------- 纯展示辅助 ---------------- */

/** 教师字段教务给的是对象数组，只取中文名 */
export function teacherText(l: CourseSelectLesson): string | null {
  const names = (l.teachers ?? [])
    .map((t) => {
      const o = t as { nameZh?: string; person?: { nameZh?: string } } | null
      return o?.nameZh ?? o?.person?.nameZh ?? ''
    })
    .filter(Boolean)
  return names.length ? names.join('、') : null
}

/**
 * 批次的窗口时刻。
 *
 * 优先结构化区间（机器可读），退化才去抠 `selectDateTimeText` 里的波浪线 ——
 * 与 Rust 侧 `CourseSelectTurn::opens_at_text` 同一套优先级，两边必须一致，
 * 否则「界面显示的开窗时间」和「引擎实际开火的时刻」会对不上。
 */
export function turnWindow(turn: CourseSelectTurn): { start: string | null; end: string | null } {
  for (const range of [turn.selectDateTimeRange, turn.openDateTimeRange]) {
    const start = range?.startDateTime?.trim()
    if (start) return { start, end: range?.endDateTime?.trim() ?? null }
  }
  const text = turn.selectDateTimeText?.trim()
  if (!text) return { start: null, end: null }
  const [head, tail] = text.split(/[~至—]/)
  return { start: head?.trim() || null, end: tail?.trim() || null }
}

/** 抢课状态的中文标签与语义色（界面与 e2e 共用一份） */
export function grabStatusMeta(t: GrabTask): { label: string; tone: 'run' | 'ok' | 'warn' | 'bad' | 'idle' } {
  if (t.status === 'success') return { label: '已抢到', tone: 'ok' }
  if (t.status === 'conflict') return { label: '需办免听', tone: 'warn' }
  if (t.status === 'failed') return { label: '未成功', tone: 'bad' }
  if (t.status === 'cancelled') return { label: '已取消', tone: 'idle' }
  if (t.status === 'paused') return { label: '已暂停', tone: 'idle' }
  // 没结束的：把「在干嘛」讲清楚。顺序要紧 —— `phase` 必须先判，
  // 否则刚交出占位单、正在等受理的任务会显示成「待开抢」（它明明已经出手了）。
  if (t.awaitWindow && !t.windowWall) return { label: '等窗口公布', tone: 'run' }
  if (t.phase === 'poll') return { label: '等教务结果', tone: 'run' }
  if (t.attempts > 0) return { label: `第 ${t.attempts} 次尝试`, tone: 'run' }
  if (t.fireAt != null) return { label: '待开抢', tone: 'run' }
  return { label: '排队中', tone: 'run' }
}
