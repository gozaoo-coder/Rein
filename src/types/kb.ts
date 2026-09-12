/**
 * 知识库与认知层类型 · 与 Rust `modules/kb/models.rs` 对应。
 *
 * 概念上分三层，检索时按需下钻（对应 OpenViking 的 L0/L1/L2）：
 * - L0 摘要：`KbHit.snippet`，列表里判断相关性用
 * - L1 概览：`kbRead(id, 'l1')` 的摘要 + 首块
 * - L2 详情：`kbRead(id, 'l2')` 的全部分块正文
 */

/** 三档检索模式 */
export type KbEmbeddingMode = 'keyword' | 'local' | 'cloud'

/** 可索引的来源类型 */
export type KbSourceType =
  | 'todo'
  | 'todo_attachment'
  | 'workout'
  | 'plan'
  | 'meal'
  | 'body_metric'
  | 'food'
  | 'program'
  | 'program_meal'
  | 'voice_memo'
  | 'chat'
  | 'chat_message'
  | 'chat_attachment'
  | 'memory'
  | 'note'

/** 来源类型的中文短名（设置页与 UI 标签用） */
export const KB_SOURCE_LABELS: Record<KbSourceType, string> = {
  todo: '日程与附件',
  todo_attachment: '待办附件',
  workout: '运动记录',
  plan: '训练课程',
  meal: '饮食记录',
  body_metric: '体测数据',
  food: '自建食物',
  program: '健康方案',
  program_meal: '方案菜单',
  voice_memo: '语音纪要',
  chat: '对话',
  chat_message: '历史聊天',
  chat_attachment: '对话附件',
  memory: '长期记忆',
  note: '笔记',
}

export interface KbSettings {
  embeddingMode: KbEmbeddingMode
  cloudBaseUrl: string | null
  /** 只回尾四位，密钥不回传明文 */
  cloudApiKeyTail: string | null
  cloudModel: string | null
  cloudDim: number | null
  /** 逐类开关，缺省视为开启 */
  sourcesEnabled: Partial<Record<KbSourceType, boolean>>
  autoMemory: boolean
  lastError: string | null
  updatedAt: string
}

export interface KbSettingsInput {
  embeddingMode?: KbEmbeddingMode
  cloudBaseUrl?: string
  cloudApiKey?: string
  cloudModel?: string
  cloudDim?: number
  sourcesEnabled?: Partial<Record<KbSourceType, boolean>>
  autoMemory?: boolean
}

export interface KbProgress {
  phase: 'idle' | 'scanning' | 'chunking' | 'embedding' | 'done' | 'error' | string
  done: number
  total: number
}

export interface KbStatus {
  mode: KbEmbeddingMode
  docs: number
  chunks: number
  vectors: number
  pending: number
  indexing: boolean
  progress: KbProgress
  lastError: string | null
  embedderReady: boolean
  vecModel: string | null
  enabledSources: KbSourceType[]
}

export interface KbHit {
  id: number
  sourceType: KbSourceType
  sourceId: string
  /** 虚拟路径，如「日程/2026-09-10/腿部力量训练-42.md」 */
  path: string | null
  /** true = 可编辑（笔记 / 记忆）；false = 只读派生文档 */
  editable: boolean
  /** 系统文件（规范）不可改不可删 */
  system: boolean
  /** 内容类型：text / image / file / audio */
  kind: 'text' | 'image' | 'file' | 'audio'
  title: string
  /** 命中片段（围绕关键词截取，非全文） */
  snippet: string
  occurredOn: string | null
  tags: string[]
  score: number
  /** 召回路径，便于排查「为什么没搜到」 */
  matched: 'fts' | 'like' | 'fuzzy' | 'vector' | 'hybrid' | 'browse'
}

export interface KbChunk {
  id: number
  ord: number
  text: string
}

export interface KbDocDetail {
  id: number
  sourceType: KbSourceType
  sourceId: string
  path: string | null
  editable: boolean
  system: boolean
  kind: 'text' | 'image' | 'file' | 'audio'
  title: string
  summary: string
  occurredOn: string | null
  tags: string[]
  meta: Record<string, unknown>
  updatedAt: string
  level: 'l1' | 'l2'
  /** 总分块数。l1 只返回首块，据此判断「还有更多」 */
  totalChunks: number
  /** 本次返回的起始块序（分页读取） */
  offset: number
  hasMore: boolean
  chunks: KbChunk[]
}

/* ---------- 真实文件（kb_files，可写） ---------- */

export interface KbFile {
  id: number
  path: string
  content: string
  system: boolean
  createdAt: string
  updatedAt: string
}

export interface KbFileInput {
  path: string
  content: string
}

/** glob 命中：* 不跨目录、** 跨目录、? 单字符 */
export interface KbGlobHit {
  id: number
  path: string
  sourceType: KbSourceType
  title: string
  kind: 'text' | 'image' | 'file' | 'audio'
  editable: boolean
  system: boolean
  occurredOn: string | null
}

/** 检索入参。query 为空表示「浏览最近内容」。 */
export interface KbQuery {
  query: string
  sources?: KbSourceType[]
  from?: string
  to?: string
  tags?: string[]
  limit?: number
}

/* ---------- 记忆层 ---------- */

export type KbMemoryType = 'preference' | 'constraint' | 'event' | 'entity' | 'profile' | 'pattern'

export const KB_MEMORY_LABELS: Record<KbMemoryType, string> = {
  preference: '偏好',
  constraint: '约束',
  event: '事件',
  entity: '实体',
  profile: '画像',
  pattern: '规律',
}

export interface KbMemory {
  id: number
  memType: KbMemoryType
  topic: string
  content: string
  confidence: number
  activeCount: number
  sourceChatId: string | null
  createdAt: string
  updatedAt: string
}

/** 落库一次记忆抽取的变更。op=update/delete 时必须带 id。 */
export interface MemoryCandidate {
  op: 'add' | 'update' | 'delete'
  id?: number
  memType?: KbMemoryType
  topic?: string
  content?: string
  confidence?: number
}

export interface MemoryApplyResult {
  added: number
  updated: number
  deleted: number
  skipped: number
}

/** 喂给系统提示词的紧凑认知块 */
export interface KbCognition {
  memories: KbMemory[]
  text: string
}
