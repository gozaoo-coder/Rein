/**
 * AI 菜单生成：模型只负责「设计结构」（每餐什么食物、多少克），
 * 营养数值一律由本模块用食物库（每 100g 数据）实算并整体缩放到目标热量——
 * 延续「程序算数字、AI 出主意」的产品原则，模型不产出一个可信的大卡数字。
 *
 * 两个入口共用同一个核心 generateDayMenu：
 * - generateDayMenu：方案页按天生成（带日期/近期已吃/训练日上下文，落 program_meals 缓存）；
 * - generateAiMenu：食谱库的一日菜单（无日期上下文）。
 */

import type { AiModel, DailyTargets } from '@/types'
import { dietService } from '@/services/dietService'
import { mealLayoutFor } from '@/utils/programEngine'
import { extractJsonObject, lastAssistantText } from './json'
import { buildRuntime } from './runtime'
import { buildAppAgentTools } from './tools/registry'

export interface AiMenuItem {
  label: string
  grams: number
  foodId: number | null
}

export interface AiMenuMeal {
  slot: string
  name: string
  items: AiMenuItem[]
  kcal: number
  protein: number
  carb: number
  fat: number
}

export interface AiMenuResult {
  meals: AiMenuMeal[]
  /** 生成过程的提示（未匹配条目、份量越界被钳制等） */
  warnings: string[]
}

/** 按天生成的上下文 */
export interface DayMenuContext {
  /** 餐次槽位与热量占比（来自引擎 mealLayoutFor） */
  slots: { slot: string; share: number }[]
  targets: DailyTargets
  restrictions: string[]
  likes: string[]
  dislikes: string[]
  /** 近期已吃 / 已排的菜名：生成时避免重复 */
  avoidNames: string[]
  trainingDay: boolean
  /** 日期说明（如「8月27日 周四」），可为空串 */
  dateNote: string
}

interface RawItem {
  foodName?: unknown
  grams?: unknown
  foodId?: unknown
}

interface RawMeal {
  name?: unknown
  slotHint?: unknown
  items?: unknown
}

interface ResolvedFood {
  id: number
  kcal: number
  protein: number
  carb: number
  fat: number
}

function systemPrompt(ctx: DayMenuContext): string {
  const kcalOf = (share: number): number => Math.round(ctx.targets.kcal * share)
  const slotLines = ctx.slots
    .map((s) => `- ${s.slot}（约 ${kcalOf(s.share)} 大卡）`)
    .join('\n')
  const prefs: string[] = []
  if (ctx.likes.length) prefs.push(`喜欢：${ctx.likes.join('、')}（优先安排）`)
  if (ctx.dislikes.length) prefs.push(`不喜欢：${ctx.dislikes.join('、')}（不要出现）`)
  return `你是 Rein 的菜单设计师，为用户设计${ctx.dateNote ? `${ctx.dateNote}的` : '一日'}完整菜单。
每日目标热量 ${Math.round(ctx.targets.kcal)} 大卡，蛋白 ${Math.round(ctx.targets.protein)}g。
餐次与热量分布：
${slotLines}
忌口：${ctx.restrictions.length ? ctx.restrictions.join('、') : '无'}。
${prefs.join('；')}
${ctx.avoidNames.length ? `以下食物近几天已经吃过，尽量不要重复：${ctx.avoidNames.slice(0, 20).join('、')}。` : ''}
${ctx.trainingDay ? '今天是训练日：碳水集中在训练前后两餐，晚餐适量。' : '今天是休息日：整体清淡，蛋白均匀分布。'}
规则：
- 每个食物必须先调用 search_food，用简短通用关键词（如「鸡胸肉」「米饭」）搜索食物库，选定最贴近的一项，foodId 填它的 id；搜不到就换一个常见的库内食品，不要编造 foodId。
- 份量用常见克重（一个鸡蛋约50g、一碗米饭约200g、一份肉 120-150g）。
只能输出一个 JSON 对象（不要 markdown 代码块、不要解释）：
{"meals":[{"name":"菜名","slotHint":"槽位名","items":[{"foodName":"库内食品名","grams":克重,"foodId":id}]}]}`
}

const round5 = (x: number): number => Math.max(5, Math.round(x / 5) * 5)

/** 核心：按上下文生成一天菜单（模型出结构，食物库实算营养并缩放到目标热量） */
export async function generateDayMenu(config: AiModel, ctx: DayMenuContext): Promise<AiMenuResult> {
  const { models, byId } = buildRuntime([config])
  const entry = byId.get(config.id)
  if (!entry) throw new Error('模型运行时构建失败')

  const { Agent } = await import('@earendil-works/pi-agent-core')
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(ctx),
      model: entry.model,
      thinkingLevel: 'off',
      tools: buildAppAgentTools(['search_food', 'get_food']),
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
  })

  await agent.prompt('请按上面的目标与偏好设计菜单。')
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  const body = extractJsonObject(raw) as { meals?: unknown } | null
  const rawMeals = Array.isArray(body?.meals) ? (body.meals as RawMeal[]) : []
  if (!rawMeals.length) throw new Error('模型没有给出菜单，请重试')

  const warnings: string[] = []
  const foodCache = new Map<number, ResolvedFood>()

  async function resolveFood(id: unknown, name: string): Promise<ResolvedFood | null> {
    let foodId = typeof id === 'number' && id > 0 ? id : null
    if (foodId == null) {
      // 模型没给 id：用库内模糊搜索兜底（只选既有条目，不新增）
      const hits = await dietService.searchFoodsFuzzy(name, 1)
      const hit = hits[0]
      if (!hit) {
        warnings.push(`「${name}」未匹配到食物库，已跳过`)
        return null
      }
      foodId = hit.id
    }
    const cached = foodCache.get(foodId)
    if (cached) return cached
    const food = await dietService.getFood(foodId)
    if (!food) {
      warnings.push(`「${name}」在库中不存在，已跳过`)
      return null
    }
    const resolved = {
      id: food.id,
      kcal: food.kcal,
      protein: food.protein,
      carb: food.carb,
      fat: food.fat,
    }
    foodCache.set(food.id, resolved)
    return resolved
  }

  const resolvedMeals: { slot: string; name: string; items: { label: string; grams: number; food: ResolvedFood }[] }[] = []
  for (const rm of rawMeals) {
    const slotHint = String(rm.slotHint ?? '').trim()
    const itemsRaw = Array.isArray(rm.items) ? (rm.items as RawItem[]) : []
    const items: { label: string; grams: number; food: ResolvedFood }[] = []
    for (const it of itemsRaw) {
      const name = String(it.foodName ?? '').trim()
      const grams = Number(it.grams)
      if (!name || !Number.isFinite(grams) || grams <= 0) continue
      const food = await resolveFood(it.foodId, name)
      if (!food) continue
      items.push({ label: name, grams: Math.round(grams), food })
    }
    if (!items.length) continue
    // 槽位名优先对齐引擎布局；模型给的 slotHint 仅作回退
    const slot = ctx.slots[resolvedMeals.length]?.slot ?? (slotHint || '餐')
    resolvedMeals.push({ slot, name: String(rm.name ?? '未命名'), items })
  }
  if (!resolvedMeals.length) throw new Error('菜单里没有可用的餐次，请重试')

  // 实算合计 → 按目标热量整体缩放（钳制 0.6~1.5，越界给出提示）
  const dayKcal = resolvedMeals.reduce(
    (s, m) => s + m.items.reduce((x, i) => x + (i.grams * i.food.kcal) / 100, 0),
    0,
  )
  const scale = dayKcal > 0 ? Math.min(1.5, Math.max(0.6, ctx.targets.kcal / dayKcal)) : 1
  if (Math.abs(scale - 1) > 0.001) {
    if (scale >= 1.5) warnings.push('模型份量偏少，已整体放大到上限')
    else if (scale <= 0.6) warnings.push('模型份量偏多，已整体压缩到下限')
    else warnings.push(`已按目标热量整体调整份量（×${scale.toFixed(2)}）`)
  }

  const meals: AiMenuMeal[] = resolvedMeals.map((m) => {
    const items = m.items.map((i) => ({ label: i.label, grams: round5(i.grams * scale), foodId: i.food.id }))
    const sum = items.reduce(
      (acc, i) => {
        const f = foodCache.get(i.foodId)!
        return {
          kcal: acc.kcal + (i.grams * f.kcal) / 100,
          protein: acc.protein + (i.grams * f.protein) / 100,
          carb: acc.carb + (i.grams * f.carb) / 100,
          fat: acc.fat + (i.grams * f.fat) / 100,
        }
      },
      { kcal: 0, protein: 0, carb: 0, fat: 0 },
    )
    return {
      slot: m.slot,
      name: m.name,
      items,
      kcal: Math.round(sum.kcal),
      protein: Math.round(sum.protein),
      carb: Math.round(sum.carb),
      fat: Math.round(sum.fat),
    }
  })

  return { meals, warnings }
}

/** 食谱库的一日菜单：无日期上下文（目标 + 忌口 + 偏好） */
export interface AiMenuInput {
  targets: DailyTargets
  /** 每日餐次：3 | 4 | 5 */
  mealsCount: number
  restrictions: string[]
  likes: string[]
  dislikes: string[]
}

export async function generateAiMenu(config: AiModel, input: AiMenuInput): Promise<AiMenuResult> {
  return generateDayMenu(config, {
    slots: mealLayoutFor(input.mealsCount).map((s) => ({ slot: s.slot, share: s.share })),
    targets: input.targets,
    restrictions: input.restrictions,
    likes: input.likes,
    dislikes: input.dislikes,
    avoidNames: [],
    trainingDay: true,
    dateNote: '',
  })
}
