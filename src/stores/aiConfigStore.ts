import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { AiConfig, ModelInfo } from "@/types/ai";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { refreshCustomModels, checkVisionSupport, registerCustomProvider } from "@/composables/usePiProvider";

const CONFIG_KEY = "ai-config";
const MODELS_KEY = "ai-models-cache";
const PRESETS_KEY = "ai-presets";
const ACTIVE_PRESET_KEY = "ai-active-preset";

const DEFAULT_CONFIG: AiConfig = {
  baseURL: "",
  apiKey: "",
  model: "",
  vision: false,
  autoExecute: true,
};

/** 用户保存的预设配置（多平台） */
export interface AiPreset {
  id: string;
  name: string;
  config: AiConfig;
}

function genId(prefix = "preset"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useAiConfigStore = defineStore("aiConfig", () => {
  const config = ref<AiConfig>({ ...DEFAULT_CONFIG });
  const models = ref<ModelInfo[]>([]);
  const loaded = ref(false);
  const loadingModels = ref(false);
  const modelsError = ref<string | null>(null);

  /** 用户保存的预设列表 */
  const presets = ref<AiPreset[]>([]);
  /** 当前激活的预设 id；null 表示"当前配置"（未绑定预设） */
  const activePresetId = ref<string | null>(null);

  const isConfigured = computed(
    () => !!config.value.baseURL && !!config.value.apiKey && !!config.value.model,
  );

  /** 当前激活的预设（不存在则 null） */
  const activePreset = computed<AiPreset | null>(
    () => presets.value.find((p) => p.id === activePresetId.value) ?? null,
  );

  async function persistPresets(): Promise<void> {
    await Promise.all([
      writeJSON(PRESETS_KEY, presets.value),
      writeJSON(ACTIVE_PRESET_KEY, activePresetId.value),
    ]);
  }

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<AiConfig>(CONFIG_KEY);
    if (stored) {
      config.value = { ...DEFAULT_CONFIG, ...stored };
    }
    const cached = await readJSON<ModelInfo[]>(MODELS_KEY);
    if (cached && Array.isArray(cached)) {
      models.value = cached;
    }
    const storedPresets = await readJSON<AiPreset[]>(PRESETS_KEY);
    if (storedPresets && Array.isArray(storedPresets)) {
      presets.value = storedPresets;
    }
    const storedActive = await readJSON<string | null>(ACTIVE_PRESET_KEY);
    if (storedActive && presets.value.some((p) => p.id === storedActive)) {
      activePresetId.value = storedActive;
    } else {
      activePresetId.value = null;
    }
    // 启动时若已有配置，立即注册 provider（避免首次发送时 streamFn 找不到 provider）
    if (config.value.baseURL && config.value.apiKey) {
      registerCustomProvider({
        baseURL: config.value.baseURL,
        apiKey: config.value.apiKey,
        cachedModels: models.value,
      });
    }
    loaded.value = true;
  }

  async function save(patch: Partial<AiConfig>): Promise<void> {
    const prevBase = config.value.baseURL;
    const prevKey = config.value.apiKey;
    config.value = { ...config.value, ...patch };
    await writeJSON(CONFIG_KEY, config.value);
    // baseURL / apiKey 变化时重建 provider
    if (config.value.baseURL && config.value.apiKey && (config.value.baseURL !== prevBase || config.value.apiKey !== prevKey)) {
      registerCustomProvider({
        baseURL: config.value.baseURL,
        apiKey: config.value.apiKey,
        cachedModels: models.value,
      });
    }
    // 同步激活的预设：表单编辑后保持预设与当前配置一致
    if (activePresetId.value) {
      const idx = presets.value.findIndex((p) => p.id === activePresetId.value);
      if (idx >= 0) {
        presets.value[idx] = { ...presets.value[idx], config: { ...config.value } };
        await persistPresets();
      }
    }
  }

  /** 拉取模型列表，并更新 vision 标志 */
  async function refreshModels(): Promise<ModelInfo[]> {
    if (!config.value.baseURL || !config.value.apiKey) {
      modelsError.value = "请先填写 baseURL 和 apiKey";
      return [];
    }
    loadingModels.value = true;
    modelsError.value = null;
    try {
      const list = await refreshCustomModels(config.value.baseURL, config.value.apiKey);
      models.value = list;
      await writeJSON(MODELS_KEY, list);
      // 自动检测当前模型是否支持图片
      if (config.value.model) {
        const supports = checkVisionSupport(config.value.model, list);
        if (supports !== config.value.vision) {
          await save({ vision: supports });
        }
      }
      return list;
    } catch (e) {
      modelsError.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      loadingModels.value = false;
    }
  }

  /** 设置当前模型并自动检测 vision */
  async function selectModel(modelId: string): Promise<void> {
    const supports = checkVisionSupport(modelId, models.value);
    await save({ model: modelId, vision: supports });
  }

  /** 保存当前配置为新预设 */
  async function savePreset(name: string): Promise<AiPreset> {
    const preset: AiPreset = {
      id: genId(),
      name: name.trim() || `预设 ${presets.value.length + 1}`,
      config: { ...config.value },
    };
    presets.value = [...presets.value, preset];
    activePresetId.value = preset.id;
    await persistPresets();
    return preset;
  }

  /** 应用预设：载入 config + 重建 provider */
  async function applyPreset(id: string): Promise<void> {
    const preset = presets.value.find((p) => p.id === id);
    if (!preset) return;
    config.value = { ...preset.config };
    activePresetId.value = id;
    await writeJSON(CONFIG_KEY, config.value);
    if (config.value.baseURL && config.value.apiKey) {
      registerCustomProvider({
        baseURL: config.value.baseURL,
        apiKey: config.value.apiKey,
        cachedModels: models.value,
      });
    }
    await persistPresets();
  }

  /** 切换到"当前配置"（解除预设绑定，不改变 config） */
  async function useCurrentConfig(): Promise<void> {
    activePresetId.value = null;
    await persistPresets();
  }

  /** 删除预设 */
  async function deletePreset(id: string): Promise<void> {
    presets.value = presets.value.filter((p) => p.id !== id);
    if (activePresetId.value === id) {
      activePresetId.value = null;
    }
    await persistPresets();
  }

  /** 重命名预设 */
  async function renamePreset(id: string, name: string): Promise<void> {
    const idx = presets.value.findIndex((p) => p.id === id);
    if (idx < 0) return;
    presets.value[idx] = { ...presets.value[idx], name: name.trim() || presets.value[idx].name };
    await persistPresets();
  }

  return {
    config,
    models,
    loaded,
    loadingModels,
    modelsError,
    isConfigured,
    presets,
    activePresetId,
    activePreset,
    load,
    save,
    refreshModels,
    selectModel,
    savePreset,
    applyPreset,
    useCurrentConfig,
    deletePreset,
    renamePreset,
  };
});
