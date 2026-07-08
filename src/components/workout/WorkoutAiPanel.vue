<script setup lang="ts">
/**
 * WorkoutAiPanel — 运动模式底部 AI 聊天面板
 *
 * 特性：
 *   - 注入当前训练上下文到系统提示（每次发送时刷新）
 *   - 提供快捷提示 chips（询问当前动作 / 调整配重 / 缩短休息…）
 *   - 复用 usePiAgent.runPrompt + 全部 PI_TOOLS（含运动模式工具）
 *   - 消息为瞬态（不持久化到 aiChatStore），关闭即销毁
 *
 * 单一职责：只负责运动模式下的 AI 交互；不渲染工具卡片细节，
 * 工具结果以摘要形式内联展示。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useWorkoutStore } from "@/stores/workoutStore";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import { runPrompt, type RunPromptCallbacks } from "@/composables/usePiAgent";
import AiToolCard from "@/components/ai/AiToolCard.vue";
import MarkdownRenderer from "@/components/ai/MarkdownRenderer.vue";
import type { ChatMessage, Conversation } from "@/types/ai";

const emit = defineEmits<{
  (e: "close"): void;
}>();

const workoutStore = useWorkoutStore();
const configStore = useAiConfigStore();

onMounted(() => {
  void configStore.load();
});

const messages = ref<ChatMessage[]>([]);
const inputText = ref("");
const sending = ref(false);
const listEl = ref<HTMLDivElement | null>(null);

const isConfigured = computed(() => configStore.isConfigured);

const quickPrompts = computed(() => {
  const step = workoutStore.currentStep;
  const base = [
    "当前动作的发力要点是什么？",
    "帮我看看现在的训练进度",
  ];
  if (step?.details.equipment) base.push(`这个动作怎么用${step.details.equipment}做更好？`);
  if (step?.details.muscleGroup) base.push(`${step.details.muscleGroup}还能怎么练？`);
  base.push("把组间休息缩短 10 秒（仅本次）");
  base.push("我有点累，跳过当前步");
  return base;
});

function genId(prefix = "msg"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function send(text: string) {
  const content = text.trim();
  if (!content || sending.value) return;
  if (!isConfigured.value) {
    messages.value.push({
      id: genId(),
      role: "assistant",
      content: "⚠️ 请先在 AI 配置页填写 baseURL / apiKey / model",
      timestamp: Date.now(),
    });
    return;
  }

  inputText.value = "";

  // 构造瞬态 Conversation
  const conv: Conversation = {
    id: "workout-transient",
    title: "运动助手",
    messages: messages.value.filter((m) => !m.pending),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const cfg = configStore.config;
  const callbacks: RunPromptCallbacks = {
    onUserMessage: (msg) => messages.value.push(msg),
    onCreateAssistantPlaceholder: () => {
      const id = genId();
      messages.value.push({
        id,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        pending: true,
      });
      return id;
    },
    onUpdateAssistant: (msgId, patch) => {
      const m = messages.value.find((x) => x.id === msgId);
      if (m) Object.assign(m, patch);
    },
    onToolResult: (msgId, result) => {
      const m = messages.value.find((x) => x.id === msgId);
      if (m) m.toolResults = [...(m.toolResults ?? []), result];
    },
    onError: (msg) => {
      messages.value.push({
        id: genId(),
        role: "assistant",
        content: `⚠️ ${msg}`,
        timestamp: Date.now(),
        error: msg,
      });
    },
    onDone: () => void 0,
  };

  sending.value = true;
  try {
    // 关键：每次发送都用最新 workoutContext 构造 systemPrompt
    // 注意：runPrompt 内部调用 buildSystemPrompt() 无参版本，
    // 我们通过 hijack 方式无法注入；故改为：将上下文作为 user 消息前缀注入。
    const ctxSummary = workoutStore.aiContextSummary ?? "";
    const enrichedContent = ctxSummary
      ? `【当前训练上下文】\n${ctxSummary}\n\n──────\n\n${content}`
      : content;

    await runPrompt(
      conv,
      enrichedContent,
      [],
      {
        modelId: cfg.model,
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        autoExecute: cfg.autoExecute,
      },
      callbacks,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    messages.value.push({
      id: genId(),
      role: "assistant",
      content: `⚠️ ${msg}`,
      timestamp: Date.now(),
      error: msg,
    });
  } finally {
    sending.value = false;
    await scrollToEnd();
  }
}

async function scrollToEnd() {
  await nextTick();
  if (listEl.value) {
    listEl.value.scrollTop = listEl.value.scrollHeight;
  }
}

watch(messages, () => void scrollToEnd(), { deep: true });

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send(inputText.value);
  }
}

function textOf(m: ChatMessage): string {
  return typeof m.content === "string" ? m.content : "";
}

function close() {
  emit("close");
}
</script>

<template>
  <div class="wai-mask" @click.self="close">
    <div class="wai-panel clean-card">
      <!-- Header -->
      <header class="wai-header">
        <div class="wai-header-left">
          <div class="wai-icon">
            <i class="bi bi-chat-dots" style="font-size:18px"></i>
          </div>
          <div class="wai-header-text">
            <div class="wai-title">AI 运动助手</div>
            <div class="wai-sub">{{ workoutStore.plan?.name ?? "—" }}</div>
          </div>
        </div>
        <button class="wai-close" @click="close" aria-label="关闭">
          <i class="bi bi-x-lg" style="font-size:18px"></i>
        </button>
      </header>

      <!-- Messages -->
      <div ref="listEl" class="wai-messages">
        <div v-if="messages.length === 0" class="wai-empty">
          <div class="wai-empty-icon">
            <i class="bi bi-chat-dots" style="font-size:36px"></i>
          </div>
          <p class="wai-empty-text">问我当前动作细节、调整配重或修改课程</p>
        </div>

        <div
          v-for="m in messages"
          :key="m.id"
          class="wai-msg"
          :class="`wai-msg--${m.role}`"
        >
          <div class="wai-msg-bubble">
            <div v-if="m.pending && !textOf(m)" class="wai-typing">
              <span class="dot" /><span class="dot" /><span class="dot" />
            </div>
            <!-- 统一 markdown 渲染（assistant 流式 + 静态） -->
            <MarkdownRenderer
              v-else
              :content="textOf(m)"
              :streaming="!!m.pending"
            />
            <!-- 工具结果卡片（复用 AiToolCard） -->
            <div v-if="m.toolResults?.length" class="wai-tool-results">
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
      <div v-if="messages.length === 0" class="wai-quick">
        <button
          v-for="(p, i) in quickPrompts"
          :key="i"
          class="wai-quick-chip"
          @click="send(p)"
        >{{ p }}</button>
      </div>

      <!-- Input -->
      <div class="wai-input-bar">
        <textarea
          v-model="inputText"
          class="wai-input"
          placeholder="问点什么…"
          rows="1"
          :disabled="sending"
          @keydown="handleKeydown"
        />
        <button
          class="wai-send"
          :disabled="!inputText.trim() || sending"
          @click="send(inputText)"
          aria-label="发送"
        >
          <i v-if="!sending" class="bi bi-send" style="font-size:18px"></i>
          <span v-else class="wai-spinner" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wai-mask {
  position: fixed;
  inset: 0;
  z-index: 330;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  animation: wai-fade 0.2s ease;
}
@keyframes wai-fade { from { opacity: 0 } to { opacity: 1 } }

.wai-panel {
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  background: rgba(255, 255, 255, 0.97);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  animation: wai-slide 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
  overflow: hidden;
}
@keyframes wai-slide {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

/* Header */
.wai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.wai-header-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.wai-icon {
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
.wai-header-text { min-width: 0; }
.wai-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.2;
}
.wai-sub {
  font-size: 11px;
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wai-close {
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
  flex-shrink: 0;
}
.wai-close:active { transform: scale(0.9); }

/* Messages */
.wai-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.wai-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
  padding: var(--space-6);
}
.wai-empty-icon { opacity: 0.4; }
.wai-empty-text {
  font-size: var(--text-sm);
  margin: 0;
  text-align: center;
}

.wai-msg {
  display: flex;
  max-width: 85%;
  animation: wai-msg-in 0.3s ease;
}
@keyframes wai-msg-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.wai-msg--user {
  align-self: flex-end;
}
.wai-msg--assistant {
  align-self: flex-start;
}
.wai-msg-bubble {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  line-height: 1.5;
  word-wrap: break-word;
}
.wai-msg--user .wai-msg-bubble {
  background: var(--color-warm);
  color: white;
  border-bottom-right-radius: 4px;
}
.wai-msg--assistant .wai-msg-bubble {
  background: var(--bg-200);
  color: var(--color-text);
  border-bottom-left-radius: 4px;
}

.wai-msg-content {
  white-space: pre-wrap;
}

.wai-tool-results {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: var(--space-1);
}
.wai-tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-pill);
  background: rgba(255, 102, 51, 0.1);
  color: var(--color-warm);
  font-weight: var(--fw-medium);
}

.wai-typing {
  display: flex;
  gap: 3px;
  padding: 4px 0;
}
.wai-typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  animation: wai-typing 1.2s ease-in-out infinite;
}
.wai-typing .dot:nth-child(2) { animation-delay: 0.2s; }
.wai-typing .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes wai-typing {
  0%, 60%, 100% { transform: scale(0.8); opacity: 0.5; }
  30% { transform: scale(1); opacity: 1; }
}

/* Quick prompts */
.wai-quick {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: 0 var(--space-4) var(--space-2);
  flex-shrink: 0;
}
.wai-quick-chip {
  font-size: var(--text-xs);
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  background: rgba(255, 102, 51, 0.08);
  color: var(--color-warm);
  border: 1px solid rgba(255, 102, 51, 0.18);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.wai-quick-chip:active { transform: scale(0.94); }

/* Input */
.wai-input-bar {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4) calc(env(safe-area-inset-bottom, 0px) + var(--space-3));
  border-top: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.wai-input {
  flex: 1;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-lg);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--bg-100, rgba(0, 0, 0, 0.03));
  resize: none;
  max-height: 100px;
  outline: none;
  font-family: inherit;
}
.wai-input:focus { border-color: var(--color-warm); }

.wai-send {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: none;
  background: var(--color-warm);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: transform 0.15s ease, opacity 0.15s ease;
}
.wai-send:disabled { opacity: 0.4; cursor: not-allowed; }
.wai-send:not(:disabled):active { transform: scale(0.92); }

.wai-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: white;
  border-radius: 50%;
  animation: wai-spin 0.8s linear infinite;
}
@keyframes wai-spin { to { transform: rotate(360deg); } }
</style>
