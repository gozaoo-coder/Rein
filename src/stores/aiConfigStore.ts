import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { AiConfig, ModelInfo } from "@/types/ai";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { fetchModels, checkVisionSupport } from "@/composables/useAiClient";

const CONFIG_KEY = "ai-config";
const MODELS_KEY = "ai-models-cache";

const DEFAULT_CONFIG: AiConfig = {
  baseURL: "",
  apiKey: "",
  model: "",
  vision: false,
  autoExecute: true,
};

export const useAiConfigStore = defineStore("aiConfig", () => {
  const config = ref<AiConfig>({ ...DEFAULT_CONFIG });
  const models = ref<ModelInfo[]>([]);
  const loaded = ref(false);
  const loadingModels = ref(false);
  const modelsError = ref<string | null>(null);

  const isConfigured = computed(
    () => !!config.value.baseURL && !!config.value.apiKey && !!config.value.model,
  );

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
    loaded.value = true;
  }

  async function save(patch: Partial<AiConfig>): Promise<void> {
    config.value = { ...config.value, ...patch };
    await writeJSON(CONFIG_KEY, config.value);
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
      const list = await fetchModels(config.value.baseURL, config.value.apiKey);
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

  return {
    config,
    models,
    loaded,
    loadingModels,
    modelsError,
    isConfigured,
    load,
    save,
    refreshModels,
    selectModel,
  };
});
