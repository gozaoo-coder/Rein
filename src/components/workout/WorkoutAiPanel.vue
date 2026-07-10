<script setup lang="ts">
/**
 * WorkoutAiPanel — 运动模式底部 AI 聊天面板
 *
 * 已统一到 aiChatStore：
 *   - 复用 ensureWorkoutConversation() 在打开时获取 / 创建一个 workout 模式会话
 *   - 消息直接读取 aiChatStore.active?.messages（持久化 + 历史）
 *   - 发送走 aiChatStore.send(content, citations, { workoutCtx, attachments })
 *     workoutCtx 由 workoutStore.aiContextSummary 实时组装，注入系统提示
 *   - 工具集在 usePiAgent.buildAgent 内根据 workoutCtx 启用运动模式工具
 *   - 复用共享 AiChatInput 组件（图片 / 文件 / 引用入口）
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useWorkoutStore } from "@/stores/workoutStore";
import { useAiChatStore } from "@/stores/aiChatStore";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import AiToolCard from "@/components/ai/AiToolCard.vue";
import MarkdownRenderer from "@/components/ai/MarkdownRenderer.vue";
import AiChatInput from "@/components/ai/AiChatInput.vue";
import type { ChatMessage, Citation, ContentPart, Conversation, FileAttachment } from "@/types/ai";

const emit = defineEmits<{
  (e: "close"): void;
}>();

const router = useRouter();
const workoutStore = useWorkoutStore();
const aiChatStore = useAiChatStore();
const configStore = useAiConfigStore();

onMounted(async () => {
  await configStore.load();
  await aiChatStore.load();
  // 确保 active 是 workout 模式会话
  aiChatStore.ensureWorkoutConversation();
  await nextTick();
  void scrollToEnd();
});

const listEl = ref<HTMLDivElement | null>(null);

const isConfigured = computed(() => configStore.isConfigured);
const sending = computed(() => aiChatStore.sending);
const vision = computed(() => configStore.config.vision);

/** active 会话：仅当 mode=workout 时才视为本面板可编辑的会话 */
const activeConv = computed<Conversation | null>(() => {
  const a = aiChatStore.active;
  return a && a.mode === "workout" ? a : null;
});

const messages = computed<ChatMessage[]>(() => activeConv.value?.messages ?? []);

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

// ===== AiChatInput 状态 =====
const inputText = ref("");
const pendingImages = ref<string[]>([]);
const pendingCitations = ref<Citation[]>([]);
const pendingAttachments = ref<FileAttachment[]>([]);

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

  // 确保 workout 会话存在（可能被用户切走）
  if (!activeConv.value) {
    aiChatStore.ensureWorkoutConversation();
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
  const ctxSummary = workoutStore.aiContextSummary ?? "";
  const workoutCtx = ctxSummary ? { summary: ctxSummary } : undefined;

  inputText.value = "";
  pendingImages.value = [];
  pendingCitations.value = [];
  pendingAttachments.value = [];

  try {
    await aiChatStore.send(content, cites, {
      workoutCtx,
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
  // 运动面板暂不弹引用选择器（无历史上下文入口），保持简单
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
  aiChatStore.newWorkoutChat();
  pendingImages.value = [];
  pendingCitations.value = [];
  pendingAttachments.value = [];
  inputText.value = "";
  void scrollToEnd();
}

function goHistory() {
  // 关闭面板并跳到历史页
  emit("close");
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
        <div class="wai-header-actions">
          <button class="wai-action" @click="newBlankChat" title="新建空白聊天">
            <i class="bi bi-plus-lg" style="font-size:18px"></i>
          </button>
          <button class="wai-action" @click="goHistory" title="历史">
            <i class="bi bi-clock-history" style="font-size:18px"></i>
          </button>
          <button class="wai-close" @click="close" aria-label="关闭">
            <i class="bi bi-x-lg" style="font-size:18px"></i>
          </button>
        </div>
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
          @click="onQuickPrompt(p)"
        >{{ p }}</button>
      </div>

      <!-- 输入区（共享 AiChatInput） -->
      <div class="wai-input-wrap">
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
.wai-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}
.wai-action {
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
.wai-action:active { transform: scale(0.9); }
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

.wai-tool-results {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: var(--space-1);
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

/* 输入区 */
.wai-input-wrap {
  padding: var(--space-2) var(--space-3) calc(env(safe-area-inset-bottom, 0px) + var(--space-3));
  border-top: 1px solid var(--color-divider);
  flex-shrink: 0;
}
</style>
