/** 健康方案域工具：查看 / 生成 / 调参 / 采购清单 · 对应 programService 与 stores/program */

import { Type } from '@earendil-works/pi-ai'

import { todayStr } from '@/utils/date'
import { parseBlob } from '@/utils/programEngine'
import { shoppingListText } from '@/utils/shoppingList'
import { defineTool, type AppTool } from './types'

const TIER = Type.Union(
  [
    Type.Literal('conservative'),
    Type.Literal('balanced'),
    Type.Literal('aggressive'),
  ],
  { description: '档位：conservative=保守 / balanced=均衡 / aggressive=进取' },
)

export const programTools: AppTool[] = [
  defineTool({
    name: 'get_program',
    group: 'program',
    label: '查看健康方案',
    description:
      '查看当前生效的健康方案：档位/版本、每日热量与蛋白目标、热量偏移、训练频率与近三日安排概览。没有方案时返回 null。',
    parameters: Type.Object({}),
    async execute() {
      const { useProgramStore } = await import('@/stores/program')
      const store = useProgramStore()
      if (!store.loaded) await store.load()
      const rec = store.active
      if (!rec) return null
      const blob = parseBlob(rec)
      return {
        id: rec.id,
        goal: rec.goal,
        tier: rec.tier,
        version: rec.version,
        weeks: rec.weeks,
        kcalDelta: blob.params.kcalDelta,
        proteinPerKg: blob.params.proteinPerKg,
        kcalTarget: blob.params.targets.kcal,
        proteinTargetG: blob.params.targets.protein,
        mealsCount: blob.params.mealsCount,
        trainingDaysPerWeek: blob.params.trainingDays,
        startDate: blob.days[0]?.date ?? null,
        endDate: blob.days.at(-1)?.date ?? null,
        upcoming: blob.days
          .filter((d) => d.date >= todayStr())
          .slice(0, 3)
          .map((d) => ({
            date: d.date,
            rest: d.rest,
            course: d.courseName,
            kcalTotal: d.meals.reduce((s, m) => s + m.kcal, 0),
          })),
      }
    },
  }),

  defineTool({
    name: 'generate_program',
    group: 'program',
    label: '生成健康方案',
    description:
      '根据个人资料与个人约束从零生成并启用一份健康方案（与页面生成走同一引擎：三档热量/蛋白/餐次 + 训练课 + 每日菜单写入日程）。仅当用户明确要求生成/新建方案时调用；会归档现有生效方案。不传档位默认均衡。生成前确认资料里训练天数/器械/忌口已按用户意图设置。',
    dangerous: true,
    parameters: Type.Object({
      tier: Type.Optional(TIER),
      weeks: Type.Optional(Type.Number({ description: '方案周数 1~26，默认 4' })),
    }),
    async execute(args) {
      const { useProgramStore, defaultStartDate, DEFAULT_PROGRAM_WEEKS } = await import('@/stores/program')
      const store = useProgramStore()
      const tier = (args.tier ?? 'balanced') as 'conservative' | 'balanced' | 'aggressive'
      const weeks = Math.min(26, Math.max(1, Math.round(args.weeks ?? DEFAULT_PROGRAM_WEEKS)))
      const drafts = await store.generateDrafts(defaultStartDate(), weeks)
      const plan = drafts.find((d) => d.tier === tier)
      if (!plan) throw new Error('该档位不存在')
      if (!plan.feasible) throw new Error(`无法启用：${plan.issues.join('；')}`)
      const rec = await store.activate(plan)
      return {
        ok: true,
        program: {
          id: rec.id,
          tier: plan.tier,
          version: rec.version,
          weeks: plan.weeks,
          kcalTarget: plan.params.targets.kcal,
          proteinTargetG: plan.params.targets.protein,
          kcalDelta: plan.params.kcalDelta,
          mealsCount: plan.params.mealsCount,
          trainingDaysPerWeek: plan.params.trainingDays,
          startDate: plan.days[0]?.date ?? null,
          endDate: plan.days.at(-1)?.date ?? null,
        },
        note: '已启用并写入日程；后续可用 adjust_program 微调，或在方案页做 AI 周复盘',
      }
    },
  }),

  defineTool({
    name: 'adjust_program',
    group: 'program',
    label: '调整健康方案参数',
    description:
      '调整当前方案的每日热量偏移(kcalDelta)/蛋白质配比(proteinPerKg)/每周训练天数(trainingDays)，生效后从今天起重排日程。仅在用户明确要求调整方案时调用；至少给一个参数，越界值会被自动钳制到安全范围。',
    parameters: Type.Object({
      kcalDelta: Type.Optional(
        Type.Number({ description: '每日相对消耗的热量偏移（大卡），减脂为负、增肌为正，如 -400' }),
      ),
      proteinPerKg: Type.Optional(Type.Number({ description: '蛋白质 g/kg 体重，如 1.8' })),
      trainingDays: Type.Optional(Type.Number({ description: '每周训练天数 0~7' })),
      summary: Type.String({ description: '一句话说明本次调整的原因' }),
    }),
    async execute(args) {
      const { useProgramStore } = await import('@/stores/program')
      const store = useProgramStore()
      if (!store.loaded) await store.load()
      const rec = store.active
      if (!rec) throw new Error('当前没有生效的健康方案，请先在「我 → 个人约束 → 健康方案」生成一个')
      const patch: { kcalDelta?: number; proteinPerKg?: number; trainingDays?: number } = {}
      if (typeof args.kcalDelta === 'number') patch.kcalDelta = args.kcalDelta
      if (typeof args.proteinPerKg === 'number') patch.proteinPerKg = args.proteinPerKg
      if (typeof args.trainingDays === 'number') patch.trainingDays = Math.round(args.trainingDays)
      if (!Object.keys(patch).length) throw new Error('至少提供一个要调整的参数')
      const { changes, record } = await store.adjust(rec, patch, args.summary || 'AI 调整', 'ai')
      return {
        ok: true,
        version: record.version,
        appliedChanges: changes,
        note: '已从今天起重排方案日程，并同步了每日营养目标',
      }
    },
  }),

  defineTool({
    name: 'get_shopping_list',
    group: 'program',
    label: '生成本周采购清单',
    description:
      '按当前生效方案的菜单（AI 菜单优先、模板回落）把未来 N 天的食材按类别聚合成采购清单：克重/份数 + 出现天数，已勾选「已买」的项会被剔除。用户要采购清单/买菜清单/备料/买什么菜时调用。',
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: '未来天数 1~14，默认 7' })),
    }),
    async execute(args) {
      const { useProgramStore } = await import('@/stores/program')
      const store = useProgramStore()
      if (!store.loaded) await store.load()
      const rec = store.active
      if (!rec) throw new Error('当前没有生效的健康方案，请先在「我 → 个人约束 → 健康方案」生成一个')
      const days = Math.min(14, Math.max(1, Math.round(args.days ?? 7)))
      const { rows, rangeLabel, aiDays, templateDays } = await store.buildShopping(rec, days)
      const list = shoppingListText({ rows, rangeLabel, aiDays, templateDays })
      return {
        rangeLabel,
        aiDays,
        templateDays,
        pendingCount: rows.filter((r) => !r.checked).length,
        checkedCount: rows.filter((r) => r.checked).length,
        list,
        note: 'list 是纯文本清单可直接给用户复制；在方案页「本周采购清单」可勾选已买项（勾过的已从 list 剔除）',
      }
    },
  }),
]
