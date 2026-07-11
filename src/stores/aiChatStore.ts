import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type {
  ChatMessage,
  Conversation,
  ConversationMode,
  Citation,
  FileAttachment,
  MessageContent,
} from "@/types/ai";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import { runPrompt, runRegenerate, type RunPromptCallbacks, type RunPromptOptions } from "@/composables/usePiAgent";
import type { WorkoutPromptContext, PomodoroPromptContext } from "@/data/aiPrompt";
import { pushChange, pushDelete, registerSyncEntity } from "@/composables/useSyncBridge";
import { useWorkoutStore } from "@/stores/workoutStore";

const CONV_KEY = "ai-conversations";

function genId(prefix = "msg"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

  function createConversation(title = "新对话", mode: ConversationMode = "normal"): Conversation {
    const conv: Conversation = {
      id: genId("conv"),
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode,
    };
    conversations.value.unshift(conv);
    activeId.value = conv.id;
    void persist();
    void pushChange(CONV_KEY, conv.id, conv);
    return conv;
  }

  /** 创建一个新的运动模式会话并设为 active */
  function newWorkoutChat(): Conversation {
    return createConversation("运动助手", "workout");
  }

  /**
   * 确保存在一个 active 的运动模式会话：
   * - 当前 active 是 workout 模式 → 直接返回
   * - 否则新建一个 workout 模式会话并设为 active
   */
  function ensureWorkoutConversation(): Conversation {
    const cur = active.value;
    if (cur && cur.mode === "workout") return cur;
    return newWorkoutChat();
  }

  /** 创建一个新的番茄钟模式会话并设为 active */
  function newPomodoroChat(): Conversation {
    return createConversation("番茄钟助手", "pomodoro");
  }
  /** 确保 active 是番茄钟模式会话 */
  function ensurePomodoroConversation(): Conversation {
    const cur = active.value;
    if (cur && cur.mode === "pomodoro") return cur;
    return newPomodoroChat();
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
    void pushDelete(CONV_KEY, id);
  }

  function togglePin(id: string): void {
    const c = conversations.value.find((x) => x.id === id);
    if (!c) return;
    c.pinned = !c.pinned;
    void persist();
    void pushChange(CONV_KEY, id, c);
  }

  function rename(id: string, title: string): void {
    const c = conversations.value.find((x) => x.id === id);
    if (!c) return;
    c.title = title || "未命名对话";
    void persist();
    void pushChange(CONV_KEY, id, c);
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
    void pushChange(CONV_KEY, active.value!.id, active.value!);
  }

  function updateMessage(msgId: string, patch: Partial<ChatMessage>): void {
    for (const c of conversations.value) {
      const m = c.messages.find((x) => x.id === msgId);
      if (m) {
        Object.assign(m, patch);
        c.updatedAt = Date.now();
        void persist();
        void pushChange(CONV_KEY, c.id, c);
        return;
      }
    }
  }

  /** 构造事件回调 */
  function makeCallbacks(): RunPromptCallbacks {
    return {
      onUserMessage: (msg) => pushMessage(msg),
      onCreateAssistantPlaceholder: () => {
        const placeholder: ChatMessage = {
          id: genId(),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          pending: true,
        };
        pushMessage(placeholder);
        return placeholder.id;
      },
      onUpdateAssistant: (msgId, patch) => updateMessage(msgId, patch),
      onToolResult: (msgId, result) => {
        const conv = active.value;
        if (!conv) return;
        const m = conv.messages.find((x) => x.id === msgId);
        if (!m) return;
        m.toolResults = [...(m.toolResults ?? []), result];
        void persist();
        void pushChange(CONV_KEY, conv.id, conv);
      },
      onError: (msg) => {
        pushMessage({
          id: genId(),
          role: "assistant",
          content: `⚠️ 发生错误：${msg}`,
          timestamp: Date.now(),
          error: msg,
        });
      },
      onDone: () => void persist(),
    };
  }

  /**
   * 发送一条用户消息并运行 pi agent 循环
   * @param content 文本或带图的多模态内容
   * @param citations 引用列表
   * @param opts 可选 { workoutCtx, attachments }：workoutCtx 注入运动模式系统提示并启用运动工具；attachments 附在用户消息上
   */
  async function send(
    content: MessageContent,
    citations: Citation[] = [],
    opts?: { workoutCtx?: WorkoutPromptContext; pomodoroCtx?: PomodoroPromptContext; attachments?: FileAttachment[] },
  ): Promise<void> {
    const configStore = useAiConfigStore();
    if (!configStore.isConfigured) {
      throw new Error("请先在 AI 配置页填写 baseURL / apiKey / model");
    }
    if (sending.value) return;
    if (!active.value) createConversation();

    const conv = active.value!;
    const cfg = configStore.config;
    const runOpts: RunPromptOptions = {
      modelId: cfg.model,
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      autoExecute: cfg.autoExecute,
      workoutCtx: opts?.workoutCtx,
      pomodoroCtx: opts?.pomodoroCtx,
    };
    sending.value = true;
    try {
      await runPrompt(
        conv,
        content,
        citations,
        runOpts,
        makeCallbacks(),
        opts?.attachments,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const conv2 = active.value;
      if (conv2) {
        const last = conv2.messages[conv2.messages.length - 1];
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

    const configStore = useAiConfigStore();
    const cfg = configStore.config;
    // workout 模式会话：重生成时仍需注入运动上下文，保持系统提示一致
    let workoutCtx: WorkoutPromptContext | undefined;
    if (conv.mode === "workout") {
      const ws = useWorkoutStore();
      const summary = ws.aiContextSummary ?? "";
      workoutCtx = summary ? { summary } : undefined;
    }
    sending.value = true;
    try {
      await runRegenerate(
        conv,
        {
          modelId: cfg.model,
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          autoExecute: cfg.autoExecute,
          workoutCtx,
        },
        makeCallbacks(),
      );
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
        void pushChange(CONV_KEY, c.id, c);
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
    newWorkoutChat,
    ensureWorkoutConversation,
    newPomodoroChat,
    ensurePomodoroConversation,
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
    applyRemote,
  };
});

// ===== 远端同步 applyRemote =====

async function applyRemote(id: string, payload: unknown, deleted: boolean): Promise<void> {
  const store = useAiChatStore();
  const idx = store.conversations.findIndex((c) => c.id === id);
  if (deleted) {
    if (idx >= 0) {
      store.conversations.splice(idx, 1);
      await writeJSON(CONV_KEY, store.conversations);
    }
    return;
  }
  const conv = payload as Conversation;
  if (!conv || typeof conv.id !== "string" || !Array.isArray(conv.messages)) return;
  if (idx >= 0) {
    if ((conv.updatedAt ?? 0) > (store.conversations[idx].updatedAt ?? 0)) {
      store.conversations[idx] = conv;
      await writeJSON(CONV_KEY, store.conversations);
    }
  } else {
    store.conversations.unshift(conv);
    await writeJSON(CONV_KEY, store.conversations);
  }
}

registerSyncEntity<Conversation>({ kind: CONV_KEY, applyRemote });
