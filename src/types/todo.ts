/** 待办域类型 · 与 Rust `modules/todo` 对应 */

export const TODO_CATEGORIES = ['general', 'workout', 'health', 'study', 'work'] as const
export type TodoCategory = (typeof TODO_CATEGORIES)[number]

export type TodoStatus = 'todo' | 'doing' | 'done'

/** 重复规则：模板行持有，实例按 recKey = "模板id:日期" 物化（与 Rust RecRule 对应） */
export interface RecRule {
  /** daily = 每天 / weekly = 每周选中星期 / interval = 每 N 天 */
  freq: 'daily' | 'weekly' | 'interval'
  /** weekly 专用：周一=0 … 周日=6 */
  weekdays: number[]
  /** interval 专用：每 N 天 */
  intervalDays: number
  /** 结束日期（含），null = 永不 */
  endDate: string | null
}

export interface TodoSubtask {
  title: string
  done: boolean
}

/** 附件种类：文字标记 / 文件 / 图片 / 音频 */
export type TodoAttachmentKind = 'text' | 'file' | 'image' | 'audio'

/**
 * 待办附件与标记：文字正文内联；文件/图片/音频存 data URL（本地个人应用，量级可控）。
 * 重复实例不继承模板附件（按次记录）。
 */
export interface TodoAttachment {
  kind: TodoAttachmentKind
  name: string
  /** text = 正文；其余 = data URL */
  content?: string
  /** 字节数（file/image/audio），用于展示与超限校验 */
  size?: number
  createdAt: string
}

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
  /** 来源健康方案的 id；null = 用户手动创建。方案重排/删除按它清理 */
  programId: number | null
  /** 重复规则；null = 不重复。模板行自身即首日实例 */
  recRule: RecRule | null
  /** 重复实例键 "模板id:日期"；null = 非实例 */
  recKey: string | null
  /** 子任务清单；null/空 = 无 */
  subtasks: TodoSubtask[] | null
  /** 附件/标记；null/空 = 无。重复实例不继承 */
  attachments?: TodoAttachment[] | null
}

export interface TodoInput {
  title: string
  notes?: string | null
  date?: string | null
  startMin?: number | null
  durationMin?: number | null
  category?: TodoCategory
  priority?: number
  recRule?: RecRule | null
  subtasks?: TodoSubtask[] | null
  attachments?: TodoAttachment[] | null
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
