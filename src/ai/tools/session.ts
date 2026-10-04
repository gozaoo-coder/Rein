/**
 * 训练课会话域工具：查看进行中的训练、查热身换算规则，以及**现场调整**（写）。
 *
 * 写操作直接落到会话 store —— 它和服务端之间只差一份「中断恢复用的快照」，
 * 状态机本身只活在前端（与沉浸页是同一个实例）。因此：
 *  - 不需要新增 IPC，也就不存在三处同步的问题；
 *  - 调整立刻反映在沉浸页上，store 的 action 内部会 touch() 落快照；
 *  - 幂等：赋值类（set_weight / set_reps）天然幂等，推进类（skip_set / add_set /
 *    swap_exercise）都先校验前置条件与上限，重复调用不会叠加。
 *    这一点对移动端尤其重要 —— 切屏会让流式请求被系统掐断，模型重放同一条
 *    指令必须是安全的（写操作先落地、再回话，断流也不丢改动）。
 *
 * 所有失败都收敛成 `{ updated: false, reason }` 而不是抛错：参数错让模型改参数，
 * 状态不满足（没在训练 / 相位不对 / 已经做过）让模型改说法，都不该让整轮对话崩掉。
 */

import { Type } from '@earendil-works/pi-ai'

import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useSessionStore } from '@/stores/session'
import {
  WARMUP_MIN_KG,
  WARMUP_RAMP_MIN_KG,
  WARMUP_RULE_TEXT,
  WARMUP_STEP_KG,
  warmupPrescription,
} from '@/utils/warmup'
import { defineTool, type AppTool } from './types'

type SessionStore = ReturnType<typeof useSessionStore>

/** 相位的中文名（模型读得懂，也方便它向用户复述） */
const PHASE_LABEL: Record<string, string> = {
  idle: '未开始',
  warmup: '激活热身',
  exercise: '做组中',
  rest: '组间休息',
  'timed-ready': '计时准备',
  'timed-run': '计时进行中',
  summary: '已结束待保存',
}

/** 单个动作最多加练几组（与界面一致的上限，防止模型批量 add_set 把课程撑爆） */
const MAX_EXTRA_SETS = 10

/** 数值入参收敛：非有限数返回 null，让调用方给出可读的 reason */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 取到「确实有进行中训练课」的会话 store。
 *
 * 应用重启后 store 是 idle，但服务端还留着未结束的会话 —— 先尝试接续一次。
 * 接续失败（课程已删 / 记录损坏）一律按「没有会话」处理，绝不抛错：
 * 这里只是查询入口，不该因为脏数据把整轮对话打断。
 */
async function activeSession(): Promise<SessionStore | null> {
  const s = useSessionStore()
  if (s.isActive) return s
  try {
    await s.hydrateFromServer()
  } catch {
    return null
  }
  return s.isActive ? s : null
}

/** 会话全景（查询与写操作的回执共用同一份投影，模型不必再调一次查询） */
function describeSession(s: SessionStore): Record<string, unknown> {
  const ex = s.currentEx
  const totalEx = s.plan?.exercises.length ?? 0
  const advice = ex ? s.adviceFor(ex) : null
  const working = ex ? s.workingWeightFor(ex) : 0
  const rx = ex ? s.warmupsFor(ex) : []
  const doneWarm = ex ? s.warmupDone(ex) : 0
  const isStrength = ex?.kind === 'strength'

  return {
    planName: s.plan?.name ?? '',
    phase: s.phase,
    phaseLabel: PHASE_LABEL[s.phase] ?? s.phase,
    elapsedSec: s.durationSec,
    progress: `动作 ${s.exIndex + 1}/${totalEx} · 第 ${s.setIndex} 组`,
    exerciseIndex: s.exIndex + 1,
    exerciseCount: totalEx,
    setIndex: s.setIndex,
    currentExercise: ex
      ? {
          exerciseId: ex.exerciseId,
          name: ex.name,
          kind: ex.kind,
          plannedSets: ex.sets,
          extraSets: s.effSets(ex) - ex.sets,
          sets: s.effSets(ex),
          reps: s.reps,
          restSec: ex.restSec,
        }
      : null,
    /** 正式组那一档的重量（今日建议优先，回落上次实际 / 课程建议值） */
    workingWeightKg: working > 0 ? working : null,
    /** 今日推荐重量（建议引擎给出，热身处方就是按它换算的） */
    recommendedWeightKg: advice?.suggestedWeight ?? null,
    /** 当前输入框里的重量：热身相位时是热身重量，做组相位时是工作重量 */
    currentWeightKg: s.weight,
    /** 激活热身：规则 + 按推荐重量换算出的处方 + 已做/剩余 */
    warmup:
      isStrength && ex
        ? {
            rule: WARMUP_RULE_TEXT,
            basisWeightKg: working > 0 ? working : null,
            prescribed: rx.map((d) => ({ weightKg: d.weightKg, reps: d.reps })),
            doneSets: doneWarm,
            remainingSets: Math.max(0, rx.length - doneWarm),
          }
        : null,
    restLeftSec: s.phase === 'rest' ? s.restLeft : null,
    counts: { done: s.doneCount, total: s.totalCount },
  }
}

/** 写成功回执：带上最新全景，模型不必再查询一次 */
function changed(s: SessionStore, message: string): Record<string, unknown> {
  return { updated: true, message, session: describeSession(s) }
}

/** 写失败回执：结构化的原因，交给模型改参数或改说法 */
function rejected(reason: string): Record<string, unknown> {
  return { updated: false, reason }
}

export const sessionTools: AppTool[] = [
  defineTool({
    name: 'get_active_session',
    group: 'session',
    label: '查看进行中训练',
    description:
      '查看当前进行中的训练课：课程名、相位（热身/做组/休息）、已进行秒数、当前动作与第几组、今日推荐重量、工作重量、热身处方与剩余热身组数。没有进行中训练返回 null。',
    parameters: Type.Object({}),
    async execute() {
      const s = await activeSession()
      if (!s) return null
      return describeSession(s)
    },
  }),

  defineTool({
    name: 'get_warmup_rule',
    group: 'session',
    label: '查看热身换算规则',
    description:
      '查看激活热身重量的科学换算规则（阈值 / 百分比 / 取整步进），可选传一个正式组重量做试算，返回该重量下的热身处方。用户问「热身为什么是这个重量」「热身怎么算的」时用它。',
    parameters: Type.Object({
      workingWeightKg: Type.Optional(
        Type.Number({ description: '要试算的正式组重量（kg）；不传则只返回规则' }),
      ),
    }),
    async execute(args) {
      const kg = num(args.workingWeightKg)
      return {
        rule: WARMUP_RULE_TEXT,
        thresholds: {
          rampFromKg: WARMUP_RAMP_MIN_KG,
          oneSetFromKg: WARMUP_MIN_KG,
          plateStepKg: WARMUP_STEP_KG,
        },
        basis:
          '热身强度取工作组的 40%–75%：低于 40% 只局部升温、对表现无增益；高于 80% 开始累积疲劳、反而压低正式组输出。复合动作两段渐进，在低次数下预演接近工作组的负荷。',
        prescribed:
          kg != null
            ? warmupPrescription(kg).map((d) => ({ weightKg: d.weightKg, reps: d.reps }))
            : null,
        note:
          '运行时热身重量按当天推荐重量实时换算；推荐重量变化（加档 / 降载 / 改今日自评）会立刻改变热身，不必改课程。',
      }
    },
  }),

  defineTool({
    name: 'update_active_session',
    group: 'session',
    label: '调整进行中训练',
    description:
      '现场调整当前进行中的训练课（改重量/次数、登记完成、跳过、加练、回退、跳过热身、临时休息、跳至某组、临时换动作）。' +
      '没有进行中的训练时返回 {updated:false,reason}，不会修改任何数据；相位不满足的操作同理，按 reason 提示用户。' +
      'action 取值：set_weight（改当前重量，需 weightKg）、set_reps（改当前组次数，需 reps）、' +
      'complete_set（登记完成当前组，可同时传 weightKg/reps 一并设置）、skip_set（跳过当前组，不计入完成）、' +
      'add_set（当前动作加练一组）、redo_last_set（撤销最近完成的一组并回到该组）、' +
      'skip_warmup（跳过剩余热身，直接进正式组）、start_temp_rest（临时休息，需 minutes）、' +
      'skip_rest（结束当前休息）、goto_set（跳到后面的某组，需 exerciseIndex/setNo，均为 1 起）、' +
      'swap_exercise（把某个还没做过的动作换成动作库里的同类动作，需 exerciseIndex/exerciseId）。',
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('set_weight'),
          Type.Literal('set_reps'),
          Type.Literal('complete_set'),
          Type.Literal('skip_set'),
          Type.Literal('add_set'),
          Type.Literal('redo_last_set'),
          Type.Literal('skip_warmup'),
          Type.Literal('start_temp_rest'),
          Type.Literal('skip_rest'),
          Type.Literal('goto_set'),
          Type.Literal('swap_exercise'),
        ],
        { description: '要执行的动作' },
      ),
      weightKg: Type.Optional(Type.Number({ description: '重量 kg（set_weight / complete_set 用）' })),
      reps: Type.Optional(Type.Number({ description: '每组次数（set_reps / complete_set 用）' })),
      minutes: Type.Optional(Type.Number({ description: '临时休息分钟数（start_temp_rest 用）' })),
      exerciseIndex: Type.Optional(
        Type.Number({ description: '第几个动作，1 起（goto_set / swap_exercise 用）' }),
      ),
      setNo: Type.Optional(Type.Number({ description: '第几组，1 起（goto_set 用）' })),
      exerciseId: Type.Optional(
        Type.String({ description: '目标动作库 id（swap_exercise 用，来自动作库查询）' }),
      ),
    }),
    async execute(args) {
      const s = await activeSession()
      if (!s) return rejected('当前没有进行中的训练课')

      const phase = PHASE_LABEL[s.phase] ?? s.phase
      const ex = s.currentEx

      try {
        switch (args.action) {
          case 'set_weight': {
            const kg = num(args.weightKg)
            if (kg == null) return rejected('set_weight 需要 weightKg（数字，单位 kg）')
            if (kg < 0 || kg > 999) return rejected(`weightKg 需在 0~999 之间，收到 ${kg}`)
            s.setWeight(kg)
            return changed(s, `当前重量已设为 ${s.weight} kg`)
          }

          case 'set_reps': {
            const r = num(args.reps)
            if (r == null) return rejected('set_reps 需要 reps（数字，每组次数）')
            if (r < 0 || r > 999) return rejected(`reps 需在 0~999 之间，收到 ${r}`)
            s.setReps(Math.round(r))
            return changed(s, `当前组次数已设为 ${s.reps ?? '未设置'}`)
          }

          case 'complete_set': {
            if (s.phase !== 'exercise') return rejected(`当前是「${phase}」，只有做组中才能登记完成`)
            // 允许「顺手改一下再登记」：模型常见的一句「这组 60kg 做了 8 次，记上」
            const kg = num(args.weightKg)
            if (kg != null) s.setWeight(kg)
            const r = num(args.reps)
            if (r != null) s.setReps(Math.round(r))
            const before = s.doneCount
            s.completeSet()
            if (s.doneCount === before) return rejected('这一组没能登记完成（相位已变化）')
            return changed(s, `已登记完成第 ${before + 1} 组`)
          }

          case 'skip_set': {
            if (!s.skipCurrentSet())
              return rejected(`当前是「${phase}」，没有可跳过的组（热身请用 skip_warmup）`)
            return changed(s, '已跳过当前组（不计入完成）')
          }

          case 'add_set': {
            if (!ex || s.phase === 'summary') return rejected(`当前是「${phase}」，不能加练`)
            const used = s.effSets(ex) - ex.sets
            if (used >= MAX_EXTRA_SETS) return rejected(`加练已达上限（${MAX_EXTRA_SETS} 组）`)
            s.addExtraSet()
            return changed(s, `${ex.name} 已加练一组（现在共 ${s.effSets(ex)} 组）`)
          }

          case 'redo_last_set': {
            if (!s.redoLastSet()) return rejected('没有可重做的组（还没有完成过任何正式组）')
            return changed(s, `已回到「${ex?.name ?? '上一组'}」第 ${s.setIndex} 组重做`)
          }

          case 'skip_warmup': {
            if (s.phase !== 'warmup') return rejected(`当前是「${phase}」，不在热身相位`)
            s.skipWarmup()
            return changed(s, '已跳过剩余热身，直接进入正式组')
          }

          case 'start_temp_rest': {
            const min = num(args.minutes)
            if (min == null) return rejected('start_temp_rest 需要 minutes（分钟数）')
            if (min <= 0 || min > 60) return rejected(`minutes 需在 0~60 之间，收到 ${min}`)
            if (!s.startTempRest(min))
              return rejected(`当前是「${phase}」，这个相位不能开计时休息（热身/休息中请直接用界面）`)
            return changed(s, `已开始 ${min} 分钟临时休息，结束后回到刚才的相位`)
          }

          case 'skip_rest': {
            if (s.phase !== 'rest') return rejected(`当前是「${phase}」，不在休息相位`)
            s.skipRest()
            return changed(s, '已结束休息')
          }

          case 'goto_set': {
            const plan = s.plan
            if (!plan) return rejected('会话里没有课程数据')
            const ei = num(args.exerciseIndex)
            const sn = num(args.setNo)
            if (ei == null || sn == null)
              return rejected('goto_set 需要 exerciseIndex 与 setNo（都从 1 开始）')
            if (!Number.isInteger(ei) || ei < 1 || ei > plan.exercises.length)
              return rejected(`exerciseIndex 需在 1~${plan.exercises.length} 之间，收到 ${ei}`)
            const target = plan.exercises[ei - 1]!
            if (!Number.isInteger(sn) || sn < 1 || sn > s.effSets(target))
              return rejected(`setNo 需在 1~${s.effSets(target)} 之间，收到 ${sn}`)
            if (!s.skipToSet(ei - 1, sn))
              return rejected('只能跳到更靠后的未做组（不能回跳已完成的组）')
            return changed(s, `已跳至「${target.name}」第 ${sn} 组，中间未做的组记为跳过`)
          }

          case 'swap_exercise': {
            const plan = s.plan
            if (!plan) return rejected('会话里没有课程数据')
            const ei = num(args.exerciseIndex)
            const id = args.exerciseId?.trim()
            if (ei == null || !id)
              return rejected('swap_exercise 需要 exerciseIndex（1 起）与 exerciseId')
            if (!Number.isInteger(ei) || ei < 1 || ei > plan.exercises.length)
              return rejected(`exerciseIndex 需在 1~${plan.exercises.length} 之间，收到 ${ei}`)
            const target = plan.exercises[ei - 1]!
            if (!s.canSwapExercise(ei - 1))
              return rejected(`「${target.name}」已经做过组了，不能换（只能换还没开始的动作）`)

            const lib = useExerciseLibStore()
            await lib.ensureLoaded()
            const src = lib.list.find((e) => e.id === id)
            if (!src) return rejected(`动作库里没有 id 为「${id}」的动作，请先用动作库工具查 id`)
            if (src.hidden) return rejected(`「${src.name}」已隐藏，不能作为替换目标`)
            if (src.kind !== target.kind)
              return rejected(`只能换成同类动作：目标是 ${target.kind}，而「${src.name}」是 ${src.kind}`)

            const ok = s.swapExercise(ei - 1, {
              exerciseId: src.id,
              name: src.name,
              tips: src.tips,
              muscles: src.muscles,
            })
            if (!ok) return rejected('替换失败：该动作已开始或与当前动作相同')
            return changed(s, `第 ${ei} 个动作已换成「${src.name}」`)
          }

          default:
            return rejected('未知的 action')
        }
      } catch (e) {
        // 兜底：任何意外都收敛成结构化失败，绝不让一轮对话因为一次调整而崩掉
        return rejected(`调整失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }),
]
