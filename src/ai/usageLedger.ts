/**
 * 本机成本账本：每轮对话记一条（tokens + 字节 + 模型费 + 流量费）。
 *
 * 为什么要本地再记一份：在线服务那条路服务端有权威账本（`/api/v1/ai/usage`），
 * 但用户自填 key 的模型（BYOK）服务端根本不知道，且离线时也得看得见花了多少。
 * 两边的公式完全一致（见 `cost.ts`），所以能直接对账；UI 会标明本机是估算值。
 *
 * 记账失败绝不能影响对话本身：这里全部吞掉异常，最多少一行账。
 */

import { aiService } from '@/services/aiService'
import type { AiModel } from '@/types'

import { modelCostNano, trafficCostNano } from './cost'

export interface TurnUsage {
  promptTokens: number
  completionTokens: number
}

/** 请求体字节数估算：文本按 UTF-8，图片按 base64 → 原始字节（×3/4） */
export function estimateRequestBytes(text: string, imageBase64: string[] = []): number {
  const textBytes = new TextEncoder().encode(text).length
  const imageBytes = imageBase64.reduce((sum, b64) => sum + Math.floor((b64.length * 3) / 4), 0)
  return textBytes + imageBytes
}

/** 响应体字节数估算：回答文本 + 思考文本 */
export function estimateResponseBytes(...parts: (string | null | undefined)[]): number {
  return parts.reduce((sum, p) => sum + (p ? new TextEncoder().encode(p).length : 0), 0)
}

/** 记一轮：成本按模型单价当场算好，Rust 只负责落库 */
export async function recordTurn(
  model: AiModel,
  usage: TurnUsage,
  bytes: { request: number; response: number },
  note?: string,
): Promise<void> {
  try {
    const costModel = modelCostNano(model, usage.promptTokens, usage.completionTokens)
    const costTraffic = trafficCostNano(model, bytes.response)
    if (costModel === 0 && costTraffic === 0 && !usage.promptTokens && !usage.completionTokens) return
    await aiService.aiUsageRecord({
      modelPk: model.id,
      modelName: model.name,
      modelId: model.modelId,
      provider: model.provider,
      source: model.source,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      requestBytes: bytes.request,
      responseBytes: bytes.response,
      costModelNano: costModel,
      costTrafficNano: costTraffic,
      note: note ?? null,
    })
  } catch {
    /* 记账失败不影响对话 */
  }
}
