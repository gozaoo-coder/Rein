<script setup lang="ts">
/**
 * AIPage — 完整 AI 聊天主界面
 * - 消息气泡 + 引用 chips + 工具结果卡片
 * - 顶部行：历史 / 配置 / 新建
 * - 浮动输入栏（与底部 pill tab bar 上下布局）
 * - 视觉模型时显示图片按钮
 * - @ 触发引用选择器（历史会话 / 当前上文）
 * - 虚拟列表：content-visibility + 消息上限，防止长对话卡顿
 * - 错误气泡：醒目红色 + 重试按钮 + 错误详情
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { marked } from "marked";
import { useAiChatStore } from "@/stores/aiChatStore";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import { useToast } from "@/composables/useToast";
import AiToolCard from "@/components/ai/AiToolCard.vue";
import AiStreamingText from "@/components/ai/AiStreamingText.vue";
import ShareSheet from "@/components/share/ShareSheet.vue";
import { formatAiChat } from "@/data/shareFormatters";
import type { Citation, ChatMessage, ContentPart, Conversation } from "@/types/ai";
import type { ShareContent } from "@/types/share";

const router = useRouter();
const store = useAiChatStore();
const cfg = useAiConfigStore();
const toast = useToast();

const chatRef = ref<HTMLElement | null>(null);
const inputText = ref("");
const pendingImages = ref<string[]>([]);
const pendingCitations = ref<Citation[]>([]);
const showCitePicker = ref(false);
const sending = ref(false);
/** 渲染窗口：默认仅渲染最近 N 条，防止超长对话卡顿 */
const RENDER_LIMIT = 200;
const showAll = ref(false);

/** 堆叠工具卡片展开状态（按消息 id 记录） */
const expandedStacks = ref<Set<string>>(new Set());
function toggleStack(msgId: string) {
  const s = new Set(expandedStacks.value);
  if (s.has(msgId)) {
    s.delete(msgId);
  } else {
    s.add(msgId);
  }
  expandedStacks.value = s;
}
function isStackExpanded(msgId: string): boolean {
  return expandedStacks.value.has(msgId);
}

const allMessages = computed(() => store.active?.messages ?? []);
const messages = computed(() => {
  if (showAll.value || allMessages.value.length <= RENDER_LIMIT) {
    return allMessages.value;
  }
  return allMessages.value.slice(-RENDER_LIMIT);
});
const hiddenCount = computed(() => Math.max(0, allMessages.value.length - messages.value.length));
const isConfigured = computed(() => cfg.isConfigured);
const vision = computed(() => cfg.config.vision);

/** 分享当前会话 */
const showShare = ref(false);
const shareContent = computed<ShareContent | null>(() => {
  if (!store.active) return null;
  return formatAiChat(store.active);
});
function openShare() {
  if (!store.active || allMessages.value.length === 0) {
    toast.info("当前没有可分享的对话");
    return;
  }
  showShare.value = true;
}

const suggestions = [
  "查看我的运动统计",
  "帮我创建一个居家徒手训练课程",
  "推荐一个减脂有氧计划",
  "我的动作库里有哪些核心动作？",
];

function renderMarkdown(content: string): string {
  if (!content) return "";
  return marked.parse(content, { breaks: true }) as string;
}

function scrollToBottom() {
  nextTick(() => {
    if (chatRef.value) {
      chatRef.value.scrollTop = chatRef.value.scrollHeight;
    }
  });
}

function textOf(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

function imagesOf(msg: ChatMessage): string[] {
  if (typeof msg.content === "string") return [];
  return msg.content
    .filter((p) => p.type === "image_url")
    .map((p) => p.image_url?.url ?? "");
}

async function send(text?: string) {
  const t = (text ?? inputText.value).trim();
  if (!t && !pendingImages.value.length) return;
  if (!isConfigured.value) {
    router.push("/ai/config");
    return;
  }
  if (sending.value) return;

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
  inputText.value = "";
  pendingImages.value = [];
  pendingCitations.value = [];
  sending.value = true;
  try {
    await store.send(content, cites);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ai] send failed", e);
    toast.error(msg);
  } finally {
    sending.value = false;
    scrollToBottom();
  }
}

/** 重试：删除最后一条 assistant 消息（含 tool）后重新生成 */
async function retryLast() {
  if (sending.value) return;
  sending.value = true;
  try {
    await store.regenerate();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ai] retry failed", e);
    toast.error(`重试失败：${msg}`);
  } finally {
    sending.value = false;
    scrollToBottom();
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function handleInput(e: Event) {
  const t = e.target as HTMLTextAreaElement;
  // 自适应高度
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
  // @ 触发引用选择器
  const v = t.value;
  if (v.endsWith("@")) {
    showCitePicker.value = true;
  }
}

// ====== 引用 ======

function citeMessage(msg: ChatMessage) {
  if (!store.active) return;
  const text = textOf(msg).slice(0, 200);
  if (!text) return;
  pendingCitations.value.push({
    type: "message",
    refId: msg.id,
    snippet: text,
    timestamp: msg.timestamp,
  });
}

function citeConversation(conv: Conversation) {
  const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
  const snippet = lastUser ? textOf(lastUser).slice(0, 200) : conv.title;
  pendingCitations.value.push({
    type: "conversation",
    refId: conv.id,
    snippet,
    fromTitle: conv.title,
    timestamp: conv.updatedAt,
  });
  showCitePicker.value = false;
}

function citeFromPicker(msg: ChatMessage) {
  citeMessage(msg);
  showCitePicker.value = false;
}

function removeCitation(idx: number) {
  pendingCitations.value.splice(idx, 1);
}

/** 引用选择器数据源：当前会话最近消息 + 其他历史会话 */
const pickerMessages = computed<ChatMessage[]>(() => {
  if (!store.active) return [];
  return store.active.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && textOf(m))
    .slice(-10)
    .reverse();
});
const pickerConversations = computed<Conversation[]>(() =>
  store.conversations.filter((c) => c.id !== store.activeId).slice(0, 10),
);

// ====== 图片 ======

function onPickImage(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  for (const f of Array.from(input.files)) {
    if (!f.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        pendingImages.value.push(reader.result);
      }
    };
    reader.readAsDataURL(f);
  }
  input.value = "";
}

function removeImage(idx: number) {
  pendingImages.value.splice(idx, 1);
}

// ====== 工具结果渲染辅助 ======

function visibleToolResults(msg: ChatMessage) {
  return msg.toolResults ?? [];
}

// ====== 顶部操作 ======

function goConfig() {
  router.push("/ai/config");
}
function goHistory() {
  router.push("/ai/history");
}
function newChat() {
  store.createConversation("新对话");
}

// ====== 生命周期 ======

onMounted(async () => {
  await Promise.all([cfg.load(), store.load()]);
  if (!store.active && store.conversations.length === 0) {
    store.createConversation("新对话");
  } else if (!store.active && store.conversations.length) {
    store.setActive(store.conversations[0].id);
  }
  scrollToBottom();
});

watch(
  () => messages.value.length,
  () => scrollToBottom(),
);
watch(
  () => store.activeId,
  () => {
    showAll.value = false;
    scrollToBottom();
  },
);
</script>

<template>
  <div class="ai-page">
    <!-- 顶部操作行 -->
    <div class="action-row">
      <button class="act-btn" @click="goHistory">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span>历史</span>
      </button>
      <button class="act-btn" @click="newChat">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>新对话</span>
      </button>
      <button class="act-btn" @click="openShare" :disabled="!store.active || allMessages.length === 0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
        <span>分享</span>
      </button>
      <button class="act-btn" :class="{ configured: isConfigured }" @click="goConfig">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>{{ isConfigured ? "已配置" : "未配置" }}</span>
      </button>
    </div>

    <!-- 聊天滚动区 -->
    <div ref="chatRef" class="chat-area scrollbar-hide">
      <!-- 未配置提示 -->
      <div v-if="!isConfigured" class="welcome-banner clean-card">
        <div class="welcome-avatar">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
            <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z" />
          </svg>
        </div>
        <p class="welcome-text">欢迎使用 Rein AI 助手</p>
        <p class="welcome-sub">请先配置 API 信息以启用聊天功能</p>
        <button class="welcome-btn" @click="goConfig">前往配置</button>
      </div>

      <!-- 欢迎横幅（已配置但无消息） -->
      <div v-else-if="allMessages.length === 0" class="welcome-banner clean-card">
        <div class="welcome-avatar">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
            <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z" />
          </svg>
        </div>
        <p class="welcome-text">Hi！我是 Rein AI 健康助手</p>
        <p class="welcome-sub">可以问我课程安排、动作指导，或直接让我帮你创建/修改训练计划</p>
        <div class="suggestion-chips">
          <button
            v-for="s in suggestions"
            :key="s"
            class="chip"
            @click="send(s)"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <!-- 虚拟列表：折叠提示 -->
      <div v-if="hiddenCount > 0" class="virtual-fold">
        <button class="fold-btn" @click="showAll = true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="18 15 12 9 6 15" />
          </svg>
          <span>加载更早的 {{ hiddenCount }} 条消息</span>
        </button>
      </div>

      <!-- 消息列表（content-visibility 自动虚拟化） -->
      <template v-for="msg in messages" :key="msg.id">
        <!-- tool 角色消息：不直接渲染（卡片挂在 assistant 上） -->
        <div v-if="msg.role === 'tool'" class="tool-msg-hidden" />

        <!-- user / assistant 气泡 -->
        <div
          v-else
          class="msg-row"
          :class="msg.role"
        >
          <!-- 头像 -->
          <div class="msg-avatar" :class="msg.role">
            <svg v-if="msg.role === 'assistant'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>

          <!-- 气泡主体 -->
          <div class="msg-bubble-wrap">
            <!-- 引用 chips（用户消息附带的引用） -->
            <div v-if="msg.citations?.length" class="cite-chips">
              <div
                v-for="(c, i) in msg.citations"
                :key="i"
                class="cite-chip"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                </svg>
                <span class="cite-label">{{ c.type === 'conversation' ? c.fromTitle : '上文' }}</span>
              </div>
            </div>

            <!-- 引用按钮（仅 user / assistant 文本消息显示） -->
            <button
              v-if="textOf(msg) && !msg.pending"
              class="cite-btn"
              :title="'引用此消息'"
              @click="citeMessage(msg)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
              </svg>
            </button>

            <!-- 气泡 -->
            <div class="msg-bubble" :class="[msg.role, { 'is-error': msg.error }]">
              <!-- 文本内容 -->
              <div
                v-if="msg.role === 'assistant' && textOf(msg)"
                class="msg-content"
              >
                <!-- 流式生成中：句子级动画 -->
                <AiStreamingText
                  v-if="msg.pending"
                  :text="textOf(msg)"
                  :is-pending="true"
                />
                <!-- 已完成：渲染 markdown -->
                <div v-else v-html="renderMarkdown(textOf(msg))" />
              </div>
              <div v-else class="msg-content">
                <p v-if="textOf(msg)">{{ textOf(msg) }}</p>
                <div v-if="imagesOf(msg).length" class="msg-images">
                  <img
                    v-for="(url, i) in imagesOf(msg)"
                    :key="i"
                    :src="url"
                    class="msg-img"
                    alt="attached"
                  />
                </div>
              </div>

              <!-- pending 指示 -->
              <div v-if="msg.pending" class="pending-dots">
                <span /><span /><span />
              </div>

              <!-- 错误详情 + 重试 -->
              <div v-if="msg.error && !msg.pending" class="err-actions">
                <div class="err-detail">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span class="err-text">{{ msg.error }}</span>
                </div>
                <button class="retry-btn" @click="retryLast">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                  <span>重试</span>
                </button>
              </div>
            </div>

            <!-- 工具结果卡片（挂在 assistant 消息下，2+ 张时堆叠） -->
            <div
              v-if="msg.role === 'assistant' && visibleToolResults(msg).length"
              class="tool-results"
            >
              <!-- 只有 1 张卡片：直接显示 -->
              <template v-if="visibleToolResults(msg).length === 1">
                <AiToolCard :result="visibleToolResults(msg)[0]" />
              </template>
              <!-- 2+ 张卡片：堆叠 UI -->
              <template v-else>
                <div class="tool-stack">
                  <!-- 首张卡片完整显示 -->
                  <AiToolCard :result="visibleToolResults(msg)[0]" />
                  <!-- 展开状态：显示剩余卡片 -->
                  <template v-if="isStackExpanded(msg.id)">
                    <AiToolCard
                      v-for="(r, i) in visibleToolResults(msg).slice(1)"
                      :key="i"
                      :result="r"
                    />
                  </template>
                  <!-- 折叠状态：堆叠示意 -->
                  <div v-else class="tool-stack-indicator">
                    <div
                      v-for="i in Math.min(visibleToolResults(msg).length - 1, 3)"
                      :key="'s' + i"
                      class="tool-stack-sheet"
                      :style="{ transform: `translateY(${-4 * i}px) scale(${1 - i * 0.03})`, zIndex: -i }"
                    />
                    <button class="stack-toggle-btn" @click="toggleStack(msg.id)">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                      <span>展开 {{ visibleToolResults(msg).length }} 张卡片</span>
                    </button>
                  </div>
                  <!-- 展开后提供收起按钮 -->
                  <button
                    v-if="isStackExpanded(msg.id)"
                    class="stack-collapse-btn"
                    @click="toggleStack(msg.id)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                    <span>收起卡片</span>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 引用选择器 -->
    <div v-if="showCitePicker" class="cite-picker-mask" @click.self="showCitePicker = false">
      <div class="cite-picker clean-card">
        <div class="picker-head">
          <span class="picker-title">选择引用</span>
          <button class="picker-close" @click="showCitePicker = false">×</button>
        </div>
        <div class="picker-body">
          <div v-if="pickerMessages.length" class="picker-section">
            <div class="picker-section-title">当前会话上文</div>
            <button
              v-for="m in pickerMessages"
              :key="m.id"
              class="picker-item"
              @click="citeFromPicker(m)"
            >
              <span class="picker-role">{{ m.role === 'user' ? '我' : 'AI' }}</span>
              <span class="picker-text">{{ textOf(m).slice(0, 80) }}</span>
            </button>
          </div>
          <div v-if="pickerConversations.length" class="picker-section">
            <div class="picker-section-title">历史会话</div>
            <button
              v-for="c in pickerConversations"
              :key="c.id"
              class="picker-item"
              @click="citeConversation(c)"
            >
              <span class="picker-role">会话</span>
              <span class="picker-text">{{ c.title }}</span>
            </button>
          </div>
          <div v-if="!pickerMessages.length && !pickerConversations.length" class="picker-empty">
            暂无可引用内容
          </div>
        </div>
      </div>
    </div>

    <!-- 浮动输入栏（与底部 pill tab bar 上下布局） -->
    <div class="input-bar-wrap">
      <!-- 待发送引用 chips -->
      <div v-if="pendingCitations.length" class="pending-cites">
        <div
          v-for="(c, i) in pendingCitations"
          :key="i"
          class="pending-cite-chip"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
          </svg>
          <span class="pcite-label">{{ c.type === 'conversation' ? c.fromTitle : '引用上文' }}</span>
          <button class="pcite-x" @click="removeCitation(i)">×</button>
        </div>
      </div>

      <!-- 待发送图片预览 -->
      <div v-if="pendingImages.length" class="pending-images">
        <div
          v-for="(url, i) in pendingImages"
          :key="i"
          class="pending-img-wrap"
        >
          <img :src="url" class="pending-img" alt="preview" />
          <button class="pending-img-x" @click="removeImage(i)">×</button>
        </div>
      </div>

      <!-- 输入栏（悬浮 pill 风格） -->
      <div class="input-bar">
        <button class="in-btn" @click="showCitePicker = true" title="引用">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
          </svg>
        </button>

        <label v-if="vision" class="in-btn" title="附加图片">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <input
            type="file"
            accept="image/*"
            multiple
            class="file-hidden"
            @change="onPickImage"
          />
        </label>

        <textarea
          v-model="inputText"
          class="text-input"
          :placeholder="isConfigured ? '输入消息，@ 引用...' : '请先配置 AI'"
          :disabled="!isConfigured"
          rows="1"
          @keydown="handleKeyDown"
          @input="handleInput"
        />

        <button
          class="send-btn"
          :disabled="!inputText.trim() && !pendingImages.length || sending"
          @click="send()"
        >
          <svg v-if="!sending" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 分享面板 -->
    <ShareSheet
      v-if="showShare && shareContent"
      :content="shareContent"
      @close="showShare = false"
    />
  </div>
</template>

<style scoped>
.ai-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  /* 留出顶部 action-row + 底部输入栏 + pill tab bar 的空间 */
  padding-bottom: calc(var(--pill-bar-height, 64px) + env(safe-area-inset-bottom, 0px) + var(--space-3) + 96px);
}

/* 顶部操作行 */
.action-row {
  display: flex;
  gap: var(--space-2);
  padding: 0 0 var(--space-3);
  flex-shrink: 0;
}
.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: var(--bg-100, rgba(0, 0, 0, 0.04));
  color: var(--color-text-secondary);
  border: 1px solid var(--color-divider);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  flex: 1;
  justify-content: center;
  transition: all var(--dur-fast);
}
.act-btn:active { transform: scale(0.96); }
.act-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.act-btn.configured {
  color: var(--color-success, #34c759);
  border-color: var(--color-success, #34c759);
}

/* 聊天区 */
.chat-area {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  padding: 0 0 var(--space-3);
  -webkit-overflow-scrolling: touch;
}
.tool-msg-hidden { display: none; }

/* 欢迎横幅 */
.welcome-banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-8, 32px) var(--space-5);
  gap: var(--space-3);
  text-align: center;
  margin: var(--space-4) 0;
}
.welcome-avatar {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--warm-300, #ffb340), var(--color-warm));
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  box-shadow: 0 4px 16px rgba(255, 149, 0, 0.25);
}
.welcome-text {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0;
}
.welcome-sub {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin: 0;
  max-width: 280px;
  line-height: 1.5;
}
.welcome-btn {
  margin-top: var(--space-2);
  padding: 8px 20px;
  border-radius: var(--radius-full);
  background: var(--color-warm);
  color: #fff;
  border: none;
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.suggestion-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: center;
  margin-top: var(--space-3);
}
.chip {
  padding: 6px 14px;
  border-radius: var(--radius-full);
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  color: var(--color-warm);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all var(--dur-fast);
}
.chip:active { transform: scale(0.96); }

/* 消息行 — content-visibility 实现浏览器原生虚拟化，跳过屏幕外布局/绘制 */
.msg-row {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  max-width: 92%;
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
  contain: layout paint style;
  animation: msg-fade-in 0.35s var(--ease-immersive) both;
}
@keyframes msg-fade-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.msg-row.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.msg-row.assistant {
  align-self: flex-start;
}

.msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}
.msg-avatar.user {
  background: var(--color-warm);
  color: #fff;
}
.msg-avatar.assistant {
  background: var(--warm-50, rgba(255, 149, 0, 0.12));
  color: var(--color-warm);
}

.msg-bubble-wrap {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
}
.msg-row.user .msg-bubble-wrap {
  align-items: flex-end;
}
.msg-row.assistant .msg-bubble-wrap {
  align-items: flex-start;
}

/* 引用 chips（消息上的） */
.cite-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 100%;
}
.cite-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  color: var(--color-warm);
  font-size: 10px;
  font-weight: var(--fw-medium);
  max-width: 160px;
}
.cite-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 引用按钮（悬浮在气泡旁） */
.cite-btn {
  position: absolute;
  top: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--bg-200);
  color: var(--color-text-tertiary);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast);
  padding: 0;
}
.msg-row.user .cite-btn {
  left: -28px;
}
.msg-row.assistant .cite-btn {
  right: -28px;
}
.msg-row:hover .cite-btn,
.msg-bubble-wrap:focus-within .cite-btn {
  opacity: 1;
}
.cite-btn:active { background: var(--bg-300, #d1d1d6); }

/* 气泡 */
.msg-bubble {
  border-radius: var(--radius-lg);
  padding: var(--space-2) var(--space-3);
  max-width: 100%;
  word-break: break-word;
  position: relative;
}
.msg-bubble.user {
  background: var(--color-warm);
  color: #fff;
  border-bottom-right-radius: var(--radius-xs);
}
.msg-bubble.assistant {
  background: var(--card-bg);
  box-shadow: var(--card-shadow);
  color: var(--color-text);
  border-bottom-left-radius: var(--radius-xs);
}
.msg-bubble.is-error {
  background: var(--danger-50, #ffe7e2);
  color: var(--danger-600, #c4180c);
  border: 1px solid var(--danger-200, #ffb4a8);
}

/* 错误详情 + 重试 */
.err-actions {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--danger-200, #ffb4a8);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.err-detail {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: var(--text-xs);
  color: var(--danger-700, #a3170a);
  line-height: 1.4;
  word-break: break-word;
}
.err-detail svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.err-text {
  flex: 1;
}
.retry-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: var(--radius-full);
  background: var(--danger-600, #c4180c);
  color: #fff;
  border: none;
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all var(--dur-fast);
}
.retry-btn:active { transform: scale(0.96); }
.retry-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 虚拟列表折叠提示 */
.virtual-fold {
  display: flex;
  justify-content: center;
  padding: var(--space-2) 0;
}
.fold-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  background: var(--bg-100, rgba(0, 0, 0, 0.04));
  color: var(--color-text-secondary);
  border: 1px solid var(--color-divider);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all var(--dur-fast);
}
.fold-btn:active { transform: scale(0.96); }

.msg-content {
  font-size: var(--text-sm);
  line-height: 1.5;
}
.msg-content :deep(h1),
.msg-content :deep(h2),
.msg-content :deep(h3) {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  margin: 6px 0 4px;
}
.msg-content :deep(p) { margin: 4px 0; }
.msg-content :deep(ul),
.msg-content :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}
.msg-content :deep(li) { margin: 2px 0; }
.msg-content :deep(code) {
  background: var(--bg-200);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.88em;
  font-family: var(--font-mono);
}
.msg-content :deep(pre) {
  background: var(--bg-200);
  padding: 10px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  margin: 6px 0;
}
.msg-content :deep(pre code) {
  background: transparent;
  padding: 0;
}
.msg-content :deep(blockquote) {
  border-left: 3px solid var(--color-warm);
  padding-left: 10px;
  color: var(--color-text-secondary);
  margin: 6px 0;
}
.msg-content :deep(strong) { font-weight: var(--fw-semibold); }
.msg-content :deep(a) { color: var(--color-warm); }

.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.msg-img {
  width: 120px;
  height: 120px;
  object-fit: cover;
  border-radius: var(--radius-md);
}

/* pending 指示 */
.pending-dots {
  display: flex;
  gap: 4px;
  padding: 2px 0;
}
.pending-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  animation: dot-bounce 1.2s infinite ease-in-out;
}
.pending-dots span:nth-child(2) { animation-delay: 0.2s; }
.pending-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dot-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* 工具结果卡片 */
.tool-results {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 100%;
  margin-top: 4px;
}

/* 堆叠工具卡片 */
.tool-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  position: relative;
}
.tool-stack-indicator {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 4px;
}
.tool-stack-sheet {
  position: absolute;
  top: 0;
  left: 4px;
  right: 4px;
  height: 100%;
  max-height: 32px;
  background: var(--card-bg);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--color-divider);
  pointer-events: none;
}
.stack-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--radius-full);
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  color: var(--color-warm);
  border: none;
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all var(--dur-fast);
  margin-top: var(--space-2);
}
.stack-toggle-btn:active { transform: scale(0.96); }
.stack-toggle-btn svg {
  transition: transform var(--dur-fast);
}
.stack-collapse-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  background: var(--bg-100, rgba(0, 0, 0, 0.04));
  color: var(--color-text-secondary);
  border: 1px solid var(--color-divider);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all var(--dur-fast);
  align-self: center;
  margin-top: 2px;
}
.stack-collapse-btn:active { transform: scale(0.96); }

/* ====== 引用选择器 ====== */
.cite-picker-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 300;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: var(--space-4);
  padding-bottom: calc(var(--pill-bar-height, 64px) + env(safe-area-inset-bottom, 0px) + 120px);
}
.cite-picker {
  width: 100%;
  max-width: 520px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-divider);
}
.picker-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.picker-close {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.picker-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.picker-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.picker-section-title {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
  padding: var(--space-1) 0;
}
.picker-item {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100, rgba(0, 0, 0, 0.02));
  border: none;
  border-radius: var(--radius-sm);
  text-align: left;
  cursor: pointer;
  align-items: flex-start;
}
.picker-item:active { background: var(--bg-200); }
.picker-role {
  font-size: 10px;
  font-weight: var(--fw-semibold);
  color: var(--color-warm);
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
  margin-top: 2px;
}
.picker-text {
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.4;
  flex: 1;
}
.picker-empty {
  text-align: center;
  padding: var(--space-6);
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

/* ====== 输入栏 ====== */
.input-bar-wrap {
  position: fixed;
  left: 0;
  right: 0;
  /* 与底部 pill tab bar 上下布局 */
  bottom: calc(var(--pill-bar-height, 64px) + env(safe-area-inset-bottom, 0px) + var(--space-3));
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  pointer-events: none;
}
.input-bar-wrap > * {
  pointer-events: auto;
}

.pending-cites {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 var(--space-1);
}
.pending-cite-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px 3px 10px;
  border-radius: var(--radius-full);
  background: var(--card-bg);
  color: var(--color-warm);
  font-size: 11px;
  font-weight: var(--fw-medium);
  box-shadow: var(--card-shadow);
  max-width: 200px;
}
.pcite-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pcite-x {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.pending-images {
  display: flex;
  gap: 6px;
  padding: 0 var(--space-1);
  flex-wrap: wrap;
}
.pending-img-wrap {
  position: relative;
  width: 64px;
  height: 64px;
}
.pending-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-md);
  box-shadow: var(--card-shadow);
}
.pending-img-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--color-text);
  color: #fff;
  border: 2px solid var(--color-bg);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

/* pill 风格输入栏 */
.input-bar {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  padding: 6px 8px;
  border-radius: var(--radius-full, 999px);
  background: var(--pill-bar-bg, rgba(255, 255, 255, 0.85));
  -webkit-backdrop-filter: blur(var(--pill-bar-blur, 24px)) saturate(180%);
  backdrop-filter: blur(var(--pill-bar-blur, 24px)) saturate(180%);
  box-shadow: var(--pill-bar-shadow, 0 4px 16px rgba(0, 0, 0, 0.08));
  border: 1px solid var(--material-thin-border, rgba(0, 0, 0, 0.06));
  max-width: 560px;
  margin: 0 auto;
  width: 100%;
}

.in-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: transparent;
  color: var(--color-text-secondary);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--dur-fast);
  padding: 0;
}
.in-btn:active {
  background: var(--bg-200);
  transform: scale(0.92);
}
.file-hidden {
  display: none;
}

.text-input {
  flex: 1;
  resize: none;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  padding: 8px 4px;
  font-size: var(--text-sm);
  line-height: 1.4;
  color: var(--color-text);
  min-height: 36px;
  max-height: 120px;
  outline: none;
  font-family: var(--font-sans);
}
.text-input::placeholder {
  color: var(--color-text-tertiary);
}
.text-input:disabled {
  opacity: 0.5;
}

.send-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-warm);
  color: #fff;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  transition: all var(--dur-fast);
  padding: 0;
}
.send-btn:disabled {
  background: var(--bg-300, #d1d1d6);
  cursor: not-allowed;
}
.send-btn:not(:disabled):active {
  transform: scale(0.92);
}
.send-btn .spin {
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 大屏：输入栏更窄 */
@media (min-width: 768px) {
  .input-bar {
    max-width: 480px;
  }
}
</style>
