<script setup lang="ts">
/**
 * AiHistoryPage — 历史会话二级页
 * - 列表（置顶优先 + 按更新时间倒序）
 * - 切换 / 置顶 / 重命名 / 删除
 * - 新建会话
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAiChatStore } from "@/stores/aiChatStore";
import { useAnime } from "@/composables/useAnime";
import type { Conversation } from "@/types/ai";

const router = useRouter();
const store = useAiChatStore();
const listRef = ref<HTMLElement | null>(null);
const { staggerEnter, reduced } = useAnime(listRef);
let staggerPlayed = false;

const renamingId = ref<string | null>(null);
const renameText = ref("");
const deleteConfirmId = ref<string | null>(null);

const list = computed(() => store.sortedConversations);

// 列表数据首次到位后播放 stagger 入场。
// useAnime.enter 仅设置目标值（from 取当前），故先手动预设起点 opacity:0 / translateY:12px。
// 尊重 reduced-motion：降级时跳过预设与播放，元素保持默认可见。
watch(
  list,
  () => {
    if (staggerPlayed) return;
    nextTick(() => {
      if (!listRef.value || staggerPlayed) return;
      const items = listRef.value.querySelectorAll(".conv-item");
      if (!items.length) return;
      staggerPlayed = true;
      if (reduced.value) return;
      items.forEach((el) => {
        const html = el as HTMLElement;
        html.style.opacity = "0";
        html.style.transform = "translateY(12px)";
      });
      staggerEnter(Array.from(items) as HTMLElement[], "fadeUp", "list");
    });
  },
  { flush: "post" },
);

onMounted(async () => {
  await store.load();
});

function open(conv: Conversation) {
  store.setActive(conv.id);
  router.push("/ai");
}

function newChat() {
  store.createConversation("新对话");
  router.push("/ai");
}

function startRename(conv: Conversation) {
  renamingId.value = conv.id;
  renameText.value = conv.title;
}

function confirmRename() {
  if (renamingId.value) {
    store.rename(renamingId.value, renameText.value.trim());
  }
  renamingId.value = null;
}

function cancelRename() {
  renamingId.value = null;
}

function askDelete(conv: Conversation) {
  deleteConfirmId.value = conv.id;
}

function confirmDelete() {
  if (!deleteConfirmId.value) return;
  store.deleteConversation(deleteConfirmId.value);
  deleteConfirmId.value = null;
}

function cancelDelete() {
  deleteConfirmId.value = null;
}

function fmtTime(ts: number): string {
  if (!ts) return "--";
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function preview(conv: Conversation): string {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === "user" || m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) return text.slice(0, 60);
    }
  }
  return "暂无消息";
}

function goBack() {
  router.push("/ai");
}
</script>

<template>
  <div class="hist-page" ref="listRef">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <i class="bi bi-chevron-left" style="font-size:22px"></i>
      </button>
      <h2 class="sub-title">历史会话</h2>
      <button class="new-btn" @click="newChat">
        <i class="bi bi-plus-lg" style="font-size:18px"></i>
        新建
      </button>
    </header>

    <!-- 列表 -->
    <div v-if="list.length" class="conv-list">
      <div
        v-for="conv in list"
        :key="conv.id"
        class="conv-item clean-card clean-card--interactive"
        :class="{ active: conv.id === store.activeId }"
        @click="renamingId === conv.id ? undefined : open(conv)"
      >
        <!-- 重命名模式 -->
        <div v-if="renamingId === conv.id" class="rename-row">
          <input
            v-model="renameText"
            class="rename-input"
            placeholder="对话标题"
            @keydown.enter="confirmRename"
            @keydown.esc="cancelRename"
          />
          <button class="rn-btn ok" @click.stop="confirmRename">保存</button>
          <button class="rn-btn" @click.stop="cancelRename">取消</button>
        </div>

        <!-- 常规展示 -->
        <template v-else>
          <div class="conv-main">
            <div class="conv-title-row">
              <span v-if="conv.pinned" class="pin">★</span>
              <span class="conv-title">{{ conv.title }}</span>
              <span v-if="conv.mode === 'workout'" class="mode-badge">运动</span>
            </div>
            <div class="conv-preview">{{ preview(conv) }}</div>
            <div class="conv-meta">
              <span>{{ conv.messages.length }} 条消息</span>
              <span class="dot">·</span>
              <span>{{ fmtTime(conv.updatedAt) }}</span>
            </div>
          </div>
          <div class="conv-ops">
            <button class="op-btn" @click.stop="store.togglePin(conv.id)" :title="conv.pinned ? '取消置顶' : '置顶'">
              <i :class="conv.pinned ? 'bi bi-pin-angle-fill' : 'bi bi-pin-angle'" style="font-size:16px"></i>
            </button>
            <button class="op-btn" @click.stop="startRename(conv)" title="重命名">
              <i class="bi bi-pencil-square" style="font-size:16px"></i>
            </button>
            <button class="op-btn danger" @click.stop="askDelete(conv)" title="删除">
              <i class="bi bi-trash3" style="font-size:16px"></i>
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- 空 -->
    <div v-else class="empty">
      <div class="empty-icon">
        <i class="bi bi-chat-dots" style="font-size:48px"></i>
      </div>
      <p class="empty-text">暂无历史会话</p>
      <button class="empty-btn" @click="newChat">开始新对话</button>
    </div>

    <!-- 删除确认 -->
    <div v-if="deleteConfirmId" class="modal-mask" @click.self="cancelDelete">
      <div class="clean-card modal">
        <h3 class="modal-title">删除对话</h3>
        <p class="modal-text">确认删除该会话？所有消息将丢失，不可撤销。</p>
        <div class="modal-actions">
          <button class="modal-btn ghost" @click="cancelDelete">取消</button>
          <button class="modal-btn danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hist-page {
  padding: var(--space-2) 0 var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sub-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-1);
}
.back-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.back-btn:active { transform: scale(0.92); }
.sub-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
  flex: 1;
}
.new-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  background: var(--color-warm);
  color: #fff;
  border: none;
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.new-btn:active { opacity: 0.85; }

/* 列表 */
.conv-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.conv-item {
  display: flex;
  align-items: stretch;
  padding: 0;
  overflow: hidden;
}
.conv-item.active {
  border: 1px solid var(--color-warm);
}
.conv-main {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  min-width: 0;
  cursor: pointer;
}
.conv-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.pin { color: var(--color-warm); font-size: var(--text-sm); }
.mode-badge {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: var(--radius-full);
  background: rgba(255, 159, 67, 0.15);
  color: var(--color-warm);
  font-weight: var(--fw-medium);
}
.conv-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-preview {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 4px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.4;
}
.conv-meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.conv-meta .dot { color: var(--color-text-tertiary); }

.conv-ops {
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--color-divider);
}
.op-btn {
  flex: 1;
  width: 44px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--dur-fast);
}
.op-btn:active { background: var(--bg-200); }
.op-btn.danger { color: var(--color-danger); }

/* 重命名 */
.rename-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
}
.rename-input {
  flex: 1;
  background: var(--bg-100, rgba(0, 0, 0, 0.03));
  border: 1px solid var(--color-warm);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: var(--text-sm);
  color: var(--color-text);
  outline: none;
  min-width: 0;
}
.rn-btn {
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  font-size: var(--text-xs);
  cursor: pointer;
}
.rn-btn.ok {
  background: var(--color-warm);
  color: #fff;
}

/* 空 */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-12, 64px) var(--space-5);
  color: var(--color-text-tertiary);
}
.empty-icon {
  color: var(--color-text-tertiary);
  opacity: 0.5;
}
.empty-text {
  font-size: var(--text-sm);
}
.empty-btn {
  padding: 8px 20px;
  border-radius: var(--radius-full);
  background: var(--color-warm);
  color: #fff;
  border: none;
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
}

/* 模态 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: var(--space-5);
}
.modal {
  width: 100%;
  max-width: 320px;
  padding: var(--space-5);
  text-align: center;
}
.modal-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0 0 var(--space-2);
}
.modal-text {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-4);
}
.modal-actions { display: flex; gap: var(--space-2); }
.modal-btn {
  flex: 1;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: none;
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.modal-btn.ghost { background: var(--bg-200); color: var(--color-text); }
.modal-btn.danger { background: var(--color-danger); color: #fff; }
</style>
