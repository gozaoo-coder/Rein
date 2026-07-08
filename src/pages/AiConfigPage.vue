<script setup lang="ts">
/**
 * AiConfigPage — AI 聊天配置二级页
 * - baseURL / apiKey / model
 * - 模型列表通过 refreshModels() 拉取
 * - 自动检测 vision 模态，显示徽标
 * - autoExecute 开关
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAiConfigStore } from "@/stores/aiConfigStore";

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

onMounted(async () => {
  await cfg.load();
  baseURL.value = cfg.config.baseURL;
  apiKey.value = cfg.config.apiKey;
  model.value = cfg.config.model;
  autoExecute.value = cfg.config.autoExecute;
});

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
  baseURL.value = cfg.config.baseURL;
  apiKey.value = cfg.config.apiKey;
}

async function toggleAuto() {
  autoExecute.value = !autoExecute.value;
  await cfg.save({ autoExecute: autoExecute.value });
}

function goBack() {
  router.push("/ai");
}
</script>

<template>
  <div class="cfg-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <h2 class="sub-title">AI 配置</h2>
    </header>

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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
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
            <svg v-if="showApiKey" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
        <div class="field-hint">仅本地存储，不上传第三方</div>
      </div>

      <div class="field">
        <div class="field-label-row">
          <label class="field-label">模型</label>
          <button class="refresh-btn" :disabled="testing || !baseURL || !apiKey" @click="refreshModels">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" :class="{ spinning: testing }">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
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
            <svg v-if="model === m.id" class="check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
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

    <!-- 帮助 -->
    <section class="clean-card help-card">
      <h3 class="help-title">说明</h3>
      <ul class="help-list">
        <li>配置仅保存在本机（app_data_dir 或 localStorage）。</li>
        <li>支持 OpenAI 兼容接口：OpenAI / DeepSeek / 智谱 / Qwen / Claude 兼容代理等。</li>
        <li>模型列表通过 GET {baseURL}/models 拉取，失败可手动填入 id。</li>
        <li>视觉模型检测基于模型 id 关键字（gpt-4o / claude-3 / gemini / qwen-vl 等），支持图片输入时聊天输入框会出现图片按钮。</li>
      </ul>
    </section>
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
</style>
