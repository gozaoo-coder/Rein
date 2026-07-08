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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAiChatStore } from "@/stores/aiChatStore";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import { useToast } from "@/composables/useToast";
import { useTopBar, ICONS } from "@/composables/useTopBar";
import AiToolCard from "@/components/ai/AiToolCard.vue";
import MarkdownRenderer from "@/components/ai/MarkdownRenderer.vue";
import ShareSheet from "@/components/share/ShareSheet.vue";
import { formatAiChat } from "@/data/shareFormatters";
import type { Citation, ChatMessage, ContentPart, Conversation } from "@/types/ai";
import type { ShareContent } from "@/types/share";

const router = useRouter();
const route = useRoute();
const store = useAiChatStore();
const cfg = useAiConfigStore();
const toast = useToast();
const { setActions, clearActions } = useTopBar();

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

function syncTopBar() {
  setActions([
    { id: "history", icon: ICONS.history, label: "历史", onClick: goHistory },
    { id: "new", icon: ICONS.plus, label: "新对话", onClick: newChat },
    { id: "share", icon: ICONS.share, label: "分享", onClick: openShare },
    { id: "config", icon: ICONS.config, label: isConfigured.value ? "已配置" : "配置", onClick: goConfig },
  ]);
}

// ====== 生命周期 ======

onMounted(async () => {
  syncTopBar();
  await Promise.all([cfg.load(), store.load()]);
  if (!store.active && store.conversations.length === 0) {
    store.createConversation("新对话");
  } else if (!store.active && store.conversations.length) {
    store.setActive(store.conversations[0].id);
  }
  syncTopBar();
  const prefill = route.query.prefill;
  if (typeof prefill === "string" && prefill.trim()) {
    inputText.value = prefill.trim();
    await nextTick();
    scrollToBottom();
  }
  scrollToBottom();
});

onUnmounted(() => {
  clearActions();
});

watch(isConfigured, () => syncTopBar());

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
    <!-- 聊天滚动区 -->
    <div ref="chatRef" class="chat-area scrollbar-hide">
      <!-- 未配置提示 -->
      <div v-if="!isConfigured" class="welcome-banner clean-card">
        <div class="welcome-avatar">
          <i class="bi bi-stars" style="font-size:32px"></i>
        </div>
        <p class="welcome-text">欢迎使用 Rein AI 助手</p>
        <p class="welcome-sub">请先配置 API 信息以启用聊天功能</p>
        <button class="welcome-btn" @click="goConfig">前往配置</button>
      </div>

      <!-- 欢迎横幅（已配置但无消息） -->
      <div v-else-if="allMessages.length === 0" class="welcome-banner clean-card">
        <div class="welcome-avatar">
          <i class="bi bi-stars" style="font-size:32px"></i>
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
          <i class="bi bi-chevron-up" style="font-size:14px"></i>
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
            <i v-if="msg.role === 'assistant'" class="bi bi-stars" style="font-size:16px"></i>
            <i v-else class="bi bi-person" style="font-size:16px"></i>
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
                <i class="bi bi-pin-angle" style="font-size:11px"></i>
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
              <i class="bi bi-pin-angle" style="font-size:12px"></i>
            </button>

            <!-- 气泡 -->
            <div class="msg-bubble" :class="[msg.role, { 'is-error': msg.error }]">
              <!-- 文本内容 -->
              <div
                v-if="msg.role === 'assistant' && textOf(msg)"
                class="msg-content"
              >
                <!-- 统一 markdown 渲染：流式打字机 + 静态一次性 -->
                <MarkdownRenderer
                  :content="textOf(msg)"
                  :streaming="!!msg.pending"
                />
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
                  <i class="bi bi-exclamation-triangle-fill" style="font-size:12px"></i>
                  <span class="err-text">{{ msg.error }}</span>
                </div>
                <button class="retry-btn" @click="retryLast">
                  <i class="bi bi-arrow-clockwise" style="font-size:12px"></i>
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
                      <i class="bi bi-chevron-down" style="font-size:14px"></i>
                      <span>展开 {{ visibleToolResults(msg).length }} 张卡片</span>
                    </button>
                  </div>
                  <!-- 展开后提供收起按钮 -->
                  <button
                    v-if="isStackExpanded(msg.id)"
                    class="stack-collapse-btn"
                    @click="toggleStack(msg.id)"
                  >
                    <i class="bi bi-chevron-up" style="font-size:14px"></i>
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
          <i class="bi bi-pin-angle" style="font-size:10px"></i>
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
          <i class="bi bi-pin-angle" style="font-size:18px"></i>
        </button>

        <label v-if="vision" class="in-btn" title="附加图片">
          <i class="bi bi-camera" style="font-size:18px"></i>
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
          <i v-if="!sending" class="bi bi-send" style="font-size:18px"></i>
          <i v-else class="bi bi-arrow-repeat spin" style="font-size:18px"></i>
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

/* 聊天滚动区 */
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
.err-detail i {
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
  line-height: 1.55;
}
.msg-content :deep(h1) {
  font-size: 18px;
  font-weight: var(--fw-bold);
  margin: 10px 0 6px;
  color: var(--color-text);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--color-divider);
}
.msg-content :deep(h2) {
  font-size: 16px;
  font-weight: var(--fw-semibold);
  margin: 8px 0 4px;
  color: var(--color-text);
}
.msg-content :deep(h3) {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  margin: 6px 0 3px;
  color: var(--color-text);
}
.msg-content :deep(h4),
.msg-content :deep(h5),
.msg-content :deep(h6) {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  margin: 6px 0 2px;
  color: var(--color-text-secondary);
}
.msg-content :deep(p) { margin: 5px 0; }
.msg-content :deep(ul),
.msg-content :deep(ol) {
  padding-left: 22px;
  margin: 5px 0;
}
.msg-content :deep(li) { margin: 3px 0; }
.msg-content :deep(li::marker) { color: var(--color-warm); }
.msg-content :deep(code) {
  background: var(--bg-200);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.88em;
  font-family: var(--font-mono);
  color: var(--color-warm);
}
.msg-content :deep(pre) {
  background: transparent;
  padding: 0;
  border-radius: 0;
  overflow-x: auto;
  margin: 0;
}
.msg-content :deep(pre code) {
  background: transparent;
  padding: 0;
  color: var(--color-text);
  font-size: 0.85em;
}
.msg-content :deep(.code-block) {
  background: var(--bg-200);
  border-radius: var(--radius-md);
  margin: 8px 0;
  overflow: hidden;
  border: 1px solid var(--color-divider);
}
.msg-content :deep(.code-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: var(--bg-300);
  border-bottom: 1px solid var(--color-divider);
}
.msg-content :deep(.code-lang) {
  font-size: 11px;
  font-weight: var(--fw-semibold);
  color: var(--color-text-secondary);
  letter-spacing: 0.5px;
}
.msg-content :deep(.copy-code-btn) {
  background: transparent;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: 11px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-immersive);
}
.msg-content :deep(.copy-code-btn:hover) {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}
.msg-content :deep(.copy-code-btn:active) { transform: scale(0.94); }
.msg-content :deep(.code-block pre) {
  padding: 10px 12px;
  overflow-x: auto;
}
.msg-content :deep(blockquote) {
  border-left: 3px solid var(--color-warm);
  padding: 4px 12px;
  color: var(--color-text-secondary);
  margin: 8px 0;
  background: var(--bg-100);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.msg-content :deep(strong) {
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.msg-content :deep(em) { color: var(--color-text-secondary); }
.msg-content :deep(a) {
  color: var(--color-warm);
  text-decoration: none;
  border-bottom: 1px dashed var(--color-warm);
}
.msg-content :deep(a:hover) { opacity: 0.8; }
.msg-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-divider);
  margin: 10px 0;
}
.msg-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
  font-size: 0.92em;
  display: block;
  overflow-x: auto;
}
.msg-content :deep(thead) {
  background: var(--bg-200);
}
.msg-content :deep(th),
.msg-content :deep(td) {
  border: 1px solid var(--color-divider);
  padding: 5px 10px;
  text-align: left;
}
.msg-content :deep(th) {
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.msg-content :deep(td) { color: var(--color-text-secondary); }
.msg-content :deep(tbody tr:nth-child(even)) {
  background: var(--bg-100);
}
.msg-content :deep(kbd) {
  background: var(--bg-200);
  border: 1px solid var(--color-divider);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 0.85em;
  font-family: var(--font-mono);
}
.msg-content :deep(mark) {
  background: rgba(255, 149, 0, 0.2);
  color: var(--color-warm);
  padding: 0 3px;
  border-radius: 3px;
}
.msg-content :deep(del) {
  color: var(--color-text-tertiary);
  text-decoration: line-through;
}
.msg-content :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-sm);
  margin: 6px 0;
}

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
.stack-toggle-btn i {
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
