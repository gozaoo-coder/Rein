/** 提供商/模型列表的纯函数小工具：类别文案、昵称解析、角色引用编解码、分组。
 *
 * 这些逻辑被「服务模型卡 / 选择抽屉 / 提供商抽屉 / 全部模型抽屉 / AI 工具」共用，
 * 所以集中在这里而不是散在各组件里 —— 尤其是**昵称解析与分组**，它们直接对应
 * 用户要的渲染声明（provider name display / folder）。
 */

import type { AiProvider, ProviderAdapter, ProviderModelKind, ProviderModelMeta } from '@/types'

/** 类别中文名（UI 与工具结果共用一套说法） */
export const KIND_LABEL: Record<ProviderModelKind, string> = {
  llm: '对话',
  vision: '视觉',
  asr: '语音识别',
  embedding: '向量',
  tts: '语音合成',
}

/** 类别短说明（选择抽屉与提供商抽屉里的副标题） */
export const KIND_HINT: Record<ProviderModelKind, string> = {
  llm: '主对话模型：聊天、生成、总结都用它',
  vision: '看图：拍照识别、图片理解（主模型没有视觉能力时启用）',
  asr: '语音识别：语音对话与纪要转写',
  embedding: '向量：知识库与长期记忆的语义检索',
  tts: '语音合成：朗读纪要',
}

/** 非适配器来源的 provider 字段 → 中文昵称 */
const BUILTIN_NICKNAMES: Record<string, string> = {
  'rein-online': 'Rein 在线服务',
  'openai-compatible': '自定义',
  manual: '手动添加',
}

/** provider 字段（ai_models.provider 或适配器 id）→ 展示昵称 */
export function providerNickname(provider: string, adapters: ProviderAdapter[]): string {
  const id = (provider || '').trim()
  if (!id) return BUILTIN_NICKNAMES.manual!
  return (
    adapters.find((a) => a.id === id)?.nickname ??
    BUILTIN_NICKNAMES[id] ??
    id
  )
}

/** 模型显示名：`provider name display = true` 时前缀提供商昵称 */
export function modelDisplayName(name: string, provider: string, display: boolean): string {
  const nick = (provider || '').trim()
  if (!display || !nick) return name
  return `${nick} · ${name}`
}

export interface ProviderGroup<T> {
  /** 分组名（folder = false 时为空串，表示不分组的整段） */
  provider: string
  items: T[]
}

/** 按提供商分组：`provider name folder = true` 时给出多组，否则单组 */
export function groupByProvider<T>(
  items: T[],
  providerOf: (item: T) => string,
  folder: boolean,
): ProviderGroup<T>[] {
  if (!folder) return [{ provider: '', items }]
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = providerOf(item) || BUILTIN_NICKNAMES.manual!
    const arr = map.get(key)
    if (arr) arr.push(item)
    else map.set(key, [item])
  }
  return [...map.entries()].map(([provider, items]) => ({ provider, items }))
}

/** 目录行的元信息 JSON → 对象（坏了当空） */
export function parseModelMeta(meta: string | null): ProviderModelMeta {
  if (!meta) return {}
  try {
    const v = JSON.parse(meta) as ProviderModelMeta
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** 该提供商下按类别分好的模型（提供商卡片的「3 对话 · 1 向量」摘要用） */
export function kindCounts(p: AiProvider): { kind: ProviderModelKind; count: number }[] {
  const map = new Map<ProviderModelKind, number>()
  for (const m of p.models) map.set(m.kind, (map.get(m.kind) ?? 0) + 1)
  return [...map.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count)
}

/** 角色引用编解码：`scheme:a:b`（b 里可能还有冒号，所以只切前两段） */
export function encodeRef(scheme: string, a = '', b = ''): string {
  return b ? `${scheme}:${a}:${b}` : a ? `${scheme}:${a}` : scheme
}

export function parseRef(ref: string): { scheme: string; a: string; b: string } {
  const parts = (ref || '').split(':')
  return { scheme: parts[0] ?? '', a: parts[1] ?? '', b: parts.slice(2).join(':') }
}
