<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import type { Agent, SessionMeta } from "../types";
import { formatSessionTime, previewText } from "../utils";
import Avatar from "../components/Avatar.vue";
import NewSessionSheet from "../components/NewSessionSheet.vue";
import { useBreakpoint } from "../composables/useBreakpoint";

const router = useRouter();
const showToast = inject<((text: string) => void) | undefined>("toast");
const isWide = useBreakpoint();

const sessions = ref<SessionMeta[]>([]);
const agents = ref<Agent[]>([]);
const keyword = ref("");
const loading = ref(true);

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return sessions.value;
  return sessions.value.filter(
    (s) => s.title.toLowerCase().includes(kw) || s.last_msg.toLowerCase().includes(kw),
  );
});

async function refresh() {
  sessions.value = await api.sessionsList();
  loading.value = false;
}

function onSessionsChanged() {
  refresh();
}

onMounted(() => {
  refresh();
  window.addEventListener("rein:sessions-changed", onSessionsChanged);
});
onUnmounted(() => {
  window.removeEventListener("rein:sessions-changed", onSessionsChanged);
});

function openSession(id: string) {
  router.push({ name: "chat-detail", params: { id } });
}

/* 新建会话 */
const showNewSheet = ref(false);

async function openNew() {
  agents.value = await api.agentsList();
  showNewSheet.value = true;
}

async function createSession(payload: { title: string; agentId: string | null }) {
  const session = await api.sessionCreate(payload.title, payload.agentId);
  showNewSheet.value = false;
  router.push({ name: "chat-detail", params: { id: session.id } });
}
</script>

<template>
  <!-- ======== 窄窗：手机式会话列表 ======== -->
  <div v-if="!isWide" class="page">
    <header class="topbar">
      <div class="topbar-left" />
      <div class="topbar-title">Rein</div>
      <div class="topbar-right">
        <button class="topbar-btn" title="新建会话" @click="openNew">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </header>

    <div class="search-bar">
      <div class="search-box">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
        <input v-model="keyword" placeholder="搜索" />
      </div>
    </div>

    <div v-if="!loading && filtered.length === 0" class="empty">
      <span class="big">💬</span>
      <span>{{ keyword ? "没有匹配的会话" : "还没有会话，点右上角 ＋ 开始聊天" }}</span>
    </div>

    <div v-else class="session-list">
      <div
        v-for="s in filtered"
        :key="s.id"
        class="session-item"
        :class="{ active: $route.name === 'chat-detail' && $route.params.id === s.id }"
        @click="openSession(s.id)"
      >
        <Avatar :emoji="s.agent_emoji" :color="s.agent_color" />
        <div class="session-main">
          <div class="session-row">
            <span class="session-name">{{ s.title }}</span>
            <span class="session-time">{{ formatSessionTime(s.last_ts) }}</span>
          </div>
          <div class="session-preview">
            <span class="session-preview-text">{{ previewText(s.last_msg) || "开始聊天吧" }}</span>
            <span v-if="s.unread > 0" class="badge">{{ s.unread > 99 ? "99+" : s.unread }}</span>
          </div>
        </div>
      </div>
    </div>

    <NewSessionSheet
      v-if="showNewSheet"
      :agents="agents"
      @close="showNewSheet = false"
      @create="createSession"
    />
  </div>

  <!-- ======== 宽窗：桌面会话列 ======== -->
  <aside v-else class="chat-column">
    <div class="column-head">
      <span class="column-title">会话</span>
      <button class="column-add" title="新建会话" @click="openNew">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <div class="column-search">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
      <input v-model="keyword" placeholder="搜索" />
    </div>
    <div class="column-list">
      <div
        v-for="s in filtered"
        :key="s.id"
        class="column-row"
        :class="{ on: $route.name === 'chat-detail' && $route.params.id === s.id }"
        @click="openSession(s.id)"
      >
        <Avatar :emoji="s.agent_emoji" :color="s.agent_color" size="sm" />
        <div class="column-main">
          <div class="column-top">
            <span class="column-name">{{ s.title }}</span>
            <span class="column-time">{{ formatSessionTime(s.last_ts) }}</span>
          </div>
          <span class="column-preview">{{ previewText(s.last_msg) || "开始聊天吧" }}</span>
        </div>
      </div>
      <div v-if="!loading && filtered.length === 0" class="column-empty">没有匹配的会话</div>
    </div>

    <NewSessionSheet
      v-if="showNewSheet"
      :agents="agents"
      @close="showNewSheet = false"
      @create="createSession"
    />
  </aside>
</template>
