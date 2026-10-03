/** 运动域工具：记录 CRUD + MET 热量估算 · 对应 exerciseService；动作库的增改见下方 */

import { Type } from '@earendil-works/pi-ai'

import { normalizeActivation } from '@/config/muscles'
import {
  WORKOUT_GROUPS,
  WORKOUT_META,
  estimateKcal,
  estimateKcalByEffort,
  effortToIntensity,
  workoutTypesInGroup,
} from '@/config/domain'
import { exerciseService } from '@/services/exerciseService'
import { exerciseLibService } from '@/services/exerciseLibService'
import { nutritionService } from '@/services/nutritionService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import type { EffortLevel, Intensity, WorkoutType } from '@/types'
import { endOfMonth, startOfMonth, todayStr } from '@/utils/date'
import { MUSCLES } from './muscleSchema'
import { defineTool, hhmmToMin, resolveDate, type AppTool } from './types'

const TYPE_KEYS = Object.keys(WORKOUT_META) as WorkoutType[]
/** 分区列出类型：平铺 30 项模型容易挑错（把「爬山」塞进 run），按语义分区它对得上 */
const TYPE_HELP = WORKOUT_GROUPS.map(
  (g) => `${g.label}：${workoutTypesInGroup(g.key).map((k) => `${k}=${WORKOUT_META[k].label}`).join('、')}`,
).join('\n')
const WORKOUT_TYPE = Type.Union(
  TYPE_KEYS.map((k) => Type.Literal(k)),
  {
    description: `运动类型（按语义分区）：\n${TYPE_HELP}\n\n挑最贴近的一项；用户说的项目不在表里时用 other。`,
  },
)
const INTENSITY = Type.Union(
  [Type.Literal('low'), Type.Literal('moderate'), Type.Literal('high')],
  { description: '强度：low=低 / moderate=中 / high=高' },
)

/**
 * 体感强度 1–5（用户说「累不累」）。用户能答的只有这个 —— 他不知道自己配速多少、
 * 也不知道自己的 MET 档，所以凡是问得到用户的地方都优先问这个，别去推导 intensity。
 */
const EFFORT = Type.Number({
  description:
    '体感强度 1–5（用户自己说「这次累不累」）：1=毫不累 2=有点累 3=适中 4=挺累 5=累坏了。' +
    '用户能答这个，别要求他给 MET 档位或配速；没提到体感时省略（按 3 适中处理）。',
  minimum: 1,
  maximum: 5,
})

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

/**
 * 热量口径：体感优先，其次客观档位，都没有按适中算。
 * 前端手动补录是同一条路（`AddWorkoutSheet` → `estimateKcalByEffort`），
 * 所以「AI 里记一笔」和「自己点一下记一笔」得到的估算值是一致的 ——
 * 这两条路分叉会让同一件事有两个数。
 */
function kcalFromArgs(
  type: WorkoutType,
  effort: number | undefined,
  intensity: Intensity | undefined,
  durationMin: number,
  weightKg: number,
): number {
  if (effort != null) {
    const e = Math.min(5, Math.max(1, Math.round(effort))) as EffortLevel
    return estimateKcalByEffort(type, e, durationMin, weightKg)
  }
  return estimateKcal(type, intensity ?? 'moderate', durationMin, weightKg)
}

/**
 * 体感 → 落库用的客观档位（workouts.intensity 是 NOT NULL，见 db.rs MIGRATION_0035）。
 * 直接复用前端那条映射，别在这里另写一份。
 */
const effortToIntensityLocal = effortToIntensity

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
    description:
      '按 MET 表与用户最新体重估算一次运动的千卡消耗。create_workout 不传 kcal 时会自动用它。' +
      '用户给了实测数字（手表/体脂秤/运动 App）就直接用他的，别用这个估算值覆盖 —— 实测比 MET 表准。',
    parameters: Type.Object({
      workoutType: WORKOUT_TYPE,
      effort: Type.Optional(EFFORT),
      intensity: Type.Optional(INTENSITY),
      durationMin: Type.Number({ description: '时长（分钟）' }),
    }),
    async execute(args) {
      const weight = await currentWeightKg()
      if (weight == null) throw new Error('缺少体重（先 record_body_metric 或 update_profile 提供）')
      return {
        weightKg: weight,
        kcal: kcalFromArgs(args.workoutType as WorkoutType, args.effort, args.intensity, args.durationMin, weight),
      }
    },
  }),

  defineTool({
    name: 'create_workout',
    group: 'exercise',
    label: '写入运动记录',
    description:
      '新增一条运动记录。用户口述的运动一律走这里：他说「刚跑了 40 分钟，累但不算累坏了」' +
      '→ workoutType=run, durationMin=40, effort=3；他说「手表上 420 大卡」→ 一并传 kcal，' +
      '**实测值优先于估算**（kcal 传了就不要自己再算）。' +
      'kcal 不传时按最新体重 × MET × 体感估算；date 不传默认今天；startTime 用 HH:mm。' +
      '不知道具体类型就选最接近的，别硬套成 run。',
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: '名称；缺省按「类型 · 时长」自动生成（如「羽毛球 · 50分钟」）' }),
      ),
      workoutType: WORKOUT_TYPE,
      effort: Type.Optional(EFFORT),
      intensity: Type.Optional(INTENSITY),
      durationMin: Type.Number({ description: '时长（分钟）；用户说了实际数字就用他的' }),
      kcal: Type.Optional(Type.Number({ description: '消耗（大卡）。用户报了实测值就传；缺省自动估算' })),
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，缺省为今天' })),
      startTime: Type.Optional(Type.String({ description: '开始时间 HH:mm' })),
      note: Type.Optional(Type.String({ description: '备注' })),
    }),
    async execute(args) {
      const weight = await currentWeightKg()
      const kcal =
        args.kcal != null
          ? args.kcal
          : kcalFromArgs(
              args.workoutType as WorkoutType,
              args.effort,
              args.intensity,
              args.durationMin,
              weight ?? 70,
            )
      const effort = args.effort != null ? (Math.min(5, Math.max(1, Math.round(args.effort))) as EffortLevel) : null
      const row = await exerciseService.createWorkout({
        name: args.name?.trim() || `${WORKOUT_META[args.workoutType as WorkoutType].label} · ${args.durationMin}分钟`,
        type: args.workoutType as WorkoutType,
        date: resolveDate(args.date),
        startMin: args.startTime ? hhmmToMin(args.startTime) : null,
        durationMin: args.durationMin,
        // 体感在场时 intensity 写派生档位（NOT NULL 列，老代码与知识库仍读它）；否则用客观档位
        intensity: effort != null ? effortToIntensityLocal(effort) : ((args.intensity as Intensity | undefined) ?? 'moderate'),
        effort,
        kcal,
        note: args.note ?? (args.kcal != null ? `用户输入消耗 ${args.kcal} 大卡` : null),
      })
      return { ok: true, id: row.id, kcal, estimated: args.kcal == null }
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
