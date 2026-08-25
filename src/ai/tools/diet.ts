/** 饮食域工具：食物库检索/新增 + 餐次记录 CRUD · 对应 dietService */

import { Type } from '@earendil-works/pi-ai'

import { dietService } from '@/services/dietService'
import type { FoodUnit, MealType } from '@/types'
import { defineTool, resolveDate, type AppTool } from './types'

const MEAL_TYPE = Type.Union(
  [Type.Literal('breakfast'), Type.Literal('lunch'), Type.Literal('dinner'), Type.Literal('snack')],
  { description: '餐次：breakfast=早餐 / lunch=午餐 / dinner=晚餐 / snack=加餐' },
)

export const dietTools: AppTool[] = [
  defineTool({
    name: 'search_food',
    group: 'diet',
    label: '搜索食物库',
    description: '按名称模糊搜索 Rein 食物库（按字包含/顺序相似度排序），返回 id 与每 100g 营养。记录饮食前先用它确认 foodId。',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '名称关键词，如「米饭」「无糖可乐」；不传返回常见食物' })),
      limit: Type.Optional(Type.Number({ description: '最多返回条数，默认 15，最大 30' })),
    }),
    async execute(args) {
      const limit = Math.min(Math.max(1, args.limit ?? 15), 30)
      const q = args.query?.trim()
      // 模糊搜索算法在 Rust 层（移动端减负）；无关键词时回退常用列表
      const rows = q
        ? await dietService.searchFoodsFuzzy(q, limit)
        : await dietService.listFoods(undefined, null, limit)
      return rows.map((f) => ({
        id: f.id,
        name: f.name,
        category: f.category,
        kcal: f.kcal,
        protein: f.protein,
        carb: f.carb,
        fat: f.fat,
        defaultUnit: f.defaultUnit,
      }))
    },
  }),

  defineTool({
    name: 'get_food',
    group: 'diet',
    label: '查询食物详情',
    description: '按 id 查询单个食物的完整营养信息（每 100g，含维生素矿物质）。',
    parameters: Type.Object({ id: Type.Number({ description: 'search_food 返回的食物 id' }) }),
    async execute(args) {
      const f = await dietService.getFood(args.id)
      if (!f) throw new Error(`食物不存在：id=${args.id}`)
      return f
    },
  }),

  defineTool({
    name: 'list_meals',
    group: 'diet',
    label: '查看饮食记录',
    description: '查看某一天的已记录餐次（含换算后热量）。date 不传默认今天。',
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，缺省为今天' })),
    }),
    async execute(args) {
      const date = resolveDate(args.date)
      const rows = await dietService.listMeals(date)
      let totalKcal = 0
      const meals = rows.map((m) => {
        const kcal = Math.round(((m.food?.kcal ?? 0) * m.grams) / 100)
        totalKcal += kcal
        return {
          id: m.id,
          mealType: m.mealType,
          foodName: m.food?.name ?? `food#${m.foodId}`,
          grams: m.grams,
          kcal,
          note: m.note,
        }
      })
      return { date, totalKcal, count: meals.length, meals }
    },
  }),

  defineTool({
    name: 'log_meal',
    group: 'diet',
    label: '写入饮食记录',
    description:
      '把一条食物写入指定日期的餐次记录。foodId 必填——先用 search_food 搜索并选定；库里没有时先调 create_food 补录（营养按每 100g 估算）拿到新 id 再写，不要硬写。',
    parameters: Type.Object({
      foodId: Type.Number({ description: 'search_food 选定的食物 id' }),
      grams: Type.Optional(Type.Number({ description: '克重，按常见份量估算，默认 100' })),
      mealType: MEAL_TYPE,
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，缺省为今天' })),
      note: Type.Optional(Type.String({ description: '备注' })),
    }),
    async execute(args) {
      const food = await dietService.getFood(args.foodId)
      if (!food) throw new Error(`食物不存在：id=${args.foodId}，请先用 search_food 确认`)
      if (args.grams != null && (!Number.isFinite(args.grams) || args.grams <= 0)) {
        throw new Error(`克重非法：${args.grams}`)
      }
      const meal = await dietService.logMeal({
        foodId: food.id,
        date: resolveDate(args.date),
        mealType: args.mealType as MealType,
        quantityMode: 'grams',
        grams: args.grams ?? 100,
        units: null,
        unitName: null,
        source: 'text_ai',
        note: args.note ?? null,
      })
      return { ok: true, mealId: meal.id, foodName: food.name, grams: meal.grams }
    },
  }),

  defineTool({
    name: 'create_food',
    group: 'diet',
    label: '新增食物到库',
    description:
      '把食物库没有的食品新建进 Rein 食物库，营养按每 100g 估算。search_food 确认库里没有时直接调用补录（无需先征求用户同意），建完用返回的 id 继续后续动作；同名已存在时直接返回已有记录（不重复建）。',
    parameters: Type.Object({
      name: Type.String({ description: '食品通用名称，不带品牌/规格后缀，如「杨枝甘露」' }),
      kcal: Type.Number({ description: '每 100g 热量（大卡）' }),
      protein: Type.Number({ description: '每 100g 蛋白质（g）' }),
      carb: Type.Number({ description: '每 100g 碳水（g）' }),
      fat: Type.Number({ description: '每 100g 脂肪（g）' }),
      category: Type.Optional(
        Type.String({
          description: '分类：主食/肉蛋/水产/蔬菜/水果/豆制品/奶类/坚果/油脂/饮品/调味品/零食/加工食品/其他',
        }),
      ),
      fiber: Type.Optional(Type.Number({ description: '每 100g 膳食纤维（g），未知可省略' })),
      sugar: Type.Optional(Type.Number({ description: '每 100g 糖（g），未知可省略' })),
      sodiumMg: Type.Optional(Type.Number({ description: '每 100g 钠（mg），未知可省略' })),
      defaultUnit: Type.Optional(Type.String({ description: '常用份单位名，如 碗/个/杯/片' })),
      units: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: '份单位名，如 碗' }),
            grams: Type.Number({ description: '一份对应的克重' }),
          }),
          { description: '份单位换算表，最多 4 个' },
        ),
      ),
    }),
    async execute(args) {
      const name = args.name.trim()
      if (!name) throw new Error('食物名称不能为空')
      for (const [label, v] of [
        ['热量', args.kcal],
        ['蛋白质', args.protein],
        ['碳水', args.carb],
        ['脂肪', args.fat],
      ] as const) {
        if (!Number.isFinite(v) || v < 0) throw new Error(`${label}数值非法：${v}`)
      }
      const units: FoodUnit[] = (args.units ?? [])
        .filter((u) => u.name.trim() && Number.isFinite(u.grams) && u.grams > 0)
        .slice(0, 4)
        .map((u) => ({ name: u.name.trim(), grams: Math.round(u.grams) }))
      const r = await dietService.createFood({
        name,
        category: args.category?.trim() || null,
        kcal: args.kcal,
        protein: args.protein,
        carb: args.carb,
        fat: args.fat,
        fiber: args.fiber ?? 0,
        sugar: args.sugar ?? 0,
        sodiumMg: args.sodiumMg ?? 0,
        defaultUnit: args.defaultUnit?.trim() || null,
        units,
      })
      return {
        id: r.food.id,
        name: r.food.name,
        created: r.created,
        message: r.created
          ? `已创建「${r.food.name}」（id=${r.food.id}），可直接用于 log_meal`
          : `食物库已有同名「${r.food.name}」（id=${r.food.id}），直接复用即可`,
      }
    },
  }),

  defineTool({
    name: 'delete_meal',
    group: 'diet',
    label: '删除饮食记录',
    description: '删除一条饮食记录。仅限用户明确要求删除时使用；id 来自 list_meals。',
    dangerous: true,
    parameters: Type.Object({ id: Type.Number({ description: 'list_meals 返回的记录 id' }) }),
    async execute(args) {
      await dietService.deleteMeal(args.id)
      return { ok: true }
    },
  }),
]
