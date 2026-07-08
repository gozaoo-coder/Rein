/**
 * usePiProvider — 把用户填写的 OpenAI 兼容 baseURL/apiKey 包装成 pi-ai 的 Provider。
 * 复用 pi-ai 内置的 openAICompletionsApi 实现，仅替换 baseUrl/auth/模型列表。
 *
 * 通过 createProvider 构造自定义 provider，注册到 MutableModels 集合中。
 * 模型列表通过 GET {baseURL}/models 拉取，并附带 vision 推断。
 */
import {
  createModels,
  createProvider,
  type Model,
  type MutableModels,
  type Provider,
  type ApiKeyAuth,
  type AuthResult,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ModelInfo } from "@/types/ai";

const PROVIDER_ID = "rein-custom-openai";

/** 单例 Models 集合（进程内） */
let modelsCollection: MutableModels | null = null;

function getCollection(): MutableModels {
  if (!modelsCollection) {
    modelsCollection = createModels();
  }
  return modelsCollection;
}

/** 由模型 id 推测能力（vision 关键字粗略匹配） */
export function inferCapabilities(modelId: string): string[] {
  const id = modelId.toLowerCase();
  const caps: string[] = ["text"];
  if (
    id.includes("vision") ||
    id.includes("gpt-4o") ||
    id.includes("gpt-4.1") ||
    id.includes("gpt-4.5") ||
    id.includes("gpt-5") ||
    id.includes("claude-3") ||
    id.includes("claude-sonnet") ||
    id.includes("claude-opus") ||
    id.includes("claude-haiku") ||
    id.includes("gemini-1.5") ||
    id.includes("gemini-2") ||
    id.includes("gemini-3") ||
    id.includes("qwen-vl") ||
    id.includes("qwen2-vl") ||
    id.includes("qwen3-vl") ||
    id.includes("vl-") ||
    id.includes("-vl") ||
    id.includes("multimodal") ||
    id.includes("omni")
  ) {
    caps.push("vision");
  }
  return caps;
}

/** 检测模型是否支持图片输入 */
export function checkVisionSupport(modelId: string, list?: ModelInfo[]): boolean {
  const m = list?.find((x) => x.id === modelId);
  if (m?.capabilities?.length) {
    return m.capabilities.includes("vision");
  }
  return inferCapabilities(modelId).includes("vision");
}

/** GET {baseURL}/models — 拉取模型列表 */
async function fetchModelList(baseURL: string, apiKey: string): Promise<ModelInfo[]> {
  const url = baseURL.replace(/\/+$/, "") + "/models";
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`获取模型列表失败 (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  const list = json.data ?? [];
  return list.map((m) => ({ id: m.id, capabilities: inferCapabilities(m.id) }));
}

/**
 * 构造一个 "ApiKey 直接返回" 的 auth — 不走环境变量，绕过 CredentialStore。
 * resolve() 永远从配置中读取，配置变更立即生效。
 */
function makeStaticApiKeyAuth(getKey: () => string): ApiKeyAuth {
  return {
    name: "OpenAI 兼容 API Key",
    resolve: async (): Promise<AuthResult | undefined> => {
      const key = getKey();
      if (!key) return undefined;
      return {
        auth: { apiKey: key },
        source: "user-config",
      };
    },
  };
}

/**
 * 构造或更新自定义 OpenAI 兼容 provider，并注册到 Models 集合。
 * 返回 provider id（用于后续 getModel 调用）。
 */
export function registerCustomProvider(opts: {
  baseURL: string;
  apiKey: string;
  cachedModels?: ModelInfo[];
}): Provider {
  const collection = getCollection();
  const cached = opts.cachedModels ?? [];

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "自定义 OpenAI 兼容",
    baseUrl: opts.baseURL,
    auth: { apiKey: makeStaticApiKeyAuth(() => opts.apiKey) },
    models: cached.map((m) => buildPiModel(m.id, opts.baseURL, m.capabilities?.includes("vision") ?? false)),
    api: openAICompletionsApi(),
    refreshModels: async () => {
      const list = await fetchModelList(opts.baseURL, opts.apiKey);
      return list.map((m) =>
        buildPiModel(m.id, opts.baseURL, m.capabilities?.includes("vision") ?? false),
      );
    },
  });

  collection.setProvider(provider);
  return provider;
}

/**
 * 构造一个 pi-ai Model<"openai-completions">。
 * vision=true 时 input 包含 image。
 */
export function buildPiModel(
  modelId: string,
  baseURL: string,
  vision: boolean,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: baseURL.replace(/\/+$/, ""),
    reasoning: false,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

/** 获取 Models 集合中的当前 provider；不存在则返回 undefined */
export function getCustomProvider(): Provider | undefined {
  return getCollection().getProvider(PROVIDER_ID);
}

/** 获取已注册的 Models 集合，用于 streamSimple 调用 */
export function getModelsCollection(): MutableModels {
  return getCollection();
}

/** 通过模型 id 在自定义 provider 中查找 pi-ai Model，未找到则现场构造（vision 自动推断） */
export function resolvePiModel(modelId: string, baseURL?: string): Model<"openai-completions"> | undefined {
  const collection = getCollection();
  const provider = collection.getProvider(PROVIDER_ID);
  if (!provider) {
    if (!baseURL) return undefined;
    return buildPiModel(modelId, baseURL, inferCapabilities(modelId).includes("vision"));
  }
  const found = provider.getModels().find((m) => m.id === modelId);
  if (found) return found as Model<"openai-completions">;
  // 模型列表未刷新但用户手填了 id：现场构造
  return buildPiModel(
    modelId,
    provider.baseUrl ?? baseURL ?? "",
    inferCapabilities(modelId).includes("vision"),
  );
}

/** 拉取模型列表并刷新 provider — 供 aiConfigStore 调用 */
export async function refreshCustomModels(baseURL: string, apiKey: string): Promise<ModelInfo[]> {
  let provider = getCustomProvider();
  if (!provider || provider.baseUrl !== baseURL.replace(/\/+$/, "")) {
    provider = registerCustomProvider({ baseURL, apiKey });
  }
  const list = await fetchModelList(baseURL, apiKey);
  // 重新注册以更新 models 缓存
  registerCustomProvider({ baseURL, apiKey, cachedModels: list });
  return list;
}
