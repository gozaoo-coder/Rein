/**
 * 膳食营养素参考摄入量（成人，近似《中国居民膳食营养素参考摄入量》DRIs）。
 * 仅用于「营养全览」的微量元素对照展示；可编辑目标（大卡/宏量/钠/水）在数据库 profile 中。
 */
import type { NutrientIntake } from '@/types/nutrition'

export interface MicroDef {
  key: keyof NutrientIntake
  label: string
  unit: string
  /** 推荐摄入量 */
  dri: number
  /** true = 上限类营养（如添加糖、钠），进度条语义为「不要超过」 */
  isLimit?: boolean
  /** 一句话说明：生理作用 / 主要来源（营养全览详情页展示） */
  desc: string
}

export const MICROS: MicroDef[] = [
  { key: 'fiber', label: '膳食纤维', unit: 'g', dri: 25, desc: '促进肠道蠕动、延缓血糖上升、增强饱腹感；来源：全谷物、蔬菜、豆类。' },
  { key: 'sugar', label: '添加糖', unit: 'g', dri: 25, isLimit: true, desc: '游离糖建议每日不超过约 50g，控制在 25g 内更佳；含糖饮料是主要来源。' },
  { key: 'sodiumMg', label: '钠', unit: 'mg', dri: 1500, isLimit: true, desc: '维持电解质平衡，出汗后需补充；过量与高血压相关，食盐是主要来源。' },
  { key: 'potassiumMg', label: '钾', unit: 'mg', dri: 2000, desc: '参与神经肌肉兴奋与电解质平衡，有助于稳定血压；来源：新鲜蔬果、薯类。' },
  { key: 'calciumMg', label: '钙', unit: 'mg', dri: 800, desc: '骨骼与牙齿的主要构成，配合维生素 D 吸收更好；来源：奶类、豆制品、绿叶菜。' },
  { key: 'ironMg', label: '铁', unit: 'mg', dri: 15, desc: '血红蛋白合成的核心原料，缺乏易疲劳贫血；来源：红肉、动物肝、血制品。' },
  { key: 'zincMg', label: '锌', unit: 'mg', dri: 12.5, desc: '支持免疫功能与伤口愈合、维持味觉；来源：贝类海产、瘦肉、坚果。' },
  { key: 'magnesiumMg', label: '镁', unit: 'mg', dri: 330, desc: '参与 300+ 种酶促反应与能量代谢，帮助肌肉放松；来源：粗粮、坚果、绿叶菜。' },
  { key: 'vitAUg', label: '维生素A', unit: 'μg', dri: 750, desc: '维护夜间视力与皮肤黏膜健康；来源：动物肝脏、蛋黄、深色蔬果。' },
  { key: 'vitCMg', label: '维生素C', unit: 'mg', dri: 100, desc: '抗氧化、促进铁吸收与胶原合成；来源：新鲜蔬菜与水果。' },
  { key: 'vitDUg', label: '维生素D', unit: 'μg', dri: 10, desc: '促进钙吸收、维护骨骼健康；主要靠日晒合成，食物中海鱼、蛋黄含量较高。' },
  { key: 'vitEMg', label: '维生素E', unit: 'mg', dri: 14, desc: '重要脂溶性抗氧化剂，保护细胞膜；来源：植物油、坚果、牛油果。' },
  { key: 'vitB12Ug', label: '维生素B12', unit: 'μg', dri: 2.4, desc: '神经系统与红细胞生成所必需，几乎只存在于动物性食物；素食者需关注。' },
  { key: 'folateUg', label: '叶酸', unit: 'μg', dri: 400, desc: '参与细胞分裂与红细胞成熟；来源：深绿叶菜、豆类、动物肝。' },
]

/** 宏量营养素说明 · key 与 MacroStat.key 对应 */
export interface MacroGuide {
  key: 'protein' | 'carb' | 'fat' | 'sodiumMg'
  label: string
  colorVar: string
  desc: string
}

export const MACRO_GUIDES: MacroGuide[] = [
  {
    key: 'protein',
    label: '蛋白质',
    colorVar: '--c-protein',
    desc: '肌肉与组织修复的原料。减脂期吃够可保留肌肉、增强饱腹；来源：肉蛋、水产、奶类、豆制品。',
  },
  {
    key: 'carb',
    label: '碳水',
    colorVar: '--c-carb',
    desc: '大脑与运动的首选燃料，训练前后优先补充；来源：主食、薯类、水果，粗细搭配血糖更稳。',
  },
  {
    key: 'fat',
    label: '脂肪',
    colorVar: '--c-fat',
    desc: '参与激素合成与脂溶性维生素吸收，约占总热量两到三成；来源：食用油、坚果、深海鱼。',
  },
  {
    key: 'sodiumMg',
    label: '钠',
    colorVar: '--c-sodium',
    desc: '上限类目标——长期超过会升高血压与心血管风险；加工食品与外卖是最常见的隐形来源。',
  },
]
