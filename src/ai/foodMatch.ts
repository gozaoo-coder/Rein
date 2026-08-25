/**
 * 模型识别行 → 解析卡条目。
 *
 * 匹配策略：由模型在输出前自行调用 search_food 工具按关键词搜索食物库并选定 foodId
 * （见 chat.ts 的提示词约定）；这里对模型给到的 foodId 做「库中存在」校验。
 * foodId 缺失或校验不过时：不再让用户二次确认——直接用模型估算的营养自动补录进库
 * （create_food 同名幂等），卡片因此始终可写入。
 */

import { dietService } from '@/services/dietService'
import type { ParsedFoodItem } from '@/types'

/** 模型输出的单行识别结果（foodId 由模型经工具选定；缺省/非法按未匹配自动补录） */
export interface ModelFoodRow {
  foodName: string
  grams: number
  kcalEstimate: number
  foodId?: number | null
  /** 库中不存在时，模型按每 100g 估算的营养（自动补录 create_food 用） */
  nutrition?: {
    kcal?: number
    protein?: number
    carb?: number
    fat?: number
    fiber?: number
    sugar?: number
    sodiumMg?: number
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0
}

export async function toParsedItems(rows: ModelFoodRow[]): Promise<ParsedFoodItem[]> {
  const out: ParsedFoodItem[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !r.foodName || typeof r.foodName !== 'string') continue
    let foodId = typeof r.foodId === 'number' && Number.isFinite(r.foodId) ? r.foodId : null
    if (foodId != null && !(await dietService.getFood(foodId))) foodId = null
    if (foodId == null) {
      // 未匹配 → 自动补录（不二次确认）：营养取模型估算，缺省回退 kcalEstimate / 0
      const n = r.nutrition ?? {}
      const created = await dietService.createFood({
        name: r.foodName,
        category: null,
        kcal: num(n.kcal) || num(r.kcalEstimate),
        protein: num(n.protein),
        carb: num(n.carb),
        fat: num(n.fat),
        fiber: num(n.fiber),
        sugar: num(n.sugar),
        sodiumMg: num(n.sodiumMg),
        defaultUnit: null,
        units: [],
      })
      foodId = created.food.id
    }
    out.push({
      foodId,
      foodName: r.foodName,
      grams: num(r.grams) || 100,
      kcalEstimate: num(r.kcalEstimate),
      confidence: 0.9,
      note: null,
    })
  }
  return out
}
