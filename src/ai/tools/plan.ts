/** 训练课程域工具：课程 CRUD · 对应 planService */

import { Type } from '@earendil-works/pi-ai'

import { WORKOUT_META } from '@/config/domain'
import { planService } from '@/services/planService'
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

const EXERCISE = Type.Object({
  name: Type.String({ description: '动作名，如「杠铃卧推」' }),
  kind: EXERCISE_KIND,
  sets: Type.Optional(Type.Number({ description: '组数，默认 3' })),
  reps: Type.Optional(Type.Number({ description: '每组次数（strength 用）' })),
  weightKg: Type.Optional(Type.Number({ description: '建议重量 kg（strength 用）' })),
  targetSec: Type.Optional(Type.Number({ description: '每组目标秒数（timed 用）' })),
  durationMin: Type.Optional(Type.Number({ description: '时长分钟（cardio 用）' })),
  restSec: Type.Optional(Type.Number({ description: '组间休息秒，默认 90' })),
  tips: Type.Optional(Type.String({ description: '动作要点' })),
})

/** 动作入参 → 存储结构：补 id 与缺省值 */
function normalizeExercise(e: { [k: string]: unknown }): {
  id: string
  name: string
  kind: PlanExerciseKind
  sets: number
  reps: number | null
  weightKg: number | null
  targetSec: number | null
  durationMin: number | null
  restSec: number
  group?: string
  tips: string
} {
  return {
    id: crypto.randomUUID(),
    name: String(e.name ?? '').trim() || '未命名动作',
    kind: (e.kind as PlanExerciseKind) ?? 'strength',
    sets: typeof e.sets === 'number' && e.sets > 0 ? Math.round(e.sets) : 3,
    reps: typeof e.reps === 'number' ? e.reps : null,
    weightKg: typeof e.weightKg === 'number' ? e.weightKg : null,
    targetSec: typeof e.targetSec === 'number' ? e.targetSec : null,
    durationMin: typeof e.durationMin === 'number' ? e.durationMin : null,
    restSec: typeof e.restSec === 'number' && e.restSec >= 0 ? Math.round(e.restSec) : 90,
    tips: typeof e.tips === 'string' ? e.tips : '',
  }
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
]
