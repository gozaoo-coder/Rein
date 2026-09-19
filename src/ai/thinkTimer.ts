/**
 * thinkTimer —— 推理思考时长的数据层累计（照搬 EffiBuddy 同名模块）
 *
 * 背景：ProcessSection 的「思考中 X 秒」曾把累计时长放在组件内部 ref，
 * 组件一旦因虚拟列表窗口移动 / 页签切换等原因卸载重建，累计值即清零。
 * 本模块把累计状态提升到数据层（随消息常驻），用时间戳累计：
 *
 * - thinkingSec       ：已完成思考段的累计秒数（跨段累加，随记录持久）
 * - thinkingStartedAt ：当前思考段的开始时间戳（null = 未在思考）
 *
 * markThinkingStart / markThinkingEnd 幂等：重复调用不重复计段，
 * 即使在组件卸载期间思考仍在进行，结束时也能按真实时间戳累计完整时长。
 */

export interface ThinkTrack {
  isThinking: boolean
  thinkingSec: number
  thinkingStartedAt: number | null
}

/** 标记思考开始：仅在该段尚未开始时记录时间戳，避免重复计数 */
export function markThinkingStart(t: ThinkTrack): void {
  if (!t.isThinking) {
    t.thinkingStartedAt = Date.now()
    t.isThinking = true
  }
}

/** 标记思考结束：把本段实际耗时（按真实时间戳）累加进 thinkingSec */
export function markThinkingEnd(t: ThinkTrack): void {
  if (!t.isThinking) return
  if (t.thinkingStartedAt) {
    t.thinkingSec += Math.max(1, Math.round((Date.now() - t.thinkingStartedAt) / 1000))
  }
  t.isThinking = false
  t.thinkingStartedAt = null
}
