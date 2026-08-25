/**
 * 模型能力探测：全部以 max_tokens=1 的最小请求验证
 * ① 基础连通 ② 多模态（图片上传） ③ thinking 开关 ④ effort 开关。
 *
 * 判定规则（按 DeepSeek 文档实测）：
 * - 请求成功（200/流结束）＝该能力支持；
 * - 400 错误消息含 "does not support image" 等 ＝ 明确不支持；
 * - 错误消息仅抱怨 token 预算（thinking 开启时 max_tokens=1 过小）＝
 *   参数已被接受，视为支持（原文会写入 lastError 供人工复核）；
 * - 认证/网络类错误 ＝ 中止整轮探测，不能得出能力结论（结果置 null）。
 */

import type { AssistantMessage, ImageContent, TextContent, ThinkingLevel } from '@earendil-works/pi-ai'

import type { AiModel, AiProbeResult } from '@/types'
import { buildRuntime } from './runtime'

/** 1×1 透明 PNG，图片探测的最小载荷 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type Classify = 'ok' | 'unsupported' | 'auth' | 'budget' | 'unknown'

/**
 * pi-ai 的 ThinkingLevel 不含 'off'（运行时却接受：off → 不发 reasoning_effort），
 * 探测需要显式发送 thinking disabled，所以这里用扩展类型再转换。
 */
type ProbeReasoning = 'off' | 'low' | 'high'

function asThinkingLevel(v: ProbeReasoning): ThinkingLevel {
  return v as unknown as ThinkingLevel
}

function classify(err: string): Classify {
  const e = err.toLowerCase()
  if (/(unauthorized|authentication|invalid (api )?key|401|403|forbidden|api key incorrect)/.test(e)) return 'auth'
  if (/(not support|doesn'?t support|unsupported|not supported|cannot accept|仅支持文字|不支持)/.test(e)) return 'unsupported'
  if (/(token|max_tokens|budget|字数|长度).*(insufficient|minimum|too small|too few|limited|exceed)|(insufficient|too small|too few|minimum).*(token|max_tokens)/.test(e)) return 'budget'
  return 'unknown'
}

interface Outcome {
  ok: boolean
  err: string
  cls: Classify
}

async function probeOnce(
  config: AiModel,
  content: string | (TextContent | ImageContent)[],
  options?: { reasoning?: ProbeReasoning },
): Promise<Outcome> {
  const { models, byId } = buildRuntime([config])
  const entry = byId.get(config.id)
  if (!entry) {
    return { ok: false, err: '模型运行时构建失败', cls: 'unknown' }
  }
  try {
    const result = (await models.completeSimple(
      entry.model,
      { messages: [{ role: 'user', content, timestamp: Date.now() }] },
      {
        apiKey: config.apiKey,
        maxTokens: 1,
        timeoutMs: 30_000,
        ...(options?.reasoning ? { reasoning: asThinkingLevel(options.reasoning) } : {}),
      },
    )) as AssistantMessage
    if (result.stopReason === 'error') {
      const msg = result.errorMessage ?? '请求失败'
      return { ok: false, err: msg, cls: classify(msg) }
    }
    return { ok: true, err: '', cls: 'ok' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, err: msg, cls: classify(msg) }
  }
}

/**
 * 合并某能力的探测结果（1~2 次请求）：
 * - 任何 auth 错误 → 中止整轮（结果 null，由调用方返回）
 * - 任何 unsupported → 明确不支持（false）
 * - 全部成功 → 支持（true）
 * - 全部为 token 预算抱怨（参数已接受）→ 视为支持（true，附注原文）
 * - 其余（网络超时等未知错误）→ 结论未知（null，附注原文）
 */
function capability(outs: Outcome[]): { value: boolean | null; abort: boolean; notes: string[] } {
  const notes: string[] = []
  for (const o of outs) {
    if (o.cls === 'auth') return { value: null, abort: true, notes: [o.err] }
    if (o.cls === 'unsupported') return { value: false, abort: false, notes: [o.err] }
    if (o.cls === 'budget') notes.push(`参数已接受（预算报错）：${o.err}`)
    if (o.cls === 'unknown') notes.push(o.err)
  }
  if (outs.length > 0 && outs.every((o) => o.cls === 'ok')) return { value: true, abort: false, notes }
  if (outs.length > 0 && outs.every((o) => o.cls === 'budget')) return { value: true, abort: false, notes }
  return { value: null, abort: false, notes }
}

/** 执行整轮探测（6 个 max_tokens=1 请求） */
export async function probeModel(config: AiModel): Promise<AiProbeResult> {
  // ① 基础连通（纯文本）
  const text = await probeOnce(config, 'hi')
  if (!text.ok && text.cls === 'auth') {
    return { vision: null, thinking: null, effort: null, error: text.err }
  }

  // ② 多模态：文本 + 1×1 图片
  const vision = await probeOnce(config, [
    { type: 'text', text: '说明这张图片里有什么' },
    { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
  ])

  // ③ thinking 开关（enabled / disabled 各一次）
  const thinkOn = await probeOnce(config, 'hi', { reasoning: 'high' })
  const thinkOff = await probeOnce(config, 'hi', { reasoning: 'off' })

  // ④ effort 档位（low / high 各一次）
  const effortLow = await probeOnce(config, 'hi', { reasoning: 'low' })
  const effortHigh = await probeOnce(config, 'hi', { reasoning: 'high' })

  const capVision = capability([vision])
  const capThinking = capability([thinkOn, thinkOff])
  const capEffort = capability([effortLow, effortHigh])

  if (capVision.abort || capThinking.abort || capEffort.abort) {
    const err = [capVision.notes, capThinking.notes, capEffort.notes].flat().find(Boolean)
    return { vision: null, thinking: null, effort: null, error: err ?? '认证失败' }
  }

  const notes = [
    ...capVision.notes,
    ...capThinking.notes,
    ...capEffort.notes,
  ].join('\n')

  return {
    vision: capVision.value,
    thinking: capThinking.value,
    effort: capEffort.value,
    error: notes ? notes.slice(0, 500) : null,
  }
}
