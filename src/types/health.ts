/**
 * Health data types — 饮水 / 饮食 / 体征
 *
 * - WaterRecord: 单次饮水记录
 * - FoodRecord: 单次饮食记录（引用食品库 + 克数）
 * - FoodItem: 食品数据库条目（每 100g 营养信息）
 * - BodyMetrics: 身高/体重/体脂（手动记录，支持历史）
 */

/** 单次饮水记录 */
export interface WaterRecord {
  id: string;
  /** 毫升 */
  amount: number;
  /** 时间戳 */
  timestamp: number;
}

/** 食品单位定义 */
export interface FoodUnit {
  /** 单位名（如 "个" / "两" / "杯"） */
  name: string;
  /** 折算克数 */
  grams: number;
}

/** 食品数据库条目 — 营养信息以 100g 为基准 */
export interface FoodItem {
  id: string;
  name: string;
  category: string;
  /** 每 100g 热量 kcal */
  caloriesPer100g: number;
  /** 每 100g 碳水 g */
  carbsPer100g: number;
  /** 每 100g 蛋白质 g */
  proteinPer100g: number;
  /** 每 100g 脂肪 g */
  fatPer100g: number;
  /** 可选：维生素/矿物质描述 */
  microNutrients?: string;
  /** 可用单位（默认含 100g） */
  units: FoodUnit[];
  /** 是否用户自定义 */
  custom: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 单次饮食记录 */
export interface FoodRecord {
  id: string;
  /** 关联食品 id（可空，表示快速记录） */
  foodId?: string;
  /** 食品名（冗余，便于显示） */
  foodName: string;
  /** 摄入克数 */
  grams: number;
  /** 计算所得热量 kcal */
  calories: number;
  /** 计算所得碳水 g */
  carbs: number;
  /** 计算所得蛋白质 g */
  protein: number;
  /** 计算所得脂肪 g */
  fat: number;
  /** 时间戳 */
  timestamp: number;
}

/** 体征记录（身高/体重/体脂）— 每次更新写一条历史 */
export interface BodyMetricsRecord {
  id: string;
  /** cm */
  heightCm?: number;
  /** kg */
  weightKg?: number;
  /** 体脂率 % */
  bodyFatPercent?: number;
  /** BMI（计算得出） */
  bmi?: number;
  timestamp: number;
}

/** BMI 分类 */
export type BmiCategory = "underweight" | "normal" | "overweight" | "obese";

export const BMI_CATEGORY_LABEL: Record<BmiCategory, string> = {
  underweight: "过瘦",
  normal: "正常",
  overweight: "较重",
  obese: "超重",
};

export const BMI_CATEGORY_RANGE: Record<BmiCategory, { min: number; max: number }> = {
  underweight: { min: 0, max: 18.5 },
  normal: { min: 18.5, max: 24 },
  overweight: { min: 24, max: 28 },
  obese: { min: 28, max: 100 },
};

/** 计算 BMI */
export function calcBmi(heightCm: number, weightKg: number): number | undefined {
  if (heightCm <= 0 || weightKg <= 0) return undefined;
  const h = heightCm / 100;
  return Math.round((weightKg / (h * h)) * 10) / 10;
}

/** BMI 分类 */
export function classifyBmi(bmi: number): BmiCategory {
  if (bmi < 18.5) return "underweight";
  if (bmi < 24) return "normal";
  if (bmi < 28) return "overweight";
  return "obese";
}
