/**
 * 激活热身处方（纯函数，无 IPC、不落库）：把「正式组重量」换算成热身组。
 *
 * 为什么按重量换算而不是写死在课程里：热身的目的不是训练容量，而是
 *  ① 唤醒目标肌群与神经通路；② 预演动作模式；③ 降低大重量下的受伤风险。
 * 因此热身强度必须**跟着当天的工作重量走** —— 今天建议 65kg，热身就该是
 * 41 / 57.5kg，而不是课程里写死的 30 / 45kg（那是按 60kg 编的）。
 *
 * 科学依据（写在代码里便于复核与调整）：
 *  - 热身强度取工作组的 **40%–75% 1RM** 区间。低于 ~40% 只产生局部升温，
 *    对后续表现无增益；高于 ~80% 则开始累积疲劳，反而压低工作组的正式输出。
 *    （DeRenne 等 1996 热身负荷研究；NSCA《Essentials of Strength Training
 *    and Conditioning》渐进热身章节）
 *  - 两段渐进：50% 1RM × 8 建立动作模式 → 70% 1RM × 4 在低次数下预演接近工作组的
 *    负荷（次数少 = 离力竭远，不产生实质疲劳）。
 *  - 相对强度不足（工作重量不到估算极限的 40%）时一段 50% × 12 已足够唤醒，
 *    多一段只是拖时间。
 *  - 重量取整到 2.5kg：大多数健身房最小配重片步进（哑铃常见 2.5kg 一档）；
 *    并保证**严格小于**工作重量（否则「热身＝正式组」，语义不成立）。
 *
 * ⚠️ 百分比乘的是**估算极限（e1RM）**，不是工作重量 —— 这一点曾经写错：文件头写着
 * 「40%–75% 1RM」，代码却拿 `w * 0.5` 当热身重量。工作重量本来就只占 e1RM 的
 * 一半多时，热身会落到 25% 1RM 附近，即「低于 40% 只产生局部升温」的那一段 ——
 * 白白占掉一组的时间。修法是显式传入 e1rm 并按它换算，拿不到 e1rm 时才回落
 * 到按工作重量取百分比（见下）。
 *
 * ⚠️ 这套规则同时是「AI 生成课程时的处方约定」（见 ai/tools/plan.ts 的
 * warmups 参数说明）。运行时的热身重量以本函数为准，课程里的 warmups
 * 只在拿不到工作重量（无引擎 / 无历史 / 无计划重量）时作回落。
 */

import type { WarmupSet } from '@/types'

/** 最小配重片步进（kg）——热身重量一律取整到它的倍数 */
export const WARMUP_STEP_KG = 2.5

/** 无基线时：≥ 该工作重量按两段处理 */
export const WARMUP_RAMP_MIN_KG = 30

/** 无基线时：≥ 该工作重量配单组，低于则不配 */
export const WARMUP_MIN_KG = 12

/** 有基线时：工作重量 / e1RM ≥ 该比例 → 两段渐进 */
export const WARMUP_RELATIVE_RAMP_RATIO = 0.65

/** 有基线时：工作重量 / e1RM ≥ 该比例 → 单组激活；低于则不配 */
export const WARMUP_RELATIVE_MIN_RATIO = 0.4

/**
 * 轻负荷豁免（kg）：≤ 该工作重量一律不配热身，**不问相对强度**。
 * 理由是「这点负荷对身体几乎没压力，不值得占一组」，与它占 e1RM 的多少无关 ——
 * 10kg 侧平举可能已经是 35% 1RM，但 10kg 就是 10kg。
 */
export const WARMUP_LIGHT_KG = 20

/**
 * 取整到配重步进（至少一个步进）。
 * 非有限数或 ≤0 一律返回 0 = 无法换算（调用方据此判定「没有热身」）。
 */
export function roundToPlate(kg: number, step: number = WARMUP_STEP_KG): number {
  if (!Number.isFinite(kg) || kg <= 0 || !Number.isFinite(step) || step <= 0) return 0
  return Math.max(step, Math.round(kg / step) * step)
}

export interface WarmupOptions {
  /**
   * 该动作当天的估算极限（e1RM）。给了就按**相对强度**判据并把百分比乘在它上面；
   * 不给（新动作 / 换器械 / 无历史）则回落绝对负荷阈值 —— 那恰是热身最该出现的场合，
   * 所以这条回落必须留着，且调用方应据 `usedBaseline` 把口径讲给用户听。
   */
  e1rm?: number | null
}

/** 该处方是按什么口径算出来的（文案要说清，免得界面与代码漂移成两套说法） */
export interface WarmupPrescription {
  sets: WarmupSet[]
  /** true = 按 e1RM 的相对强度算；false = 无基线，按工作重量的绝对阈值回落 */
  usedBaseline: boolean
}

/**
 * 工作重量 → 热身处方。返回空数组 = 该重量不配热身（自重动作 / 负荷过轻 / 相对强度不足）。
 * 输出保证：严格递增，且每一段都 < 工作重量。
 */
export function warmupPrescription(workingKg: number, opts?: WarmupOptions): WarmupSet[] {
  return warmupPlan(workingKg, opts).sets
}

/** 同 [`warmupPrescription`]，但把「用了哪套口径」一并交出来（界面文案要用） */
export function warmupPlan(workingKg: number, opts?: WarmupOptions): WarmupPrescription {
  const w = Number(workingKg)
  if (!Number.isFinite(w) || w <= 0) return { sets: [], usedBaseline: false }
  if (w <= WARMUP_LIGHT_KG) return { sets: [], usedBaseline: false }

  const e1rm = Number(opts?.e1rm ?? 0)
  // e1rm 必须**大于**工作重量：否则「工作重量」本身就是或超过当天极限，
  // 拿它当基线只会把两段都算到工作重量之上，被下面的越界过滤全部剔除。
  const usedBaseline = Number.isFinite(e1rm) && e1rm > w
  const base = usedBaseline ? e1rm : w

  const rampTwo = usedBaseline
    ? w / base >= WARMUP_RELATIVE_RAMP_RATIO
    : w >= WARMUP_RAMP_MIN_KG
  const rampOne = usedBaseline ? w / base >= WARMUP_RELATIVE_MIN_RATIO : w >= WARMUP_MIN_KG

  let out: WarmupSet[] = []
  if (rampTwo) {
    out = [
      { weightKg: roundToPlate(base * 0.5), reps: 8 },
      { weightKg: roundToPlate(base * 0.7), reps: 4 },
    ]
  } else if (rampOne) {
    out = [{ weightKg: roundToPlate(base * 0.5), reps: 12 }]
  }

  // 取整可能把两段压到同一重量（小重量边界）、或压到工作重量本身（相对强度高时
  // 第二段会顶到工作重量）：去重 + 越界剔除
  const seen = new Set<number>()
  const sets = out.filter((d) => {
    if (d.weightKg <= 0 || d.weightKg >= w || seen.has(d.weightKg)) return false
    seen.add(d.weightKg)
    return true
  })
  return { sets, usedBaseline }
}

/**
 * 规则文案（AI 工具与界面共用的一句话）：说清阈值、百分比与取整，
 * 避免界面上写的和代码里算的漂移成两套说法。两套口径都要写出来 ——
 * 只说「按百分比换算」会让「为什么这个动作没有热身」显得没有解释。
 */
export const WARMUP_RULE_TEXT =
  `热身按当天的估算极限（e1RM）换算：工作重量 ≥${WARMUP_RELATIVE_RAMP_RATIO * 100}% 极限时两段渐进（50%×8 + 70%×4），` +
  `≥${WARMUP_RELATIVE_MIN_RATIO * 100}% 时单组激活（50%×12）；` +
  `没有历史估不出极限时回落绝对负荷：≥${WARMUP_RAMP_MIN_KG}kg 两段、≥${WARMUP_MIN_KG}kg 单组；` +
  `≤${WARMUP_LIGHT_KG}kg 的轻负荷一律不配；重量取整到 ${WARMUP_STEP_KG}kg 的倍数，且严格小于工作重量。`
