/**
 * 食谱模板与忌口匹配。
 *
 * programEngine（菜单生成时排除）与食谱库页（打「忌口」标）必须共用同一份数据
 * 和同一套匹配规则，否则两处会出现「菜单里排除了、页面上却没标」的口径分裂。
 */

import seedRecipes from '@resources/recipe_templates.json'

export interface RecipeItem {
  food: string
  grams?: number
  unit?: string
  count?: number
  /** 单位制条目的单位克重（gen-recipes 生成时写入），供缩放展示 */
  unitGrams?: number | null
}

export interface RecipeTemplate {
  id: string
  name: string
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack'
  items: RecipeItem[]
  baseKcal: number
  baseProtein: number
  baseCarb: number
  baseFat: number
  allergens: string[]
}

export const RECIPES = (seedRecipes as { recipes: RecipeTemplate[] }).recipes

/**
 * 单条忌口是否命中该食谱。
 *
 * 双向子串匹配：忌口可能比标签更具体（「花生过敏」），也可能更宽泛（「不要乳制品」）。
 * 只做 `allergen.includes(kw)` 单向会导致前者静默失效——用户以为排除了，
 * 实际还留在菜单里。标签最短为 2 字（乳制品/坚果/大豆/海鲜/蛋类/麸质），
 * 反向包含不会因单字标签产生大面积误伤。
 */
export function matchesRestriction(r: RecipeTemplate, restriction: string): boolean {
  const kw = restriction.trim()
  if (!kw) return false
  const hit = (x: string): boolean => x.includes(kw) || kw.includes(x)
  return r.allergens.some(hit) || r.items.some((it) => hit(it.food))
}

/** 该食谱是否命中任一忌口 */
export function isRestricted(
  r: RecipeTemplate,
  restrictions: readonly string[] | null | undefined,
): boolean {
  if (!restrictions?.length) return false
  return restrictions.some((kw) => matchesRestriction(r, kw))
}

/** 一批忌口命中的模板 id 集合（菜单生成时批量排除） */
export function restrictedRecipeIds(restrictions: readonly string[] | null): Set<string> {
  const ids = new Set<string>()
  if (!restrictions?.length) return ids
  for (const r of RECIPES) {
    if (isRestricted(r, restrictions)) ids.add(r.id)
  }
  return ids
}
