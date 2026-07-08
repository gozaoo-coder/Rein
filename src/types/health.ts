/**
 * Health data types — 饮水 / 饮食 / 体征
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

/** 重要矿物质枚举 (mg per 100g) */
export interface FoodMinerals {
  /** 钙 mg */
  calcium?: number;
  /** 铁 mg */
  iron?: number;
  /** 镁 mg */
  magnesium?: number;
  /** 磷 mg */
  phosphorus?: number;
  /** 钾 mg */
  potassium?: number;
  /** 钠 mg */
  sodium?: number;
  /** 锌 mg */
  zinc?: number;
}

/** 重要维生素枚举 (per 100g) */
export interface FoodVitamins {
  /** 维生素A μg RAE */
  a?: number;
  /** 维生素C mg */
  c?: number;
  /** 维生素D IU */
  d?: number;
  /** 维生素E mg */
  e?: number;
  /** 维生素K μg */
  k?: number;
  /** 维生素B1 (硫胺素) mg */
  b1?: number;
  /** 维生素B2 (核黄素) mg */
  b2?: number;
  /** 维生素B3 (烟酸) mg */
  b3?: number;
  /** 维生素B6 mg */
  b6?: number;
  /** 维生素B12 μg */
  b12?: number;
  /** 叶酸 μg DFE */
  folate?: number;
}

/** 自定义营养素条目 (用于咖啡因等非标准项) */
export interface CustomNutrient {
  /** 营养素名，如 "咖啡因" */
  name: string;
  /** 数值 (per 100g) */
  value: number;
  /** 单位，如 "mg" */
  unit: string;
}

/** 健康评分 0-100 */
export type HealthScore = 0 | 1 | 2 | 3 | 4 | 5;

export const HEALTH_SCORE_LABEL: Record<HealthScore, string> = {
  0: "慎食",
  1: "较差",
  2: "一般",
  3: "良好",
  4: "优秀",
  5: "极佳",
};

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
  /** 每 100g 膳食纤维 g */
  fiberPer100g?: number;
  /** 每 100g 糖 g */
  sugarPer100g?: number;
  /** 每 100g 饱和脂肪 g */
  saturatedFatPer100g?: number;
  /** 每 100g 胆固醇 mg */
  cholesterolPer100g?: number;
  /** 每 100g 钠 mg */
  sodiumPer100g?: number;
  /** 矿物质明细 */
  minerals?: FoodMinerals;
  /** 维生素明细 */
  vitamins?: FoodVitamins;
  /** 自定义营养素（咖啡因等） */
  customNutrients?: CustomNutrient[];
  /** 健康评分 0-5 */
  healthScore: HealthScore;
  /** 可选：描述/备注 */
  description?: string;
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
