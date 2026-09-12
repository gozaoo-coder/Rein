/**
 * AI 方案周复盘：汇总最近 7 天的执行数据（饮食达成 / 训练完成 / 体重趋势 /
 * 日程执行率），交给模型做偏差分析，产出「下一周怎么调」的结构化建议。
 *
 * 边界（对应产品原则）：AI 只输出参数级建议（缺口/蛋白配比/训练天数），
 * 不生成新计划；建议必须经用户在方案页确认、由引擎钳制后才生效。
 */

import type { AiModel, ProgramRecord } from '@/types'
import { exerciseService } from '@/services/exerciseService'
import { nutritionService } from '@/services/nutritionService'
import { todoService } from '@/services/todoService'
import { addDays, todayStr } from '@/utils/date'
import { parseBlob } from '@/utils/programEngine'
import { extractJsonObject, lastAssistantText } from './json'
import { jsonStringField } from './streamExtract'
import { buildRuntime } from './runtime'

export interface ProgramReviewPayload {
  today: string
  program: {
    goal: string
    tier: string
    version: number
    kcalTarget: number
    proteinPerKg: number
    kcalDelta: number
    trainingDaysPerWeek: number
  }
  /** 最近 7 天逐日：目标热量 / 实际摄入 / 运动消耗 */
  daily: { date: string; kcalTarget: number; intake: number; exercise: number }[]
  /** 实际运动记录（区别于日程完成率）：条数与总消耗 */
  workouts: { count: number; kcal: number }
  /** 训练完成情况：计划条数与已完成条数 */
  training: { planned: number; done: number }
  /** 饮食锚点完成情况 */
  dietTodos: { planned: number; done: number }
  /** 近期体重记录（时间正序） */
  weights: { date: string; kg: number }[]
}

export interface ReviewSuggestion {
  /** 一段话诊断：本周执行 vs 目标的偏差 */
  diagnosis: string
  changes: {
    kcalDelta?: number
    proteinPerKg?: number
    trainingDays?: number
  }
  /** 给用户的 2~3 条下周执行建议 */
  advice: string[]
}

/** 汇总最近 7 天执行数据（饮食/训练/体重/方案日程完成率）为复盘输入 */
export async function buildReviewPayload(record: ProgramRecord): Promise<ProgramReviewPayload> {
  const blob = parseBlob(record)
  const today = todayStr()
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, -6 + i))

  const summaries = await Promise.all(days.map((d) => nutritionService.getDailySummary(d)))
  const workouts = await exerciseService.listWorkouts(days[0]!, today)
  const allTodos = await todoService.listAllTodos()
  const mine = allTodos.filter(
    (t) => t.programId === record.id && t.date != null && t.date >= days[0]! && t.date <= today,
  )
  const trainingTodos = mine.filter((t) => t.category === 'workout')
  const dietAnchorTodos = mine.filter((t) => t.category === 'health')
  const metrics = await nutritionService.listBodyMetrics(10)

  return {
    today,
    program: {
      goal: record.goal,
      tier: record.tier,
      version: record.version,
      kcalTarget: Math.round(blob.params.targets.kcal),
      proteinPerKg: blob.params.proteinPerKg,
      kcalDelta: blob.params.kcalDelta,
      trainingDaysPerWeek: blob.params.trainingDays,
    },
    daily: summaries.map((s) => ({
      date: s.date,
      kcalTarget: Math.round(s.targets.kcal),
      intake: Math.round(s.intake.kcal),
      exercise: Math.round(s.exerciseKcal),
    })),
    workouts: {
      count: workouts.length,
      kcal: Math.round(workouts.reduce((s, w) => s + w.kcal, 0)),
    },
    training: {
      planned: trainingTodos.length,
      done: trainingTodos.filter((t) => t.status === 'done').length,
    },
    dietTodos: {
      planned: dietAnchorTodos.length,
      done: dietAnchorTodos.filter((t) => t.status === 'done').length,
    },
    weights: metrics
      .filter((m) => m.weightKg != null)
      .slice(0, 5)
      .reverse()
      .map((m) => ({ date: m.date, kg: m.weightKg! })),
  }
}

function systemPrompt(): string {
  return `你是 Rein 健康应用的方案复盘助手。用户正在执行一个由程序计算的健康方案（初始为平均线基线），你负责分析他最近一周的执行数据，给出下一周的参数调整建议，让方案逐步贴合他个人的真实代谢与执行力。
只能调整这三个参数（都在安全范围内，前端还会再次钳制）：
- kcalDelta：每日相对消耗的热量偏移（大卡），减脂为负、增肌为正；参考范围 -600 ~ +500；
- proteinPerKg：蛋白质 g/kg 体重，1.2 ~ 2.2；
- trainingDays：每周训练天数，0 ~ 6。
判断要点：
- 摄入长期明显低于目标且体重掉太快（>1% 体重/周）→ 收小缺口或下调训练频率；
- 执行率低（训练/饮食完成度差）→ 降低档位而不是加大强度；
- 体重纹丝不动连续两周且执行良好 → 加大缺口 50~100 大卡；
- 数据不足时保持参数不变（changes 给 {}），在 diagnosis 里说明原因。
只能输出一个 JSON 对象（不要 markdown 代码块、不要解释文字）：
{"diagnosis":"两三句话的诊断，指出数据里的关键证据","changes":{"kcalDelta":数值,"proteinPerKg":数值,"trainingDays":数值}（只给需要改的）,"advice":["给用户的执行建议，1~3 条"]}`
}

/** 单轮复盘：无工具、纯数据分析；模型未配置时由调用方先行保证。
 * onDiagnosis 可选：流式输出过程中增量回传已流出的诊断文本（定稿以返回值为准）。 */
export async function reviewProgram(
  config: AiModel,
  payload: ProgramReviewPayload,
  onDiagnosis?: (partial: string) => void,
): Promise<ReviewSuggestion> {
  const { models, byId } = buildRuntime([config])
  const entry = byId.get(config.id)
  if (!entry) throw new Error('模型运行时构建失败')

  const { Agent } = await import('@earendil-works/pi-agent-core')
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(),
      model: entry.model,
      thinkingLevel: 'low',
      tools: [],
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
  })

  if (onDiagnosis) {
    let acc = ''
    agent.subscribe((e) => {
      if (e.type !== 'message_update') return
      const ev = e.assistantMessageEvent
      if (ev.type !== 'text_delta') return
      acc += ev.delta
      const d = jsonStringField(acc, 'diagnosis')
      if (d) onDiagnosis(d)
    })
  }

  await agent.prompt(`方案与最近一周执行数据如下（JSON）：\n${JSON.stringify(payload)}`)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  const body = extractJsonObject(raw) as ReviewSuggestion | null
  if (!body || typeof body.diagnosis !== 'string') throw new Error('模型返回格式异常，请重试')
  return {
    diagnosis: body.diagnosis,
    changes: body.changes ?? {},
    advice: Array.isArray(body.advice) ? body.advice.map(String).slice(0, 3) : [],
  }
}

/* ---------------- 本周 vs 上周对比（复盘「数据先行」区） ---------------- */

export interface WeekComparePoint {
  label: string
  unit: string
  /** 本周值 */
  now: number
  /** 上周值 */
  prev: number
}

export interface WeekCompare {
  points: WeekComparePoint[]
}

const avgOf = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0)

/** 汇总最近两周的执行对比：日均摄入 / 训练完成次数 / 日均蛋白（仅记录日参与平均） */
export async function buildWeekCompare(record: ProgramRecord): Promise<WeekCompare> {
  const today = todayStr()
  const weeks = [
    Array.from({ length: 7 }, (_, i) => addDays(today, -6 + i)), // 本周
    Array.from({ length: 7 }, (_, i) => addDays(today, -13 + i)), // 上周
  ]
  const [thisSum, lastSum] = await Promise.all(
    weeks.map((days) => Promise.all(days.map((d) => nutritionService.getDailySummary(d)))),
  )
  const all = await todoService.listAllTodos()
  const mine = all.filter((t) => t.programId === record.id && t.date != null)

  const trainDone = (days: string[]): number =>
    mine.filter((t) => t.category === 'workout' && t.date != null && days.includes(t.date) && t.status === 'done').length

  const intake = (sum: typeof thisSum): number[] => sum.map((s) => Math.round(s.intake.kcal)).filter((x) => x > 0)
  const protein = (sum: typeof thisSum): number[] => sum.map((s) => Math.round(s.intake.protein)).filter((x) => x > 0)

  return {
    points: [
      { label: '日均摄入', unit: '大卡', now: avgOf(intake(thisSum)), prev: avgOf(intake(lastSum)) },
      { label: '训练完成', unit: '次', now: trainDone(weeks[0]!), prev: trainDone(weeks[1]!) },
      { label: '日均蛋白', unit: 'g', now: avgOf(protein(thisSum)), prev: avgOf(protein(lastSum)) },
    ],
  }
}
