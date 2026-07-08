/**
 * AI 聊天相关类型
 * - 配置 (AiConfig)
 * - 消息与多模态内容 (ChatMessage / MessageContent)
 * - 工具调用反馈 (ToolCall / ToolResult)
 * - 引用 (Citation)
 */

export interface AiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 模型是否支持图片输入（视觉模态） */
  vision: boolean;
  /** 用户允许 AI 自动执行工具（true）或仅返回建议（false） */
  autoExecute: boolean;
}

export interface ModelInfo {
  id: string;
  /** 推测的能力：vision / text 等 */
  capabilities?: string[];
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ContentPartType = "text" | "image_url";

export interface ImageUrl {
  url: string; // data: URL 或 http(s) URL
  detail?: "auto" | "low" | "high";
}

export interface ContentPart {
  type: ContentPartType;
  text?: string;
  image_url?: ImageUrl;
}

export type MessageContent = string | ContentPart[];

/** 工具调用请求（assistant 发起） */
export interface ToolCall {
  id: string;
  /** 工具名，例如 course.create / exercise.update */
  name: string;
  /** 序列化的 JSON 参数 */
  arguments: string;
}

/** 工具调用结果（tool 角色 message） */
export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string; // 序列化 JSON
  ok: boolean;
  /** 简短摘要，用于卡片显示 */
  summary?: string;
  /** 卡片渲染类型 */
  card?:
    | "course"
    | "course-list"
    | "exercise"
    | "exercise-list"
    | "stats"
    | "raw";
  /** 卡片渲染数据 */
  cardData?: unknown;
}

/** 引用上文 / 历史消息 / 历史会话 */
export interface Citation {
  type: "message" | "conversation";
  /** 被引用的消息 id 或会话 id */
  refId: string;
  /** 显示用的摘要文本 */
  snippet: string;
  /** 来源会话名（引用历史会话时） */
  fromTitle?: string;
  /** 时间戳 */
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: MessageContent;
  timestamp: number;
  /** assistant 消息附带的工具调用 */
  toolCalls?: ToolCall[];
  /** tool 角色消息对应的工具调用 id */
  toolCallId?: string;
  /** name 字段（tool 角色消息） */
  name?: string;
  /** 用户消息附带的引用 */
  citations?: Citation[];
  /** 该消息关联的工具结果（用于在 assistant 消息下方渲染卡片） */
  toolResults?: ToolResult[];
  /** 是否正在生成中 */
  pending?: boolean;
  /** 错误信息（发送失败等） */
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** 是否已固定 */
  pinned?: boolean;
}
