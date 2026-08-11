<script setup lang="ts">
import { inject, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Agent, AgentMemory, CoreMemory, LoreEntry } from "../types";
import { newId } from "../utils";
import Avatar from "../components/Avatar.vue";

const router = useRouter();
const showToast = inject<((text: string) => void) | undefined>("toast");

const agents = ref<Agent[]>([]);

const COLORS = ["#07C160", "#10AEFF", "#FF9500", "#576B95", "#FA5151", "#8E44AD", "#E67E22", "#1ABC9C"];
const CATEGORIES = ["user_info", "preference", "relationship", "event", "fact", "custom"];

async function refresh() {
  agents.value = await api.agentsList();
}
onMounted(refresh);

async function startChat(agent: Agent) {
  const session = await api.sessionCreate(agent.name, agent.id);
  router.push(`/chat/${session.id}`);
}

/* ---------- 酒馆导入 ---------- */

const importing = ref(false);

async function importTavern() {
  try {
    const file = await open({
      multiple: false,
      filters: [{ name: "酒馆角色卡", extensions: ["png", "json"] }],
    });
    if (!file || typeof file !== "string") return;
    importing.value = true;
    const result = await api.tavernImport(file);
    agents.value = result.agents;
    showToast?.(`已导入「${result.imported.name}」（含 ${result.lore_count} 条世界观设定）`);
  } catch (e) {
    showToast?.(String(e));
  } finally {
    importing.value = false;
  }
}

/* ---------- 编辑/新增 ---------- */

const showEditor = ref(false);
const editing = ref<Agent | null>(null);
const form = ref<Agent>(blankAgent());
const tab = ref<"base" | "lore" | "memory">("base");
const memory = ref<AgentMemory | null>(null);

function blankAgent(): Agent {
  return {
    id: newId(),
    name: "",
    emoji: "🤖",
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    desc: "",
    system_prompt: "",
    greeting: "",
  };
}

async function openEditor(agent?: Agent) {
  editing.value = agent ?? null;
  form.value = agent ? { ...agent } : blankAgent();
  tab.value = "base";
  showEditor.value = true;
  await loadMemory();
}

async function loadMemory() {
  memory.value = await api.memoryGet(form.value.id);
}

async function save() {
  if (!form.value.name.trim()) {
    showToast?.("请输入智能体名称");
    return;
  }
  agents.value = await api.agentSave(form.value);
  showEditor.value = false;
  showToast?.(editing.value ? "已保存修改" : "智能体已创建");
}

async function remove() {
  if (!editing.value) return;
  const list = await api.agentDelete(editing.value.id);
  agents.value = list;
  showEditor.value = false;
  showToast?.("已删除智能体（含其记忆库）");
}

/* ---------- 世界观 ---------- */

const loreEditor = ref<{ entry: LoreEntry } | null>(null);
const loreDraft = ref<LoreEntry>(blankLore());

function blankLore(): LoreEntry {
  return {
    id: newId(),
    name: "",
    keys: [],
    content: "",
    enabled: true,
    constant: false,
    insertion_order: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function openLore(entry?: LoreEntry) {
  loreDraft.value = entry ? { ...entry } : blankLore();
  loreEditor.value = { entry: loreDraft.value };
}

function loreKeysText(): string {
  return loreDraft.value.keys.join("，");
}

function setLoreKeys(text: string) {
  loreDraft.value.keys = text
    .split(/[，,、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function saveLore() {
  if (!loreDraft.value.content.trim()) {
    showToast?.("请输入设定内容");
    return;
  }
  loreDraft.value.updated_at = Date.now();
  memory.value = await api.memoryLoreSave(form.value.id, { ...loreDraft.value });
  loreEditor.value = null;
  showToast?.("世界观已保存");
}

async function deleteLore(entryId: string) {
  memory.value = await api.memoryLoreDelete(form.value.id, entryId);
  showToast?.("已删除该设定");
}

async function toggleLore(entry: LoreEntry) {
  memory.value = await api.memoryLoreSave(form.value.id, { ...entry, enabled: !entry.enabled });
}

/* ---------- 记忆库 ---------- */

const coreEditor = ref(false);
const coreDraft = ref<CoreMemory>(blankCore());

function blankCore(): CoreMemory {
  return {
    id: newId(),
    category: "fact",
    content: "",
    importance: 5,
    created_at: Date.now(),
    updated_at: Date.now(),
    accessed_at: Date.now(),
  };
}

function openCore(entry?: CoreMemory) {
  coreDraft.value = entry ? { ...entry } : blankCore();
  coreEditor.value = true;
}

async function saveCore() {
  if (!coreDraft.value.content.trim()) {
    showToast?.("请输入记忆内容");
    return;
  }
  coreDraft.value.updated_at = Date.now();
  memory.value = await api.memoryCoreSave(form.value.id, { ...coreDraft.value });
  coreEditor.value = false;
  showToast?.("永久记忆已保存");
}

async function deleteCore(entryId: string) {
  memory.value = await api.memoryCoreDelete(form.value.id, entryId);
  showToast?.("已删除该记忆");
}

/* ---------- 情景检索 ---------- */

const recallQuery = ref("");
const recallResults = ref<{ id: string; condensed: string; ts: number; score: string }[]>([]);

async function doRecall() {
  const q = recallQuery.value.trim();
  if (!q) return;
  const items = await api.memoryRecall(form.value.id, q, 8);
  recallResults.value = items.map((it) => ({
    id: it.id,
    condensed: it.condensed,
    ts: it.ts,
    score: "",
  }));
}

const EMOJIS = ["🤖", "💻", "🌏", "✍️", "🎨", "🧮", "🎯", "📚", "🎬", "🧠", "⚡", "🛠️", "💼", "🎵"];
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="topbar-left" />
      <div class="topbar-title">智能体</div>
      <div class="topbar-right">
        <button class="topbar-btn" title="从酒馆导入角色卡" :disabled="importing" @click="importTavern">
          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
        </button>
        <button class="topbar-btn" title="新建智能体" @click="openEditor()">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </header>

    <div class="agent-grid" style="flex: 1; overflow-y: auto; align-content: start">
      <div v-for="a in agents" :key="a.id" class="agent-card" @click="startChat(a)">
        <Avatar :emoji="a.emoji" :color="a.color" />
        <div class="agent-name">{{ a.name }}</div>
        <div class="agent-desc">{{ a.desc }}</div>
        <div class="agent-chat-btn">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          开始对话
        </div>
        <button
          class="inputbar-icon"
          style="position: absolute; top: 8px; right: 8px; width: 28px; height: 28px"
          title="编辑"
          @click.stop="openEditor(a)"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
        </button>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="showEditor" class="overlay" @click="showEditor = false">
      <div class="sheet editor-sheet" @click.stop>
        <div class="sheet-title">{{ editing ? "编辑智能体" : "新建智能体" }}</div>

        <div class="editor-tabs">
          <button class="editor-tab" :class="{ on: tab === 'base' }" @click="tab = 'base'">基本信息</button>
          <button class="editor-tab" :class="{ on: tab === 'lore' }" @click="tab = 'lore'">
            世界观<em v-if="memory?.lore.length">{{ memory.lore.length }}</em>
          </button>
          <button class="editor-tab" :class="{ on: tab === 'memory' }" @click="tab = 'memory'">
            记忆库<em v-if="memory?.core.length">{{ memory.core.length }}</em>
          </button>
        </div>

        <div class="sheet-body">
          <!-- 基本信息 -->
          <div v-if="tab === 'base'" class="form-card" style="margin: 0">
            <div class="form-row">
              <span class="form-label">名称</span>
              <input v-model="form.name" class="form-input" placeholder="例如：周报助手" />
            </div>
            <div class="form-row">
              <span class="form-label">头像表情</span>
              <div style="display: flex; flex-wrap: wrap; gap: 6px">
                <button
                  v-for="e in EMOJIS"
                  :key="e"
                  class="emoji-pick"
                  :class="{ on: form.emoji === e }"
                  @click="form.emoji = e"
                >
                  {{ e }}
                </button>
              </div>
            </div>
            <div class="form-row">
              <span class="form-label">主题色</span>
              <div style="display: flex; gap: 8px">
                <button
                  v-for="c in COLORS"
                  :key="c"
                  class="color-pick"
                  :class="{ on: form.color === c }"
                  :style="{ background: c }"
                  @click="form.color = c"
                />
              </div>
            </div>
            <div class="form-row">
              <span class="form-label">简介</span>
              <input v-model="form.desc" class="form-input" placeholder="一句话介绍这个智能体" />
            </div>
            <div class="form-row">
              <span class="form-label">开场白（新会话的第一条消息）</span>
              <textarea v-model="form.greeting" class="form-input" rows="2" placeholder="例如：我是你的专属助手，随时可以开始 ~" />
            </div>
            <div class="form-row">
              <span class="form-label">系统提示词（决定它的性格与能力）</span>
              <textarea v-model="form.system_prompt" class="form-input" placeholder="你是……" />
            </div>
          </div>

          <!-- 世界观 -->
          <div v-else-if="tab === 'lore'" class="mem-tab">
            <p class="mem-hint">
              世界观设定会按「关键词」自动注入上下文；勾选常驻的设定则每次对话都生效。适合放角色背景、世界观规则、重要伏笔。
            </p>
            <button class="mem-add-btn" @click="openLore()">＋ 添加设定</button>
            <div v-if="!memory?.lore.length" class="mem-empty">还没有世界观设定，点击上方按钮添加</div>
            <div v-for="e in memory?.lore" :key="e.id" class="lore-card">
              <div class="lore-head">
                <span class="lore-name">{{ e.name || "未命名设定" }}</span>
                <span v-if="e.constant" class="lore-badge">常驻</span>
                <span class="lore-actions">
                  <button class="lore-btn" :title="e.enabled ? '停用' : '启用'" @click="toggleLore(e)">
                    {{ e.enabled ? "启用中" : "已停用" }}
                  </button>
                  <button class="lore-btn" @click="openLore(e)">编辑</button>
                  <button class="lore-btn danger" @click="deleteLore(e.id)">删除</button>
                </span>
              </div>
              <div v-if="e.keys.length" class="lore-keys">
                <span v-for="k in e.keys" :key="k" class="lore-key">{{ k }}</span>
              </div>
              <div class="lore-content" :class="{ off: !e.enabled }">{{ e.content }}</div>
            </div>
          </div>

          <!-- 记忆库 -->
          <div v-else class="mem-tab">
            <p class="mem-hint">
              永久记忆由主智能体在对话中自动提炼（也可手动增删），每次对话自动注入；情景记忆用于检索过往对话片段。
            </p>

            <div class="mem-sec-title">永久记忆（{{ memory?.core.length ?? 0 }}）</div>
            <button class="mem-add-btn" @click="openCore()">＋ 添加记忆</button>
            <div v-if="!memory?.core.length" class="mem-empty">暂无永久记忆，对话中告诉智能体「记住……」，或点击上方手动添加</div>
            <div v-for="c in memory?.core" :key="c.id" class="core-card">
              <div class="core-head">
                <span class="core-cat">{{ c.category }}</span>
                <span class="core-importance">{{ "★".repeat(Math.max(1, c.importance)) }}</span>
                <span class="lore-actions">
                  <button class="lore-btn" @click="openCore(c)">编辑</button>
                  <button class="lore-btn danger" @click="deleteCore(c.id)">删除</button>
                </span>
              </div>
              <div class="core-content">{{ c.content }}</div>
            </div>

            <div class="mem-sec-title">滚动摘要（{{ memory?.summaries.length ?? 0 }}）</div>
            <div v-if="!memory?.summaries.length" class="mem-empty">对话超过 20 轮后会自动压缩为摘要，实现无限上下文</div>
            <div v-for="s in memory?.summaries.slice().reverse()" :key="s.id" class="summary-card">{{ s.content }}</div>

            <div class="mem-sec-title">情景记忆检索</div>
            <div class="recall-row">
              <input v-model="recallQuery" class="recall-input" placeholder="搜索过往对话，如：上次聊过的跑步计划" @keydown.enter="doRecall" />
              <button class="mem-add-btn" style="margin: 0; flex: none" @click="doRecall">检索</button>
            </div>
            <div v-for="r in recallResults" :key="r.id" class="summary-card">
              <div class="epi-time">{{ new Date(r.ts).toLocaleString() }}</div>
              {{ r.condensed }}
            </div>
          </div>

          <div style="display: flex; gap: 10px; margin-top: 14px">
            <button class="btn btn-danger" style="flex: 1; margin: 0" @click="remove">删除</button>
            <button class="btn btn-primary" style="flex: 2; margin: 0" @click="save">保存</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 世界观条目编辑 -->
    <div v-if="loreEditor" class="modal" @click="loreEditor = null">
      <div class="modal-card lore-modal" @click.stop>
        <div class="modal-title">世界观设定</div>
        <div class="modal-body">
          <div class="form-row" style="padding: 6px 0">
            <span class="form-label">名称</span>
            <input v-model="loreDraft.name" class="form-input" placeholder="设定名称（可选）" />
          </div>
          <div class="form-row" style="padding: 6px 0">
            <span class="form-label">触发关键词（逗号分隔，对话中出现即注入）</span>
            <input class="form-input" :value="loreKeysText()" placeholder="如：龙族，艾拉，魔法" @input="setLoreKeys(($event.target as HTMLInputElement).value)" />
          </div>
          <div class="form-row" style="padding: 6px 0">
            <span class="form-label">设定内容</span>
            <textarea v-model="loreDraft.content" class="form-input" rows="6" placeholder="这个世界的规则、角色的背景……" />
          </div>
          <label class="chk-row">
            <input v-model="loreDraft.constant" type="checkbox" />
            <span>常驻注入（每次对话都生效，不依赖关键词）</span>
          </label>
        </div>
        <div class="modal-actions">
          <button @click="loreEditor = null">取消</button>
          <button class="primary" @click="saveLore">保存</button>
        </div>
      </div>
    </div>

    <!-- 永久记忆编辑 -->
    <div v-if="coreEditor" class="modal" @click="coreEditor = false">
      <div class="modal-card lore-modal" @click.stop>
        <div class="modal-title">永久记忆</div>
        <div class="modal-body">
          <div class="form-row" style="padding: 6px 0">
            <span class="form-label">分类</span>
            <div style="display: flex; flex-wrap: wrap; gap: 6px">
              <button
                v-for="c in CATEGORIES"
                :key="c"
                class="emoji-pick cat-chip"
                :class="{ on: coreDraft.category === c }"
                @click="coreDraft.category = c"
              >
                {{ c }}
              </button>
            </div>
          </div>
          <div class="form-row" style="padding: 6px 0">
            <span class="form-label">内容</span>
            <textarea v-model="coreDraft.content" class="form-input" rows="4" placeholder="例如：用户喜欢简洁的回答，讨厌客套话" />
          </div>
          <div class="form-row" style="padding: 6px 0">
            <span class="form-label">重要度 {{ coreDraft.importance }}/10</span>
            <div class="range-row">
              <input v-model.number="coreDraft.importance" type="range" min="1" max="10" step="1" />
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button @click="coreEditor = false">取消</button>
          <button class="primary" @click="saveCore">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.emoji-pick {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  font-size: 20px;
  background: var(--wx-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
}
.emoji-pick:hover {
  background: #e0e0e0;
}
.emoji-pick.on {
  background: #e7f8ee;
  outline: 2px solid var(--wx-green);
}
.color-pick {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  transition: all 0.12s;
}
.color-pick.on {
  outline: 2px solid #191919;
  outline-offset: 2px;
  transform: scale(1.1);
}

/* 编辑器布局 */
.editor-sheet {
  max-height: 92vh;
}
.editor-tabs {
  display: flex;
  flex: none;
  background: var(--wx-white);
  border-bottom: 1px solid var(--wx-divider);
}
.editor-tab {
  flex: 1;
  height: 42px;
  font-size: 14px;
  color: var(--wx-text-sub);
  position: relative;
}
.editor-tab em {
  font-style: normal;
  font-size: 10px;
  background: var(--wx-green);
  color: #fff;
  border-radius: 8px;
  padding: 1px 6px;
  margin-left: 4px;
  vertical-align: 2px;
}
.editor-tab.on {
  color: var(--wx-green);
  font-weight: 600;
}
.editor-tab.on::after {
  content: "";
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 0;
  width: 32px;
  height: 3px;
  border-radius: 2px;
  background: var(--wx-green);
}

/* 记忆库 */
.mem-tab {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mem-hint {
  font-size: 12px;
  color: var(--wx-text-sub);
  line-height: 1.6;
  background: #e7f8ee;
  border-radius: 8px;
  padding: 10px 12px;
}
.mem-sec-title {
  font-size: 13px;
  color: var(--wx-text-sub);
  margin-top: 10px;
}
.mem-add-btn {
  align-self: flex-start;
  font-size: 13px;
  color: var(--wx-green);
  background: var(--wx-white);
  border: 1px solid var(--wx-divider);
  border-radius: 16px;
  padding: 6px 14px;
  transition: all 0.12s;
}
.mem-add-btn:hover {
  border-color: var(--wx-green);
}
.mem-empty {
  font-size: 12.5px;
  color: #b2b2b2;
  padding: 8px 2px;
  line-height: 1.6;
}

.lore-card,
.core-card,
.summary-card {
  background: var(--wx-white);
  border-radius: 10px;
  padding: 12px;
}
.lore-head,
.core-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lore-name {
  font-size: 14px;
  font-weight: 600;
}
.lore-badge {
  font-size: 10px;
  color: #b36800;
  background: #fff3e0;
  border-radius: 8px;
  padding: 2px 8px;
}
.lore-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
  flex: none;
}
.lore-btn {
  font-size: 11.5px;
  color: var(--wx-blue);
  padding: 3px 8px;
  border-radius: 6px;
  background: #f0f3fa;
}
.lore-btn.danger {
  color: var(--wx-red);
  background: #fdeeee;
}
.lore-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 8px 0 6px;
}
.lore-key {
  font-size: 10.5px;
  color: #576b95;
  background: #eef1f8;
  border-radius: 8px;
  padding: 2px 8px;
}
.lore-content {
  font-size: 12.5px;
  color: var(--wx-text);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.lore-content.off {
  color: #b2b2b2;
}
.core-cat {
  font-size: 10.5px;
  color: var(--wx-green);
  background: #e7f8ee;
  border-radius: 8px;
  padding: 2px 8px;
}
.core-importance {
  font-size: 11px;
  color: #ff9500;
  letter-spacing: 1px;
}
.core-content {
  font-size: 13px;
  line-height: 1.6;
  margin-top: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.summary-card {
  font-size: 12.5px;
  color: var(--wx-text-sub);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.epi-time {
  font-size: 10.5px;
  color: #b2b2b2;
  margin-bottom: 4px;
}
.recall-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.recall-input {
  flex: 1;
  background: var(--wx-white);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
  border: 1px solid var(--wx-divider);
}

/* 条目编辑弹窗 */
.lore-modal {
  width: min(360px, 90vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
}
.lore-modal .modal-body {
  overflow-y: auto;
  flex: 1;
}
.chk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  padding: 4px 0;
  color: var(--wx-text);
}
.chk-row input {
  accent-color: var(--wx-green);
  width: 16px;
  height: 16px;
}
.cat-chip {
  width: auto;
  padding: 0 10px;
  font-size: 12px;
  height: 28px;
}
</style>
