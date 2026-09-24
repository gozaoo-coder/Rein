/** 运动域工具：记录 CRUD + MET 热量估算 · 对应 exerciseService；动作库的增改见下方 */

import { Type } from '@earendil-works/pi-ai'

import { normalizeActivation } from '@/config/muscles'
import { estimateKcal, WORKOUT_META } from '@/config/domain'
import { exerciseService } from '@/services/exerciseService'
import { exerciseLibService } from '@/services/exerciseLibService'
import { nutritionService } from '@/services/nutritionService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import type { Intensity, WorkoutType } from '@/types'
import { endOfMonth, startOfMonth, todayStr } from '@/utils/date'
import { MUSCLES } from './muscleSchema'
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

/* ---- 动作库（0025）的写入 schema：与 src/types/exercise.ts 的枚举一一对应 ---- */

const EXERCISE_KIND = Type.Union(
  [Type.Literal('strength'), Type.Literal('timed'), Type.Literal('cardio')],
  { description: '动作类型：strength=力量(按组次计重) / timed=计时(平板支撑等) / cardio=有氧(按时长计)' },
)
const EXERCISE_CATEGORY = Type.Union(
  [
    Type.Literal('push'),
    Type.Literal('pull'),
    Type.Literal('legs'),
    Type.Literal('core'),
    Type.Literal('cardio'),
    Type.Literal('mobility'),
    Type.Literal('other'),
  ],
  { description: '浏览分类：push 推 / pull 拉 / legs 腿 / core 核心 / cardio 有氧 / mobility 柔韧 / other 其他' },
)
const EXERCISE_EQUIPMENT = Type.Union(
  [
    Type.Literal('barbell'),
    Type.Literal('dumbbell'),
    Type.Literal('machine'),
    Type.Literal('cable'),
    Type.Literal('bodyweight'),
    Type.Literal('band'),
    Type.Literal('cardio'),
    Type.Literal('other'),
  ],
  { description: '器材：决定建议重量的取整步进（杠铃 2.5 / 哑铃 2 / 自重不加重量）' },
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

  defineTool({
    name: 'upsert_exercise',
    group: 'exercise',
    label: '新建/修改自建动作',
    description:
      '在动作库（全部动作的唯一真源）里新建或修改一个**自建**动作：名称、别名、类型/分类/器材、肌群激活表、要点与默认处方。内置动作只读——提交内置动作的 id 会被中文报错拒绝（那种情况改说「隐藏它」或「另建自建动作」）。用户要「加一个动作 / 自定义动作 / 给某个动作标肌群」时用它。',
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: '动作 id（list_exercises 返回）；缺省 = 新建。只能改自建动作（custom=true）' }),
      ),
      name: Type.String({ description: '动作名（用户口语，如「器械推胸」）' }),
      aliases: Type.Optional(
        Type.Array(Type.String(), { description: '别名：旧数据/口语按名匹配时的补充命中词' }),
      ),
      kind: EXERCISE_KIND,
      category: EXERCISE_CATEGORY,
      equipment: Type.Optional(EXERCISE_EQUIPMENT),
      muscles: Type.Optional(MUSCLES),
      tips: Type.Optional(Type.String({ description: '动作要点（≤120 字，训练中展示）' })),
      defaultSets: Type.Optional(Type.Number({ description: '默认组数，缺省 3' })),
      defaultReps: Type.Optional(Type.Number({ description: '默认次数（strength 用）' })),
      defaultWeightKg: Type.Optional(Type.Number({ description: '建议重量 kg（strength 用）' })),
      defaultTargetSec: Type.Optional(Type.Number({ description: '每组目标秒数（timed 用）' })),
      defaultDurationMin: Type.Optional(Type.Number({ description: '时长分钟（cardio 用）' })),
      defaultRestSec: Type.Optional(Type.Number({ description: '组间休息秒，缺省 90' })),
    }),
    async execute(args) {
      const rec = await exerciseLibService.upsert({
        id: args.id,
        name: args.name.trim(),
        aliases: args.aliases?.map((a) => a.trim()).filter(Boolean),
        kind: args.kind,
        category: args.category,
        equipment: args.equipment ?? null,
        muscles: normalizeActivation(args.muscles),
        tips: args.tips?.trim(),
        defaultSets: args.defaultSets,
        defaultReps: args.defaultReps,
        defaultWeightKg: args.defaultWeightKg,
        defaultTargetSec: args.defaultTargetSec,
        defaultDurationMin: args.defaultDurationMin,
        defaultRestSec: args.defaultRestSec,
      })
      // 动作库缓存立即刷新：用户切回动作库就能看到新动作与肌群图
      await useExerciseLibStore().load(true)
      return { ok: true, id: rec.id, name: rec.name, muscles: rec.muscles, custom: rec.isCustom }
    },
  }),

  defineTool({
    name: 'set_exercise_muscles',
    group: 'exercise',
    label: '修改动作肌群',
    description:
      '只改某个动作的肌群激活表（主攻/辅助/稳定档位），不动其它字段。内置动作只读：会返回中文错误（此时向用户说明「要么隐藏它，要么另建自建动作」）。',
    parameters: Type.Object({
      exerciseId: Type.String({ description: '动作库 id（list_exercises 返回）' }),
      muscles: MUSCLES,
    }),
    async execute(args) {
      const rec = await exerciseLibService.get(args.exerciseId)
      if (!rec.isCustom) {
        throw new Error(`内置动作「${rec.name}」的肌群表不可改：可以隐藏它，或另建一个自建动作`)
      }
      const updated = await exerciseLibService.upsert({
        id: rec.id,
        name: rec.name,
        aliases: rec.aliases,
        kind: rec.kind,
        category: rec.category,
        equipment: rec.equipment,
        muscles: normalizeActivation(args.muscles),
        tips: rec.tips,
        defaultSets: rec.defaultSets,
        defaultReps: rec.defaultReps,
        defaultWeightKg: rec.defaultWeightKg,
        defaultTargetSec: rec.defaultTargetSec,
        defaultDurationMin: rec.defaultDurationMin,
        defaultRestSec: rec.defaultRestSec,
      })
      await useExerciseLibStore().load(true)
      return { ok: true, id: updated.id, name: updated.name, muscles: updated.muscles }
    },
  }),
]
