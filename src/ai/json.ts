import type { AgentFinalMessage } from '@/types'

/** pi-ai Agent 输出解析公共工具：从消息流取最后一条 assistant 文本，并从中抽出 JSON 数组。 */

/** 与 Agent 原始输出解析（包装 JSON 提取与容错）无关，仅取文本 */
export function lastAssistantText(messages: AgentFinalMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content)
        ? (m.content as { type?: string; text?: string }[])
        : []
      return blocks
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('')
    }
  }
  return ''
}

/** 从模型输出中抽出 JSON 数组（容忍 ```json 围栏与前后废话） */
export function extractJsonArray(raw: string): unknown {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('模型输出中没有找到 JSON 数组')
  }
  return JSON.parse(raw.slice(start, end + 1))
}

/** 从模型输出中抽出 JSON 对象（智能添加/聊天共用；容忍围栏与前后废话） */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('模型输出中没有找到 JSON 对象')
  }
  return JSON.parse(raw.slice(start, end + 1))
}
