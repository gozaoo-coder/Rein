/** 待办域类型 · 与 Rust `modules/todo` 对应 */

export const TODO_CATEGORIES = ['general', 'workout', 'health', 'study', 'work'] as const
export type TodoCategory = (typeof TODO_CATEGORIES)[number]

export type TodoStatus = 'todo' | 'doing' | 'done'

export interface Todo {
  id: number
  title: string
  notes: string | null
  /** 计划日期，null = 无日期（收件箱） */
  date: string | null
  /** 开始时间，距 00:00 的分钟数；有值的待办会出现在日时间线里 */
  startMin: number | null
  durationMin: number | null
  category: TodoCategory
  priority: number
  status: TodoStatus
  completedAt: string | null
  createdAt: string
}

export interface TodoInput {
  title: string
  notes?: string | null
  date?: string | null
  startMin?: number | null
  durationMin?: number | null
  category?: TodoCategory
  priority?: number
}

/**
 * 待办草稿：AI 解析生成、待用户确认添加。
 * key 为前端临时标识；确认添加或经编辑器落库后置 added。
 */
export interface TodoDraft {
  key: string
  title: string
  notes: string | null
  date: string
  startMin: number | null
  durationMin: number | null
  category: TodoCategory
  priority: number
  /** 是否勾选待批量添加 */
  checked: boolean
  /** 已单独保存（经编辑器调整后落库） */
  added: boolean
}
