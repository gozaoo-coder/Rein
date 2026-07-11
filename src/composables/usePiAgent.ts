/**
 * usePiAgent — 把 pi-agent-core 的 Agent 包装为对 ChatMessage[] 友好的接口。
 *
 * 职责：
 * - 由 aiConfigStore 构造 Agent 实例（model + tools + systemPrompt + streamFn）
 * - 把当前 Conversation.messages 转换为 pi AgentMessage[] 同步到 agent.state
 * - 订阅 Agent 事件，把流式更新映射回 ChatMessage[]（pending / 内容增量 / 工具结果）
 * - 暴露 runPrompt(text, images, citations) 供 aiChatStore 调用
 */
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ImageContent,
  ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";
import { getModelsCollection, resolvePiModel, registerCustomProvider } from "@/composables/usePiProvider";
import { PI_TOOLS, PI_TOOLS_CORE, PI_TOOLS_POMODORO, type PiToolDetails } from "@/composables/usePiTools";
import { buildSystemPrompt, type WorkoutPromptContext, type PomodoroPromptContext } from "@/data/aiPrompt";
import type {
  ChatMessage,
  Citation,
  FileAttachment,
  MessageContent,
  ToolResult,
  ToolCall,
  Conversation,
} from "@/types/ai";

function genId(prefix = "msg"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把附件列表转为给模型的纯文本注记（模型不直接消费二进制）。
 * 例：【附件：a.txt, b.log】【文件夹：docs/（含 c.md, d.ts）】
 */
function formatAttachmentNote(attachments?: FileAttachment[]): string {
  if (!attachments?.length) return "";
  const files = attachments.filter((a) => a.kind === "file");
  const folders = attachments.filter((a) => a.kind === "folder");
  const parts: string[] = [];
  if (files.length) {
    parts.push(`【附件：${files.map((a) => a.name).join(", ")}】`);
  }
  for (const f of folders) {
    const childList = f.children?.length ? `（含 ${f.children.slice(0, 8).join(", ")}${f.children.length > 8 ? " 等" : ""}）` : "";
    parts.push(`【文件夹：${f.name}${childList}】`);
  }
  return parts.join("");
}

/** ChatMessage → pi AgentMessage（user / assistant / toolResult） */
function toAgentMessage(m: ChatMessage): AgentMessage | null {
  if (m.pending) return null;
  if (m.role === "user") {
    const cites = m.citations ?? [];
    const citePrefix = cites
      .map((c) =>
        c.type === "conversation"
          ? `【引用历史会话：${c.fromTitle ?? ""}】\n${c.snippet}`
          : `【引用上文】\n${c.snippet}`,
      )
      .join("\n\n");
    const attachNote = formatAttachmentNote(m.attachments);
    const textContent =
      (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("")) || "";
    const prefixParts = [citePrefix, attachNote].filter(Boolean).join("\n\n");
    const fullText = prefixParts ? `${prefixParts}\n\n${textContent}` : textContent;

    if (typeof m.content === "string" || !m.content.some((p) => p.type === "image_url")) {
      return {
        role: "user",
        content: fullText,
        timestamp: m.timestamp,
      } as UserMessage;
    }
    // 多模态
    const parts: (TextContent | ImageContent)[] = [];
    if (fullText) parts.push({ type: "text", text: fullText });
    for (const p of m.content) {
      if (p.type === "image_url" && p.image_url?.url) {
        const url = p.image_url.url;
        const match = /^data:(.+?);base64,(.*)$/.exec(url);
        if (match) {
          parts.push({ type: "image", data: match[2], mimeType: match[1] });
        } else {
          // http(s) url — pi-ai 的 ImageContent 需要 base64+mime；这里跳过非 data url
          // （OpenAI completions API 原生支持 image_url，但我们走的是 pi 的 ImageContent）
          // 为兼容，仍尝试包装为 base64 占位：实际不支持时模型会忽略
          // 生产建议：调用方传入 data: URL
        }
      }
    }
    return {
      role: "user",
      content: parts,
      timestamp: m.timestamp,
    } as UserMessage;
  }

  if (m.role === "assistant") {
    const content: (TextContent | PiToolCall)[] = [];
    const text = typeof m.content === "string" ? m.content : "";
    if (text) content.push({ type: "text", text });
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        content.push({
          type: "toolCall",
          id: tc.id,
          name: tc.name,
          arguments: args,
        });
      }
    }
    return {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "rein-custom-openai",
      model: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: m.error ? "error" : "stop",
      errorMessage: m.error,
      timestamp: m.timestamp,
    } as AssistantMessage;
  }

  if (m.role === "tool") {
    // 从 toolResults 反查 details
    const details: PiToolDetails | undefined = undefined;
    return {
      role: "toolResult",
      toolCallId: m.toolCallId ?? "",
      toolName: m.name ?? "",
      content: [{ type: "text", text: typeof m.content === "string" ? m.content : "" }],
      details,
      isError: false,
      timestamp: m.timestamp,
    } as ToolResultMessage;
  }

  return null;
}

/** runPrompt / runRegenerate 共享的运行时选项 */
export interface RunPromptOptions {
  modelId: string;
  baseURL: string;
  apiKey: string;
  autoExecute: boolean;
  /** 运动模式上下文；存在则注入系统提示并启用运动模式工具 */
  workoutCtx?: WorkoutPromptContext;
  /** 番茄钟模式上下文；存在则注入系统提示并启用番茄钟模式工具 */
  pomodoroCtx?: PomodoroPromptContext;
}

/** 构造 Agent 实例（每次发送时按最新配置构造） */
function buildAgent(opts: RunPromptOptions): Agent | null {
  // 兜底：provider 未注册时立即注册（避免 streamFn 调用时 requireProvider 抛错）
  if (opts.baseURL && opts.apiKey) {
    registerCustomProvider({ baseURL: opts.baseURL, apiKey: opts.apiKey });
  }
  const piModel = resolvePiModel(opts.modelId, opts.baseURL);
  if (!piModel) return null;

  const collection = getModelsCollection();
  const isWorkout = Boolean(opts.workoutCtx);
  const isPomodoro = Boolean(opts.pomodoroCtx);
  const tools = opts.autoExecute
    ? (isWorkout ? PI_TOOLS : (isPomodoro ? [...PI_TOOLS_CORE, ...PI_TOOLS_POMODORO] : PI_TOOLS_CORE))
    : [];

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(opts.workoutCtx, opts.pomodoroCtx),
      model: piModel,
      thinkingLevel: "off",
      tools,
      messages: [],
    },
    convertToLlm: (messages) => {
      // 只保留 LLM 可见的角色
      return messages.filter(
        (m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
      ) as Message[];
    },
    streamFn: (model, context, options) => {
      // 通过 Models 集合路由到自定义 provider 的 stream 实现
      return collection.streamSimple(model, context, {
        ...options,
        apiKey: opts.apiKey,
      });
    },
    toolExecution: "sequential",
  });

  return agent;
}

export interface RunPromptCallbacks {
  /** 用户消息已构造，准备发送（用于 store 推送 user ChatMessage） */
  onUserMessage?: (msg: ChatMessage) => void;
  /** 创建一条 pending assistant 占位消息，返回它的 id 供后续更新 */
  onCreateAssistantPlaceholder?: () => string;
  /** 更新指定 assistant 消息（流式增量 / 完成时清理 pending） */
  onUpdateAssistant?: (msgId: string, patch: Partial<ChatMessage>) => void;
  /** 工具执行完成，挂 ToolResult 到对应 assistant 消息 */
  onToolResult?: (assistantMsgId: string, result: ToolResult) => void;
  /** 错误：把错误写到当前 pending assistant 上 */
  onError?: (msg: string) => void;
  /** 完成本轮 prompt（无论成功失败） */
  onDone?: () => void;
}

/**
 * 发送一条用户消息并运行 agent 循环。
 * @returns 完成时 resolve；出错 reject
 */
export async function runPrompt(
  conv: Conversation,
  content: MessageContent,
  citations: Citation[],
  opts: RunPromptOptions,
  cb: RunPromptCallbacks,
  attachments?: FileAttachment[],
): Promise<void> {
  const agent = buildAgent(opts);
  if (!agent) {
    cb.onError?.("无法解析模型配置，请检查 baseURL / model");
    cb.onDone?.();
    return;
  }

  // 1. 构造 user ChatMessage
  const userMsg: ChatMessage = {
    id: genId(),
    role: "user",
    content,
    citations: citations.length ? citations : undefined,
    attachments: attachments?.length ? attachments : undefined,
    timestamp: Date.now(),
  };
  cb.onUserMessage?.(userMsg);

  // 2. 同步历史到 agent.state（不含刚构造的 userMsg）
  const history: AgentMessage[] = [];
  for (const m of conv.messages) {
    const am = toAgentMessage(m);
    if (am) history.push(am);
  }
  agent.state.messages = history;

  // 3. 把 userMsg 也转为 pi AgentMessage 作为 prompt
  const promptMsg = toAgentMessage(userMsg);
  if (!promptMsg) {
    cb.onError?.("消息转换失败");
    cb.onDone?.();
    return;
  }

  // 4. 创建 pending assistant 占位
  let placeholderId: string | null = null;
  let collectedToolResults: ToolResult[] = [];
  let currentText = "";

  // 工具调用 → assistant 消息的映射（用 toolCallId 关联）
  const toolCallToPlaceholder = new Map<string, string>();

  placeholderId = cb.onCreateAssistantPlaceholder?.() ?? genId();

  // 5. 订阅事件
  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant") {
          // 新的 assistant 消息开始：若已有 placeholder 复用，否则新建
          if (!placeholderId) {
            placeholderId = cb.onCreateAssistantPlaceholder?.() ?? genId();
          }
          currentText = "";
          collectedToolResults = [];
        }
        break;
      }
      case "message_update": {
        // assistant 流式增量
        if (event.assistantMessageEvent.type === "text_delta" && placeholderId) {
          currentText += event.assistantMessageEvent.delta;
          cb.onUpdateAssistant?.(placeholderId, {
            content: currentText,
            pending: true,
          });
        } else if (event.assistantMessageEvent.type === "toolcall_end" && placeholderId) {
          // 收到 toolcall_end：记录 toolCall.id → placeholderId
          const tc = event.assistantMessageEvent.toolCall;
          toolCallToPlaceholder.set(tc.id, placeholderId);
          // 立即把 toolCalls 写到 placeholder
          // （最终在 message_end 时统一更新）
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant" && placeholderId) {
          const am = event.message as AssistantMessage;
          let text = "";
          const toolCalls: ToolCall[] = [];
          for (const c of am.content) {
            if (c.type === "text") text += c.text;
            else if (c.type === "toolCall") {
              toolCalls.push({
                id: c.id,
                name: c.name,
                arguments: JSON.stringify(c.arguments),
              });
            }
          }
          const errMsg = am.errorMessage;
          // 出错且无文本时，把错误信息作为可见内容写入气泡
          const finalContent = errMsg && !text ? `⚠️ ${errMsg}` : text;
          cb.onUpdateAssistant?.(placeholderId, {
            content: finalContent,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            pending: false,
            error: errMsg,
          });
          // 如果这一条 assistant 有 toolCalls，下一条 assistant 消息要新建 placeholder
          if (toolCalls.length) {
            placeholderId = null;
          }
        }
        break;
      }
      case "tool_execution_end": {
        // 把 details（我们的 ToolResult）挂回对应 assistant 消息
        const details = event.result?.details as PiToolDetails | undefined;
        if (details) {
          const targetPlaceholder = toolCallToPlaceholder.get(event.toolCallId) ?? placeholderId;
          if (targetPlaceholder) {
            const r: ToolResult = {
              ...details,
              toolCallId: event.toolCallId,
              name: event.toolName,
              ok: !event.isError && details.ok !== false,
            };
            collectedToolResults.push(r);
            cb.onToolResult?.(targetPlaceholder, r);
          }
        }
        break;
      }
      case "agent_end": {
        // 兜底：若 placeholder 仍 pending，标记完成
        if (placeholderId) {
          cb.onUpdateAssistant?.(placeholderId, { pending: false });
        }
        break;
      }
    }
  });

  // 6. 执行
  try {
    await agent.prompt(promptMsg as AgentMessage);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (placeholderId) {
      cb.onUpdateAssistant?.(placeholderId, {
        pending: false,
        error: msg,
        content: `⚠️ 发生错误：${msg}`,
      });
    } else {
      cb.onError?.(msg);
    }
  } finally {
    unsubscribe();
    cb.onDone?.();
  }
}

/** 重新生成：移除末尾 assistant+tool 消息后再次运行 */
export async function runRegenerate(
  conv: Conversation,
  opts: RunPromptOptions,
  cb: RunPromptCallbacks,
): Promise<void> {
  // conv.messages 已被 store 裁剪过末尾 assistant/tool
  // 我们用一个空 user prompt 走 continue 路径：实际上需要把最后一条 user 重新作为 prompt
  // 简化：找到最后一条 user 消息，作为 prompt 重新走 runPrompt
  let lastUser: ChatMessage | undefined;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === "user") {
      lastUser = conv.messages[i];
      break;
    }
  }
  if (!lastUser) {
    cb.onError?.("没有可重新生成的消息");
    cb.onDone?.();
    return;
  }
  // 从 conv 中移除 lastUser（store 已裁剪 assistant/tool，但保留 user）
  // 实际：我们重新提交 lastUser 的 content/citations/attachments
  const trimmed: Conversation = {
    ...conv,
    messages: conv.messages.filter((m) => m.id !== lastUser!.id),
  };
  await runPrompt(
    trimmed,
    lastUser.content,
    lastUser.citations ?? [],
    opts,
    cb,
    lastUser.attachments,
  );
}
