<script setup lang="ts">
/**
 * AiConfigPage — AI 聊天配置二级页
 * - baseURL / apiKey / model
 * - 模型列表通过 refreshModels() 拉取
 * - 自动检测 vision 模态，显示徽标
 * - autoExecute 开关
 * - 多平台预设：保存/应用/重命名/删除 + 一键模板
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import type { AiPreset } from "@/stores/aiConfigStore";
import { BottomSheet } from "@/components/ui";

const router = useRouter();
const cfg = useAiConfigStore();

const baseURL = ref("");
const apiKey = ref("");
const model = ref("");
const autoExecute = ref(true);
const showApiKey = ref(false);
const testing = ref(false);
const testMsg = ref<string | null>(null);
const testOk = ref(false);

/** 内置一键模板（仅填 baseURL，用户自行输入 apiKey） */
const PRESET_TEMPLATES = [
  { name: "OpenAI", baseURL: "https://api.openai.com/v1" },
  { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1" },
  { name: "智谱", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "Qwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
];

onMounted(async () => {
  await cfg.load();
  syncFromConfig();
});

function syncFromConfig() {
  baseURL.value = cfg.config.baseURL;
  apiKey.value = cfg.config.apiKey;
  model.value = cfg.config.model;
  autoExecute.value = cfg.config.autoExecute;
}

async function saveAll() {
  await cfg.save({
    baseURL: baseURL.value.trim(),
    apiKey: apiKey.value.trim(),
    autoExecute: autoExecute.value,
  });
}

async function refreshModels() {
  testMsg.value = null;
  await saveAll();
  testing.value = true;
  try {
    const list = await cfg.refreshModels();
    testOk.value = true;
    testMsg.value = `已获取 ${list.length} 个模型`;
  } catch (e) {
    testOk.value = false;
    testMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    testing.value = false;
  }
}

async function pickModel(id: string) {
  model.value = id;
  await cfg.selectModel(id);
  syncFromConfig();
}

async function toggleAuto() {
  autoExecute.value = !autoExecute.value;
  await cfg.save({ autoExecute: autoExecute.value });
}

// ===== 预设选择 =====
const selectedPreset = computed<string>({
  get: () => cfg.activePresetId ?? "",
  set: (v) => {
    void onPresetChange(v);
  },
});

async function onPresetChange(value: string) {
  if (!value) {
    await cfg.useCurrentConfig();
    return;
  }
  await cfg.applyPreset(value);
  syncFromConfig();
}

// ===== 保存 / 重命名 命名弹层 =====
const showNaming = ref(false);
const namingMode = ref<"create" | "rename">("create");
const namingId = ref<string>("");
const namingName = ref("");

function openSavePreset() {
  namingMode.value = "create";
  namingName.value = "";
  showNaming.value = true;
}

function openRename(p: AiPreset) {
  namingMode.value = "rename";
  namingId.value = p.id;
  namingName.value = p.name;
  showNaming.value = true;
}

async function confirmName() {
  const name = namingName.value.trim();
  if (!name) return;
  if (namingMode.value === "create") {
    await cfg.savePreset(name);
  } else {
    await cfg.renamePreset(namingId.value, name);
  }
  showNaming.value = false;
}

// ===== 删除（二次确认） =====
const pendingDeleteId = ref<string | null>(null);
let deleteTimer: ReturnType<typeof setTimeout> | null = null;

async function removePreset(p: AiPreset) {
  if (pendingDeleteId.value === p.id) {
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = null;
    pendingDeleteId.value = null;
    await cfg.deletePreset(p.id);
    return;
  }
  pendingDeleteId.value = p.id;
  deleteTimer = setTimeout(() => {
    pendingDeleteId.value = null;
    deleteTimer = null;
  }, 3000);
}

// ===== 一键模板 =====
async function applyTemplate(t: { name: string; baseURL: string }) {
  await cfg.useCurrentConfig();
  baseURL.value = t.baseURL;
  await saveAll();
  testMsg.value = null;
}

function goBack() {
  router.push("/ai");
}
</script>

<template>
  <div class="cfg-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <i class="bi bi-chevron-left" style="font-size:22px"></i>
      </button>
      <h2 class="sub-title">AI 配置</h2>
    </header>

    <!-- 预设选择 + 保存 -->
    <section class="clean-card preset-card">
      <div class="preset-head">
        <div class="preset-label">
          <i class="bi bi-collection" style="font-size:16px"></i>
          <span>配置预设</span>
        </div>
        <button class="save-preset-btn" @click="openSavePreset">
          <i class="bi bi-bookmark-plus" style="font-size:14px"></i>
          <span>保存为预设</span>
        </button>
      </div>
      <div class="preset-select-wrap">
        <i class="bi bi-boxes preset-select-icon" style="font-size:16px"></i>
        <select v-model="selectedPreset" class="preset-select">
          <option value="">当前配置（未绑定预设）</option>
          <option v-for="p in cfg.presets" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <i class="bi bi-chevron-down preset-select-arrow" style="font-size:12px"></i>
      </div>
    </section>

    <!-- 一键模板 -->
    <section class="clean-card template-card">
      <div class="template-label">一键填充平台</div>
      <div class="template-row">
        <button
          v-for="t in PRESET_TEMPLATES"
          :key="t.name"
          class="template-chip"
          :class="{ active: baseURL.trim() === t.baseURL }"
          @click="applyTemplate(t)"
        >
          {{ t.name }}
        </button>
      </div>
    </section>

    <!-- 当前状态卡 -->
    <section class="clean-card status-card" :class="{ configured: cfg.isConfigured }">
      <div class="status-left">
        <div class="status-dot" :class="cfg.isConfigured ? 'on' : 'off'" />
        <div>
          <div class="status-title">{{ cfg.isConfigured ? "已配置" : "未配置" }}</div>
          <div class="status-sub">
            <template v-if="cfg.isConfigured">
              {{ cfg.config.model }}
              <span v-if="cfg.config.vision" class="vision-tag">视觉</span>
            </template>
            <template v-else>请填写 baseURL / apiKey / model</template>
          </div>
        </div>
      </div>
      <div v-if="cfg.config.vision" class="vision-badge">
        <i class="bi bi-eye" style="font-size:14px"></i>
        <span>Vision</span>
      </div>
    </section>

    <!-- 表单 -->
    <section class="clean-card form-card">
      <div class="field">
        <label class="field-label">Base URL</label>
        <input
          v-model="baseURL"
          class="field-input"
          placeholder="https://api.openai.com/v1"
          type="url"
          @blur="saveAll"
        />
        <div class="field-hint">OpenAI 兼容接口根路径，含 /v1</div>
      </div>

      <div class="field">
        <label class="field-label">API Key</label>
        <div class="field-row">
          <input
            v-model="apiKey"
            class="field-input"
            placeholder="sk-..."
            :type="showApiKey ? 'text' : 'password'"
            autocomplete="off"
            @blur="saveAll"
          />
          <button class="eye-btn" @click="showApiKey = !showApiKey" :aria-label="showApiKey ? '隐藏' : '显示'">
            <i v-if="showApiKey" class="bi bi-eye-slash" style="font-size:18px"></i>
            <i v-else class="bi bi-eye" style="font-size:18px"></i>
          </button>
        </div>
        <div class="field-hint">仅本地存储，不上传第三方</div>
      </div>

      <div class="field">
        <div class="field-label-row">
          <label class="field-label">模型</label>
          <button class="refresh-btn" :disabled="testing || !baseURL || !apiKey" @click="refreshModels">
            <i class="bi bi-arrow-clockwise" style="font-size:14px" :class="{ spinning: testing }"></i>
            {{ testing ? "拉取中..." : "刷新模型列表" }}
          </button>
        </div>
        <div v-if="cfg.modelsError" class="field-error">{{ cfg.modelsError }}</div>
        <div v-if="testMsg" class="field-msg" :class="{ ok: testOk, err: !testOk }">{{ testMsg }}</div>

        <div v-if="cfg.models.length" class="model-list">
          <button
            v-for="m in cfg.models"
            :key="m.id"
            class="model-item"
            :class="{ active: model === m.id }"
            @click="pickModel(m.id)"
          >
            <div class="model-id">{{ m.id }}</div>
            <div class="model-caps">
              <span v-for="c in m.capabilities" :key="c" class="cap-tag" :data-cap="c">{{ c }}</span>
            </div>
            <i v-if="model === m.id" class="bi bi-check-lg check" style="font-size:16px"></i>
          </button>
        </div>
        <div v-else class="empty-models">
          <input
            v-model="model"
            class="field-input"
            placeholder="手动输入模型 id"
            @blur="cfg.save({ model: model })"
          />
        </div>
      </div>

      <div class="field">
        <label class="field-label">自动执行工具</label>
        <div class="toggle-row">
          <div class="toggle-text">
            <div class="toggle-title">允许 AI 直接修改课程/动作库</div>
            <div class="toggle-sub">关闭后 AI 仅返回建议，不实际写入</div>
          </div>
          <button class="toggle" :class="{ on: autoExecute }" @click="toggleAuto">
            <span class="toggle-knob" />
          </button>
        </div>
      </div>
    </section>

    <!-- 已保存预设列表 -->
    <section v-if="cfg.presets.length" class="clean-card preset-list-card">
      <div class="preset-list-head">已保存预设</div>
      <div class="preset-list">
        <div
          v-for="p in cfg.presets"
          :key="p.id"
          class="preset-row"
          :class="{ active: cfg.activePresetId === p.id }"
        >
          <button class="preset-row-main" @click="cfg.activePresetId !== p.id && onPresetChange(p.id)">
            <div class="preset-row-name">
              <i class="bi bi-bookmark-fill preset-row-icon" style="font-size:14px"></i>
              <span class="preset-row-title">{{ p.name }}</span>
              <span v-if="cfg.activePresetId === p.id" class="preset-row-badge">当前</span>
            </div>
            <div class="preset-row-sub">
              {{ p.config.baseURL || "—" }}
              <span v-if="p.config.model"> · {{ p.config.model }}</span>
            </div>
          </button>
          <div class="preset-row-actions">
            <button class="icon-action" aria-label="重命名" @click="openRename(p)">
              <i class="bi bi-pencil" style="font-size:14px"></i>
            </button>
            <button
              class="icon-action danger"
              :class="{ confirm: pendingDeleteId === p.id }"
              :aria-label="pendingDeleteId === p.id ? '再次点击确认删除' : '删除'"
              @click="removePreset(p)"
            >
              <i class="bi bi-trash" style="font-size:14px"></i>
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 帮助 -->
    <section class="clean-card help-card">
      <h3 class="help-title">说明</h3>
      <ul class="help-list">
        <li>配置仅保存在本机（app_data_dir 或 localStorage）。</li>
        <li>支持 OpenAI 兼容接口：OpenAI / DeepSeek / 智谱 / Qwen / Claude 兼容代理等。</li>
        <li>模型列表通过 GET {baseURL}/models 拉取，失败可手动填入 id。</li>
        <li>视觉模型检测基于模型 id 关键字（gpt-4o / claude-3 / gemini / qwen-vl 等），支持图片输入时聊天输入框会出现图片按钮。</li>
        <li>预设可保存多套配置快速切换；编辑当前表单会同步更新已激活的预设。</li>
      </ul>
    </section>

    <!-- 命名弹层 -->
    <BottomSheet v-model:visible="showNaming" :title="namingMode === 'create' ? '保存为预设' : '重命名预设'" :detents="['medium']" default-detent="medium">
      <div class="naming-body">
        <input
          v-model="namingName"
          class="field-input naming-input"
          placeholder="预设名称"
          maxlength="30"
          @keydown.enter="confirmName"
        />
        <div class="naming-actions">
          <button class="naming-btn naming-cancel" @click="showNaming = false">取消</button>
          <button class="naming-btn naming-ok" :disabled="!namingName.trim()" @click="confirmName">
            {{ namingMode === 'create' ? '保存' : '重命名' }}
          </button>
        </div>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.cfg-page {
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
}

/* 预设选择卡 */
.preset-card {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.preset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.preset-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.preset-label i { color: var(--color-warm); }
.save-preset-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-immersive);
}
.save-preset-btn:active { transform: scale(0.95); }

.preset-select-wrap {
  position: relative;
  display: flex;
  align-items: center;
  background: var(--bg-100);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  padding: 0 var(--space-3);
}
.preset-select-icon {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  margin-right: var(--space-2);
}
.preset-select {
  flex: 1;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  border: none;
  outline: none;
  padding: var(--space-3) var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text);
  cursor: pointer;
  min-width: 0;
}
.preset-select-arrow {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  pointer-events: none;
}

/* 一键模板 */
.template-card {
  padding: var(--space-4) var(--space-5);
}
.template-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-semibold);
  margin-bottom: var(--space-2);
}
.template-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.template-chip {
  padding: 6px 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-immersive);
}
.template-chip:active { transform: scale(0.95); }
.template-chip.active {
  background: var(--warm-50);
  border-color: var(--color-warm);
  color: var(--color-warm);
}

/* 状态卡 */
.status-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5);
  gap: var(--space-3);
}
.status-card.configured { border-left: 3px solid var(--color-success, #34c759); }
.status-left { display: flex; align-items: center; gap: var(--space-3); min-width: 0; flex: 1; }
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.on { background: var(--color-success, #34c759); box-shadow: 0 0 0 4px rgba(52, 199, 89, 0.15); }
.status-dot.off { background: var(--color-text-tertiary); }
.status-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.status-sub {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.vision-tag {
  font-size: 10px;
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  color: var(--color-warm);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  font-weight: var(--fw-medium);
}
.vision-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  background: var(--warm-50, rgba(255, 149, 0, 0.1));
  color: var(--color-warm);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
}

/* 表单 */
.form-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.field-label {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.field-row {
  display: flex;
  gap: var(--space-2);
  align-items: stretch;
}
.field-input {
  flex: 1;
  background: var(--bg-100, rgba(0, 0, 0, 0.03));
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text);
  outline: none;
  transition: border-color var(--dur-fast);
  min-width: 0;
}
.field-input:focus { border-color: var(--color-warm); }
.field-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.field-error {
  font-size: var(--text-xs);
  color: var(--color-danger);
  background: var(--danger-50, #ffe7e2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
}
.field-msg {
  font-size: var(--text-xs);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
}
.field-msg.ok { color: var(--success-600, #1a7f37); background: var(--success-50, #e8f8ee); }
.field-msg.err { color: var(--danger-600, #c4180c); background: var(--danger-50, #ffe7e2); }
.eye-btn {
  width: 44px;
  border: 1px solid var(--color-divider);
  background: var(--bg-100, rgba(0, 0, 0, 0.03));
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.eye-btn:active { background: var(--bg-200); }
.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--color-warm);
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  padding: 4px 10px;
  border-radius: var(--radius-full);
  border: none;
  cursor: pointer;
  font-weight: var(--fw-medium);
}
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.refresh-btn .spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 模型列表 */
.model-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 320px;
  overflow-y: auto;
  padding: 2px;
}
.model-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-100, rgba(0, 0, 0, 0.02));
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  transition: all var(--dur-fast);
}
.model-item:hover { background: var(--bg-200); }
.model-item.active {
  background: var(--warm-50, rgba(255, 149, 0, 0.08));
  border-color: var(--color-warm);
}
.model-id {
  flex: 1;
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.model-caps {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.cap-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-200);
  color: var(--color-text-secondary);
}
.cap-tag[data-cap="vision"] {
  background: var(--warm-50, rgba(255, 149, 0, 0.1));
  color: var(--color-warm);
  font-weight: var(--fw-medium);
}
.check { color: var(--color-warm); flex-shrink: 0; }
.empty-models { /* nothing special */ }

/* toggle */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.toggle-text { flex: 1; min-width: 0; }
.toggle-title {
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: var(--fw-medium);
}
.toggle-sub {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}
.toggle {
  width: 44px;
  height: 26px;
  border-radius: var(--radius-full);
  background: var(--bg-300, #d1d1d6);
  border: none;
  position: relative;
  cursor: pointer;
  transition: background var(--dur-fast);
  flex-shrink: 0;
  padding: 0;
}
.toggle.on { background: var(--color-warm); }
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform var(--dur-fast) var(--ease-immersive);
}
.toggle.on .toggle-knob { transform: translateX(18px); }

/* 预设列表 */
.preset-list-card {
  padding: var(--space-5);
}
.preset-list-head {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin-bottom: var(--space-3);
}
.preset-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.preset-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  transition: all var(--dur-fast);
}
.preset-row.active {
  background: var(--warm-50);
  border-color: var(--color-warm);
}
.preset-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  padding: 0;
}
.preset-row-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.preset-row-icon { color: var(--color-text-tertiary); flex-shrink: 0; }
.preset-row.active .preset-row-icon { color: var(--color-warm); }
.preset-row-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preset-row-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--color-warm);
  color: #fff;
  font-weight: var(--fw-semibold);
  flex-shrink: 0;
}
.preset-row-sub {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preset-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.icon-action {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--dur-fast);
}
.icon-action:active { transform: scale(0.9); }
.icon-action.danger { color: var(--color-danger); }
.icon-action.danger.confirm {
  background: var(--color-danger);
  color: #fff;
  animation: shake 0.3s var(--ease-immersive);
}
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-2px); }
  75% { transform: translateX(2px); }
}

/* 帮助卡 */
.help-card { padding: var(--space-5); }
.help-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0 0 var(--space-2);
}
.help-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.help-list li {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  padding-left: var(--space-3);
  position: relative;
  line-height: 1.5;
}
.help-list li::before {
  content: "·";
  position: absolute;
  left: 0;
  color: var(--color-text-tertiary);
  font-weight: bold;
}

/* 命名弹层 */
.naming-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-2) var(--space-4);
}
.naming-input {
  background: var(--bg-100);
}
.naming-actions {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
}
.naming-btn {
  padding: var(--space-2) var(--space-5);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all var(--dur-fast);
}
.naming-cancel {
  background: var(--bg-200);
  color: var(--color-text-secondary);
}
.naming-cancel:active { transform: scale(0.96); }
.naming-ok {
  background: var(--color-warm);
  color: #fff;
}
.naming-ok:disabled { opacity: 0.4; cursor: not-allowed; }
.naming-ok:not(:disabled):active { transform: scale(0.96); }
</style>
