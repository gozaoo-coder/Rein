/**
 * foodDatabase — 预设食品数据库
 *
 * 营养信息以 100g 为基准，含常用单位换算
 */
import type { FoodItem } from "@/types/health";

function genFoodId(name: string): string {
  return `food-${name.replace(/\s+/g, "-")}`;
}

const now = Date.now();

export const PRESET_FOODS: FoodItem[] = [
  // 主食
  {
    id: genFoodId("rice"), name: "白米饭", category: "主食",
    caloriesPer100g: 116, carbsPer100g: 25.9, proteinPer100g: 2.6, fatPer100g: 0.3,
    microNutrients: "含少量 B 族维生素",
    units: [{ name: "碗(熟)", grams: 200 }, { name: "两", grams: 50 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("noodle"), name: "面条", category: "主食",
    caloriesPer100g: 280, carbsPer100g: 55, proteinPer100g: 9, fatPer100g: 1.5,
    units: [{ name: "碗", grams: 180 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("bread"), name: "全麦面包", category: "主食",
    caloriesPer100g: 247, carbsPer100g: 41, proteinPer100g: 13, fatPer100g: 4.2,
    units: [{ name: "片", grams: 35 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("oat"), name: "燕麦片", category: "主食",
    caloriesPer100g: 389, carbsPer100g: 66, proteinPer100g: 17, fatPer100g: 7,
    units: [{ name: "杯", grams: 40 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("sweet-potato"), name: "红薯", category: "主食",
    caloriesPer100g: 90, carbsPer100g: 21, proteinPer100g: 1.1, fatPer100g: 0.2,
    units: [{ name: "个", grams: 200 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  // 蛋白质
  {
    id: genFoodId("chicken-breast"), name: "鸡胸肉", category: "蛋白质",
    caloriesPer100g: 165, carbsPer100g: 0, proteinPer100g: 31, fatPer100g: 3.6,
    units: [{ name: "块", grams: 120 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("egg"), name: "鸡蛋", category: "蛋白质",
    caloriesPer100g: 144, carbsPer100g: 1.1, proteinPer100g: 13.3, fatPer100g: 8.8,
    units: [{ name: "个", grams: 50 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("beef"), name: "瘦牛肉", category: "蛋白质",
    caloriesPer100g: 250, carbsPer100g: 0, proteinPer100g: 26, fatPer100g: 15,
    units: [{ name: "两", grams: 50 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("fish"), name: "龙利鱼", category: "蛋白质",
    caloriesPer100g: 83, carbsPer100g: 0, proteinPer100g: 17, fatPer100g: 1.4,
    units: [{ name: "块", grams: 150 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("tofu"), name: "豆腐", category: "蛋白质",
    caloriesPer100g: 81, carbsPer100g: 1.9, proteinPer100g: 8.1, fatPer100g: 3.7,
    units: [{ name: "块", grams: 120 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("shrimp"), name: "虾仁", category: "蛋白质",
    caloriesPer100g: 99, carbsPer100g: 0.2, proteinPer100g: 24, fatPer100g: 0.3,
    units: [{ name: "把", grams: 80 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  // 蔬菜
  {
    id: genFoodId("broccoli"), name: "西兰花", category: "蔬菜",
    caloriesPer100g: 36, carbsPer100g: 4.3, proteinPer100g: 4.1, fatPer100g: 0.6,
    units: [{ name: "朵", grams: 50 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("spinach"), name: "菠菜", category: "蔬菜",
    caloriesPer100g: 28, carbsPer100g: 4.5, proteinPer100g: 2.6, fatPer100g: 0.3,
    units: [{ name: "把", grams: 100 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("tomato"), name: "番茄", category: "蔬菜",
    caloriesPer100g: 22, carbsPer100g: 5.5, proteinPer100g: 1.1, fatPer100g: 0.2,
    units: [{ name: "个", grams: 130 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("cucumber"), name: "黄瓜", category: "蔬菜",
    caloriesPer100g: 16, carbsPer100g: 3.6, proteinPer100g: 0.8, fatPer100g: 0.2,
    units: [{ name: "根", grams: 150 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("cabbage"), name: "卷心菜", category: "蔬菜",
    caloriesPer100g: 24, carbsPer100g: 5.5, proteinPer100g: 1.5, fatPer100g: 0.3,
    units: [{ name: "把", grams: 100 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  // 水果
  {
    id: genFoodId("apple"), name: "苹果", category: "水果",
    caloriesPer100g: 53, carbsPer100g: 13.7, proteinPer100g: 0.2, fatPer100g: 0.2,
    units: [{ name: "个", grams: 200 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("banana"), name: "香蕉", category: "水果",
    caloriesPer100g: 93, carbsPer100g: 22, proteinPer100g: 1.4, fatPer100g: 0.2,
    units: [{ name: "根", grams: 120 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("orange"), name: "橙子", category: "水果",
    caloriesPer100g: 48, carbsPer100g: 11.1, proteinPer100g: 0.8, fatPer100g: 0.2,
    units: [{ name: "个", grams: 180 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("grape"), name: "葡萄", category: "水果",
    caloriesPer100g: 67, carbsPer100g: 17, proteinPer100g: 0.6, fatPer100g: 0.2,
    units: [{ name: "串", grams: 200 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  // 乳制品
  {
    id: genFoodId("milk"), name: "牛奶", category: "乳制品",
    caloriesPer100g: 65, carbsPer100g: 4.9, proteinPer100g: 3.3, fatPer100g: 3.6,
    units: [{ name: "杯", grams: 250 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("yogurt"), name: "原味酸奶", category: "乳制品",
    caloriesPer100g: 88, carbsPer100g: 9.3, proteinPer100g: 2.5, fatPer100g: 2.7,
    units: [{ name: "盒", grams: 150 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  // 坚果
  {
    id: genFoodId("almond"), name: "杏仁", category: "坚果",
    caloriesPer100g: 579, carbsPer100g: 22, proteinPer100g: 21, fatPer100g: 50,
    units: [{ name: "把", grams: 28 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("walnut"), name: "核桃", category: "坚果",
    caloriesPer100g: 646, carbsPer100g: 14, proteinPer100g: 15, fatPer100g: 65,
    units: [{ name: "个", grams: 5 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  // 饮品
  {
    id: genFoodId("coffee"), name: "黑咖啡", category: "饮品",
    caloriesPer100g: 2, carbsPer100g: 0.3, proteinPer100g: 0.3, fatPer100g: 0,
    units: [{ name: "杯", grams: 240 }],
    custom: false, createdAt: now, updatedAt: now,
  },
  {
    id: genFoodId("soy-milk"), name: "豆浆", category: "饮品",
    caloriesPer100g: 30, carbsPer100g: 1.1, proteinPer100g: 3, fatPer100g: 1.6,
    units: [{ name: "杯", grams: 250 }],
    custom: false, createdAt: now, updatedAt: now,
  },
];

export const FOOD_CATEGORIES = ["主食", "蛋白质", "蔬菜", "水果", "乳制品", "坚果", "饮品", "其他"];
