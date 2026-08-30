/** 训练课程域工具：课程 CRUD · 对应 planService */

import { Type, type TSchema } from '@earendil-works/pi-ai'

import { MUSCLE_KEYS, MUSCLE_LABELS, type ActivationMap, type MuscleKey } from '@/config/muscles'
import { WORKOUT_META } from '@/config/domain'
import { planService } from '@/services/planService'
import { sessionService } from '@/services/sessionService'
import { aggregateStrengthDays, fmtKg } from '@/utils/strength'
import type { PlanExerciseKind, WorkoutType } from '@/types'
import { defineTool, type AppTool } from './types'

const TYPE_KEYS = Object.keys(WORKOUT_META) as WorkoutType[]
const PLAN_TYPE = Type.Union(
  TYPE_KEYS.map((k) => Type.Literal(k)),
  { description: `保存训练时计入的运动类型：${TYPE_KEYS.map((k) => `${k}=${WORKOUT_META[k].label}`).join(' / ')}` },
)

const EXERCISE_KIND = Type.Union(
  [Type.Literal('strength'), Type.Literal('timed'), Type.Literal('cardio')],
  { description: '动作类型：strength=力量(按组次计重) / timed=计时(平板支撑等) / cardio=有氧(按时长计)' },
)

const MUSCLE_LEVEL = Type.Union(
  [Type.Literal(1), Type.Literal(2), Type.Literal(3)],
  { description: '档位：1=稳定 2=辅助 3=主攻' },
)

/** 动作显式肌群：键为全部 13 个肌群，值 1~3 档，只给练到的键即可 */
const MUSCLES = Type.Object(
  Object.fromEntries(MUSCLE_KEYS.map((k) => [k, Type.Optional(MUSCLE_LEVEL)])) as Record<string, TSchema>,
  {
    description: `动作训练到的肌群与档位（可选）：${MUSCLE_KEYS.map((k) => `${k}=${MUSCLE_LABELS[k]}`).join(' / ')}。不填则按动作名自动识别（卧推/深蹲等常见名可识别）。`,
  },
)

/** 激活热身组：正式组前的小重量激活（不计入正式组数） */
const WARMUP_SET = Type.Object({
  weightKg: Type.Number({ description: '热身重量 kg，必须明显小于正式组重量' }),
  reps: Type.Number({ description: '热身次数' }),
})

const EXERCISE = Type.Object({
  name: Type.String({
    description: '动作名，如「杠铃卧推」。建议用常见中文动作名（卧推/深蹲/硬拉/划船/弯举/推举/卷腹等），名称无法识别肌群时请用 muscles 字段直接指定',
  }),
  kind: EXERCISE_KIND,
  sets: Type.Optional(Type.Number({ description: '组数，默认 3' })),
  reps: Type.Optional(Type.Number({ description: '每组次数（strength 用）' })),
  weightKg: Type.Optional(Type.Number({ description: '建议重量 kg（strength 用）' })),
  warmups: Type.Optional(
    Type.Array(WARMUP_SET, {
      description:
        '激活热身组（strength 用，最多 2 组）：≥30kg 的复合动作配两段渐进 [50%×8, 75%×4]；12~30kg 配单组激活 [50%×12]；<12kg 不配。热身重量取整到 2.5 的倍数',
      maxItems: 2,
    }),
  ),
  targetSec: Type.Optional(Type.Number({ description: '每组目标秒数（timed 用）' })),
  durationMin: Type.Optional(Type.Number({ description: '时长分钟（cardio 用）' })),
  restSec: Type.Optional(Type.Number({ description: '组间休息秒，默认 90' })),
  tips: Type.Optional(Type.String({ description: '动作要点' })),
  muscles: Type.Optional(MUSCLES),
})

/** 动作入参 → 存储结构：补 id 与缺省值 */
function normalizeExercise(e: { [k: string]: unknown }): {
  id: string
  name: string
  kind: PlanExerciseKind
  sets: number
  reps: number | null
  weightKg: number | null
  warmups?: { weightKg: number; reps: number }[]
  targetSec: number | null
  durationMin: number | null
  restSec: number
  group?: string
  tips: string
  muscles?: ActivationMap
} {
  const out = {
    id: crypto.randomUUID(),
    name: String(e.name ?? '').trim() || '未命名动作',
    kind: (e.kind as PlanExerciseKind) ?? 'strength',
    sets: typeof e.sets === 'number' && e.sets > 0 ? Math.round(e.sets) : 3,
    reps: typeof e.reps === 'number' ? e.reps : null,
    weightKg: typeof e.weightKg === 'number' ? e.weightKg : null,
    ...normalizeWarmups(e.warmups),
    targetSec: typeof e.targetSec === 'number' ? e.targetSec : null,
    durationMin: typeof e.durationMin === 'number' ? e.durationMin : null,
    restSec: typeof e.restSec === 'number' && e.restSec >= 0 ? Math.round(e.restSec) : 90,
    tips: typeof e.tips === 'string' ? e.tips : '',
    ...normalizeMuscles(e.muscles),
  }
  // 热身重量必须小于正式组重量，否则整组丢弃（宁可没有热身也不要假热身）
  if (out.warmups && out.weightKg != null) {
    const ok = out.warmups.filter((w) => w.weightKg < out.weightKg!)
    if (ok.length) out.warmups = ok
    else delete out.warmups
  }
  return out
}

/** 校验激活热身组：重量/次数为正、最多 2 组、必须小于正式组重量，非法时丢弃 */
function normalizeWarmups(w: unknown): { warmups?: { weightKg: number; reps: number }[] } {
  if (!Array.isArray(w)) return {}
  const list: { weightKg: number; reps: number }[] = []
  for (const it of w.slice(0, 2)) {
    if (!it || typeof it !== 'object') continue
    const o = it as { [k: string]: unknown }
    const weightKg = typeof o.weightKg === 'number' ? o.weightKg : NaN
    const reps = typeof o.reps === 'number' ? o.reps : NaN
    if (!Number.isFinite(weightKg) || weightKg <= 0 || !Number.isFinite(reps) || reps <= 0) continue
    list.push({ weightKg: Math.round(weightKg * 10) / 10, reps: Math.round(reps) })
  }
  return list.length ? { warmups: list } : {}
}

/** 白名单校验显式肌群：只保留合法键与 1~3 档，全非法时返回空对象（不落库） */
function normalizeMuscles(m: unknown): { muscles?: ActivationMap } {
  if (!m || typeof m !== 'object') return {}
  const out: ActivationMap = {}
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (MUSCLE_KEYS.includes(k as MuscleKey) && (v === 1 || v === 2 || v === 3)) {
      out[k as MuscleKey] = v
    }
  }
  return Object.keys(out).length ? { muscles: out } : {}
}

export const planTools: AppTool[] = [
  defineTool({
    name: 'list_plans',
    group: 'plan',
    label: '查看训练课程',
    description: '列出全部训练课程模板（最近使用的在前）。',
    parameters: Type.Object({}),
    async execute() {
      const rows = await planService.list()
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        subtitle: p.subtitle,
        workoutType: p.workoutType,
        exerciseCount: p.exercises.length,
        lastUsedAt: p.lastUsedAt,
      }))
    },
  }),

  defineTool({
    name: 'get_plan',
    group: 'plan',
    label: '查看课程详情',
    description: '查看一门训练课程的完整动作清单。',
    parameters: Type.Object({ id: Type.String({ description: '课程 id（list_plans 返回）' }) }),
    async execute(args) {
      const p = await planService.get(args.id)
      if (!p) throw new Error(`课程不存在：id=${args.id}`)
      return p
    },
  }),

  defineTool({
    name: 'upsert_plan',
    group: 'plan',
    label: '新建/覆盖训练课程',
    description:
      '创建或整门覆盖一门训练课程。id 不传为新建；传已有 id 则整体替换（以本次 exercises 为准）。用户明确要求创建/修改课程时调用。',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '课程 id；缺省 = 新建' })),
      name: Type.String({ description: '课程名，如「推力日 A」' }),
      subtitle: Type.Optional(Type.String({ description: '一句话副标题' })),
      workoutType: PLAN_TYPE,
      exercises: Type.Array(EXERCISE, { description: '动作清单，按训练顺序排列' }),
    }),
    async execute(args) {
      if (args.exercises.length === 0) throw new Error('课程至少要有一个动作')
      const saved = await planService.upsert({
        id: args.id ?? crypto.randomUUID(),
        name: args.name.trim(),
        subtitle: args.subtitle?.trim() || '',
        workoutType: args.workoutType,
        exercises: args.exercises.map(normalizeExercise),
      })
      return { ok: true, id: saved.id, name: saved.name, exerciseCount: saved.exercises.length }
    },
  }),

  defineTool({
    name: 'delete_plan',
    group: 'plan',
    label: '删除训练课程',
    description: '删除一门训练课程模板。仅限用户明确要求删除时使用。',
    dangerous: true,
    parameters: Type.Object({ id: Type.String({ description: '课程 id' }) }),
    async execute(args) {
      await planService.remove(args.id)
      return { ok: true }
    },
  }),

  defineTool({
    name: 'get_strength_progress',
    group: 'plan',
    label: '查看力量进步',
    description:
      '查看动作的重量变化记录（逐组明细，含热身组标记）。不带参数 = 列出有力量记录的动作（按最近训练排序）；带 exercise_name = 该动作每次训练的做组明细与最大重量。用户问「卧推进步了没/该加重了吗/重量曲线」时调用。',
    parameters: Type.Object({
      exerciseName: Type.Optional(Type.String({ description: '动作名（不带参数时返回动作清单）' })),
    }),
    async execute(args) {
      if (!args.exerciseName) return { exercises: await sessionService.strengthExercises() }
      const rows = await sessionService.strengthHistory(args.exerciseName)
      const days = aggregateStrengthDays(rows)
      const warmupNote = rows.filter((r) => r.warmup).length
      return {
        exercise: args.exerciseName,
        sessions: days.map((d) => ({
          date: d.date,
          top: `${fmtKg(d.top)}kg${d.topReps != null ? `×${d.topReps}` : ''}`,
          workingSets: d.sets.map((s) => `${fmtKg(s.weightKg ?? 0)}kg×${s.reps ?? '?'}`),
        })),
        latestVsFirst:
          days.length >= 2
            ? `${fmtKg(days[days.length - 1]!.top)} vs ${fmtKg(days[0]!.top)} kg`
            : null,
        warmupSetsTotal: warmupNote,
      }
    },
  }),
]
