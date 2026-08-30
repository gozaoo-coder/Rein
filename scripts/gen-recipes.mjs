/**
 * 生成 resources/recipe_templates.json —— 方案引擎的食谱模板库。
 *
 * 运行：node scripts/gen-recipes.mjs
 *
 * 设计约定：
 * - 模板 = 「食物 + 固定份量」的组合，营养值一律由本脚本从 resources/foods.json
 *   的每 100g 数据实算，禁止手填数字（保证方案里的热量可复算、可验证）；
 * - 引擎运行时按热量比例整体缩放模板（factor 0.6~1.8），宏量比例不变；
 * - 过敏原标签由食材名关键词自动推导，忌口过滤在引擎侧按它匹配。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const foodsFile = JSON.parse(readFileSync(join(root, 'resources/foods.json'), 'utf8'))

function foodByName(name) {
  const f = foodsFile.foods.find((x) => x.name === name)
  if (!f) throw new Error(`foods.json 缺少食材「${name}」，请改用库内名称`)
  return f
}

/** 食材名关键词 → 过敏原/忌口大类 */
const ALLERGEN_KEYWORDS = [
  ['鸡蛋', '蛋类'],
  ['牛奶', '乳制品'],
  ['酸奶', '乳制品'],
  ['奶酪', '乳制品'],
  ['全麦面包', '麸质'],
  ['馒头', '麸质'],
  ['面条', '麸质'],
  ['豆浆', '大豆'],
  ['豆腐', '大豆'],
  ['三文鱼', '海鲜'],
  ['虾仁', '海鲜'],
  ['核桃', '坚果'],
]

function deriveAllergens(items) {
  const tags = new Set()
  for (const item of items) {
    for (const [keyword, tag] of ALLERGEN_KEYWORDS) {
      if (item.food.includes(keyword)) tags.add(tag)
    }
  }
  return [...tags]
}

/** 一项食物的摄入量：克重制 {food, grams} 或单位制 {food, unit, count} */
function itemKcal(item) {
  const f = foodByName(item.food)
  const grams = item.grams ?? f.units.find((u) => u.name === item.unit)?.grams * item.count
  if (!grams) throw new Error(`食材「${item.food}」缺少份量或单位「${item.unit}」`)
  return grams
}

function compute(items) {
  const sum = { kcal: 0, protein: 0, carb: 0, fat: 0 }
  for (const item of items) {
    const f = foodByName(item.food)
    const grams = itemKcal(item)
    const x = grams / 100
    sum.kcal += f.kcal * x
    sum.protein += f.protein * x
    sum.carb += f.carb * x
    sum.fat += f.fat * x
  }
  return {
    baseKcal: Math.round(sum.kcal),
    baseProtein: Math.round(sum.protein),
    baseCarb: Math.round(sum.carb),
    baseFat: Math.round(sum.fat),
  }
}

/* ---- 模板定义（份量为基准份；数值由 compute 实算） ---- */

const templates = [
  // ---- 早餐 ----
  { id: 'bf-oat-egg', name: '燕麦鸡蛋牛奶碗', mealType: 'breakfast', items: [
    { food: '燕麦片', grams: 50 }, { food: '鸡蛋', unit: '个', count: 1 }, { food: '牛奶(全脂)', unit: '杯', count: 1 },
  ] },
  { id: 'bf-bread-egg', name: '全麦面包鸡蛋早餐', mealType: 'breakfast', items: [
    { food: '全麦面包', unit: '片', count: 2 }, { food: '鸡蛋', unit: '个', count: 2 }, { food: '牛奶(全脂)', unit: '杯', count: 1 },
  ] },
  { id: 'bf-yogurt-oat', name: '酸奶水果燕麦杯', mealType: 'breakfast', items: [
    { food: '无糖酸奶', grams: 200 }, { food: '燕麦片', grams: 40 }, { food: '蓝莓', grams: 60 }, { food: '核桃', grams: 10 },
  ] },
  { id: 'bf-steamer', name: '中式馒头豆浆套餐', mealType: 'breakfast', items: [
    { food: '馒头', unit: '个', count: 1 }, { food: '鸡蛋', unit: '个', count: 1 }, { food: '豆浆(无糖)', unit: '杯', count: 1 },
  ] },
  { id: 'bf-corn-egg', name: '粗粮鸡蛋早餐', mealType: 'breakfast', items: [
    { food: '玉米(鲜)', unit: '根', count: 1 }, { food: '鸡蛋', unit: '个', count: 2 }, { food: '豆浆(无糖)', unit: '杯', count: 1 },
  ] },

  // ---- 午餐 ----
  { id: 'lu-chicken-rice', name: '鸡胸肉米饭便当', mealType: 'lunch', items: [
    { food: '米饭(熟)', grams: 300 }, { food: '鸡胸肉', grams: 150 }, { food: '西兰花', grams: 150 }, { food: '番茄', grams: 150 },
  ] },
  { id: 'lu-beef-rice', name: '牛肉时蔬餐', mealType: 'lunch', items: [
    { food: '米饭(熟)', grams: 250 }, { food: '牛里脊(瘦)', grams: 120 }, { food: '菠菜', grams: 150 }, { food: '胡萝卜', grams: 100 },
  ] },
  { id: 'lu-salmon-rice', name: '三文鱼米饭餐', mealType: 'lunch', items: [
    { food: '三文鱼', grams: 150 }, { food: '米饭(熟)', grams: 200 }, { food: '生菜', grams: 100 }, { food: '黄瓜', grams: 100 },
  ] },
  { id: 'lu-shrimp-noodle', name: '虾仁青菜汤面', mealType: 'lunch', items: [
    { food: '面条(熟)', unit: '碗', count: 1 }, { food: '虾仁', grams: 120 }, { food: '菠菜', grams: 150 }, { food: '番茄', grams: 100 },
  ] },
  { id: 'lu-pork-tofu', name: '里脊豆腐盖饭', mealType: 'lunch', items: [
    { food: '米饭(熟)', grams: 250 }, { food: '猪里脊', grams: 120 }, { food: '豆腐(北)', grams: 100 }, { food: '黄瓜', grams: 100 },
  ] },
  { id: 'lu-chicken-salad', name: '轻食鸡胸沙拉', mealType: 'lunch', items: [
    { food: '鸡胸肉', grams: 120 }, { food: '生菜', grams: 150 }, { food: '玉米(鲜)', grams: 100 }, { food: '苹果', grams: 100 },
  ] },

  // ---- 晚餐 ----
  { id: 'dn-fish-veggie', name: '清蒸鱼配杂粮', mealType: 'dinner', items: [
    { food: '三文鱼', grams: 120 }, { food: '红薯(蒸)', unit: '个', count: 1 }, { food: '西兰花', grams: 200 },
  ] },
  { id: 'dn-chicken-stir', name: '鸡胸时蔬炒饭', mealType: 'dinner', items: [
    { food: '鸡胸肉', grams: 130 }, { food: '胡萝卜', grams: 100 }, { food: '菠菜', grams: 150 }, { food: '米饭(熟)', grams: 150 },
  ] },
  { id: 'dn-shrimp-broccoli', name: '虾仁西兰花', mealType: 'dinner', items: [
    { food: '虾仁', grams: 150 }, { food: '西兰花', grams: 200 }, { food: '玉米(鲜)', grams: 100 }, { food: '米饭(熟)', grams: 150 },
  ] },
  { id: 'dn-tofu-soup', name: '豆腐蔬菜暖汤餐', mealType: 'dinner', items: [
    { food: '豆腐(北)', grams: 200 }, { food: '番茄', grams: 200 }, { food: '菠菜', grams: 150 }, { food: '米饭(熟)', grams: 150 },
  ] },
  { id: 'dn-beef-noodle', name: '牛肉青菜汤面', mealType: 'dinner', items: [
    { food: '面条(熟)', grams: 200 }, { food: '牛里脊(瘦)', grams: 100 }, { food: '生菜', grams: 150 }, { food: '鸡蛋', unit: '个', count: 1 },
  ] },
  { id: 'dn-egg-veggie', name: '鸡蛋时蔬轻晚餐', mealType: 'dinner', items: [
    { food: '鸡蛋', unit: '个', count: 2 }, { food: '土豆(蒸)', unit: '个', count: 1 }, { food: '西兰花', grams: 150 }, { food: '胡萝卜', grams: 50 },
  ] },

  // ---- 加餐 ----
  { id: 'sn-yogurt-nuts', name: '酸奶核桃杯', mealType: 'snack', items: [
    { food: '无糖酸奶', grams: 120 }, { food: '核桃', grams: 10 },
  ] },
  { id: 'sn-banana', name: '香蕉一根', mealType: 'snack', items: [
    { food: '香蕉', unit: '根', count: 1 },
  ] },
  { id: 'sn-apple-greek', name: '苹果希腊酸奶', mealType: 'snack', items: [
    { food: '苹果', unit: '个', count: 1 }, { food: '希腊酸奶', unit: '杯', count: 1 },
  ] },
  { id: 'sn-blueberry-milk', name: '蓝莓牛奶', mealType: 'snack', items: [
    { food: '蓝莓', unit: '盒', count: 1 }, { food: '牛奶(全脂)', unit: '杯', count: 1 },
  ] },
  { id: 'sn-egg-tomato', name: '水煮蛋小番茄', mealType: 'snack', items: [
    { food: '鸡蛋', unit: '个', count: 1 }, { food: '番茄', grams: 150 },
  ] },
]

const recipes = templates.map((t) => ({
  id: t.id,
  name: t.name,
  mealType: t.mealType,
  items: t.items,
  ...compute(t.items),
  allergens: deriveAllergens(t.items),
}))

// 单位制条目补记单位克重（供引擎按系数缩放后还原展示）
for (const r of recipes) {
  for (const item of r.items) {
    if (item.unit != null && item.count != null) {
      const f = foodByName(item.food)
      item.unitGrams = f.units.find((u) => u.name === item.unit)?.grams ?? null
      if (item.unitGrams == null) throw new Error(`食材「${item.food}」缺少单位「${item.unit}」克重`)
    }
  }
}

const out = join(root, 'resources/recipe_templates.json')
writeFileSync(out, `${JSON.stringify({ recipes }, null, 2)}\n`, 'utf8')
console.log(`已生成 ${recipes.length} 个食谱模板 → resources/recipe_templates.json`)
for (const r of recipes) {
  console.log(`  ${r.id.padEnd(20)} ${r.mealType.padEnd(10)} ${String(r.baseKcal).padStart(4)}kcal p${r.baseProtein} c${r.baseCarb} f${r.baseFat}`)
}
