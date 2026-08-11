<script setup lang="ts">
import { inject, onMounted, reactive, ref } from "vue";
import { api } from "../api";
import type { AppConfig } from "../types";

const showToast = inject<((text: string) => void) | undefined>("toast");

const config = reactive<AppConfig>({
  provider: "deepseek",
  api_key: "",
  base_url: "",
  model: "deepseek-chat",
  temperature: 0.7,
  system_prompt: "",
  memory_provider: "",
  memory_base_url: "",
  memory_api_key: "",
  memory_model: "",
  embedding_model: "",
});
const saved = ref(false);
const probing = ref(false);
const probeResult = ref<string>("");

const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", emoji: "🐋", desc: "deepseek-chat / reasoner", url: "https://api.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "openai", name: "OpenAI", emoji: "🟢", desc: "GPT 系列", url: "https://api.openai.com/v1", models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3-mini"] },
  { id: "ollama", name: "Ollama", emoji: "🦙", desc: "本地模型，无需 Key", url: "http://localhost:11434/v1", models: ["llama3.1", "qwen2.5", "deepseek-r1"] },
  { id: "compatible", name: "OpenAI 兼容", emoji: "🔌", desc: "任意兼容端点", url: "https://your-endpoint/v1", models: [] },
];

const current = computedProvider();

function computedProvider() {
  return PROVIDERS.find((p) => p.id === config.provider) ?? PROVIDERS[0];
}

function pickProvider(id: string) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) return;
  config.provider = id;
  config.base_url = p.url;
  if (p.models.length > 0) config.model = p.models[0];
  saved.value = false;
}

function pickModel(m: string) {
  config.model = m;
  saved.value = false;
}

onMounted(async () => {
  const c = await api.configGet();
  Object.assign(config, c);
  const p = PROVIDERS.find((x) => x.id === c.provider);
  if (p && !config.base_url.trim()) config.base_url = p.url;
});

async function save() {
  await api.configSave({ ...config });
  saved.value = true;
  showToast?.("配置已保存");
}

async function probe() {
  probing.value = true;
  probeResult.value = "";
  try {
    await api.modelProbe();
    probeResult.value = `✅ 连接成功：${config.provider} / ${config.model}`;
  } catch (e) {
    probeResult.value = `❌ ${String(e)}`;
  } finally {
    probing.value = false;
  }
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="topbar-left" />
      <div class="topbar-title">模型配置</div>
      <div class="topbar-right">
        <button class="topbar-btn" title="保存" @click="save">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </button>
      </div>
    </header>

    <div class="list-group">
      <div class="group-title">选择服务商</div>
      <div class="provider-grid">
        <div
          v-for="p in PROVIDERS"
          :key="p.id"
          class="provider-card"
          :class="{ active: config.provider === p.id }"
          @click="pickProvider(p.id)"
        >
          <span class="provider-emoji">{{ p.emoji }}</span>
          <div>
            <div class="provider-name">{{ p.name }}</div>
            <div class="provider-desc">{{ p.desc }}</div>
          </div>
        </div>
      </div>

      <div class="group-title">连接参数</div>
      <div class="form-card">
        <div class="form-row">
          <span class="form-label">API Key（{{ config.provider }}）</span>
          <input
            v-model="config.api_key"
            type="password"
            class="form-input"
            :placeholder="config.provider === 'ollama' ? '本地服务无需 Key，可留空' : 'sk-…'"
          />
        </div>
        <div class="form-row">
          <span class="form-label">Base URL</span>
          <input v-model="config.base_url" class="form-input mono" placeholder="https://api.deepseek.com" />
        </div>
        <div class="form-row">
          <span class="form-label">模型</span>
          <input v-model="config.model" class="form-input mono" placeholder="deepseek-chat" />
          <div v-if="current.models.length" style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px">
            <button
              v-for="m in current.models"
              :key="m"
              class="model-chip"
              :class="{ on: config.model === m }"
              @click="pickModel(m)"
            >
              {{ m }}
            </button>
          </div>
        </div>
        <div class="form-row">
          <span class="form-label">温度（越低越严谨，越高越有创意）</span>
          <div class="range-row">
            <input v-model.number="config.temperature" type="range" min="0" max="2" step="0.1" />
            <span class="range-val">{{ config.temperature.toFixed(1) }}</span>
          </div>
        </div>
      </div>

      <div class="group-title">默认系统提示词（未指定智能体时生效）</div>
      <div class="form-card">
        <div class="form-row">
          <textarea v-model="config.system_prompt" class="form-input" rows="3" />
        </div>
      </div>

      <div class="group-title">记忆模型（摘要/事实抽取专用，留空则跟随主模型）</div>
      <div class="form-card">
        <div class="form-row">
          <span class="form-label">服务商</span>
          <select v-model="config.memory_provider" class="form-select">
            <option value="">跟随主模型</option>
            <option v-for="p in PROVIDERS" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="form-row">
          <span class="form-label">API Key（留空跟随主模型）</span>
          <input v-model="config.memory_api_key" type="password" class="form-input" placeholder="sk-…" />
        </div>
        <div class="form-row">
          <span class="form-label">Base URL（留空跟随主模型）</span>
          <input v-model="config.memory_base_url" class="form-input mono" placeholder="https://api.deepseek.com" />
        </div>
        <div class="form-row">
          <span class="form-label">记忆模型</span>
          <input v-model="config.memory_model" class="form-input mono" placeholder="留空则用主模型，如 deepseek-chat" />
        </div>
        <div class="form-row">
          <span class="form-label">嵌入模型（向量检索用；Ollama 如 nomic-embed-text）</span>
          <input v-model="config.embedding_model" class="form-input mono" placeholder="如 text-embedding-3-small / nomic-embed-text" />
        </div>
      </div>

      <div style="display: flex; gap: 10px; padding: 6px 12px 16px">
        <button class="btn btn-primary" style="flex: 1; margin: 0" :disabled="!config.api_key && config.provider !== 'ollama'" @click="probe">
          {{ probing ? "连接中…" : "测试连接" }}
        </button>
        <button class="btn" style="flex: 1; margin: 0; background: var(--wx-white)" @click="save">保存配置</button>
      </div>
      <div v-if="probeResult" class="probe-result">{{ probeResult }}</div>
      <div v-if="saved" class="probe-result ok">配置已保存，新的对话将使用当前模型</div>
    </div>
  </div>
</template>

<style scoped>
.model-chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 12px;
  background: var(--wx-bg);
  color: var(--wx-text);
  transition: all 0.12s;
  font-family: Consolas, monospace;
}
.model-chip:hover {
  background: #e0e0e0;
}
.model-chip.on {
  background: #e7f8ee;
  color: var(--wx-green);
  font-weight: 600;
}
.form-select {
  width: 100%;
  font-size: 14px;
  padding: 8px 10px;
  background: var(--wx-white);
  border: 1px solid var(--wx-divider);
  border-radius: 8px;
  color: var(--wx-text);
  outline: none;
}
.probe-result {
  margin: 0 12px 10px;
  padding: 10px 14px;
  background: var(--wx-white);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-all;
}
.probe-result.ok {
  color: var(--wx-green);
}
</style>
