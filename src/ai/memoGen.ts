/**
 * 语音纪要整理：转写句 → 单轮 Agent（带应用工具，可查账/查日程）→ 结构化纪要。
 * 输出协议：JSON {kind:'memo', title, reply, items}；
 * items 的 refs 指向转写句编号（驱动引用角标跳转），todo/food 带写入参数。
 */

import type { AiModel } from '@/types'
import { extractJsonObject } from './json'
import { chatWithModel, type ChatStreamHandlers } from './chat'

export interface MemoGenItem {
  kind: 'food' | 'todo' | 'note'
  text: string
  note?: string
  /** 依据的转写句编号（0 起） */
  refs: number[]
  todo?: { title: string; date?: string; startMin?: number | null }
  food?: { name: string; grams?: number }
}

export interface MemoGenResult {
  title: string
  /** 给聊天气泡的 markdown 回复 */
  reply: string
  items: MemoGenItem[]
}

function buildMemoPrompt(lines: { idx: number; text: string }[]): string {
  const body = lines.map((l) => `${l.idx}. ${l.text}`).join('\n')
  return `你是 Rein 健康生活应用的语音纪要整理助手。用户刚像开会一样说完一段话，下面是带编号的逐句转写，请整理成结构化纪要。

【转写】
${body}

【任务】
1. title：8~14 字概括这段话的主旨（给这段录音起名）。
2. items：从转写中提取的结构化条目：
   - kind:"food"：提到吃喝 → text=条目短句，food 字段必填 {name:通用食物名, grams:估计克重数字}，note 可写建议写入哪一餐；
   - kind:"todo"：提到要做的事 → text=待办标题，todo 字段必填 {title, date:"YYYY-MM-DD"（没说日期默认今天）, startMin:分钟数（说了具体时刻才填，如 15:00=900，否则 null）}，note 可写补充；
   - kind:"note"：其他值得记的信息（包括用户问的问题，若能回答在 note 里给出答案）→ text=要点短句；
   - 每条 refs=[依据的句子编号数组]（必填）；忠实原意，不编造转写里没有的信息；无任何可提取内容时 items=[]。
3. reply：给用户看的简短 markdown 回复（要点列表 + 对转写中问题的回答；语气自然）。
涉及应用内数据的问题（如查账、查日程）先调用工具查证再回答，不要编造数字。

【输出】只输出一个 JSON 对象（不要 markdown 围栏、不要解释）：
{"kind":"memo","title":"...","reply":"...","items":[{"kind":"todo","text":"...","note":"...","refs":[1],"todo":{"title":"...","date":"...","startMin":900},"food":null}]}`
}

/** 整理一段纪要（带工具的单轮 Agent）；handlers.onText 收到原始 JSON 流（增量全量） */
export async function generateMemo(
  config: AiModel,
  lines: { idx: number; text: string }[],
  handlers?: Pick<ChatStreamHandlers, 'onText' | 'onThinking'>,
): Promise<MemoGenResult> {
  const r = await chatWithModel(
    config,
    [],
    { text: '（请整理上方转写为纪要）' },
    handlers,
    { systemPrompt: buildMemoPrompt(lines) },
  )
  let body: unknown
  try {
    body = extractJsonObject(r.text)
  } catch {
    // 非 JSON 输出：整段当 reply，无结构化条目
    return { title: (r.text.replace(/\s+/g, ' ').slice(0, 12) || '语音纪要'), reply: r.text, items: [] }
  }
  const o = body as { kind?: unknown; title?: unknown; reply?: unknown; items?: unknown }
  if (!o || o.kind !== 'memo') {
    throw new Error('纪要输出协议不符')
  }
  const items: MemoGenItem[] = Array.isArray(o.items)
    ? (o.items as unknown[])
        .map((raw): MemoGenItem | null => {
          if (typeof raw !== 'object' || raw === null) return null
          const it = raw as Record<string, unknown>
          const kind = it.kind === 'food' || it.kind === 'todo' ? it.kind : 'note'
          const text = typeof it.text === 'string' ? it.text.trim() : ''
          if (!text) return null
          const refs = Array.isArray(it.refs)
            ? (it.refs as unknown[]).filter((n): n is number => typeof n === 'number')
            : []
          const todoRaw = it.todo as Record<string, unknown> | null | undefined
          const foodRaw = it.food as Record<string, unknown> | null | undefined
          return {
            kind,
            text,
            note: typeof it.note === 'string' ? it.note : undefined,
            refs,
            todo:
              kind === 'todo' && todoRaw && typeof todoRaw.title === 'string'
                ? {
                    title: todoRaw.title,
                    date: typeof todoRaw.date === 'string' ? todoRaw.date : undefined,
                    startMin: typeof todoRaw.startMin === 'number' ? todoRaw.startMin : null,
                  }
                : undefined,
            food:
              kind === 'food' && foodRaw && typeof foodRaw.name === 'string'
                ? { name: foodRaw.name, grams: typeof foodRaw.grams === 'number' ? foodRaw.grams : undefined }
                : undefined,
          }
        })
        .filter((x): x is MemoGenItem => x !== null)
    : []
  return {
    title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : '语音纪要',
    reply: typeof o.reply === 'string' && o.reply.trim() ? o.reply : '纪要已生成。',
    items,
  }
}
