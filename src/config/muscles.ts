/**
 * 全身肌群激活 · 领域配置
 *
 * 动作名 → 肌群激活档位的映射。课程种子只有少量动作，而用户会在
 * 计划编辑页自建动作（自由命名），因此采用「关键词规则、先专后泛」
 * 的匹配策略：命中即返回激活表，全部未命中返回 null（页面隐藏卡片，
 * 不展示猜测信息）。
 *
 * 档位：3 主攻 / 2 辅助 / 1 稳定；强度取自常见训练常识，
 * 非精确 EMG 数据，仅作可视化参考。
 */

/** 肌群键（与 MuscleMap.vue 的 SVG 区域一一对应） */
export type MuscleKey =
  | 'scm' // 胸锁乳突肌（颈）
  | 'deltoid' // 三角肌（肩）
  | 'chest' // 胸大肌
  | 'biceps' // 肱二头
  | 'triceps' // 肱三头
  | 'forearm' // 前臂
  | 'core' // 核心（腹直肌/下背）
  | 'traps' // 斜方肌
  | 'lats' // 背阔肌
  | 'glutes' // 臀肌
  | 'quads' // 股四头
  | 'hamstrings' // 腘绳肌
  | 'calves' // 小腿

/** 激活档位：3 主攻 / 2 辅助 / 1 稳定 */
export type Level = 1 | 2 | 3

export type ActivationMap = Partial<Record<MuscleKey, Level>>

export const MUSCLE_LABELS: Record<MuscleKey, string> = {
  scm: '胸锁乳突肌',
  deltoid: '三角肌',
  chest: '胸大肌',
  biceps: '肱二头',
  triceps: '肱三头',
  forearm: '前臂',
  core: '核心',
  traps: '斜方肌',
  lats: '背阔肌',
  glutes: '臀肌',
  quads: '股四头',
  hamstrings: '腘绳肌',
  calves: '小腿',
}

/** 肌群作用简介（MuscleMap 点击详情用），一句话讲清功能与训练角色 */
export const MUSCLE_DESCS: Record<MuscleKey, string> = {
  scm: '颈前斜跨的细长肌，主管头颈转向与屈曲；颈桥、卷颈等颈部抗阻动作的主攻肌，也是良好体态的关键。',
  deltoid: '肩部轮廓肌群，主管手臂上举与外展；推举、侧平举等动作的主力，也是肩部稳定与伤病预防的关键。',
  chest: '上肢推类动作（卧推、俯卧撑、飞鸟）的主攻肌，负责手臂水平内收与内旋。',
  biceps: '屈肘主力，弯举类动作的主攻肌；上臂前侧隆起的主要来源。',
  triceps: '伸肘主力，占上臂围度约三分之二；卧推、臂屈伸等推类动作的重要协同肌。',
  forearm: '握力与腕部稳定的来源；拉类与抓握类动作中持续发力，帮助收紧握姿。',
  core: '躯干抗伸展、抗旋转的稳定器（腹直肌/腹斜/竖脊）；几乎所有复合动作都要靠它传递力量。',
  traps: '控制肩胛骨上提、后收与下沉；划船、硬拉等拉类动作中的关键稳定肌。',
  lats: '背部最宽的肌群，肩内收与伸展的主力；引体、下拉、划船的主攻肌，塑造倒三角。',
  glutes: '髋伸与外展的发动机；深蹲、硬拉、跑跳中都是发力核心。',
  quads: '伸膝主力；蹲类、跑步、跳跃与骑行都高度依赖它。',
  hamstrings: '屈膝与髋伸的协同肌；硬拉类动作的主攻肌，跑跳中负责减速与稳定。',
  calves: '踝关节跖屈主力（腓肠肌/比目鱼肌）；提踵、跑跳与骑行中持续参与，支撑落地缓冲。',
}

/** 顺序即优先级：越靠前越专用（如「登山跑」须先于泛匹配「跑」） */
const RULES: { match: RegExp; act: ActivationMap | null }[] = [
  // ---- 专项动作先行：名字含泛关键词但主攻不同，必须先于后面的泛规则 ----
  {
    // 「反向飞鸟」含"飞鸟"但练后束，不是胸
    match: /反向飞鸟|俯身飞鸟/,
    act: { deltoid: 3, traps: 2 },
  },
  {
    // 面拉：后束 + 肩袖外旋肌群
    match: /面拉/,
    act: { deltoid: 3, traps: 2 },
  },
  {
    match: /耸肩/,
    act: { traps: 3, forearm: 2 },
  },
  {
    // 「腕弯举」含"弯举"但主攻前臂，不是二头
    match: /腕弯举|腕屈伸/,
    act: { forearm: 3 },
  },
  {
    // 「腿弯举」同理是腘绳肌
    match: /腿弯举/,
    act: { hamstrings: 3, calves: 1 },
  },
  {
    match: /腿屈伸/,
    act: { quads: 3 },
  },
  {
    // 悬垂举腿/提膝：下腹为主，悬挂兼练握力
    match: /举腿|提膝/,
    act: { core: 3, forearm: 2 },
  },
  // ---- 颈部 ----
  {
    match: /颈桥|卷颈|颈部/,
    act: { scm: 3, traps: 2 },
  },
  // ---- 推（胸）----
  {
    match: /卧推|俯卧撑|飞鸟|夹胸/,
    act: { chest: 3, triceps: 2, deltoid: 2, core: 1 },
  },
  // ---- 手臂伸----
  {
    match: /双杠|臂屈伸|下压/,
    act: { triceps: 3, chest: 2, deltoid: 2 },
  },
  // ---- 推（肩）----
  {
    match: /肩推|推举|平举|直立划船|阿诺德/,
    act: { deltoid: 3, triceps: 2, traps: 1, core: 1 },
  },
  // ---- 拉（背）----
  {
    match: /引体|下拉|划船/,
    act: { lats: 3, biceps: 2, traps: 2, core: 2, forearm: 1 },
  },
  // ---- 手臂屈（二头）----
  {
    match: /弯举|锤式/,
    act: { biceps: 3, forearm: 2 },
  },
  // ---- 髋铰链（后链）----
  {
    match: /硬拉|臀桥|挺身|早安/,
    act: { hamstrings: 3, glutes: 3, lats: 2, traps: 2, core: 2, forearm: 1 },
  },
  // ---- 蹲（膝主导）----
  {
    match: /深蹲|蹲|弓步|保加利亚|腿举|哈克/,
    act: { quads: 3, glutes: 3, hamstrings: 2, core: 1, calves: 1 },
  },
  // ---- 小腿----
  {
    match: /提踵|踮/,
    act: { calves: 3 },
  },
  // ---- 爬坡类（先于泛「跑」）----
  {
    match: /登山|爬楼|爬坡/,
    act: { quads: 3, glutes: 2, calves: 2, core: 2 },
  },
  // ---- 核心----
  {
    match: /平板|卷腹|仰卧|死虫|转体|核心|腹|plank|crunch/i,
    act: { core: 3 },
  },
  // ---- 跑步----
  {
    match: /跑/,
    act: { quads: 2, hamstrings: 2, calves: 3, glutes: 2, core: 1 },
  },
  // ---- 跳绳----
  {
    match: /跳绳/,
    act: { quads: 2, calves: 3, core: 1 },
  },
  // ---- 骑行----
  {
    match: /单车|骑行|自行车/,
    act: { quads: 3, glutes: 2, calves: 2, hamstrings: 1 },
  },
  // ---- 游泳----
  {
    match: /游泳/,
    act: { lats: 3, deltoid: 2, core: 2 },
  },
  // ---- 椭圆机----
  {
    match: /椭圆/,
    act: { quads: 2, glutes: 2, calves: 1, core: 1 },
  },
  // ---- 拉伸/放松类：不展示猜测信息----
  { match: /伸展|拉伸|放松|瑜伽|热身|泡沫轴/, act: null },
]

/** 按动作名解析肌群激活表；无法识别时返回 null */
export function resolveActivation(name: string | null | undefined): ActivationMap | null {
  if (!name) return null
  for (const r of RULES) {
    if (r.match.test(name)) return r.act ? { ...r.act } : null
  }
  return null
}
