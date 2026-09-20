/**
 * 成本口径 · 与 `server/src/ai.mjs` 的 `costOf()` 一一对应。
 *
 * 金额一律用**纳元（1e-9 元）整数**结算：单次请求的出方向流量费常在 1e-7 元量级，
 * 用分或微元逐笔取整会被抹成 0，「服务器流量 0.8 元/GB」就永远显示不出来。
 *
 * 公式（两端一致）：
 *   tokenCost   = promptTokens/1e6*priceIn + completionTokens/1e6*priceOut
 *   trafficCost = 出方向字节 / 1e9 * trafficPerGb
 *   total       = tokenCost + trafficCost
 *
 * 模型价与官方同价（服务端下发，不溢价）；流量默认只算出方向，与云厂商按流量计费一致。
 */

import type { AiModel } from '@/types'

/** 元 → 纳元倍数 */
export const NANO_PER_YUAN = 1e9

/** 模型费（纳元）：tokens × (元/百万 tokens) → 元 → 纳元，系数正好是 ×1000 */
export function modelCostNano(model: AiModel, promptTokens: number, completionTokens: number): number {
  const priceIn = model.priceIn ?? 0
  const priceOut = model.priceOut ?? 0
  if (!priceIn && !priceOut) return 0
  return Math.round((promptTokens * priceIn + completionTokens * priceOut) * 1000)
}

/** 流量费（纳元）：bytes/1e9 GB × 元/GB × 1e9 → 系数正好是 ×perGb */
export function trafficCostNano(model: AiModel, bytes: number): number {
  const perGb = model.trafficPerGb ?? 0
  if (!perGb || bytes <= 0) return 0
  return Math.round(bytes * perGb)
}

/** 展示用：0 / <0.0001 / 四位小数（¥0.0123） */
export function formatCnyNano(nano: number): string {
  const yuan = (nano || 0) / NANO_PER_YUAN
  if (yuan === 0) return '¥0'
  if (Math.abs(yuan) < 0.0001) return '¥<0.0001'
  return `¥${yuan.toFixed(4)}`
}

/** 展示用：单价（元/百万 tokens）；未定价回 null（UI 显示「未定价」） */
export function formatUnitPrice(model: AiModel): string | null {
  if (!model.priceIn && !model.priceOut) return null
  const fmt = (v: number | null) => (v && v > 0 ? `¥${Number(v.toFixed(2))}` : '—')
  return `入 ${fmt(model.priceIn)} / 出 ${fmt(model.priceOut)} 每百万 tokens`
}
