/**
 * 校园教务域工具 · **AI 的最后补救**。
 *
 * 另一半（照常的那一半：读培养方案、提前预约）在 `campusProgram.ts` —— 那边管
 * 「我该修什么、提前排好」，这边管「排好了却抢不到」。两边共用 `note()` 这一个审计入口。
 *
 * 抢课引擎（`src-tauri/src/modules/campus/grab.rs`）管「一切照常」：窗口到了开火、满员守着、
 * 会话掉了自己重登。这一组工具管「不照常」——教务改了接口、返回了 HTML 回退、多了个没见过的
 * 报错、任务卡死、计划怎么都解析不出来。那些时刻用户没别的办法，只能让 AI 上。
 *
 * 三件事构成一条闭环：
 * 1. `campus_status` 看清现场（含「我上一步干了什么」）；
 * 2. `campus_grab_*` / `campus_select` / `campus_session` 把状态摆回去；
 * 3. `campus_http` 看原始响应定位真因，`campus_export_script` 把这一路固化成能脱离 App 重放的脚本。
 *
 * 与 UI 的关系：这些工具调的是**同一批 Tauri 命令**（`campusService`），所以 AI 排出来的任务
 * 与人在页面上排出来的完全同形 —— 用户回到抢课页看到的就是同一份任务单。
 */

import { Type } from '@earendil-works/pi-ai'

import { campusService } from '@/services/campusService'
import { kbService } from '@/services/kbService'
import { idOf, teacherText, turnWindow } from '@/stores/courseSelect'
import type {
  AiAction,
  CourseSelectLesson,
  CourseSelectPoll,
  CourseSelectTurn,
  GrabIntent,
  GrabSettings,
  GrabState,
  GrabTask,
  RescueState,
} from '@/types'
import { defineTool, type AppTool } from './types'

/* ─────────────────────────── 投影：别把整个快照丢给模型 ─────────────────────────── */

/** 本机 unix 毫秒 → `MM-DD HH:mm:ss`。倒计时与开火时刻都是毫秒，直接看数字没意义。 */
function clock(ms?: number | null): string | undefined {
  if (!ms || ms <= 0) return undefined
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 一个任务的诊断投影：字段三十多个，但「卡在哪一步」必须留下 */
function taskDigest(t: GrabTask) {
  return {
    id: t.id,
    course: t.courseName ?? t.lessonName ?? undefined,
    teacher: t.teacher ?? undefined,
    turn: t.turnName ?? t.turnId,
    status: t.status,
    phase: t.phase,
    mode: t.mode,
    group: t.groupKey
      ? {
          key: t.groupKey,
          name: t.groupName ?? undefined,
          priority: t.priority ?? 0,
          /** 被同组更高志愿压着：它此刻不会出手，这不是故障 */
          heldBy: t.heldBy ?? undefined,
        }
      : undefined,
    attempts: t.attempts,
    polls: t.polls,
    strikes: t.strikes,
    strikeKind: t.strikeKind ?? undefined,
    requestId: t.requestId ?? undefined,
    lastMessage: t.lastMessage ?? undefined,
    fireAt: clock(t.fireAt),
    nextAt: clock(t.nextAt),
    window: t.windowWall ? `${t.windowWall} ~ ${t.windowEndWall ?? '?'}` : undefined,
    awaitWindow: t.awaitWindow || undefined,
  }
}

function turnDigest(t: CourseSelectTurn) {
  const w = turnWindow(t)
  return {
    id: idOf(t.id),
    name: t.name ?? undefined,
    allowEnter: t.allowEnter ?? false,
    window: w.start ? `${w.start} ~ ${w.end ?? '?'}` : (t.selectDateTimeText ?? undefined),
    /** 教务给的「为什么现在不能进」原文（有它就不必猜） */
    blocked: t.allowEnter ? undefined : (t.disallowReasons ?? []).join(' / ') || undefined,
  }
}

function intentDigest(i: GrabIntent) {
  return {
    id: i.id,
    query: i.query,
    turn: i.turnName ?? i.turnId ?? undefined,
    status: i.status,
    mode: i.mode,
    spread: i.spread || undefined,
    attempts: i.attempts,
    nextAt: clock(i.nextAt),
    lastMessage: i.lastMessage ?? undefined,
    /** 已解析出的志愿组（任务单上那几行归它管） */
    groups: i.groupKeys?.length ? i.groupKeys : undefined,
    candidates: i.candidates?.length
      ? i.candidates.map((c) => `${c.courseName ?? '?'}${c.teacher ? ` · ${c.teacher}` : ''}`)
      : undefined,
  }
}

function actionDigest(a: AiAction) {
  return {
    at: a.at,
    kind: a.kind,
    summary: a.summary,
    status: a.status,
    curl: a.curl && a.curl.length > 240 ? `${a.curl.slice(0, 240)}…` : (a.curl ?? undefined),
  }
}

/** 现场快照的模型视图。`includeFinished` 决定要不要带已结束的任务（默认不带）。 */
function stateDigest(s: RescueState, includeFinished: boolean, settings: GrabSettings) {
  const g: GrabState = s.grab
  const tasks = g.tasks ?? []
  const shown = includeFinished
    ? tasks
    : tasks.filter((t) => t.status !== 'cancelled' && t.status !== 'failed' && t.status !== 'success')
  return {
    account: s.account
      ? {
          loginName: s.account.loginName,
          baseUrl: s.account.baseUrl,
          loggedIn: s.account.loggedIn,
          hasPassword: s.account.hasPassword,
          student: s.account.studentName ?? undefined,
          lastSyncAt: s.account.lastSyncAt ?? undefined,
        }
      : null,
    /** 探针：true = 会话还有效；false = 被踢回登录页；null = 没探 */
    sessionAlive: s.sessionAlive,
    /** 探针自己报错了（区别于「探通了但说会话无效」） */
    sessionError: s.sessionError ?? undefined,
    clock: {
      serverTime: g.serverTime ?? undefined,
      /** 教务 wall clock − 本机（秒）。倒计时与开火时刻全按它校正 */
      skewSec: g.skewSec ?? undefined,
    },
    engine: {
      alive: g.alive,
      /** 引擎级故障原文：一旦出现，所有任务都会停下等处理 */
      error: g.lastError ?? undefined,
      active: g.active,
      /** 最近一次窗口探测的结果 */
      turns: (g.turns ?? []).map(turnDigest),
      probedAt: clock(g.probedAt),
    },
    /** 「我想抢什么」：还没解析成任务的计划 */
    intents: (g.intents ?? []).map(intentDigest),
    /** 「正在抢什么」 */
    tasks: shown.map(taskDigest),
    tasksHidden: tasks.length - shown.length,
    /** 引擎判读出来的「卡住」候选（非终态但连败或逾期未动）—— 提示，不是结论 */
    stuckTaskIds: s.stuckTaskIds,
    /** 引擎节奏（改动走 campus_grab_control 的 settings） */
    settings,
    /** 我(你)最近做过的动作 —— 避免把同一件事再做一遍 */
    recentActions: (s.recentActions ?? []).slice(0, 12).map(actionDigest),
  }
}

/* ─────────────────────────── 共用小工具 ─────────────────────────── */

/** 当前该用哪个批次：优先「允许进入」的那个，否则第一个，再否则报错说清为什么。 */
async function pickTurn(wanted?: string | null): Promise<CourseSelectTurn> {
  const status = await campusService.courseSelectStatus()
  const turns = status.turns ?? []
  const turn = wanted
    ? turns.find((t) => idOf(t.id) === wanted)
    : (turns.find((t) => t.allowEnter) ?? turns[0])
  if (!turn) {
    throw new Error(
      wanted
        ? `教务当前开放的批次里没有 ${wanted}（可能已关闭）。用 campus_status 看 engine.turns 里现在有哪几个批次。`
        : '教务现在没有开放任何选课批次。窗口还没开是常态；若你确信窗口已经开了，用 campus_http 打 ' +
          '`/course-selection-api/api/v1/student/course-select/open-turns/<学生id>` 看它到底回了什么。',
    )
  }
  return turn
}

/** 教学班 → 抢课目标。**与页面批量加入（`stores/courseSelect.ts::enqueue`）逐字段对齐** ——
 *  两处映射一旦分叉，AI 排出来的任务与用户自己排出来的就会长得不一样。 */
function targetOf(l: CourseSelectLesson) {
  return {
    lessonId: l.id,
    lessonName: null,
    courseName: l.course?.nameZh ?? l.course?.nameEn ?? null,
    courseCode: l.course?.code ?? null,
    teacher: teacherText(l),
    credits: l.course?.credits ?? null,
  }
}

function lessonDigest(l: CourseSelectLesson) {
  const groups = l.scheduleGroups ?? []
  return {
    id: idOf(l.id),
    course: l.course?.nameZh ?? l.course?.nameEn ?? undefined,
    code: l.course?.code ?? undefined,
    teacher: teacherText(l) ?? undefined,
    credits: l.course?.credits ?? undefined,
    /** 余量 = 上限 − 已选；两者都缺时为 undefined（教务没给 count） */
    seatsLeft:
      l.limitCount != null && l.stdCount != null ? l.limitCount - l.stdCount : undefined,
    limit: l.limitCount ?? undefined,
    stdCount: l.stdCount ?? undefined,
    selectable: l.canSelect ?? undefined,
    /** 教务给的自身状态（如已选/已满），原文 */
    picked: l.selectedLesson?.status ?? undefined,
    groups: groups.length
      ? groups.map((g) => ({ id: idOf(g.id), no: g.no ?? undefined, default: g.default || undefined }))
      : undefined,
  }
}

/** 轮询受理单到结论：与页面 `apply` 同一节奏（2 秒 × 10 次）。 */
async function pollTicket(
  requestId: string,
  kind: 'submit' | 'predicate',
): Promise<CourseSelectPoll & { polls: number }> {
  const read = kind === 'submit' ? campusService.courseSelectResult : campusService.courseSelectPredicateResult
  for (let i = 1; i <= 10; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const poll = await read(requestId)
    if (!poll.pending) return { ...poll, polls: i }
  }
  return {
    pending: true,
    success: false,
    message: '教务迟迟没有返回结果（问了 10 次）。受理单可能还在队列里 —— 用 campus_http 直接查一次受理单看它怎么说。',
    needAttend: false,
    polls: 10,
  }
}

/** 审计：把一次动作连同理由写进 `campus_ai_actions`（写操作不弹确认，靠这个兜底）。
 *  `campusProgram.ts` 的预约也走它 —— 审计只该有一条写入口。 */
export async function note(kind: string, summary: string, detail?: unknown): Promise<void> {
  try {
    await campusService.rescueNote({ kind, summary, detail })
  } catch {
    /* 审计失败不该把动作本身判成失败 */
  }
}

export const campusTools: AppTool[] = [
  /* ─────────────── 1. 现场 ─────────────── */
  defineTool({
    name: 'campus_status',
    group: 'campus',
    label: '教务现场',
    description:
      '一次拿到教务与抢课的完整现场：账号与会话是否有效、教务服务器时间与时钟偏差、当前开放的批次与窗口、' +
      '抢课计划解析到哪一步、每个任务卡在哪个阶段（连败几次、下次何时动它、引擎自己的报错原文），' +
      '以及**你刚才做过的动作**（避免把同一件事再做一遍）。' +
      '用户说「抢不到 / 卡住了 / 报错 / 教务那边好像变了 / 一直失败」时，先调它看清现场再动手。',
    parameters: Type.Object({
      probe: Type.Optional(
        Type.Boolean({ description: '是否真的打一次教务探测会话是否还有效，默认 true' }),
      ),
      includeFinished: Type.Optional(
        Type.Boolean({ description: '是否带上已结束的任务（默认只给在场的）' }),
      ),
    }),
    async execute(args) {
      // 快照与节奏各是一次本地查询：分开两个命令拿，但一次调用给模型 —— 现场要完整
      const [s, settings] = await Promise.all([
        campusService.rescueState(args.probe ?? true),
        campusService.grabSettingsGet(),
      ])
      return stateDigest(s, args.includeFinished ?? false, settings)
    },
  }),

  /* ─────────────── 2. 教学班 ─────────────── */
  defineTool({
    name: 'campus_lessons',
    group: 'campus',
    label: '教学班查询',
    description:
      '查教务当前批次的教学班：给关键词（空格分词，全部命中；可命中课程名/课程代码/教学班/教师）就模糊查，' +
      '不给就返回全部。用来确认「现在有哪些班、还剩多少名额、能不能选」，也是给 campus_grab_plan 挑靶子的地方。' +
      '返回教学班 id —— 提交选课与直接排查课都用它。',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '关键词，如「高数 张」；不传 = 全部' })),
      turnId: Type.Optional(Type.String({ description: '批次 id，不传 = 教务当前开放的那个' })),
      limit: Type.Optional(Type.Number({ description: '最多返回多少条（默认 40）' })),
    }),
    async execute(args) {
      const turn = await pickTurn(args.turnId)
      const q = args.query?.trim()
      const lessons = await campusService.courseSelectLessons(
        idOf(turn.id),
        q
          ? {
              // 教务把「课程」与「教学班」分成两层，一个搜索框要同时喂三个字段（对齐页面）
              courseNameOrCode: q,
              lessonNameOrCode: q,
              teacherNameOrCode: q,
              hasCount: true,
              sortField: 'lessonAssoc',
              sortType: 'ASC',
            }
          : { hasCount: true, sortField: 'lessonAssoc', sortType: 'ASC' },
      )
      const limit = Math.max(1, Math.min(args.limit ?? 40, 200))
      const sorted = [...lessons].sort((a, b) => {
        const left = (x: CourseSelectLesson) => (x.limitCount ?? 0) - (x.stdCount ?? 0)
        return left(b) - left(a)
      })
      return {
        turn: turnDigest(turn),
        total: lessons.length,
        shown: Math.min(limit, sorted.length),
        lessons: sorted.slice(0, limit).map(lessonDigest),
      }
    },
  }),

  /* ─────────────── 3. 排抢课 ─────────────── */
  defineTool({
    name: 'campus_grab_plan',
    group: 'campus',
    label: '排抢课',
    description:
      '把课排进抢课任务单，之后引擎自己守时钟与重试，不用人盯着。两种给法：' +
      '① 给 query（模糊查询，如「高数 张」）= 写一条**计划**，引擎会在能看见名单时自己解析成志愿任务 —— ' +
      '批次还没开也能写，这是提前排课的正路；' +
      '② 给 lessonIds（先用 campus_lessons 拿 id）= 直接编排定的教学班。' +
      '给多个 = 排成一个志愿组（互斥备选，只会中一个），**顺序就是志愿序**。',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '模糊查询（与 lessonIds 二选一）' })),
      lessonIds: Type.Optional(
        Type.Array(Type.String(), { description: '教学班 id 列表，顺序 = 志愿序（与 query 二选一）' }),
      ),
      turnId: Type.Optional(Type.String({ description: '批次 id，不传 = 当前开放的批次' })),
      mode: Type.Optional(
        Type.Union([Type.Literal('predicate'), Type.Literal('direct')], {
          description: 'predicate = 先占位再正式提交（推荐）；direct = 直接提交',
        }),
      ),
      groupName: Type.Optional(Type.String({ description: '志愿组名（给人看，如「大英 志愿组」）' })),
      priority: Type.Optional(Type.Number({ description: '起始志愿序，默认 1（小的先出手）' })),
      virtualCost: Type.Optional(Type.Number({ description: '意愿值，普通轮次填 0 即可' })),
      spread: Type.Optional(
        Type.Boolean({ description: '计划模式：命中多门课时每门课各排一组（默认合并成一组）' }),
      ),
    }),
    async execute(args) {
      const ids = (args.lessonIds ?? []).map((s) => s.trim()).filter(Boolean)
      if (args.query?.trim() && ids.length) throw new Error('query 与 lessonIds 只能给一个')
      if (!args.query?.trim() && !ids.length) throw new Error('要么给 query（模糊查询），要么给 lessonIds')

      if (args.query?.trim()) {
        const query = args.query.trim()
        const intent = await campusService.grabIntentAdd({
          query,
          turnId: args.turnId ?? null,
          mode: args.mode ?? 'predicate',
          spread: args.spread ?? false,
        })
        await note('grab', `写了一条抢课计划：「${query}」`, { intentId: intent.id })
        return {
          kind: 'intent' as const,
          intent: intentDigest(intent),
          message:
            '计划已落库：引擎会自己等批次、自己解析成志愿任务、到点开抢。' +
            (intent.status === 'empty'
              ? '当前名单里没匹配到班 —— 教务可能还没公布，引擎会继续试。'
              : ''),
        }
      }

      const turn = await pickTurn(args.turnId)
      const listed = await campusService.courseSelectLessons(idOf(turn.id), {
        hasCount: true,
        sortField: 'lessonAssoc',
        sortType: 'ASC',
      })
      const byId = new Map(listed.map((l) => [idOf(l.id), l]))
      const missing = ids.filter((id) => !byId.has(id))
      if (missing.length === ids.length) {
        throw new Error(
          `这些教学班在当前批次里查不到：${missing.join('、')}。名单可能变了 —— ` +
            '先用 campus_lessons 重新确认一遍 id，别拿旧 id 硬抢。',
        )
      }
      const picked = ids.map((id) => byId.get(id)!).filter(Boolean)
      // 多个教学班 → 排成志愿组（与页面多选批量加入的默认一致）
      const grouped = picked.length > 1 || !!args.groupName
      const groupKey = grouped ? `ai-${Date.now().toString(36)}` : null
      const base = args.priority ?? 1
      const w = turnWindow(turn)
      const taskIds = await campusService.grabEnqueue({
        turnId: idOf(turn.id),
        turnName: turn.name ?? null,
        mode: args.mode ?? 'predicate',
        windowWall: w.start,
        windowEndWall: w.end,
        targets: picked.map((l, i) => ({
          ...targetOf(l),
          virtualCost: args.virtualCost ?? null,
          scheduleGroupId: null,
          groupKey,
          groupName: groupKey ? (args.groupName ?? 'AI 排的志愿组') : null,
          priority: grouped ? base + i : 0,
        })),
      })
      await note('grab', `排了 ${picked.length} 个教学班进抢课任务单`, {
        turnId: idOf(turn.id),
        taskIds,
        groupKey: groupKey ?? undefined,
      })
      return {
        kind: 'tasks' as const,
        taskIds,
        grouped,
        tasks: picked.map((l, i) => ({
          ...lessonDigest(l),
          priority: grouped ? base + i : 0,
        })),
        missing: missing.length ? missing : undefined,
        window: w.start ? `${w.start} ~ ${w.end ?? '?'}` : undefined,
      }
    },
  }),

  /* ─────────────── 4. 调度 ─────────────── */
  defineTool({
    name: 'campus_grab_control',
    group: 'campus',
    label: '抢课调度',
    description:
      '指挥抢课引擎。`retry_stuck` = 把卡住（连败/逾期未动）的任务全部重置重试 —— 任务「不动了」先试它；' +
      '`task` 对单个任务 pause/cancel/retry/remove；`intent` 对计划 remove（连它派出的任务一起收）/ now（立刻重新解析名单）；' +
      '`pause_all` / `resume_all` / `clear_finished`；`settings` 改引擎节奏（只传要改的字段）。' +
      '注意重试**不清空窗口判断**：任务不会因此盲撞，只是重新开始守着。',
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('retry_stuck'),
          Type.Literal('task'),
          Type.Literal('intent'),
          Type.Literal('pause_all'),
          Type.Literal('resume_all'),
          Type.Literal('clear_finished'),
          Type.Literal('settings'),
        ],
        { description: '要做的动作' },
      ),
      taskId: Type.Optional(Type.Number({ description: 'action=task 时的任务 id' })),
      taskAction: Type.Optional(
        Type.Union([Type.Literal('pause'), Type.Literal('cancel'), Type.Literal('retry'), Type.Literal('remove')], {
          description: 'action=task 时的动作',
        }),
      ),
      intentId: Type.Optional(Type.Number({ description: 'action=intent 时的计划 id' })),
      intentAction: Type.Optional(
        Type.Union([Type.Literal('remove'), Type.Literal('now')], {
          description: 'action=intent 时的动作',
        }),
      ),
      settings: Type.Optional(
        Type.Object(
          {
            minIntervalMs: Type.Optional(Type.Number({ description: '两次提交之间的全局最小间隔（毫秒）' })),
            pollIntervalMs: Type.Optional(Type.Number({ description: '轮询受理结果的间隔（毫秒）' })),
            fullRetryMs: Type.Optional(Type.Number({ description: '满员后的重试间隔（毫秒）' })),
            backoffMs: Type.Optional(Type.Number({ description: '出错退避基数（毫秒）' })),
            maxBackoffMs: Type.Optional(Type.Number({ description: '退避上限（毫秒）' })),
            leadMs: Type.Optional(Type.Number({ description: '提前量（毫秒）：开窗前多久出手' })),
            maxAttempts: Type.Optional(Type.Number({ description: '单个任务最大提交次数，0 = 不限' })),
            maxPolls: Type.Optional(Type.Number({ description: '轮询同一受理单的最大次数' })),
            cedeAfterMs: Type.Optional(
              Type.Number({ description: '让贤期限（毫秒）：当前志愿连续满员这么久就让给下一志愿，0 = 死守' }),
            ),
            watchWindow: Type.Optional(Type.Boolean({ description: '是否开着窗口监听（每分钟问一次批次）' })),
          },
          { description: 'action=settings 时只传要改的字段' },
        ),
      ),
    }),
    async execute(args) {
      switch (args.action) {
        case 'retry_stuck': {
          const st = await campusService.rescueState(false)
          const ids = st.stuckTaskIds ?? []
          for (const id of ids) await campusService.grabTaskAction(id, 'retry')
          const engineError = st.grab.lastError ?? null
          await note('grab', `重置重试了 ${ids.length} 个卡住的任务`, { ids, engineError })
          return {
            retried: ids,
            engineError: engineError ?? undefined,
            message: ids.length
              ? `已把 ${ids.length} 个任务重置重试（次数与连败清零，回到守着窗口的状态）。`
              : '没有判定为「卡住」的任务 —— 若你确信有，说明卡住的原因不是连败或逾期，用 campus_status 看它们的 lastMessage。',
            hint: engineError
              ? '引擎级故障要等下一次成功请求才会自己清掉；若与会话有关，先 campus_session 的 probe 看会话。'
              : undefined,
          }
        }
        case 'task': {
          if (args.taskId == null || !args.taskAction) throw new Error('action=task 需要 taskId 与 taskAction')
          await campusService.grabTaskAction(args.taskId, args.taskAction)
          await note('grab', `任务 ${args.taskId} → ${args.taskAction}`)
          return { ok: true, taskId: args.taskId, taskAction: args.taskAction }
        }
        case 'intent': {
          if (args.intentId == null || !args.intentAction) throw new Error('action=intent 需要 intentId 与 intentAction')
          await campusService.grabIntentAction(args.intentId, args.intentAction)
          await note('grab', `计划 ${args.intentId} → ${args.intentAction}`)
          return {
            ok: true,
            intentId: args.intentId,
            intentAction: args.intentAction,
            message:
              args.intentAction === 'remove'
                ? '计划已移除，它派出去的任务也一并收掉了。'
                : '已要求立刻重新解析 —— 引擎会在下一轮心跳里照当时的名单重排志愿。',
          }
        }
        case 'pause_all': {
          await campusService.grabPauseAll()
          await note('grab', '暂停了全部抢课任务')
          return { ok: true }
        }
        case 'resume_all': {
          await campusService.grabResumeAll()
          await note('grab', '恢复了全部抢课任务')
          return { ok: true }
        }
        case 'clear_finished': {
          const n = await campusService.grabClearFinished()
          await note('grab', `清理了 ${n} 条已结束的任务`)
          return { cleared: n }
        }
        case 'settings': {
          if (!args.settings || Object.keys(args.settings).length === 0) {
            throw new Error('action=settings 要给出至少一个要改的字段')
          }
          const current = await campusService.grabSettingsGet()
          const next: GrabSettings = { ...current, ...args.settings }
          const saved = await campusService.grabSettingsSet(next)
          await note('grab', '改了抢课节奏参数', args.settings)
          return { settings: saved }
        }
        default:
          throw new Error(`未知的动作：${String(args.action)}`)
      }
    },
  }),

  /* ─────────────── 5. 直接选课 ─────────────── */
  defineTool({
    name: 'campus_select',
    group: 'campus',
    label: '直接选课',
    description:
      '绕过抢课引擎直接提交一次选课并等结果（submit = 正式提交，predicate = 占位，drop = 退课）。' +
      '**抢课优先用 campus_grab_plan**（引擎会自己守着名额）；这个工具留给：补选一两个班、' +
      '名额刚放出来的瞬间手动补刀、以及退掉已经抢到的课。提交后按 2 秒一次轮询到结论（最多 10 次）。' +
      'needAttend = 与已选课时间冲突，必须去教务网页端办免听，本 App 做不了。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('submit'), Type.Literal('predicate'), Type.Literal('drop')], {
        description: '要做的动作',
      }),
      turnId: Type.Optional(Type.String({ description: '批次 id，不传 = 当前开放的批次' })),
      lessonId: Type.Optional(Type.String({ description: '教学班 id（submit / predicate 用）' })),
      lessonIds: Type.Optional(Type.Array(Type.String(), { description: '教学班 id 列表（drop 用）' })),
      virtualCost: Type.Optional(Type.Number({ description: '意愿值（submit 用，普通轮次 0）' })),
      scheduleGroupId: Type.Optional(Type.String({ description: '上课小组 id（一般不用给）' })),
      confirmMidtermRetake: Type.Optional(
        Type.Boolean({ description: 'drop 时确认「期中退课重修」的提示（默认 false）' }),
      ),
    }),
    dangerous: true,
    async execute(args) {
      const turn = await pickTurn(args.turnId)
      const turnId = idOf(turn.id)

      if (args.action === 'drop') {
        const ids = (args.lessonIds ?? []).filter(Boolean)
        if (!ids.length) throw new Error('drop 需要 lessonIds（哪几个教学班要退）')
        const poll = await campusService.courseSelectDrop(turnId, ids, args.confirmMidtermRetake ?? false)
        await note('select', `退课 ${ids.length} 个教学班`, { turnId, lessonIds: ids, poll })
        return { action: 'drop' as const, poll }
      }

      const lessonId = args.lessonId?.trim()
      if (!lessonId) throw new Error(`${args.action} 需要 lessonId（用 campus_lessons 查 id）`)
      const ticket =
        args.action === 'submit'
          ? await campusService.courseSelectApply(turnId, lessonId, {
              virtualCost: args.virtualCost ?? null,
              scheduleGroupId: args.scheduleGroupId ?? null,
            })
          : await campusService.courseSelectPredicate(turnId, lessonId, {
              scheduleGroupId: args.scheduleGroupId ?? null,
            })
      const poll = await pollTicket(ticket.requestId, args.action)
      await note('select', `${args.action === 'submit' ? '提交' : '占位'}教学班 ${lessonId}`, {
        turnId,
        requestId: ticket.requestId,
        poll,
      })
      return {
        action: args.action,
        requestId: ticket.requestId,
        result: poll,
        message: poll.needAttend
          ? '与已选课程时间冲突，需要在教务网页端办理免听 —— 这一步 App 做不了。'
          : poll.success
            ? '教务已受理成功。'
            : poll.pending
              ? '教务还没给结论，受理单可能还在队列里。'
              : (poll.message ?? '教务拒绝了这次提交。'),
      }
    },
  }),

  /* ─────────────── 6. 会话 ─────────────── */
  defineTool({
    name: 'campus_session',
    group: 'campus',
    label: '教务会话',
    description:
      '处理教务会话。probe = 看会话是否还有效（一次请求）；relogin = 用保存的密码静默重登（没存密码时会明确拒绝并说怎么办）；' +
      'sync = 重新拉课表并重建时间线（顺带验证整条链路）。' +
      '注意：选课与抢课的每条命令**遇到会话失效已经会自动重登一次**，所以别把 relogin 当万灵药 —— ' +
      '先 probe：探针说还活着却什么都失败，问题就不在会话上（多半是接口变了，用 campus_http 看原始响应）。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('probe'), Type.Literal('relogin'), Type.Literal('sync')], {
        description: '要做的动作',
      }),
      semesterId: Type.Optional(Type.Number({ description: 'sync 时指定学期，不传 = 当前学期' })),
    }),
    async execute(args) {
      if (args.action === 'probe') {
        const alive = await campusService.sessionProbe()
        return {
          alive,
          message: alive ? '教务会话还有效。' : '会话已被踢回登录页 —— 用 relogin 静默重登（需要存过密码）。',
        }
      }
      if (args.action === 'relogin') {
        const st = await campusService.rescueState(false)
        const acc = st.account
        if (!acc) throw new Error('还没有绑定教务账号，请用户在「课表配置」里登录一次')
        const outcome = await campusService.login({
          systemKind: acc.systemKind,
          baseUrl: acc.baseUrl,
          loginName: acc.loginName,
          // 口令留空 → 后端回落到库里已保存的那份（这正是静默重登的做法）
          password: '',
          savePassword: acc.savePassword,
        })
        await note('session', outcome.ok ? '静默重新登录成功' : `静默重新登录失败：${outcome.message ?? '未知原因'}`)
        if (!outcome.ok) {
          throw new Error(
            `重新登录失败：${outcome.message ?? '教务没给原因'}` +
              (outcome.actionRequired === 'change_password'
                ? '；教务要求先去网页端改密码'
                : outcome.needCaptcha
                  ? '；教务这次要验证码，只能请用户在「课表配置」页手动登录一次'
                  : ''),
          )
        }
        return {
          ok: true,
          account: outcome.account ? { loggedIn: outcome.account.loggedIn } : undefined,
          message: '会话已刷新。选课令牌会跟着作废，下一次选课/抢课会自动换一张新的。',
        }
      }
      const out = await campusService.sync(args.semesterId ?? null)
      await note('session', `重新同步课表：${out.courses} 门课 / ${out.todosWritten} 条日程`)
      return {
        courses: out.courses,
        sessions: out.sessions,
        todosWritten: out.todosWritten,
        semester: out.semesterName,
        syncedAt: out.syncedAt,
        skippedActivities: out.skippedActivities,
      }
    },
  }),

  /* ─────────────── 7. 原始请求（curl） ─────────────── */
  defineTool({
    name: 'campus_http',
    group: 'campus',
    label: '教务请求',
    description:
      '带教务会话打一条任意 HTTP 请求（就是 curl）。教务改了接口、返回了看不懂的东西、某个命令报错时，用它看**原始响应**：' +
      '状态码、响应头、正文（默认截断到 16KB）与等价 curl。' +
      'url 用相对路径（/student/home）会自动拼上教务域名并带上会话（withSelectToken 再加选课令牌）；' +
      '外部地址一律不带任何凭据（带凭据的请求只允许打教务同源，这是硬边界）。' +
      '**它不是一个轮询接口**：同一条请求 1 分钟内超过 20 次会被熔断，重复打不会得到不同的答案 —— 拿到结果就换判断依据。',
    parameters: Type.Object({
      url: Type.String({
        description: '相对路径（/student/home、/course-selection-api/api/v1/student/course-select/getCurrentDateTime）或完整 URL',
      }),
      reason: Type.String({ description: '这条请求想搞清楚什么？会写进审计与脚本注释（必填）' }),
      method: Type.Optional(
        Type.Union(
          [
            Type.Literal('GET'),
            Type.Literal('POST'),
            Type.Literal('PUT'),
            Type.Literal('PATCH'),
            Type.Literal('DELETE'),
            Type.Literal('HEAD'),
          ],
          { description: '默认 GET' },
        ),
      ),
      headers: Type.Optional(
        Type.Array(Type.Array(Type.String()), {
          description: '请求头，形如 [["Content-Type","application/json"]]。Cookie/Authorization 不许手写',
        }),
      ),
      body: Type.Optional(Type.String({ description: '请求正文（字符串，通常是 JSON）' })),
      contentType: Type.Optional(Type.String({ description: '正文的 Content-Type，默认 application/json' })),
      withSession: Type.Optional(
        Type.Boolean({ description: '是否带教务 Cookie（同源默认 true；外部地址给了会被拒）' }),
      ),
      withSelectToken: Type.Optional(
        Type.Boolean({ description: '是否带选课 SSO 令牌（Authorization: <JWT>，裸 token）' }),
      ),
      maxBytes: Type.Optional(
        Type.Number({ description: '正文最多返回多少字节（默认 16384）；读大文件时才调大' }),
      ),
    }),
    async execute(args) {
      const headers = (args.headers ?? [])
        .filter((h) => Array.isArray(h) && h.length >= 2)
        .map((h) => [String(h[0]), String(h[1])] as [string, string])
      const res = await campusService.rescueHttp({
        url: args.url,
        method: args.method ?? 'GET',
        reason: args.reason,
        headers,
        body: args.body ?? null,
        contentType: args.contentType ?? null,
        withSession: args.withSession,
        withSelectToken: args.withSelectToken ?? false,
        maxBytes: args.maxBytes ?? 16 * 1024,
      })
      return {
        url: res.url,
        method: res.method,
        status: res.status,
        ok: res.ok,
        sameOrigin: res.sameOrigin,
        withSession: res.withSession,
        withSelectToken: res.withSelectToken,
        healed: res.healed || undefined,
        note: res.note ?? undefined,
        /** 响应头（Set-Cookie 的值已由后端收进会话，这里只给名字与内容类型这类线索） */
        headers: res.headers.filter(([k]) => !/^set-cookie$/i.test(k)),
        contentType: res.headers.find(([k]) => /^content-type$/i.test(k))?.[1],
        body: res.body,
        truncated: res.truncated || undefined,
        bytes: res.bytes,
        elapsedMs: res.elapsedMs,
        curl: res.curl,
      }
    },
  }),

  /* ─────────────── 8. 导出脚本 ─────────────── */
  defineTool({
    name: 'campus_export_script',
    group: 'campus',
    label: '导出救援脚本',
    description:
      '把刚才真实打过的请求导出成一份**能脱离 App 重放的 bash 脚本**（含当时的 Cookie 与选课令牌快照）：' +
      '落成磁盘上的 .sh，同时在知识库里写一份 markdown 副本供随时翻看。' +
      '这是「最后补救」的交付物 —— App 被系统杀掉、手机没电、人在另一台机器上时，靠它继续。' +
      '导出前先把要固化的请求都打完：脚本只收这段时间里真实发出过的请求。',
    parameters: Type.Object({
      hours: Type.Optional(Type.Number({ description: '回看多少小时内的请求（默认 6，最多 168）' })),
      title: Type.Optional(Type.String({ description: '这份脚本叫什么（写进知识库文件名）' })),
    }),
    async execute(args) {
      const out = await campusService.curlExport({ hours: args.hours })
      const now = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const stampText = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}-${p(now.getMinutes())}`
      const title = (args.title ?? '救援脚本').replace(/[\\/:*?"<>|]/g, ' ').trim() || '救援脚本'
      const notePath = `文档/教务救援/${title} ${stampText}.md`
      const body =
        `# ${title}\n\n` +
        `> 由 AI 在 ${out.generatedAt} 导出，含 ${out.count} 条真实打过的请求。\n` +
        `> 可执行副本（带凭据）：\`${out.path}\`\n\n` +
        `## 怎么用\n\n` +
        `1. 把上面那个 \`.sh\` 拷到任意一台能连到教务的机器上，\`bash\` 跑它；\n` +
        `2. 里面的 Cookie / 选课令牌是导出那一刻的快照，过期就回 App 重新导出一份；\n` +
        `3. 这个文件里有你自己的账号凭据，别传给别处。\n\n` +
        `## 脚本\n\n\`\`\`bash\n${out.script}\n\`\`\`\n`
      let kbPath: string | null = null
      try {
        const f = await kbService.fileWrite({ path: notePath, content: body })
        kbPath = f.path
      } catch {
        /* 知识库写不进去（容量/权限）不该让「脚本已经落盘」这件事失败 */
      }
      await note('script', `导出救援脚本：${out.count} 条请求 → ${out.path}`, { kbPath: kbPath ?? undefined })
      return {
        count: out.count,
        scriptPath: out.path,
        notePath: kbPath ?? undefined,
        generatedAt: out.generatedAt,
        /** 前 40 行给模型核对内容，不必读整个文件 */
        preview: out.script.split('\n').slice(0, 40).join('\n'),
        message: `脚本已导出到 ${out.path}${kbPath ? `，知识库里也留了一份：${kbPath}` : ''}。`,
      }
    },
  }),
]
