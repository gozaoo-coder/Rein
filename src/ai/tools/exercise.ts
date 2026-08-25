/** 运动域工具：记录 CRUD + MET 热量估算 · 对应 exerciseService */

import { Type } from '@earendil-works/pi-ai'

import { estimateKcal, WORKOUT_META } from '@/config/domain'
import { exerciseService } from '@/services/exerciseService'
import { nutritionService } from '@/services/nutritionService'
import type { Intensity, WorkoutType } from '@/types'
import { endOfMonth, startOfMonth, todayStr } from '@/utils/date'
import { defineTool, hhmmToMin, resolveDate, type AppTool } from './types'

const TYPE_KEYS = Object.keys(WORKOUT_META) as WorkoutType[]
const WORKOUT_TYPE = Type.Union(
  TYPE_KEYS.map((k) => Type.Literal(k)),
  {
    description: `运动类型：${TYPE_KEYS.map((k) => `${k}=${WORKOUT_META[k].label}`).join(' / ')}`,
  },
)
const INTENSITY = Type.Union(
  [Type.Literal('low'), Type.Literal('moderate'), Type.Literal('high')],
  { description: '强度：low=低 / moderate=中 / high=高' },
)

/** 最新体重：先看体重记录，缺省回落到个人资料 */
async function currentWeightKg(): Promise<number | null> {
  const rows = await nutritionService.listBodyMetrics(1)
  if (rows[0]?.weightKg != null) return rows[0].weightKg
  const profile = await nutritionService.getProfile()
  return profile.weightKg
}

export const exerciseTools: AppTool[] = [
  defineTool({
    name: 'list_workouts',
    group: 'exercise',
    label: '查看运动记录',
    description: '查看某日期区间的运动记录。区间不传默认本月。',
    parameters: Type.Object({
      start: Type.Optional(Type.String({ description: '起始 YYYY-MM-DD，缺省为本月 1 日' })),
      end: Type.Optional(Type.String({ description: '结束 YYYY-MM-DD，缺省为本月末' })),
    }),
    async execute(args) {
      const today = todayStr()
      return exerciseService.listWorkouts(
        args.start?.trim() ? resolveDate(args.start, 'start') : startOfMonth(today),
        args.end?.trim() ? resolveDate(args.end, 'end') : endOfMonth(today),
      )
    },
  }),

  defineTool({
    name: 'list_all_workouts',
    group: 'exercise',
    label: '查看全部运动记录',
    description: '查看全部历史运动记录（数量多，优先用 list_workouts 按区间查）。',
    parameters: Type.Object({}),
    async execute() {
      return exerciseService.listAllWorkouts()
    },
  }),

  defineTool({
    name: 'estimate_kcal',
    group: 'exercise',
    label: '估算运动消耗',
    description: '按 MET 表与用户最新体重估算一次运动的千卡消耗。create_workout 不传 kcal 时会自动用它。',
    parameters: Type.Object({
      workoutType: WORKOUT_TYPE,
      intensity: INTENSITY,
      durationMin: Type.Number({ description: '时长（分钟）' }),
    }),
    async execute(args) {
      const weight = await currentWeightKg()
      if (weight == null) throw new Error('缺少体重（先 record_body_metric 或 update_profile 提供）')
      return {
        weightKg: weight,
        kcal: estimateKcal(args.workoutType as WorkoutType, args.intensity as Intensity, args.durationMin, weight),
      }
    },
  }),

  defineTool({
    name: 'create_workout',
    group: 'exercise',
    label: '写入运动记录',
    description:
      '新增一条运动记录。kcal 不传时按最新体重自动估算；date 不传默认今天；startTime 用 HH:mm。',
    parameters: Type.Object({
      name: Type.String({ description: '名称，如「晨跑」「胸肩训练」' }),
      workoutType: WORKOUT_TYPE,
      intensity: INTENSITY,
      durationMin: Type.Number({ description: '时长（分钟）' }),
      kcal: Type.Optional(Type.Number({ description: '消耗（大卡）；缺省自动按 MET×体重估算' })),
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，缺省为今天' })),
      startTime: Type.Optional(Type.String({ description: '开始时间 HH:mm' })),
      note: Type.Optional(Type.String({ description: '备注' })),
    }),
    async execute(args) {
      let { kcal } = args
      if (kcal == null) {
        const weight = await currentWeightKg()
        kcal =
          weight == null
            ? 0
            : estimateKcal(args.workoutType as WorkoutType, args.intensity as Intensity, args.durationMin, weight)
      }
      const row = await exerciseService.createWorkout({
        name: args.name.trim(),
        type: args.workoutType as WorkoutType,
        date: resolveDate(args.date),
        startMin: args.startTime ? hhmmToMin(args.startTime) : null,
        durationMin: args.durationMin,
        intensity: args.intensity as Intensity,
        kcal,
        note: args.note ?? null,
      })
      return { ok: true, id: row.id, kcal }
    },
  }),

  defineTool({
    name: 'delete_workout',
    group: 'exercise',
    label: '删除运动记录',
    description: '删除一条运动记录。仅限用户明确要求删除时使用。',
    dangerous: true,
    parameters: Type.Object({ id: Type.Number({ description: '运动记录 id' }) }),
    async execute(args) {
      await exerciseService.deleteWorkout(args.id)
      return { ok: true }
    },
  }),
]
