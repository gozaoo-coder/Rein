<script setup lang="ts">
/**
 * PomodoroAiPanel — 番茄钟页面内嵌的 AI 聊天面板
 *
 * 已统一到 aiChatStore：
 *   - 复用 ensurePomodoroConversation() 在打开时获取 / 创建一个 pomodoro 模式会话
 *   - 消息直接读取 aiChatStore.active?.messages（持久化 + 历史）
 *   - 发送走 aiChatStore.send(content, citations, { pomodoroCtx, attachments })
 *     pomodoroCtx 由 pomodoroStore.snapshot() + sortedTodos 实时组装，注入系统提示
 *   - 工具集在 usePiAgent.buildAgent 内根据 pomodoroCtx 启用番茄钟模式工具
 *   - 复用共享 AiChatInput 组件（图片 / 文件 / 引用入口）
 *
 * 与 WorkoutAiPanel 的差异：本面板为内嵌式（非模态），无遮罩与关闭按钮，
 * 直接填充父容器的剩余高度；上下文来源为番茄钟快照而非运动状态。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAiChatStore } from "@/stores/aiChatStore";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import { usePomodoroStore } from "@/stores/pomodoroStore";
import AiToolCard from "@/components/ai/AiToolCard.vue";
import MarkdownRenderer from "@/components/ai/MarkdownRenderer.vue";
import AiChatInput from "@/components/ai/AiChatInput.vue";
import type { ChatMessage, Citation, ContentPart, Conversation, FileAttachment } from "@/types/ai";

const router = useRouter();
const pomodoroStore = usePomodoroStore();
const aiChatStore = useAiChatStore();
const configStore = useAiConfigStore();

onMounted(async () => {
  await configStore.load();
  await aiChatStore.load();
  // 确保 active 是 pomodoro 模式会话
  aiChatStore.ensurePomodoroConversation();
  await nextTick();
  void scrollToEnd();
});

const listEl = ref<HTMLDivElement | null>(null);

const isConfigured = computed(() => configStore.isConfigured);
const sending = computed(() => aiChatStore.sending);
const vision = computed(() => configStore.config.vision);

/** active 会话：仅当 mode=pomodoro 时才视为本面板可编辑的会话 */
const activeConv = computed<Conversation | null>(() => {
  const a = aiChatStore.active;
  return a && a.mode === "pomodoro" ? a : null;
});

const messages = computed<ChatMessage[]>(() => activeConv.value?.messages ?? []);

/** 顶部副标题：优先显示专注待办，否则显示当前阶段 */
const headerSub = computed(() => {
  const focus = pomodoroStore.sortedTodos.find((t) => t.id === pomodoroStore.focusTodoId);
  if (focus) return focus.title;
  const phaseText: Record<string, string> = {
    idle: "空闲",
    focus: "专注中",
    rest: "休息中",
    done: "已完成",
  };
  return phaseText[pomodoroStore.phase] ?? "—";
});

/** 快捷指令（番茄钟场景） */
const quickPrompts = [
  "帮我调整番茄钟配置",
  "跳过当前阶段",
  "按重要性排一下待办",
  "设置第一个待办为专注事项",
  "我现在该专注什么？",
];

// ===== AiChatInput 状态 =====
const inputText = ref("");
const pendingImages = ref<string[]>([]);
const pendingCitations = ref<Citation[]>([]);
const pendingAttachments = ref<FileAttachment[]>([]);

/** 由番茄钟快照 + 排序后待办组装运行时上下文摘要 */
function buildPomodoroSummary(): string {
  const snap = pomodoroStore.snapshot();
  const phaseText: Record<string, string> = {
    idle: "空闲",
    focus: "专注中",
    rest: "休息中",
    done: "已完成",
  };
  const mm = String(Math.floor(snap.remainingSec / 60)).padStart(2, "0");
  const ss = String(snap.remainingSec % 60).padStart(2, "0");

  const lines: string[] = [];
  lines.push(`阶段：${phaseText[snap.phase] ?? snap.phase}`);
  lines.push(`剩余：${mm}:${ss}`);
  lines.push(`已完成：${snap.completedCount}/${snap.targetCount}`);
  lines.push(`专注时长：${snap.config.focusMin}分钟，休息时长：${snap.config.restMin}分钟`);

  const todos = pomodoroStore.sortedTodos;
  const focusTodo = todos.find((t) => t.id === snap.focusTodoId);
  lines.push(`专注待办：${focusTodo ? focusTodo.title : "无"}`);

  if (todos.length) {
    lines.push("待办列表：");
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    todos.forEach((t, i) => {
      const parts: string[] = [];
      if (t.priority === "high") parts.push("高优先级");
      else if (t.priority === "low") parts.push("低优先级");
      if (t.urgent) parts.push("紧急");
      if (t.dueDate) {
        if (t.dueDate === todayKey) parts.push(t.dueTime ? `今日 ${t.dueTime}` : "今日截止");
        else parts.push(t.dueDate);
      }
      const suffix = parts.length ? `（${parts.join("，")}）` : "";
      lines.push(`${i + 1}. ${t.title}${suffix}`);
    });
  }
  return lines.join("\n");
}

async function send(text?: string) {
  const t = (text ?? inputText.value).trim();
  if (!t && !pendingImages.value.length && !pendingAttachments.value.length) return;
  if (!isConfigured.value) {
    // 未配置：写入提示气泡
    aiChatStore.pushMessage({
      id: `err-${Date.now()}`,
      role: "assistant",
      content: "⚠️ 请先在 AI 配置页填写 baseURL / apiKey / model",
      timestamp: Date.now(),
    });
    return;
  }
  if (sending.value) return;

  // 确保 pomodoro 会话存在（可能被用户切走）
  if (!activeConv.value) {
    aiChatStore.ensurePomodoroConversation();
  }

  let content: string | ContentPart[];
  if (pendingImages.value.length) {
    content = [
      { type: "text", text: t },
      ...pendingImages.value.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ];
  } else {
    content = t;
  }

  const cites = [...pendingCitations.value];
  const atts = pendingAttachments.value.length ? [...pendingAttachments.value] : undefined;
  // 实时组装番茄钟上下文摘要并注入系统提示
  const pomodoroCtx = { summary: buildPomodoroSummary() };

  inputText.value = "";
  pendingImages.value = [];
  pendingCitations.value = [];
  pendingAttachments.value = [];

  try {
    await aiChatStore.send(content, cites, {
      pomodoroCtx,
      attachments: atts,
    });
  } catch {
    // 错误已由 store 写入气泡
  } finally {
    await scrollToEnd();
  }
}

function onInputSend() {
  void send();
}

function onQuickPrompt(p: string) {
  void send(p);
}

function onAddImages(urls: string[]) {
  pendingImages.value.push(...urls);
}

function onAddFiles(files: FileAttachment[]) {
  pendingAttachments.value.push(...files);
}

function onAddFolder(folder: FileAttachment) {
  pendingAttachments.value.push(folder);
}

function onAddCitation() {
  // 番茄钟面板暂不弹引用选择器（无历史上下文入口），保持简单
  // 如需引用，可走主 AI 页；这里保留 emit 钩子以备扩展
}

function onRemoveImage(idx: number) {
  pendingImages.value.splice(idx, 1);
}

function onRemoveCitation(idx: number) {
  pendingCitations.value.splice(idx, 1);
}

function onRemoveAttachment(idx: number) {
  pendingAttachments.value.splice(idx, 1);
}

// ===== 头部操作 =====

function newBlankChat() {
  aiChatStore.newPomodoroChat();
  pendingImages.value = [];
  pendingCitations.value = [];
  pendingAttachments.value = [];
  inputText.value = "";
  void scrollToEnd();
}

function goHistory() {
  // 内嵌面板：直接跳转到历史页
  router.push("/ai/history");
}

async function scrollToEnd() {
  await nextTick();
  if (listEl.value) {
    listEl.value.scrollTop = listEl.value.scrollHeight;
  }
}

watch(messages, () => void scrollToEnd(), { deep: true });

function textOf(m: ChatMessage): string {
  return typeof m.content === "string" ? m.content : "";
}
</script>

<template>
  <div class="pai-panel">
    <!-- Header -->
    <header class="pai-header">
      <div class="pai-header-left">
        <div class="pai-icon">
          <i class="bi bi-chat-dots" style="font-size:18px"></i>
        </div>
        <div class="pai-header-text">
          <div class="pai-title">AI 番茄钟助手</div>
          <div class="pai-sub">{{ headerSub }}</div>
        </div>
      </div>
      <div class="pai-header-actions">
        <button class="pai-action" @click="newBlankChat" title="新建空白聊天">
          <i class="bi bi-plus-lg" style="font-size:18px"></i>
        </button>
        <button class="pai-action" @click="goHistory" title="历史">
          <i class="bi bi-clock-history" style="font-size:18px"></i>
        </button>
      </div>
    </header>

    <!-- Messages -->
    <div ref="listEl" class="pai-messages">
      <div v-if="messages.length === 0" class="pai-empty">
        <div class="pai-empty-icon">
          <i class="bi bi-chat-dots" style="font-size:36px"></i>
        </div>
        <p class="pai-empty-text">问我该专注什么、调整番茄钟配置或重新排待办</p>
      </div>

      <div
        v-for="m in messages"
        :key="m.id"
        class="pai-msg"
        :class="`pai-msg--${m.role}`"
      >
        <div class="pai-msg-bubble">
          <div v-if="m.pending && !textOf(m)" class="pai-typing">
            <span class="dot" /><span class="dot" /><span class="dot" />
          </div>
          <!-- 统一 markdown 渲染（assistant 流式 + 静态） -->
          <MarkdownRenderer
            v-else
            :content="textOf(m)"
            :streaming="!!m.pending"
          />
          <!-- 工具结果卡片（复用 AiToolCard） -->
          <div v-if="m.toolResults?.length" class="pai-tool-results">
            <AiToolCard
              v-for="(tr, i) in m.toolResults"
              :key="i"
              :result="tr"
              :compact="true"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Quick prompts -->
    <div v-if="messages.length === 0" class="pai-quick">
      <button
        v-for="(p, i) in quickPrompts"
        :key="i"
        class="pai-quick-chip"
        @click="onQuickPrompt(p)"
      >{{ p }}</button>
    </div>

    <!-- 输入区（共享 AiChatInput） -->
    <div class="pai-input-wrap">
      <AiChatInput
        v-model="inputText"
        :pending-images="pendingImages"
        :pending-citations="pendingCitations"
        :pending-attachments="pendingAttachments"
        :disabled="false"
        :vision="vision"
        :allow-citations="false"
        :sending="sending"
        placeholder="问点什么…"
        @send="onInputSend"
        @add-images="onAddImages"
        @add-files="onAddFiles"
        @add-folder="onAddFolder"
        @add-citation="onAddCitation"
        @remove-image="onRemoveImage"
        @remove-citation="onRemoveCitation"
        @remove-attachment="onRemoveAttachment"
      />
    </div>
  </div>
</template>

<style scoped>
/* 内嵌面板：填充父容器剩余高度 */
.pai-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--card-bg);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

/* Header */
.pai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.pai-header-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.pai-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--color-warm), #ff8a5a);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pai-header-text { min-width: 0; }
.pai-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.2;
}
.pai-sub {
  font-size: 11px;
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pai-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}
.pai-action {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg-200);
  border: none;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.pai-action:active { transform: scale(0.9); }

/* Messages */
.pai-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pai-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
  padding: var(--space-6);
}
.pai-empty-icon { opacity: 0.4; }
.pai-empty-text {
  font-size: var(--text-sm);
  margin: 0;
  text-align: center;
}

.pai-msg {
  display: flex;
  max-width: 85%;
  animation: pai-msg-in 0.3s ease;
}
@keyframes pai-msg-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.pai-msg--user {
  align-self: flex-end;
}
.pai-msg--assistant {
  align-self: flex-start;
}
.pai-msg-bubble {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  line-height: 1.5;
  word-wrap: break-word;
}
.pai-msg--user .pai-msg-bubble {
  background: var(--color-warm);
  color: white;
  border-bottom-right-radius: 4px;
}
.pai-msg--assistant .pai-msg-bubble {
  background: var(--bg-200);
  color: var(--color-text);
  border-bottom-left-radius: 4px;
}

.pai-tool-results {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: var(--space-1);
}

.pai-typing {
  display: flex;
  gap: 3px;
  padding: 4px 0;
}
.pai-typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  animation: pai-typing 1.2s ease-in-out infinite;
}
.pai-typing .dot:nth-child(2) { animation-delay: 0.2s; }
.pai-typing .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes pai-typing {
  0%, 60%, 100% { transform: scale(0.8); opacity: 0.5; }
  30% { transform: scale(1); opacity: 1; }
}

/* Quick prompts */
.pai-quick {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: 0 var(--space-4) var(--space-2);
  flex-shrink: 0;
}
.pai-quick-chip {
  font-size: var(--text-xs);
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  background: rgba(255, 102, 51, 0.08);
  color: var(--color-warm);
  border: 1px solid rgba(255, 102, 51, 0.18);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.pai-quick-chip:active { transform: scale(0.94); }

/* 输入区 */
.pai-input-wrap {
  padding: var(--space-2) var(--space-3) calc(env(safe-area-inset-bottom, 0px) + var(--space-3));
  border-top: 1px solid var(--color-divider);
  flex-shrink: 0;
}
</style>
