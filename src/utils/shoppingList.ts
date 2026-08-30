/**
 * 周采购清单聚合：把若干天的菜单（AI 缓存 + 模板回落）按食材聚合成采购行。
 *
 * 「程序算数字」原则：聚合、解析、排序全部是确定性纯函数，本模块零运行时依赖
 * （esbuild 可直接 bundle 冒烟）；分类映射由调用方经 categoryOf 回调注入。
 *
 * 聚合键 foodId 优先——AI 菜单的食材已绑定库内 id，同食材不同叫法（鸡胸肉/鸡胸）
 * 不会分裂成两行；模板菜单的展示串（「燕麦片 50g」「鸡蛋 1个」）先解析再聚合，
 * 无 id 的克重行最后尝试并入同名有 id 的行。
 */

/** 统一食材行：克重制（grams）或单位制（count+unit）二选一 */
export interface ShoppingSourceItem {
  label: string
  grams: number | null
  count: number | null
  unit: string | null
  foodId: number | null
}

/** 单天聚合输入：source 标注该天菜单来源（覆盖范围提示用） */
export interface ShoppingDay {
  date: string
  source: 'ai' | 'template'
  /** 每餐的统一食材行 */
  meals: ShoppingSourceItem[][]
}

export interface ShoppingRow {
  /** 聚合键（渲染 diff 用） */
  key: string
  label: string
  foodId: number | null
  category: string | null
  /** 克重制合计；纯单位制行该值必然为 null */
  totalGrams: number | null
  /** 单位制合计（同一单位下求和） */
  totalCount: number | null
  unit: string | null
  /** 该食材出现在几天里 */
  days: number
}

/** 聚合行 + 勾选状态（store.buildShopping 组装；勾选持久化在 shopping_checks 表） */
export type CheckedRow = ShoppingRow & { checked: boolean }

/** 分组展示顺序（沿用食物库 14 类；未登记类别排「其他」之前） */
export const SHOP_CATEGORY_ORDER = [
  '蔬菜',
  '水果',
  '肉蛋',
  '水产',
  '豆制品',
  '主食',
  '奶类',
  '坚果',
  '油脂',
  '调味品',
  '饮品',
  '零食',
  '加工食品',
  '其他',
]

/** AI 菜单餐（label+grams+foodId）→ 统一行；结构兼容 AiMenuMeal，避免模块依赖 */
export function itemsFromAi(meal: { items: { label: string; grams: number; foodId: number | null }[] }): ShoppingSourceItem[] {
  return meal.items.map((it) => ({
    label: it.label,
    grams: it.grams,
    count: null,
    unit: null,
    foodId: it.foodId,
  }))
}

/** 模板菜单展示串 → 统一行：克重制「燕麦片 50g」；单位制「鸡蛋 1个」「牛奶(全脂) 1杯」 */
export function parseTemplateItem(s: string): ShoppingSourceItem {
  const t = s.trim()
  let m = /^(.+?)\s*(\d+(?:\.\d+)?)g$/.exec(t)
  if (m) {
    return { label: m[1]!, grams: Number(m[2]), count: null, unit: null, foodId: null }
  }
  m = /^(.+?)\s*(\d+(?:\.\d+)?)([^0-9]*)$/.exec(t)
  if (m) {
    const unit = (m[3] ?? '').trim()
    return { label: m[1]!, grams: null, count: Number(m[2]), unit: unit || null, foodId: null }
  }
  // 解析不了（无数量）：按名称行处理，采购时人工估量
  return { label: t, grams: null, count: null, unit: null, foodId: null }
}

export function itemsFromTemplate(meal: { items: string[] }): ShoppingSourceItem[] {
  return meal.items.map(parseTemplateItem)
}

const norm = (s: string): string => s.trim().toLowerCase()

/** 单行聚合键：克重行按 id（无 id 退名称）；单位行按名称+单位（鸡蛋「个」与「盒」分开） */
function rowKey(it: ShoppingSourceItem): string {
  if (it.grams != null) {
    return it.foodId != null && it.foodId > 0 ? `f:${it.foodId}` : `n:${norm(it.label)}`
  }
  return `n:${norm(it.label)}|u:${it.unit ?? ''}`
}

/**
 * 核心聚合。categoryOf 注入分类映射（查不到返回 null → 归「其他」）。
 * 输出按 SHOP_CATEGORY_ORDER 分组排序、组内克重降序（单位制行殿后）。
 */
export function buildShoppingList(
  days: ShoppingDay[],
  categoryOf?: (item: { label: string; foodId: number | null }) => string | null,
): ShoppingRow[] {
  interface Acc {
    key: string
    label: string
    foodId: number | null
    totalGrams: number | null
    totalCount: number | null
    unit: string | null
    dateSet: Set<string>
  }
  const accs = new Map<string, Acc>()

  for (const day of days) {
    for (const meal of day.meals) {
      for (const it of meal) {
        const label = it.label.trim()
        if (!label) continue
        const key = rowKey({ ...it, label })
        let acc = accs.get(key)
        if (!acc) {
          acc = { key, label, foodId: it.foodId, totalGrams: null, totalCount: null, unit: it.unit, dateSet: new Set() }
          accs.set(key, acc)
        }
        acc.dateSet.add(day.date)
        if (it.grams != null && Number.isFinite(it.grams)) {
          acc.totalGrams = (acc.totalGrams ?? 0) + it.grams
        }
        if (it.count != null && Number.isFinite(it.count)) {
          acc.totalCount = (acc.totalCount ?? 0) + it.count
        }
      }
    }
  }

  // 无 id 的克重行并入同名有 id 的行（AI 行 label 即库内名，同名即同物）
  const merged: Acc[] = []
  for (const acc of accs.values()) {
    if (acc.foodId == null && acc.totalGrams != null && acc.key.startsWith('n:')) {
      const host = merged.find(
        (m) => m.foodId != null && m.totalGrams != null && !m.key.includes('|u:') && norm(m.label) === norm(acc.label),
      )
      if (host) {
        host.totalGrams = (host.totalGrams ?? 0) + (acc.totalGrams ?? 0)
        for (const d of acc.dateSet) host.dateSet.add(d)
        continue
      }
    }
    merged.push(acc)
  }

  const rows: ShoppingRow[] = merged.map((a) => ({
    key: a.key,
    label: a.label,
    foodId: a.foodId,
    category: categoryOf?.({ label: a.label, foodId: a.foodId }) ?? null,
    totalGrams: a.totalGrams != null ? Math.round(a.totalGrams) : null,
    totalCount: a.totalCount != null ? Math.round(a.totalCount * 10) / 10 : null,
    unit: a.totalCount != null ? a.unit : null,
    days: a.dateSet.size,
  }))

  const order = (c: string | null): number => {
    const i = SHOP_CATEGORY_ORDER.indexOf(c ?? '其他')
    return i === -1 ? SHOP_CATEGORY_ORDER.length - 1 : i
  }
  return rows.sort(
    (a, b) =>
      order(a.category) - order(b.category) ||
      (b.totalGrams ?? 0) - (a.totalGrams ?? 0) ||
      (b.totalCount ?? 0) - (a.totalCount ?? 0) ||
      a.label.localeCompare(b.label),
  )
}

/** 按 category 切组（顺序与 SHOP_CATEGORY_ORDER 一致；空组不出现）；泛型保留子类型（如 CheckedRow） */
export function groupShoppingRows<T extends ShoppingRow>(rows: T[]): { name: string; rows: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const name = r.category && SHOP_CATEGORY_ORDER.includes(r.category) ? r.category : '其他'
    const list = groups.get(name)
    if (list) list.push(r)
    else groups.set(name, [r])
  }
  return SHOP_CATEGORY_ORDER.filter((n) => groups.has(n)).map((name) => ({ name, rows: groups.get(name)! }))
}

/** 数量展示：「1050g」/「5个」/ 两口径并存时「350g · 5个」 */
export function amountText(r: Pick<ShoppingRow, 'totalGrams' | 'totalCount' | 'unit'>): string {
  const parts: string[] = []
  if (r.totalGrams != null) parts.push(`${Math.round(r.totalGrams)}g`)
  if (r.totalCount != null) parts.push(`${r.totalCount}${r.unit ?? ''}`)
  return parts.join(' · ') || '—'
}

/** 复制全文：纯文本清单（分组 + 天数注记），已勾选「已买」的项剔除；全买完时给一句收尾 */
export function shoppingListText(opts: {
  rows: ReadonlyArray<ShoppingRow & { checked?: boolean }>
  rangeLabel: string
  aiDays: number
  templateDays: number
}): string {
  const pending = opts.rows.filter((r) => !r.checked)
  if (opts.rows.length && !pending.length) return `采购清单（${opts.rangeLabel}）：全部已买 ✓`
  const lines: string[] = [`采购清单（${opts.rangeLabel}）`, '']
  for (const g of groupShoppingRows(pending)) {
    lines.push(`【${g.name}】`)
    for (const r of g.rows) lines.push(`· ${r.label} ${amountText(r)}（${r.days}天）`)
    lines.push('')
  }
  lines.push(`覆盖 ${opts.aiDays + opts.templateDays} 天：${opts.aiDays} 天 AI 菜单、${opts.templateDays} 天模板菜单`)
  return lines.join('\n').trim()
}
