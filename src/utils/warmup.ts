/**
 * 激活热身处方（纯函数，无 IPC、不落库）：把「正式组重量」换算成热身组。
 *
 * 为什么按重量换算而不是写死在课程里：热身的目的不是训练容量，而是
 *  ① 唤醒目标肌群与神经通路；② 预演动作模式；③ 降低大重量下的受伤风险。
 * 因此热身强度必须**跟着当天的工作重量走** —— 今天建议 65kg，热身就该是
 * 32.5 / 50kg，而不是课程里写死的 30 / 45kg（那是按 60kg 编的）。
 *
 * 科学依据（写在代码里便于复核与调整）：
 *  - 热身强度取工作组的 **40%–75% 1RM** 区间。低于 ~40% 只产生局部升温，
 *    对后续表现无增益；高于 ~80% 则开始累积疲劳，反而压低工作组的正式输出。
 *    （DeRenne 等 1996 热身负荷研究；NSCA《Essentials of Strength Training
 *    and Conditioning》渐进热身章节）
 *  - 复合动作（本库以 ≥30kg 界定）两段渐进：50% × 8 建立动作模式 →
 *    75% × 4 在低次数下预演接近工作组的负荷（次数少 = 离力竭远，不产生实质疲劳）。
 *  - 单关节 / 中等重量（12–30kg）一段 50% × 12 已足够唤醒，多一段只是拖时间。
 *  - < 12kg 相对负荷很低，热身的收益小于占用的时间，不配。
 *  - 重量取整到 2.5kg：大多数健身房最小配重片步进（哑铃常见 2.5kg 一档）；
 *    并保证**严格小于**工作重量（否则「热身＝正式组」，语义不成立）。
 *
 * ⚠️ 这套规则同时是「AI 生成课程时的处方约定」（见 ai/tools/plan.ts 的
 * warmups 参数说明）。运行时的热身重量以本函数为准，课程里的 warmups
 * 只在拿不到工作重量（无引擎 / 无历史 / 无计划重量）时作回落。
 */

import type { WarmupSet } from '@/types'

/** 最小配重片步进（kg）——热身重量一律取整到它的倍数 */
export const WARMUP_STEP_KG = 2.5

/** 两段 ramp 的下限：≥ 该值按复合动作处理 */
export const WARMUP_RAMP_MIN_KG = 30

/** 配一组激活的下限：≥ 该值配单组，低于则不配 */
export const WARMUP_MIN_KG = 12

/**
 * 取整到配重步进（至少一个步进）。
 * 非有限数或 ≤0 一律返回 0 = 无法换算（调用方据此判定「没有热身」）。
 */
export function roundToPlate(kg: number, step: number = WARMUP_STEP_KG): number {
  if (!Number.isFinite(kg) || kg <= 0 || !Number.isFinite(step) || step <= 0) return 0
  return Math.max(step, Math.round(kg / step) * step)
}

/**
 * 工作重量 → 热身处方。返回空数组 = 该重量不配热身（自重动作或负荷过轻）。
 * 输出保证：严格递增，且每一段都 < 工作重量。
 */
export function warmupPrescription(workingKg: number): WarmupSet[] {
  const w = Number(workingKg)
  if (!Number.isFinite(w) || w <= 0) return []

  let out: WarmupSet[] = []
  if (w >= WARMUP_RAMP_MIN_KG) {
    out = [
      { weightKg: roundToPlate(w * 0.5), reps: 8 },
      { weightKg: roundToPlate(w * 0.75), reps: 4 },
    ]
  } else if (w >= WARMUP_MIN_KG) {
    out = [{ weightKg: roundToPlate(w * 0.5), reps: 12 }]
  }

  // 取整可能把两段压到同一重量（小重量边界）或压到工作重量本身：去重 + 越界剔除
  const seen = new Set<number>()
  return out.filter((d) => {
    if (d.weightKg <= 0 || d.weightKg >= w || seen.has(d.weightKg)) return false
    seen.add(d.weightKg)
    return true
  })
}

/**
 * 规则文案（AI 工具与界面共用的一句话）：说清阈值、百分比与取整，
 * 避免界面上写的和代码里算的漂移成两套说法。
 */
export const WARMUP_RULE_TEXT =
  `热身重量按当天工作重量的百分比换算：≥${WARMUP_RAMP_MIN_KG}kg 两段渐进（50%×8 + 75%×4），` +
  `${WARMUP_MIN_KG}~${WARMUP_RAMP_MIN_KG}kg 单组激活（50%×12），<${WARMUP_MIN_KG}kg 不配；` +
  `重量取整到 ${WARMUP_STEP_KG}kg 的倍数，且严格小于工作重量。`
