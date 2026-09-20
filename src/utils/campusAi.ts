/**
 * 抢课排障的入口：把当前现场压成一段话递给 AI，然后跳到 AI 页。
 *
 * 为什么要「压成一段话」而不是让 AI 自己去查：用户点这个按钮的时刻，往往是
 * 窗口已经开了、任务却不动的时候 —— 那时最贵的是时间。把已知的东西一次说清，
 * AI 的第一轮就能落在判断上，而不是先花两次工具调用把现状读一遍。
 *
 * 提示词里刻意**只给事实**（状态、次数、引擎原文），不给结论：结论是 AI 的工作，
 * 而「我猜是会话过期了」这种预设会把判断带偏（真因常常是教务改了接口）。
 */

import { router } from '@/router'
import { useAiStore } from '@/stores/ai'
import { grabStatusMeta } from '@/stores/courseSelect'
import type { GrabState, GrabTask } from '@/types'

/** 本机 unix 毫秒 → `HH:mm:ss` */
function clock(ms?: number | null): string {
  if (!ms || ms <= 0) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function taskLine(t: GrabTask): string {
  const bits = [
    `#${t.id} ${t.courseName ?? t.lessonName ?? '（未命名）'}${t.teacher ? ` · ${t.teacher}` : ''}`,
    `状态 ${grabStatusMeta(t).label}（${t.status}/${t.phase}）`,
    `提交 ${t.attempts} 次 · 轮询 ${t.polls} 次 · 连败 ${t.strikes}${t.strikeKind ? `（${t.strikeKind}）` : ''}`,
  ]
  if (t.heldBy) bits.push(`被同组 #${t.heldBy} 压着`)
  if (t.awaitWindow) bits.push('在等窗口公布')
  if (t.fireAt) bits.push(`开火 ${clock(t.fireAt)}`)
  else bits.push(`下次动作 ${clock(t.nextAt)}`)
  if (t.lastMessage) bits.push(`最后消息：「${t.lastMessage}」`)
  return `- ${bits.join(' · ')}`
}

/** 现场 → 一段给 AI 的话。没有任务时也要能说清「什么都没有」这件事。 */
export function grabRescuePrompt(state: GrabState): string {
  const tasks = state.tasks ?? []
  // `needs_ai` 单独成段：它不是「还在抢」，而是「这条请求的写法被教务拒了」
  const rejected = tasks.filter((t) => t.status === 'needs_ai')
  const live = tasks.filter(
    (t) => t.status !== 'cancelled' && t.status !== 'failed' && t.status !== 'success' && t.status !== 'needs_ai',
  )
  const lines: string[] = [
    '【抢课排障】抢课引擎出问题了，请你**先看现场再动手**（campus_status），判清楚是会话问题、教务改了接口、还是任务本身的问题，然后把它救回来。',
    '',
    `引擎级故障：${state.lastError ?? '（无 —— 引擎自己没报错，问题在任务上）'}`,
    `服务器时间：${state.serverTime ?? '未知'} · 时钟偏差：${state.skewSec ?? '未知'} 秒`,
  ]

  if (rejected.length) {
    lines.push(
      '',
      `**被教务拒绝的请求 ${rejected.length} 个（参数错误 —— 重试一万次也是同一个结果，引擎已经停下不再骚扰教务）**：`,
    )
    lines.push(...rejected.map(taskLine))
    lines.push(
      '这类失败通常是：教务换了参数名 / 少了必填字段 / 批次 id 变了 / 令牌绑的是另一个入口。',
      '请用同样的参数**手工打一次那接口看原始响应**（campus_request 带会话），再决定是改参数、改流程，还是教务那边变了；改完把任务重新排上。',
    )
  }

  lines.push('', `在场任务 ${live.length} 个（共 ${tasks.length}）：`)
  lines.push(...(live.length ? live.map(taskLine) : ['- （没有在场的任务）']))

  const finished = tasks.filter((t) => t.status === 'failed' || t.status === 'conflict')
  if (finished.length) {
    lines.push('', `需要留意的已结束任务 ${finished.length} 个：`)
    lines.push(...finished.slice(0, 6).map(taskLine))
  }

  const intents = state.intents ?? []
  lines.push('', `抢课计划 ${intents.length} 条：`)
  lines.push(
    ...(intents.length
      ? intents.map(
          (i) =>
            `- #${i.id}「${i.query}」：${i.status}` +
            `${i.lastMessage ? ` · ${i.lastMessage}` : ''}` +
            `${i.candidates?.length ? ` · 已解析 ${i.candidates.length} 个班` : ''}`,
        )
      : ['- （没有计划）']),
  )

  const turns = state.turns ?? []
  lines.push('', `教务批次 ${turns.length} 个：`)
  lines.push(
    ...(turns.length
      ? turns.map(
          (t) =>
            `- ${t.id} ${t.name ?? ''}：${t.allowEnter ? '可进入' : '不可进入'}` +
            `${t.windowStart ? ` · 窗口 ${t.windowStart} ~ ${t.windowEnd ?? '?'}` : ''}`,
        )
      : ['- （教务没给批次 —— 窗口可能还没开，也可能接口变了）']),
  )

  return lines.join('\n')
}

/** 抢课面板调它：把现场递给 AI 并跳过去 */
export function askAiForGrabRescue(state: GrabState | null): void {
  const ai = useAiStore()
  ai.askFrom(
    state
      ? grabRescuePrompt(state)
      : '【抢课排障】抢课页现在读不到引擎状态（campus_grab_state 没返回），请你先看现场（campus_status）判断是哪里断了，再动手。',
  )
  // 直接拿 router 实例：这个函数从点击回调里调，那里没有组件实例可用 `useRouter()`
  void router.push({ name: 'ai' })
}
