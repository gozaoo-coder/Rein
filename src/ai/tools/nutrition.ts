/** 营养域工具：每日汇总 / 目标与资料配置 / 体重身高记录 · 对应 nutritionService */

import { Type } from '@earendil-works/pi-ai'

import { nutritionService } from '@/services/nutritionService'
import type { ActivityLevel, DailyTargets, Goal, Profile, Sex } from '@/types'
import { defineTool, resolveDate, type AppTool } from './types'

const SEX = Type.Union([Type.Literal('male'), Type.Literal('female')], {
  description: '性别：male=男 / female=女',
})
const ACTIVITY = Type.Union(
  [
    Type.Literal('sedentary'),
    Type.Literal('light'),
    Type.Literal('moderate'),
    Type.Literal('active'),
  ],
  { description: '活动水平：sedentary=久坐 / light=轻度活动 / moderate=中度活动 / active=高度活动' },
)
const GOAL = Type.Union([Type.Literal('cut'), Type.Literal('keep'), Type.Literal('bulk')], {
  description: '目标：cut=减脂 / keep=保持 / bulk=增肌',
})

/** 用入参中显式提供的字段覆盖基准（undefined 视为不修改） */
function mergeTargets(base: DailyTargets, patch: Partial<DailyTargets>): DailyTargets {
  const next = { ...base }
  for (const k of Object.keys(patch) as (keyof DailyTargets)[]) {
    const v = patch[k]
    if (typeof v === 'number' && Number.isFinite(v)) next[k] = v
  }
  return next
}

export const nutritionTools: AppTool[] = [
  defineTool({
    name: 'get_daily_summary',
    group: 'nutrition',
    label: '查看每日营养汇总',
    description: '查询某天的摄入聚合（热量/蛋白/碳水/脂肪/钠等）、当日目标与运动消耗。date 不传默认今天。',
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，缺省为今天' })),
    }),
    async execute(args) {
      return nutritionService.getDailySummary(resolveDate(args.date))
    },
  }),

  defineTool({
    name: 'get_targets',
    group: 'nutrition',
    label: '查看每日目标',
    description: '查看当前生效的每日营养目标（热量/蛋白/碳水/脂肪/钠/饮水）。',
    parameters: Type.Object({}),
    async execute() {
      return nutritionService.getTargets(null)
    },
  }),

  defineTool({
    name: 'set_targets',
    group: 'nutrition',
    label: '设置每日目标',
    description:
      '修改每日营养目标，只传需要改的字段（其余保持不变）。用户明确要求调整目标时调用（应用内另有确认卡流程，这里是直接生效）。',
    parameters: Type.Object({
      kcal: Type.Optional(Type.Number({ description: '能量（大卡）' })),
      protein: Type.Optional(Type.Number({ description: '蛋白质（g）' })),
      carb: Type.Optional(Type.Number({ description: '碳水（g）' })),
      fat: Type.Optional(Type.Number({ description: '脂肪（g）' })),
      sodiumMg: Type.Optional(Type.Number({ description: '钠（mg）' })),
      waterMl: Type.Optional(Type.Number({ description: '饮水（ml）' })),
    }),
    async execute(args) {
      const patch = args as Partial<DailyTargets>
      if (Object.values(patch).every((v) => typeof v !== 'number')) {
        throw new Error('至少提供一个要修改的字段')
      }
      const current = await nutritionService.getTargets(null)
      const next = mergeTargets(current, patch)
      await nutritionService.setTargets(next, null)
      return { ok: true, targets: next }
    },
  }),

  defineTool({
    name: 'get_profile',
    group: 'nutrition',
    label: '查看个人资料',
    description: '查看个人资料：昵称、性别、生日、身高体重、目标体重、活动水平、减脂/保持/增肌目标。',
    parameters: Type.Object({}),
    async execute() {
      return nutritionService.getProfile()
    },
  }),

  defineTool({
    name: 'update_profile',
    group: 'nutrition',
    label: '更新个人资料',
    description: '更新个人资料，只传需要改的字段。注意：体重变化建议用 record_body_metric 留档。',
    parameters: Type.Object({
      nickname: Type.Optional(Type.String({ description: '昵称' })),
      sex: Type.Optional(SEX),
      birthday: Type.Optional(Type.String({ description: 'YYYY-MM-DD' })),
      heightCm: Type.Optional(Type.Number({ description: '身高（cm）' })),
      weightKg: Type.Optional(Type.Number({ description: '体重（kg）' })),
      targetWeightKg: Type.Optional(Type.Number({ description: '目标体重（kg）' })),
      activityLevel: Type.Optional(ACTIVITY),
      goal: Type.Optional(GOAL),
    }),
    async execute(args) {
      const cur: Profile = await nutritionService.getProfile()
      const next: Profile = {
        ...cur,
        nickname: args.nickname ?? cur.nickname,
        sex: (args.sex as Sex | undefined) ?? cur.sex,
        birthday: args.birthday ?? cur.birthday,
        heightCm: args.heightCm ?? cur.heightCm,
        weightKg: args.weightKg ?? cur.weightKg,
        targetWeightKg: args.targetWeightKg ?? cur.targetWeightKg,
        activityLevel: (args.activityLevel as ActivityLevel | undefined) ?? cur.activityLevel,
        goal: (args.goal as Goal | undefined) ?? cur.goal,
      }
      return nutritionService.updateProfile(next)
    },
  }),

  defineTool({
    name: 'list_body_metrics',
    group: 'nutrition',
    label: '查看体重身高记录',
    description: '按时间倒序查看最近的体重 / 身高记录。查最新体重时 limit 取 1。',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: '最多返回条数，默认 30' })),
    }),
    async execute(args) {
      const rows = await nutritionService.listBodyMetrics(Math.min(Math.max(1, args.limit ?? 30), 120))
      return rows.map((r) => ({ id: r.id, date: r.date, weightKg: r.weightKg, heightCm: r.heightCm }))
    },
  }),

  defineTool({
    name: 'record_body_metric',
    group: 'nutrition',
    label: '记录体重身高',
    description: '补录一条体重和/或身高（同日再记只覆盖）。date 不传默认今天。',
    parameters: Type.Object({
      weightKg: Type.Optional(Type.Number({ description: '体重（kg）' })),
      heightCm: Type.Optional(Type.Number({ description: '身高（cm）' })),
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，缺省为今天' })),
    }),
    async execute(args) {
      if (args.weightKg == null && args.heightCm == null) throw new Error('至少提供 weightKg 或 heightCm')
      const row = await nutritionService.recordBodyMetric({
        date: resolveDate(args.date),
        weightKg: args.weightKg ?? null,
        heightCm: args.heightCm ?? null,
      })
      return { ok: true, id: row.id, date: row.date }
    },
  }),

  defineTool({
    name: 'delete_body_metric',
    group: 'nutrition',
    label: '删除体重身高记录',
    description: '删除一条体重 / 身高记录。仅限用户明确要求删除时使用；id 来自 list_body_metrics。',
    dangerous: true,
    parameters: Type.Object({ id: Type.Number({ description: 'list_body_metrics 返回的记录 id' }) }),
    async execute(args) {
      await nutritionService.deleteBodyMetric(args.id)
      return { ok: true }
    },
  }),
]
