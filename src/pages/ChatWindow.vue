<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, onChatStream } from "../api";
import type { ChatMessage, CoreMemory, Session } from "../types";
import { formatMessageTime, newId, shouldShowTime } from "../utils";
import Avatar from "../components/Avatar.vue";
import ChatBody from "../components/ChatBody.vue";
import ChatInputBar from "../components/ChatInputBar.vue";
import { useBreakpoint } from "../composables/useBreakpoint";

const route = useRoute();
const router = useRouter();
const showToast = inject<((text: string) => void) | undefined>("toast");
const isWide = useBreakpoint();

const session = ref<Session | null>(null);
const messages = ref<ChatMessage[]>([]);
const input = ref("");
const sending = ref(false);
const streamingId = ref<string | null>(null);
const streamingText = ref("");
const bodyEl = ref<{ rootEl: HTMLElement | null } | null>(null);

function scrollEl(): HTMLElement | null {
  return bodyEl.value?.rootEl ?? null;
}
const inputEl = ref<HTMLTextAreaElement | null>(null);
const showMenu = ref(false);

const sessionId = computed(() => route.params.id as string);
const title = computed(() => session.value?.title ?? "");
const sub = computed(() => (session.value?.agent_id ? session.value.agent_name : "AI 助手 · 回复由大模型生成"));
const canSend = computed(() => input.value.trim().length > 0 && !sending.value);

async function scrollBottom(smooth = false) {
  await nextTick();
  const el = scrollEl();
  if (el) {
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }
}

function autosize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

async function load() {
  session.value = await api.sessionOpen(sessionId.value);
  messages.value = session.value.messages.map((m) => ({ ...m }));
  await scrollBottom();
}

let unsubscribers: (() => void)[] = [];

onMounted(async () => {
  await load();

  unsubscribers = await Promise.all(
    onChatStream({
      onStart: () => {
        streamingId.value = newId();
        streamingText.value = "";
        scrollEl()?.scrollTo({ top: scrollEl()!.scrollHeight, behavior: "smooth" });
      },
      onDelta: (e) => {
        if (e.session_id !== sessionId.value) return;
        streamingId.value ??= e.message_id;
        streamingText.value += e.delta ?? "";
        scrollBottom(true);
      },
      onReasoning: () => {
        streamingId.value ??= newId();
      },
      onDone: (e) => {
        if (e.session_id !== sessionId.value) return;
        if (e.content) {
          messages.value.push({ id: e.message_id, role: "assistant", content: e.content, ts: Date.now() });
        }
        streamingId.value = null;
        streamingText.value = "";
        sending.value = false;
        window.dispatchEvent(new CustomEvent("rein:sessions-changed"));
        scrollBottom(true);
      },
      onError: (e) => {
        if (e.session_id !== sessionId.value) return;
        streamingId.value = null;
        streamingText.value = "";
        sending.value = false;
        showToast?.(e.error ?? "出错了");
      },
    }),
  );
});

onUnmounted(() => {
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];
});

watch(
  () => route.params.id,
  async (id) => {
    if (id) await load();
  },
);

async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  const cmd = /^\/(记住|忘记|记忆)\s*(.*)$/.exec(text);
  if (cmd) {
    input.value = "";
    autosize();
    await handleMemoryCmd(cmd[1], cmd[2]);
    return;
  }
  input.value = "";
  autosize();
  messages.value.push({ id: newId(), role: "user", content: text, ts: Date.now() });
  sending.value = true;
  await scrollBottom(true);
  try {
    await api.chatSend(sessionId.value, text);
  } catch (e) {
    sending.value = false;
    streamingId.value = null;
    showToast?.(String(e));
  }
}

async function handleMemoryCmd(cmd: string, arg: string) {
  const agentKey = session.value?.agent_id ?? "__default__";
  const reply = (content: string) => {
    messages.value.push({ id: newId(), role: "assistant", content, ts: Date.now() });
    scrollBottom(true);
  };
  try {
    if (cmd === "记住") {
      if (!arg.trim()) return reply("用法：/记住 想记住的内容");
      const mem = await api.memoryGet(agentKey);
      const entry: CoreMemory = {
        id: newId(),
        category: "custom",
        content: arg.trim(),
        importance: 5,
        created_at: Date.now(),
        updated_at: Date.now(),
        accessed_at: Date.now(),
      };
      await api.memoryCoreSave(agentKey, entry);
      reply(`已记住：${arg.trim()}`);
    } else if (cmd === "忘记") {
      if (!arg.trim()) return reply("用法：/忘记 想删除的记忆内容");
      const mem = await api.memoryGet(agentKey);
      const hits = mem.core.filter((c) => c.content.includes(arg.trim()));
      for (const h of hits) await api.memoryCoreDelete(agentKey, h.id);
      reply(hits.length ? `已忘记 ${hits.length} 条记忆` : "没有找到相关记忆");
    } else {
      const mem = await api.memoryGet(agentKey);
      const list = mem.core.map((c) => `· ${c.content}`).join("\n") || "（暂无永久记忆）";
      reply(`【永久记忆】\n${list}\n\n摘要 ${mem.summaries.length} 段 · 情景记忆 ${mem.episodic.length} 条`);
    }
  } catch (e) {
    showToast?.(String(e));
  }
}

async function clearHistory() {
  showMenu.value = false;
  await api.sessionClear(sessionId.value);
  messages.value = [];
  showToast?.("已清空聊天记录");
  window.dispatchEvent(new CustomEvent("rein:sessions-changed"));
}

async function deleteSession() {
  showMenu.value = false;
  await api.sessionDelete(sessionId.value);
  window.dispatchEvent(new CustomEvent("rein:sessions-changed"));
  router.push({ name: "chat" });
}

function showTimeAt(i: number): boolean {
  return shouldShowTime(messages.value[i - 1], messages.value[i]);
}

function renderContent(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((p) =>
      p.startsWith("```") && p.endsWith("```") && p.length > 6
        ? `<pre>${esc(p.slice(3, -3).replace(/^\n/, ""))}</pre>`
        : `<span>${esc(p).replace(/\\n/g, "\n").replace(/\n/g, "<br>")}</span>`,
    )
    .join("");
}

watch(input, autosize);
</script>

<template>
  <!-- ======== 窄窗：手机式聊天页 ======== -->
  <div v-if="!isWide" class="page chat-page">
    <header class="topbar">
      <div class="topbar-left">
        <button class="topbar-btn" @click="router.back()">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
      </div>
      <div class="topbar-center">
        <div class="topbar-title">{{ title }}</div>
        <div class="topbar-sub">{{ sub }}</div>
      </div>
      <div class="topbar-right">
        <button class="topbar-btn" @click="showMenu = !showMenu">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
        </button>
      </div>
    </header>

    <ChatBody
      ref="bodyEl"
      :session="session"
      :messages="messages"
      :streaming-id="streamingId"
      :streaming-text="streamingText"
      :sending="sending"
      :show-time-at="showTimeAt"
      :render-content="renderContent"
    />

    <ChatInputBar v-model="input" :can-send="canSend" @send="send" />
  </div>

  <!-- ======== 宽窗：桌面聊天面板 ======== -->
  <section v-else class="chat-panel">
    <header class="panel-head">
      <div class="panel-title-wrap">
        <div class="panel-title">{{ title }}</div>
        <div class="panel-sub">{{ sub }}</div>
      </div>
      <div class="panel-actions">
        <button class="panel-btn" title="清空聊天记录" @click="clearHistory">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
        <button class="panel-btn" title="删除会话" @click="deleteSession">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
      </div>
    </header>

    <ChatBody
      ref="bodyEl"
      :session="session"
      :messages="messages"
      :streaming-id="streamingId"
      :streaming-text="streamingText"
      :sending="sending"
      :show-time-at="showTimeAt"
      :render-content="renderContent"
    />

    <ChatInputBar v-model="input" :can-send="canSend" @send="send" />
  </section>
</template>
