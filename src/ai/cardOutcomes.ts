/**
 * AI 提议卡的处理记录（记录式）：跨页面的 AI 提议被用户采纳 / 放弃时追加一条，
 * 由聊天在下一轮注入给模型 —— 因为「用户刚处理了 AI 的提议」这件事在数据里查不到
 * （结果数据本身可查：目标、待办、饮食、方案调整历史都在库里，缺的是那条因果）。
 *
 * 为什么落 localStorage 而不是 SQLite：它是「给下一轮模型看的一次性信号」，不是用户数据
 * —— 24 小时就过期，与 rein.perf.v1 / foodDrafts 同一类前端工作区状态，也不该进知识库索引。
 *
 * 纯存储模块：提示词文案统一在 @/ai/cardState 渲染，这里只管收（record）与发（list）。
 */

export type CardOutcomeKind =
  /** 智能添加（待办草稿 / 食物卡）写入 */
  | 'smart-add'
  /** 草稿箱（照片/文字识别留下的食物卡）写入 */
  | 'food-draft'
  /** AI 目标调整建议：采用 / 放弃 */
  | 'target-adjust'
  /** 智能排程幽灵块：确认落库 */
  | 'schedule'
  /** 方案复盘建议：逐条采纳应用 */
  | 'program-review'

export interface CardOutcome {
  id: string
  kind: CardOutcomeKind
  /** 写给模型看的一句事实（含具体数值），由调用点拼 */
  text: string
  /** 记录时刻（epoch ms）：注入时按它算「N 分钟前」，并按 TTL 剔除 */
  at: number
}

const KEY = 'rein.aiCards.v1'
/** 注入上限（条）：够覆盖「刚刚做的几件事」即可 */
export const MAX_OUTCOMES = 10
/** 存活时长：超过一天的结果数据模型可用工具查到，事件本身也就不必再提 */
export const OUTCOME_TTL_MS = 24 * 60 * 60 * 1000

let seq = 0

function isOutcome(v: unknown): v is CardOutcome {
  const o = v as CardOutcome | null
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.id === 'string' &&
    typeof o.text === 'string' &&
    typeof o.at === 'number'
  )
}

function alive(list: CardOutcome[], now: number): CardOutcome[] {
  return list.filter((e) => now - e.at < OUTCOME_TTL_MS).slice(0, MAX_OUTCOMES)
}

function read(): CardOutcome[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed.filter(isOutcome) as CardOutcome[]) : []
  } catch {
    return []
  }
}

function write(list: CardOutcome[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_OUTCOMES)))
  } catch {
    /* 配额满 / 隐私模式：这类信号属可丢数据，静默降级为「没有事件」 */
  }
}

/** 记一条（置顶），顺手清掉过期与超限的旧条目 */
export function recordCardOutcome(kind: CardOutcomeKind, text: string): void {
  const t = text.trim()
  if (!t) return
  const now = Date.now()
  const entry: CardOutcome = { id: `co${now.toString(36)}${++seq}`, kind, text: t, at: now }
  write([entry, ...alive(read(), now)])
}

/** 未过期的记录（新 → 旧） */
export function listCardOutcomes(): CardOutcome[] {
  return alive(read(), Date.now())
}
