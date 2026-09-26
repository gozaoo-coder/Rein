/**
 * 卡片状态块：把「用户对 AI 出的卡 / 提议做了什么」写成一段注入系统提示词的文本。
 *
 * 为什么需要它：回灌给模型的历史只挑 text/analysis/voice/photo/doc（stores/ai.ts::sendText），
 * 卡片本身（食物卡 / 语音纪要卡）与工具过程被整体丢弃 —— 模型对「用户确认了没有、最终写了什么」
 * 一无所知，于是会「用户已经确认了饮食，它还按没记录继续聊、甚至再出一张卡」。
 *
 * 两条来源，一段注入：
 *  ① **派生**：聊天里的卡（食物卡、语音纪要卡）——状态从既有数据现算，不额外记录；
 *  ② **记录**：跨页面的 AI 提议（智能添加 / 目标建议 / 智能排程 / 方案复盘）——结果数据虽然
 *     可用工具查到，但「用户刚采纳了这条提议」查不到，所以由调用点在动作发生时记一条
 *     （@/ai/cardOutcomes）。渲染只有这一份实现：调用点只记录事实，文案在这里统一拼。
 *
 * 纯函数：无 IPC、不认识 store，输入只有数据（与 utils/trainingAdvice 同约定）。
 */

import { MEAL_LABELS } from '@/config/domain'
import type { AiMessage, ParsedFoodItem, VoiceMemo } from '@/types'
import { MAX_OUTCOMES, type CardOutcome } from './cardOutcomes'

/** 最多列出几张食物卡（更早的只报数量）：卡片是低频事件，6 张足够覆盖「刚发生的事」 */
const MAX_CARDS = 6
/** 最多列出几条纪要（聊天里可能录了好几段） */
export const MAX_MEMOS = 3
/** 每条纪要最多点名几个条目，其余折成「等 N 条」 */
const MAX_MEMO_ITEMS = 3
/** 条目文本在提示词里的截断长度 */
const ITEM_TEXT_MAX = 24

export interface CardStateInput {
  /** 本会话消息（食物卡状态现算） */
  messages: AiMessage[]
  /** 本会话引用过的纪要（含 written 写入状态）；由调用方按需拉取，没拉就传空数组 */
  memos?: VoiceMemo[]
  /** 跨页 AI 提议的处理记录（新 → 旧）；空数组即整段不出现 */
  outcomes?: CardOutcome[]
  /** 注入时刻（测试可注入固定值） */
  now?: number
}

/** 条目签名：名称 + 克重。用来判断用户改没改过模型给的那一版（不比对估算热量：它只是显示值） */
function itemSig(items: { foodName: string; grams: number }[]): string {
  return items.map((i) => `${i.foodName}:${i.grams}`).join('|')
}

function entryText(it: ParsedFoodItem): string {
  return `${it.foodName} ${it.grams}g${it.kcalEstimate > 0 ? ` ≈ ${it.kcalEstimate} 大卡` : ''}`
}

function clip(text: string, max = ITEM_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 食物卡行（本会话现算） */
function foodCardLines(messages: AiMessage[]): string[] {
  const cards = messages.filter((m) => m.kind === 'food-parse' && m.items?.length)
  if (cards.length === 0) return []
  const shown = cards.slice(-MAX_CARDS)
  const omitted = cards.length - shown.length
  const lines = shown.map((m, i) => {
    const no = omitted + i + 1
    const entries = (m.items ?? []).map(entryText).join('、')
    if (!m.committed) {
      return `- 食物卡 ${no}：未确认 —— ${entries}。用户没有处理它就直接继续了对话：这不代表已记录、也不代表拒绝；不要重复出这张卡、不要假定它已入库、也不要追问，等用户重新提到相关食物再处理。`
    }
    const edited = m.proposal?.length ? itemSig(m.proposal) !== itemSig(m.items ?? []) : false
    const meal = m.mealType ? `今日${MEAL_LABELS[m.mealType]}` : '今日饮食'
    return `- 食物卡 ${no}：已确认写入${meal}${edited ? '（用户修改后确认）' : ''} —— ${entries}。以这里写入的数值为准，不要重复记录、不要重复出卡。`
  })
  if (omitted > 0) lines.push(`（更早的 ${omitted} 张食物卡已省略）`)
  return lines
}

/** 纪要行：只报「能被写入待办/饮食」的条目（note 是记录而不是待办事项），一条都没有就整条不说 */
function memoLines(memos: VoiceMemo[]): string[] {
  const actionable = (m: VoiceMemo) =>
    m.summary.filter((it) => (it.kind === 'todo' && it.todo) || (it.kind === 'food' && it.food))
  return memos
    .slice(0, MAX_MEMOS)
    .filter((m) => actionable(m).length > 0)
    .map((m) => {
      const items = actionable(m)
      const written = items.filter((it) => it.written)
      const unwritten = items.filter((it) => !it.written)
      const names = (list: typeof items) =>
        `${list
          .slice(0, MAX_MEMO_ITEMS)
          .map((it) => `${it.kind === 'todo' ? '待办' : '饮食'}「${clip(it.text)}」`)
          .join('、')}${list.length > MAX_MEMO_ITEMS ? ` 等 ${list.length} 条` : ''}`
      const parts: string[] = [`共 ${m.summary.length} 条总结`]
      if (written.length) parts.push(`已写入 ${written.length} 条 —— ${names(written)}`)
      if (unwritten.length) parts.push(`未写入 ${unwritten.length} 条 —— ${names(unwritten)}`)
      const tail = unwritten.length
        ? '未写入的条目还没进待办/饮食，别当成已记录，也不要反过来催用户去写。'
        : '纪要里的可写入条目都已经落库，不要重复创建。'
      return `- 语音纪要《${clip(m.title, 16)}》：${parts.join('；')}。${tail}`
    })
}

/** 「12 分钟前」这类相对时间：TTL 只有 24 小时，所以不做日期格式 */
function agoText(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000)
  if (min < 2) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 跨页提议卡的处理记录行（记录式，@/ai/cardOutcomes） */
function outcomeLines(outcomes: CardOutcome[], now: number): string[] {
  return outcomes
    .slice(0, MAX_OUTCOMES)
    .map((e) => `- ${agoText(e.at, now)}：${e.text}`)
}

/**
 * 生成注入块；三部分都为空时返回空串（整段不出现，零开销）。
 * 段落名与提示词【分寸】里那句说明是一对，改名要一起改。
 */
export function buildCardStateBlock(input: CardStateInput): string {
  const now = input.now ?? Date.now()
  const cards = [...foodCardLines(input.messages), ...memoLines(input.memos ?? [])]
  const outcomes = outcomeLines(input.outcomes ?? [], now)
  if (cards.length === 0 && outcomes.length === 0) return ''

  const parts: string[] = []
  if (cards.length > 0) {
    parts.push(
      `【卡片状态】你在本会话里出过的卡与用户对它们的处理，这是最新事实（与你的记忆冲突时以此为准；未确认 ≠ 已记录）：\n${cards.join('\n')}`,
    )
  }
  if (outcomes.length > 0) {
    parts.push(
      `【AI 提议处理记录】用户在其他页面处理过的 AI 提议（结果数据可用工具查询，这里只给「刚发生了什么」）：\n${outcomes.join('\n')}`,
    )
  }
  return `\n${parts.join('\n')}\n`
}
