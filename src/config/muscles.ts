/**
 * 全身肌群激活 · 领域配置
 *
 * 肌群键与 src/assets/muscles/rein/{front,back,side}.svg 中的
 * <g data-m="…"> 分区一一对应。三视图由 BodyParts3D 的真实人体解剖网格
 * 正交投影生成（scripts/build-anatomy.mjs，见 resources/muscles/SOURCE.md），
 * 因此分区边界来自解剖本体而非手绘。
 *
 * 细化到「肌束」层级：三角肌分前/中/后束、胸大肌分上/下束、斜方肌分
 * 上/中/下束、股四头分股外侧/股直/股内侧、小腿分腓肠肌/比目鱼肌等。
 * 其中上/下胸对应 FMA 的 clavicular / sternocostal+abdominal part of
 * pectoralis major，前/中/后三角肌对应 clavicular / acromial / spinal
 * part of deltoid，细分直接来自解剖本体。
 *
 * 动作名 → 肌群激活档位的映射。课程种子只有少量动作，而用户会在
 * 计划编辑页自建动作（自由命名），因此采用「关键词规则、先专后泛」
 * 的匹配策略：命中即返回激活表，全部未命中返回 null（页面隐藏卡片，
 * 不展示猜测信息）。
 *
 * 档位：3 主攻 / 2 辅助 / 1 稳定；强度取自常见训练常识，
 * 非精确 EMG 数据，仅作可视化参考。
 */

/** 肌群键（与三视图 SVG 分区一一对应） */
export type MuscleKey =
  | 'scm' // 胸锁乳突肌（颈）
  // ---- 肩 ----
  | 'delt-ant' // 三角肌前束
  | 'delt-lat' // 三角肌中束
  | 'delt-post' // 三角肌后束
  // ---- 背 ----
  | 'traps-up' // 斜方肌上束
  | 'traps-mid' // 斜方肌中束
  | 'traps-low' // 斜方肌下束
  | 'lats' // 背阔肌
  | 'lower-back' // 竖脊肌（下背）
  // ---- 胸腹 ----
  | 'chest-up' // 胸大肌上束（锁骨部）
  | 'chest-low' // 胸大肌下束（胸骨部）
  | 'abs' // 腹直肌
  | 'obliques' // 腹斜肌
  // ---- 手臂 ----
  | 'biceps' // 肱二头肌
  | 'triceps' // 肱三头肌
  | 'forearm' // 前臂肌群
  // ---- 髋臀 ----
  | 'glute-max' // 臀大肌
  | 'glute-med' // 臀中肌
  // ---- 腿 ----
  | 'quads-lat' // 股外侧肌
  | 'quads-rec' // 股直肌
  | 'quads-med' // 股内侧肌
  | 'adductors' // 内收肌群
  | 'hamstrings' // 腘绳肌
  | 'calves' // 腓肠肌
  | 'soleus' // 比目鱼肌
  | 'tibialis' // 胫骨前肌

/** 激活档位：3 主攻 / 2 辅助 / 1 稳定 */
export type Level = 1 | 2 | 3

export type ActivationMap = Partial<Record<MuscleKey, Level>>

/** 全部肌群键（AI 工具 schema 与数据校验共用） */
export const MUSCLE_KEYS: MuscleKey[] = [
  'scm',
  'delt-ant',
  'delt-lat',
  'delt-post',
  'traps-up',
  'traps-mid',
  'traps-low',
  'lats',
  'lower-back',
  'chest-up',
  'chest-low',
  'abs',
  'obliques',
  'biceps',
  'triceps',
  'forearm',
  'glute-max',
  'glute-med',
  'quads-lat',
  'quads-rec',
  'quads-med',
  'adductors',
  'hamstrings',
  'calves',
  'soleus',
  'tibialis',
]

export const MUSCLE_LABELS: Record<MuscleKey, string> = {
  scm: '胸锁乳突肌',
  'delt-ant': '三角肌前束',
  'delt-lat': '三角肌中束',
  'delt-post': '三角肌后束',
  'traps-up': '斜方肌上束',
  'traps-mid': '斜方肌中束',
  'traps-low': '斜方肌下束',
  lats: '背阔肌',
  'lower-back': '竖脊肌',
  'chest-up': '胸大肌上束',
  'chest-low': '胸大肌下束',
  abs: '腹直肌',
  obliques: '腹斜肌',
  biceps: '肱二头肌',
  triceps: '肱三头肌',
  forearm: '前臂肌群',
  'glute-max': '臀大肌',
  'glute-med': '臀中肌',
  'quads-lat': '股外侧肌',
  'quads-rec': '股直肌',
  'quads-med': '股内侧肌',
  adductors: '内收肌群',
  hamstrings: '腘绳肌',
  calves: '腓肠肌',
  soleus: '比目鱼肌',
  tibialis: '胫骨前肌',
}

/** 肌群作用简介（MuscleMap 点击详情用），一句话讲清功能与训练角色 */
export const MUSCLE_DESCS: Record<MuscleKey, string> = {
  scm: '颈前斜跨的细长肌，主管头颈转向与屈曲；也是良好体态的关键。',
  'delt-ant': '肩前束，负责手臂前举与水平内收；卧推、推举的主攻肌。',
  'delt-lat': '肩中束，负责手臂外展；侧平举的主攻肌，肩宽轮廓的主要来源。',
  'delt-post': '肩后束，负责手臂水平外展；反向飞鸟、面拉的主攻肌，圆肩体态的关键。',
  'traps-up': '上提肩胛；耸肩、直立划船的主攻肌，长期伏案紧张时会僵硬酸痛。',
  'traps-mid': '后收肩胛；划船类动作的关键稳定与发力肌，改善圆肩。',
  'traps-low': '下沉与上回旋肩胛；过顶推举与引体的稳定肌。',
  lats: '背部最宽的肌群，肩内收与伸展的主力；引体、下拉、划船的主攻肌，塑造倒三角。',
  'lower-back': '脊柱伸展与抗屈曲的核心；硬拉、挺身的主攻肌，也是所有大重量动作的稳定器。',
  'chest-up': '胸大肌锁骨部（上胸），负责手臂前举与水平内收；上斜卧推的主攻肌。',
  'chest-low': '胸大肌胸骨部（中下胸），推类动作的主要发力来源；平板卧推、俯卧撑的主攻肌。',
  abs: '躯干屈曲与抗伸展；卷腹、举腿的主攻肌，复合动作中传递上下肢力量。',
  obliques: '躯干旋转与侧屈，抗旋转稳定；转体类动作的主攻肌。',
  biceps: '屈肘与旋后主力，弯举类动作的主攻肌；上臂前侧隆起的主要来源。',
  triceps: '伸肘主力，占上臂围度约三分之二；卧推、臂屈伸等推类动作的重要协同肌。',
  forearm: '握力与腕部稳定的来源；拉类与抓握类动作中持续发力。',
  'glute-max': '髋伸与外旋的发动机；深蹲、硬拉、臀推与跑跳中都是发力核心。',
  'glute-med': '髋外展与稳定；单腿动作与跑动中防止骨盆下沉的关键。',
  'quads-lat': '伸膝主力之一，塑造大腿外侧轮廓；蹲类、骑行高度依赖它。',
  'quads-rec': '股四头中列的直肌，双关节肌；蹲类与踢腿动作的主要发力肌。',
  'quads-med': '股四头内侧的「泪滴」，伸膝末端的关键，护膝作用明显。',
  adductors: '大腿内收与稳定；深蹲底端与变向动作中提供重要支撑。',
  hamstrings: '屈膝与髋伸的协同肌；硬拉类动作的主攻肌，跑跳中负责减速与稳定。',
  calves: '腓肠肌：踝关节跖屈主力，跨膝双关节；提踵与跑跳中持续参与。',
  soleus: '比目鱼肌：跖屈与站立稳定，坐姿提踵的主攻肌。',
  tibialis: '胫骨前肌：勾脚与落地缓冲，防止胫骨应力损伤的关键。',
}

/** 顺序即优先级：越靠前越专用（如「反向飞鸟」须先于泛匹配「飞鸟」） */
const RULES: { match: RegExp; act: ActivationMap | null }[] = [
  // ---- 专项动作先行：名字含泛关键词但主攻不同，必须先于后面的泛规则 ----
  {
    // 「反向飞鸟」「俯身飞鸟」练后束，不是胸；下束参与肩胛后收下压
    match: /反向飞鸟|俯身飞鸟|后束/,
    act: { 'delt-post': 3, 'traps-mid': 2, 'traps-low': 1 },
  },
  {
    // 面拉：后束 + 肩袖外旋肌群 + 斜方中/下束（肩胛后缩下压）
    match: /面拉/,
    act: { 'delt-post': 3, 'traps-mid': 2, 'traps-low': 2 },
  },
  {
    match: /耸肩/,
    act: { 'traps-up': 3, forearm: 2 },
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
    match: /腿屈伸|腿伸展/,
    act: { 'quads-rec': 3, 'quads-med': 2, 'quads-lat': 2 },
  },
  {
    // 髋外展类：臀中肌主导
    match: /髋外展|蚌式|臀中/,
    act: { 'glute-med': 3, 'glute-max': 2 },
  },
  {
    // 臀推/臀冲/臀桥：臀主导的髋伸，不是硬拉，别把竖脊肌按主攻标
    match: /臀推|臀冲|臀桥/,
    act: { 'glute-max': 3, 'glute-med': 2, hamstrings: 2, abs: 1 },
  },
  {
    match: /内收|夹腿/,
    act: { adductors: 3, hamstrings: 1 },
  },
  {
    // 悬垂举腿/提膝：下腹为主，悬挂兼练握力
    match: /举腿|提膝/,
    act: { abs: 3, forearm: 2 },
  },
  {
    // 屈膝位提踵（坐姿）主要吃比目鱼肌，直膝位才轮到腓肠肌 —— 必须排在通用提踵之前
    match: /坐姿提踵|屈膝提踵/,
    act: { soleus: 3, calves: 1 },
  },
  {
    match: /提踵|踮/,
    act: { calves: 3, soleus: 2 },
  },
  {
    // 侧平板练的是腹斜肌，别被后面的「平板」规则按腹直肌处理
    match: /侧平板|侧桥/,
    act: { obliques: 3, abs: 1 },
  },
  {
    // 脚垫高的俯卧撑（俗称「下斜俯卧撑」）练的是上胸，须先于平推规则
    match: /脚垫高|下斜俯卧撑/,
    act: { 'chest-up': 3, 'chest-low': 1, 'delt-ant': 3, triceps: 2 },
  },
  {
    // 上斜推类先把上胸标为主攻
    match: /上斜|斜板/,
    act: { 'chest-up': 3, 'chest-low': 1, 'delt-ant': 3, triceps: 2 },
  },
  {
    match: /前平举/,
    act: { 'delt-ant': 3, 'chest-up': 1, 'traps-up': 1 },
  },
  {
    match: /侧平举/,
    act: { 'delt-lat': 3, 'traps-up': 1 },
  },
  // ---- 颈部 ----
  {
    match: /颈桥|卷颈|颈部/,
    act: { scm: 3, 'traps-up': 2 },
  },
  // ---- 手臂伸：肩伸参与的双杠/凳上撑体，与纯肘伸的绳索下压分开 ----
  {
    match: /双杠|凳上臂屈伸|椅式臂屈伸/,
    act: { triceps: 3, 'chest-low': 2, 'delt-ant': 2, abs: 1 },
  },
  {
    // 纯肘伸孤立：胸与前束只是稳定，不该按辅助标
    match: /臂屈伸|下压|三头/,
    act: { triceps: 3, forearm: 1 },
  },
  // ---- 推（胸）----
  {
    match: /卧推|俯卧撑|飞鸟|夹胸/,
    act: { 'chest-low': 3, 'chest-up': 2, triceps: 2, 'delt-ant': 2, abs: 1 },
  },
  // ---- 推（肩）----
  {
    match: /肩推|推举|平举|直立划船|阿诺德/,
    act: {
      'delt-ant': 3,
      'delt-lat': 2,
      triceps: 2,
      'traps-up': 1,
      'traps-low': 1,
      'delt-post': 1,
      abs: 1,
    },
  },
  // ---- 拉（背）----
  {
    // 拉类都吃后束与斜方中/下束（肩胛后缩下压），握力也是实打实的负荷
    match: /引体|下拉|划船/,
    act: {
      lats: 3,
      'traps-mid': 2,
      'delt-post': 2,
      'traps-low': 2,
      biceps: 2,
      forearm: 2,
      'lower-back': 1,
    },
  },
  // ---- 手臂屈（二头）----
  {
    match: /弯举|锤式/,
    act: { biceps: 3, forearm: 2 },
  },
  // ---- 髋铰链（后链）----
  {
    // 挺身/山羊：竖脊肌才是主攻，不套硬拉的模板
    match: /挺身|山羊|超伸/,
    act: { 'lower-back': 3, 'glute-max': 2, hamstrings: 2, abs: 1 },
  },
  {
    match: /硬拉|早安/,
    act: { hamstrings: 3, 'glute-max': 3, 'lower-back': 3, lats: 2, 'traps-up': 2, forearm: 2 },
  },
  // ---- 蹲（膝主导）----
  {
    match: /深蹲|蹲|弓步|保加利亚|腿举|哈克/,
    act: {
      'quads-rec': 3,
      'quads-lat': 2,
      'quads-med': 2,
      'glute-max': 3,
      'glute-med': 2,
      hamstrings: 2,
      adductors: 2,
      'lower-back': 1,
      abs: 1,
      calves: 1,
    },
  },
  // ---- 爬坡类（先于泛「跑」）----
  {
    match: /登山|爬楼|爬坡/,
    act: { 'quads-rec': 3, 'quads-lat': 2, 'glute-max': 2, 'glute-med': 1, calves: 2, tibialis: 1, abs: 2 },
  },
  // ---- 快走（先于泛「跑」，走≠跑）----
  {
    match: /快走|健走|步行|散步/,
    act: { 'quads-lat': 2, 'glute-max': 2, 'glute-med': 2, calves: 3, soleus: 2, tibialis: 2, abs: 1 },
  },
  // ---- 间歇/HIIT（含「间歇跑」，须先于泛「跑」）----
  {
    match: /hiit|间歇/i,
    act: {
      'quads-rec': 3,
      'quads-lat': 2,
      'glute-max': 3,
      'glute-med': 2,
      hamstrings: 2,
      calves: 3,
      soleus: 2,
      tibialis: 2,
      abs: 2,
    },
  },
  // ---- 核心 ----
  {
    // 转体类主攻腹斜肌，与卷腹式的躯干屈曲分开（须先于通用「腹」规则）
    match: /转体|旋转|俄罗斯/,
    act: { obliques: 3, abs: 2 },
  },
  {
    match: /平板|卷腹|仰卧|死虫|核心|腹|plank|crunch/i,
    act: { abs: 3, obliques: 1 },
  },
  // ---- 跑步：踝背屈（胫骨前肌）与髋外展稳定（臀中肌）都实打实参与 ----
  {
    match: /跑/,
    act: {
      'quads-rec': 2,
      'quads-lat': 2,
      hamstrings: 2,
      'glute-max': 2,
      'glute-med': 2,
      calves: 3,
      soleus: 2,
      tibialis: 2,
      abs: 1,
    },
  },
  // ---- 跳绳----
  {
    match: /跳绳/,
    act: { 'quads-rec': 2, calves: 3, soleus: 2, tibialis: 2, abs: 1 },
  },
  // ---- 骑行----
  {
    match: /单车|骑行|自行车/,
    act: { 'quads-rec': 3, 'quads-lat': 2, 'glute-max': 2, hamstrings: 1, calves: 2, soleus: 2 },
  },
  // ---- 游泳----
  {
    match: /游泳/,
    act: { lats: 3, 'delt-lat': 2, 'delt-post': 2, 'traps-low': 1, abs: 2 },
  },
  // ---- 椭圆机----
  {
    match: /椭圆/,
    act: { 'quads-rec': 3, 'glute-max': 2, hamstrings: 2, 'glute-med': 1, calves: 1, abs: 1 },
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
