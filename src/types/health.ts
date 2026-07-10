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

// ===== 营养目标计算 =====

/** 饮食目标 */
export type DietGoal = "lose" | "maintain" | "gain";

/** 活动水平 */
export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";

/** 活动系数（用于 TDEE = BMR × factor） */
export const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** 活动水平中文标签 */
export const ACTIVITY_LEVEL_LABEL: Record<ActivityLevel, string> = {
  sedentary: "久坐",
  light: "轻度活动",
  moderate: "中度活动",
  active: "活跃",
  very_active: "非常活跃",
};

/** 营养目标：热量(kcal) + 三大宏量营养素(g) */
export interface NutritionTarget {
  /** kcal */
  calories: number;
  /** g 碳水 */
  carbs: number;
  /** g 蛋白质 */
  protein: number;
  /** g 脂肪 */
  fat: number;
}

/** 默认营养目标（profile 未设置完整时回退） */
export const DEFAULT_NUTRITION_TARGET: NutritionTarget = {
  calories: 2000,
  carbs: 250,
  protein: 60,
  fat: 70,
};

/** 从生日计算年龄（周岁），无生日或格式非法返回 0 */
export function calcAgeFromBirthday(birthday: string): number {
  if (!birthday) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday.trim());
  if (!m) return 0;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return 0;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (
    now.getMonth() + 1 < mo ||
    (now.getMonth() + 1 === mo && now.getDate() < d)
  ) {
    age -= 1;
  }
  return age > 0 ? age : 0;
}

/**
 * 计算 BMR（基础代谢）— Mifflin-St Jeor 公式
 * 男：10*W + 6.25*H - 5*A + 5
 * 女：10*W + 6.25*H - 5*A - 161
 */
export function calcBmr(
  gender: "male" | "female" | "other",
  weightKg: number,
  heightCm: number,
  ageYears: number,
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  if (gender === "male") return base + 5;
  if (gender === "female") return base - 161;
  // other：取男女常数平均
  return base - 78;
}

/** 计算 TDEE（每日总消耗）= BMR × 活动系数 */
export function calcTdee(bmr: number, activityLevel: ActivityLevel): number {
  return bmr * ACTIVITY_FACTOR[activityLevel];
}

/** calcNutritionTarget 入参 profile */
export interface NutritionProfileInput {
  gender: "male" | "female" | "other";
  height: number;
  weight: number;
  birthday: string;
  dietGoal: DietGoal;
  activityLevel: ActivityLevel;
}

/**
 * 计算营养目标：
 * - calories = TDEE + (lose -400 / gain +350 / maintain 0)，下限 1200
 * - protein = weightKg × (lose 2.0 / gain 1.8 / maintain 1.6)
 * - fat = calories × 0.25 / 9
 * - carbs = 剩余热量 / 4
 */
export function calcNutritionTarget(profile: NutritionProfileInput): NutritionTarget {
  const age = calcAgeFromBirthday(profile.birthday);
  if (profile.height <= 0 || profile.weight <= 0 || age <= 0) {
    return { ...DEFAULT_NUTRITION_TARGET };
  }
  const bmr = calcBmr(profile.gender, profile.weight, profile.height, age);
  const tdee = calcTdee(bmr, profile.activityLevel);
  const goalDelta =
    profile.dietGoal === "lose" ? -400 : profile.dietGoal === "gain" ? 350 : 0;
  let calories = tdee + goalDelta;
  if (calories < 1200) calories = 1200;

  const proteinFactor =
    profile.dietGoal === "lose" ? 2.0 : profile.dietGoal === "gain" ? 1.8 : 1.6;
  const protein = Math.round(profile.weight * proteinFactor);
  const fat = Math.round((calories * 0.25) / 9);
  const carbs = Math.round((calories - protein * 4 - fat * 9) / 4);

  return {
    calories: Math.round(calories),
    carbs: Math.max(0, carbs),
    protein,
    fat: Math.max(0, fat),
  };
}

/** 计算饮水目标（ml）= 体重 kg × 35；体重未设置回退 2000 */
export function calcWaterGoalMl(weightKg: number): number {
  if (weightKg <= 0) return 2000;
  return Math.round(weightKg * 35);
}
