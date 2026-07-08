/**
 * foodNutrients — 食品营养素计算工具
 *
 * 所有 per-100g 数据按 grams 比例缩放。
 * 支持汇总今日总摄入（含矿物质/维生素/膳食纤维/自定义）。
 */
import type { FoodItem, FoodRecord, FoodMinerals, FoodVitamins, CustomNutrient } from "@/types/health";

export interface NutrientEntry {
  name: string;
  value: number;
  unit: string;
  /** 分组：macro / mineral / vitamin / fiber / other */
  group: "macro" | "mineral" | "vitamin" | "fiber" | "other";
}

const MINERAL_FIELDS: { key: keyof FoodMinerals; name: string }[] = [
  { key: "calcium", name: "钙" },
  { key: "iron", name: "铁" },
  { key: "magnesium", name: "镁" },
  { key: "phosphorus", name: "磷" },
  { key: "potassium", name: "钾" },
  { key: "sodium", name: "钠" },
  { key: "zinc", name: "锌" },
];

const VITAMIN_FIELDS: { key: keyof FoodVitamins; name: string; unit: string }[] = [
  { key: "a", name: "维生素A", unit: "μg" },
  { key: "c", name: "维生素C", unit: "mg" },
  { key: "d", name: "维生素D", unit: "IU" },
  { key: "e", name: "维生素E", unit: "mg" },
  { key: "k", name: "维生素K", unit: "μg" },
  { key: "b1", name: "维生素B1", unit: "mg" },
  { key: "b2", name: "维生素B2", unit: "mg" },
  { key: "b3", name: "维生素B3", unit: "mg" },
  { key: "b6", name: "维生素B6", unit: "mg" },
  { key: "b12", name: "维生素B12", unit: "μg" },
  { key: "folate", name: "叶酸", unit: "μg" },
];

/** 按克数计算单个食品的全部营养素条目 */
export function nutrientsForGrams(food: FoodItem, grams: number): NutrientEntry[] {
  const r = grams / 100;
  const out: NutrientEntry[] = [];
  const round = (n: number) => Math.round(n * 100) / 100;

  out.push({ name: "热量", value: round(food.caloriesPer100g * r), unit: "千卡", group: "macro" });
  out.push({ name: "蛋白质", value: round(food.proteinPer100g * r), unit: "g", group: "macro" });
  out.push({ name: "碳水化合物", value: round(food.carbsPer100g * r), unit: "g", group: "macro" });
  out.push({ name: "脂肪", value: round(food.fatPer100g * r), unit: "g", group: "macro" });
  if (food.saturatedFatPer100g != null) {
    out.push({ name: "饱和脂肪", value: round(food.saturatedFatPer100g * r), unit: "g", group: "macro" });
  }
  if (food.cholesterolPer100g != null) {
    out.push({ name: "胆固醇", value: round(food.cholesterolPer100g * r), unit: "mg", group: "macro" });
  }
  if (food.sugarPer100g != null) {
    out.push({ name: "糖", value: round(food.sugarPer100g * r), unit: "g", group: "macro" });
  }
  if (food.fiberPer100g != null) {
    out.push({ name: "膳食纤维", value: round(food.fiberPer100g * r), unit: "g", group: "fiber" });
  }
  if (food.sodiumPer100g != null) {
    out.push({ name: "钠", value: round(food.sodiumPer100g * r), unit: "mg", group: "mineral" });
  }
  if (food.minerals) {
    for (const f of MINERAL_FIELDS) {
      const v = food.minerals[f.key];
      if (v != null) out.push({ name: f.name, value: round(v * r), unit: "mg", group: "mineral" });
    }
  }
  if (food.vitamins) {
    for (const f of VITAMIN_FIELDS) {
      const v = food.vitamins[f.key];
      if (v != null) out.push({ name: f.name, value: round(v * r), unit: f.unit, group: "vitamin" });
    }
  }
  if (food.customNutrients) {
    for (const c of food.customNutrients) {
      out.push({ name: c.name, value: round(c.value * r), unit: c.unit, group: "other" });
    }
  }
  return out;
}

/** 今日总摄入（聚合所有 FoodRecord，按 foodId 关联 FoodItem 取明细） */
export function sumTodayNutrients(
  records: FoodRecord[],
  foodDb: FoodItem[],
): NutrientEntry[] {
  const map = new Map<string, NutrientEntry>();
  const foodById = new Map(foodDb.map((f) => [f.id, f]));
  const round = (n: number) => Math.round(n * 100) / 100;
  const add = (name: string, value: number, unit: string, group: NutrientEntry["group"]) => {
    const k = `${group}:${name}:${unit}`;
    const ex = map.get(k);
    if (ex) ex.value = round(ex.value + value);
    else map.set(k, { name, value: round(value), unit, group });
  };

  for (const rec of records) {
    // 基础四项来自 record 本身
    add("热量", rec.calories, "千卡", "macro");
    add("蛋白质", rec.protein, "g", "macro");
    add("碳水化合物", rec.carbs, "g", "macro");
    add("脂肪", rec.fat, "g", "macro");
    // 明细需关联 FoodItem
    if (rec.foodId) {
      const food = foodById.get(rec.foodId);
      if (food) {
        const r = rec.grams / 100;
        if (food.saturatedFatPer100g != null) add("饱和脂肪", food.saturatedFatPer100g * r, "g", "macro");
        if (food.cholesterolPer100g != null) add("胆固醇", food.cholesterolPer100g * r, "mg", "macro");
        if (food.sugarPer100g != null) add("糖", food.sugarPer100g * r, "g", "macro");
        if (food.fiberPer100g != null) add("膳食纤维", food.fiberPer100g * r, "g", "fiber");
        if (food.sodiumPer100g != null) add("钠", food.sodiumPer100g * r, "mg", "mineral");
        if (food.minerals) {
          for (const f of MINERAL_FIELDS) {
            const v = food.minerals[f.key];
            if (v != null) add(f.name, v * r, "mg", "mineral");
          }
        }
        if (food.vitamins) {
          for (const f of VITAMIN_FIELDS) {
            const v = food.vitamins[f.key];
            if (v != null) add(f.name, v * r, f.unit, "vitamin");
          }
        }
        if (food.customNutrients) {
          for (const c of food.customNutrients) {
            add(c.name, c.value * r, c.unit, "other");
          }
        }
      }
    }
  }
  return Array.from(map.values());
}

/** 三大营养素供能占比（蛋白质/碳水/脂肪，百分比，和为100） */
export function macroEnergyRatio(calories: number, carbs: number, protein: number, fat: number): {
  carbs: number; protein: number; fat: number;
} {
  const carbKcal = carbs * 4;
  const proteinKcal = protein * 4;
  const fatKcal = fat * 9;
  const total = carbKcal + proteinKcal + fatKcal;
  if (total <= 0) return { carbs: 0, protein: 0, fat: 0 };
  return {
    carbs: Math.round((carbKcal / total) * 1000) / 10,
    protein: Math.round((proteinKcal / total) * 1000) / 10,
    fat: Math.round((fatKcal / total) * 1000) / 10,
  };
}
