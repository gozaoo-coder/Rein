import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type {
  ChatMessage,
  Conversation,
  Citation,
  MessageContent,
  ContentPart,
  ToolResult,
} from "@/types/ai";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import {
  chatCompletion,
  type ChatCompletionMessage,
  type ChatCompletionTool,
} from "@/composables/useAiClient";
import { AI_TOOLS, executeToolCall } from "@/composables/useAiTools";
import { buildSystemPrompt } from "@/data/aiPrompt";

const CONV_KEY = "ai-conversations";

function genId(prefix = "msg"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export const useAiChatStore = defineStore("aiChat", () => {
  const conversations = ref<Conversation[]>([]);
  const activeId = ref<string | null>(null);
  const loaded = ref(false);
  const sending = ref(false);

  const active = computed<Conversation | null>(
    () => conversations.value.find((c) => c.id === activeId.value) ?? null,
  );

  const sortedConversations = computed(() =>
    [...conversations.value].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    }),
  );

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<Conversation[]>(CONV_KEY);
    if (stored && Array.isArray(stored)) {
      conversations.value = stored;
    }
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    await writeJSON(CONV_KEY, conversations.value);
  }

  function createConversation(title = "新对话"): Conversation {
    const conv: Conversation = {
      id: genId("conv"),
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    conversations.value.unshift(conv);
    activeId.value = conv.id;
    void persist();
    return conv;
  }

  function setActive(id: string): void {
    activeId.value = id;
  }

  function deleteConversation(id: string): void {
    const idx = conversations.value.findIndex((c) => c.id === id);
    if (idx < 0) return;
    conversations.value.splice(idx, 1);
    if (activeId.value === id) {
      activeId.value = conversations.value[0]?.id ?? null;
    }
    void persist();
  }

  function togglePin(id: string): void {
    const c = conversations.value.find((x) => x.id === id);
    if (!c) return;
    c.pinned = !c.pinned;
    void persist();
  }

  function rename(id: string, title: string): void {
    const c = conversations.value.find((x) => x.id === id);
    if (!c) return;
    c.title = title || "未命名对话";
    void persist();
  }

  function findMessage(convId: string, msgId: string): ChatMessage | undefined {
    return conversations.value
      .find((c) => c.id === convId)
      ?.messages.find((m) => m.id === msgId);
  }

  /** 添加一条消息到当前会话 */
  function pushMessage(msg: ChatMessage): void {
    if (!active.value) {
      createConversation();
    }
    active.value!.messages.push(msg);
    active.value!.updatedAt = Date.now();
    if (msg.role === "user" && active.value!.messages.filter((m) => m.role === "user").length === 1) {
      const text = typeof msg.content === "string" ? msg.content : "";
      active.value!.title = text.slice(0, 24) || "新对话";
    }
    void persist();
  }

  function updateMessage(msgId: string, patch: Partial<ChatMessage>): void {
    for (const c of conversations.value) {
      const m = c.messages.find((x) => x.id === msgId);
      if (m) {
        Object.assign(m, patch);
        c.updatedAt = Date.now();
        void persist();
        return;
      }
    }
  }

  /** 把对话消息序列化为 OpenAI 兼容格式 */
  function toApiMessages(conv: Conversation): ChatCompletionMessage[] {
    const sys: ChatCompletionMessage = {
      role: "system",
      content: buildSystemPrompt(),
    };
    const out: ChatCompletionMessage[] = [sys];
    for (const m of conv.messages) {
      if (m.pending) continue;
      if (m.role === "tool") {
        out.push({
          role: "tool",
          content: m.content as string,
          tool_call_id: m.toolCallId,
          name: m.name,
        });
        continue;
      }
      // user / assistant
      if (m.role === "assistant" && m.toolCalls?.length) {
        out.push({
          role: "assistant",
          content: (typeof m.content === "string" ? m.content : "") || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        continue;
      }
      // user：把引用拼接为前缀文本
      let textContent = "";
      const parts: ContentPart[] = [];
      if (typeof m.content === "string") {
        textContent = m.content;
      } else {
        for (const p of m.content) {
          if (p.type === "text" && p.text) textContent += p.text;
          else parts.push(p);
        }
      }
      const citationPrefix = (m.citations ?? [])
        .map((c) => {
          if (c.type === "conversation") return `【引用历史会话：${c.fromTitle ?? ""}】\n${c.snippet}`;
          return `【引用上文】\n${c.snippet}`;
        })
        .join("\n\n");
      const fullText = citationPrefix ? `${citationPrefix}\n\n${textContent}` : textContent;
      const content: string | ContentPart[] =
        parts.length > 0
          ? [{ type: "text", text: fullText }, ...parts]
          : fullText;
      out.push({ role: m.role as "user" | "assistant", content });
    }
    return out;
  }

  /**
   * 发送一条用户消息并触发 AI 回复（含工具调用循环）
   * @param content 文本或带图的多模态内容
   * @param citations 引用列表
   */
  async function send(content: MessageContent, citations: Citation[] = []): Promise<void> {
    const configStore = useAiConfigStore();
    if (!configStore.isConfigured) {
      throw new Error("请先在 AI 配置页填写 baseURL / apiKey / model");
    }
    if (sending.value) return;
    if (!active.value) createConversation();

    const userMsg: ChatMessage = {
      id: genId(),
      role: "user",
      content,
      citations: citations.length ? citations : undefined,
      timestamp: Date.now(),
    };
    pushMessage(userMsg);

    sending.value = true;
    try {
      await runAssistantLoop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 在最后一条 assistant 占位上写错误
      const conv = active.value;
      if (conv) {
        const last = conv.messages[conv.messages.length - 1];
        if (last && last.role === "assistant" && last.pending) {
          updateMessage(last.id, { pending: false, error: msg });
        } else {
          pushMessage({
            id: genId(),
            role: "assistant",
            content: `⚠️ 发生错误：${msg}`,
            timestamp: Date.now(),
            error: msg,
          });
        }
      }
    } finally {
      sending.value = false;
    }
  }

  /** 工具调用循环：调用模型 → 若返回 tool_calls 则执行并继续，直到无 tool_calls 或超过上限 */
  async function runAssistantLoop(): Promise<void> {
    const configStore = useAiConfigStore();
    const { baseURL, apiKey, model } = configStore.config;
    const conv = active.value!;
    const MAX_ITER = 6;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const placeholder: ChatMessage = {
        id: genId(),
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        pending: true,
      };
      conv.messages.push(placeholder);
      void persist();

      const apiMessages = toApiMessages(conv).filter(
        (m, idx) => !(idx > 0 && m.role === "assistant" && (m.content == null || m.content === "") && !m.tool_calls),
      );

      const res = await chatCompletion(baseURL, apiKey, {
        model,
        messages: apiMessages,
        tools: AI_TOOLS as ChatCompletionTool[],
        tool_choice: configStore.config.autoExecute ? "auto" : "none",
        temperature: 0.6,
      });

      const choice = res.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        updateMessage(placeholder.id, { pending: false, error: "模型未返回内容" });
        return;
      }

      const toolCalls = msg.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

      updateMessage(placeholder.id, {
        pending: false,
        content: msg.content ?? "",
        toolCalls: toolCalls?.length ? toolCalls : undefined,
      });

      // 没有工具调用：结束
      if (!toolCalls?.length) return;

      // 执行工具调用，逐条写 tool 消息 + 收集结果挂回 assistant 消息
      const results: ToolResult[] = [];
      for (const tc of toolCalls) {
        const result = executeToolCall(tc.name, tc.arguments);
        result.toolCallId = tc.id;
        results.push(result);
        conv.messages.push({
          id: genId(),
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
          name: tc.name,
          timestamp: Date.now(),
        });
      }
      // 把工具结果挂到 assistant 消息上（便于在 UI 渲染卡片）
      updateMessage(placeholder.id, { toolResults: results });
      void persist();
      // 循环继续，让模型基于工具结果生成自然语言总结
    }

    // 超过上限
    const conv2 = active.value!;
    conv2.messages.push({
      id: genId(),
      role: "assistant",
      content: "（已达到工具调用轮数上限，请继续提问以完成剩余步骤）",
      timestamp: Date.now(),
    });
    void persist();
  }

  /** 重新生成最后一条 assistant 回复 */
  async function regenerate(): Promise<void> {
    if (!active.value || sending.value) return;
    const conv = active.value;
    // 移除末尾连续的 assistant + tool 消息
    while (conv.messages.length) {
      const last = conv.messages[conv.messages.length - 1];
      if (last.role === "assistant" || last.role === "tool") {
        conv.messages.pop();
      } else {
        break;
      }
    }
    void persist();
    sending.value = true;
    try {
      await runAssistantLoop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushMessage({
        id: genId(),
        role: "assistant",
        content: `⚠️ 发生错误：${msg}`,
        timestamp: Date.now(),
        error: msg,
      });
    } finally {
      sending.value = false;
    }
  }

  /** 删除单条消息 */
  function deleteMessage(msgId: string): void {
    for (const c of conversations.value) {
      const idx = c.messages.findIndex((m) => m.id === msgId);
      if (idx >= 0) {
        c.messages.splice(idx, 1);
        c.updatedAt = Date.now();
        void persist();
        return;
      }
    }
  }

  return {
    conversations,
    active,
    activeId,
    sortedConversations,
    sending,
    loaded,
    load,
    createConversation,
    setActive,
    deleteConversation,
    togglePin,
    rename,
    findMessage,
    pushMessage,
    updateMessage,
    deleteMessage,
    send,
    regenerate,
  };
});
