/**
 * 有氧 → 练够分「等效组」换算（纯函数，无 IPC、不落库）。
 *
 * 《练够分》原本只吃力量逐组记录：「记运动」那种粗粒度记录（跑 / 走 / 骑行…）
 * 不进分，纯跑步用户的热力图整卡隐藏。这里把运动记录折算成**等效力量组**，
 * 由 trainingScore 与力量组数合并 —— 换算只回答一件事：这块肌肉本周受了多少刺激。
 *
 * 折算口径（全端唯一一份，改这里即全端生效）：
 *   U_session = min(6, (MET − 1) × durationMin / 25)
 *   · MET 取 `WORKOUT_META[type].met[intensity]` —— 全端本来就有这张 MET 表（消耗也用它），
 *     强度档位取 workouts.effort（手动补录，`effortToIntensity`）优先；
 *     effort 为空（跑步 / 导入路径）用 workouts.intensity（客观档）。
 *   · 减 1 是**净代谢**口径：MET 是相对静息的倍率，其中 1 MET 是人坐着不动也有的那部分，
 *     它不产生训练刺激。旧版是 `时长 / 10 × 强度系数`：与强度档挂钩、却与**项目类型无关** ——
 *     同样 40 分钟，快走（MET 3.5）与划船机（MET 7.0）折出来的组数完全相同，
 *     而这两门课对肌肉的刺激差着一个档。
 *   · 25 分钟/组 是**产品标定，不是文献常数**：选它是因为「40 分钟中等强度快走」
 *     （MET 3.5）恰好折算 4.0 组 —— 与旧口径在最常用的那一档上完全一致。
 *     所以这次改动只挪动**类型之间**的相对值，不挪动最常用的那个绝对值。
 *   · 再按该运动的**肌群激活档位**折算（trainingAdvice.ACTIVATION_WEIGHT：主攻 1 / 辅助 0.5 / 稳定 0.25），
 *     与逐组记录同一口径 —— 一次 40 分钟的跑步不会把小腿按主攻记满 4 组而顺带肌群也记满。
 *   · 同一评估组只按组内**最高**激活档折一次（与逐组记录「一组里取最高档」同规则）。
 *   · 每肌群每周封顶 AEROBIC_WEEK_CAP = 6 组：有氧是补量不是主课，封顶保证「有氧单独最高只到基本够」。
 *   · 换算**不区分目标**（增肌 / 减脂同一套系数）；目标只决定补到满分区下沿的那一刀，在 trainingScore 里。
 *
 * ---------- 30 个运动类型的解析结果（实测探针，逐项可复核） ----------
 * 探针 = `resolveActivation(WORKOUT_META[type].label)`（src/config/muscles.ts 的名称规则）。
 *
 * 命中（括号 = 解析出的肌束数）：
 *   walk 快走(7)、stairs 爬楼梯(11)、run 跑步(10)、cycle 骑行(6)、hiit HIIT(9)、rope 跳绳(7)、
 *   elliptical 椭圆机(6)、row 划船机(12)、ball 球类(7)、basketball 篮球(7)、badminton 羽毛球(7)、
 *   tennis 网球(7)、pingpong 乒乓球(7)、football 足球(7)、swim 游泳(6)、boxing 拳击(8)。
 * 不命中（解析为 null）：
 *   hike 徒步、chores 做家务、dogwalk 遛狗、dance 跳舞、golf 高尔夫、kayak 皮划艇、
 *   strength 力量训练、yoga 瑜伽、pilates 普拉提、martial 武术散打、climbing 攀岩、
 *   skate 滑冰轮滑、ski 滑雪、other 其他。
 *
 * 处理：命中类直接用 resolveActivation 的结果；hike 显式复用 walk 表、martial 显式复用 boxing 表
 * （不拿「徒步」「武术散打」这种解析不出的名字再试一次）；其余 12 类**显式不计**。
 * 无表 = 不进练够分，也不猜 —— 宁可少算，不可拿名字硬凑一个肌群表出来。
 * 合计 18 类进练够分、12 类不计。
 */

import { WORKOUT_META, effortToIntensity } from '@/config/domain'
import {
  SCORE_GROUP_OF,
  resolveActivation,
  type ActivationMap,
  type Level,
  type MuscleKey,
  type ScoreGroupKey,
} from '@/config/muscles'
import { ACTIVATION_WEIGHT } from '@/utils/trainingAdvice'
import type { Goal, Intensity, Workout, WorkoutType } from '@/types'

/** 有氧等效组的单次上限（理由见文件头） */
export const AEROBIC_WEEK_CAP = 6

/** 每组等效组对应的净 MET-分钟（产品标定，见文件头） */
const NET_MET_MIN_PER_SET = 25

/** 会话 → 等效组：净 MET-分钟换算，封顶 6（口径与标定见文件头） */
function sessionUnits(type: WorkoutType, intensity: Intensity, durationMin: number): number {
  const met = WORKOUT_META[type].met[intensity]
  return Math.min(6, ((met - 1) * durationMin) / NET_MET_MIN_PER_SET)
}

/**
 * 复用表：自身解析不出肌群表的两个类型，显式借用最近亲的运动表。
 * 徒步与快走是同一套动作模式（走），武术散打与拳击同属上肢主导的搏击 ——
 * 借表比按名字硬解析可靠，也避免这两类在用户侧凭空消失。
 */
const TABLE_ALIAS: Partial<Record<WorkoutType, WorkoutType>> = { hike: 'walk', martial: 'boxing' }

/** 类型 → 肌群表（惰性解析一次并缓存；别名类型解析的是被借用类型的表） */
const TABLE_CACHE = new Map<WorkoutType, ActivationMap | null>()
function aerobicTableOf(type: WorkoutType): ActivationMap | null {
  const key = TABLE_ALIAS[type] ?? type
  if (!TABLE_CACHE.has(key)) TABLE_CACHE.set(key, resolveActivation(WORKOUT_META[key].label))
  return TABLE_CACHE.get(key) ?? null
}

/** 一个评估组的有氧折算结果 */
export interface AerobicGroupLoad {
  /** 等效组数（已按激活档折算、已封顶 AEROBIC_WEEK_CAP） */
  sets: number
  /** 贡献过的日期（练够分的频率与力量日期取并集）——只收**辅助及以上**（激活 ≥2）的日期，
   *  与 trainingScore 力量侧「稳定肌群不算今天专门练过它」同一口径，见下方 days.add 处 */
  days: Set<string>
  /** 贡献最多的类型显示名（如「跑步」），tooltip 说「含跑步等效 N 组」 */
  label: string
}

/** 组内取最高激活档：与 trainingScore 逐组记录的 byGroup 规则同源 */
function maxActivationOf(act: ActivationMap): Map<ScoreGroupKey, Level> {
  const byGroup = new Map<ScoreGroupKey, Level>()
  for (const [m, lv] of Object.entries(act) as [MuscleKey, Level][]) {
    const g = SCORE_GROUP_OF[m]
    if (g && lv > (byGroup.get(g) ?? 0)) byGroup.set(g, lv)
  }
  return byGroup
}

/**
 * 运动记录 → 各评估组的等效组（≤ AEROBIC_WEEK_CAP/组）。
 *
 * 调用方负责先按 workoutId 去掉「已有逐组记录」的课（那种课由 sets 代表，
 * 否则同一堂课会被记两遍）；本函数只看记录本身，不查库、不认 store。
 * 第二个参数（目标）不参与折算 —— 系数与封顶都与目标无关，只有「补到满分区下沿」
 * 那一刀是目标相关的，在 trainingScore 里做；保留该参数是为了调用处与 SETS_SWEET 口径同屏。
 */
export function aerobicSetsByGroup(
  workouts: Workout[],
  _goal?: Goal | null,
): Map<ScoreGroupKey, AerobicGroupLoad> {
  /** 中间态：还要按类型累计，供「贡献最多者」出显示名 */
  const mid = new Map<ScoreGroupKey, { sets: number; days: Set<string>; byType: Map<WorkoutType, number> }>()

  for (const w of workouts) {
    if (!(w.durationMin > 0)) continue
    const act = aerobicTableOf(w.type)
    if (!act) continue
    const intensity = w.effort != null ? effortToIntensity(w.effort) : w.intensity
    const unit = sessionUnits(w.type, intensity, w.durationMin)

    for (const [g, lv] of maxActivationOf(act)) {
      const cur = mid.get(g) ?? { sets: 0, days: new Set<string>(), byType: new Map<WorkoutType, number>() }
      const eq = unit * ACTIVATION_WEIGHT[lv]
      cur.sets += eq
      // 频率日期只收辅助及以上（激活 ≥2）：与 trainingScore 力量侧
      // `if (lv >= 2) acc.days.add(...)` 同口径 —— 否则「快走」里顺带的 abs:1
      // 会让核心记上一次训练（频率分 55），而同样只被 level-1 顺带刺激的核心
      // 走力量路径却记 0 次、被判「不够」并要求加练：同一块肌肉换个运动方式口径就变了。
      // 组数照计（稳定档折算 0.25 组），只是不冒充「今天专门练过它」。
      if (lv >= 2) cur.days.add(w.date)
      cur.byType.set(w.type, (cur.byType.get(w.type) ?? 0) + eq)
      mid.set(g, cur)
    }
  }

  const out = new Map<ScoreGroupKey, AerobicGroupLoad>()
  for (const [g, m] of mid) {
    // 频率上限与类型名都按「封顶前」的实际贡献判定；封顶只削组数
    let label = ''
    let best = 0
    for (const [t, v] of m.byType) {
      if (v > best) {
        best = v
        label = WORKOUT_META[t].label
      }
    }
    out.set(g, { sets: Math.min(m.sets, AEROBIC_WEEK_CAP), days: m.days, label })
  }
  return out
}
