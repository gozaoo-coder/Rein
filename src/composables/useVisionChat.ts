/**
 * useVisionChat — 一次性视觉模型调用（非 agent 循环）。
 * 复用 aiConfigStore 的 baseURL/apiKey/model，直接 POST 到 OpenAI 兼容的 /chat/completions。
 * 用于 FoodPage 拍照识别饮食等场景：传入图片 data URL + prompt，返回文本。
 */
import { useAiConfigStore } from "@/stores/aiConfigStore";

export interface VisionChatOptions {
  /** 系统提示词 */
  systemPrompt?: string;
  /** 温度，默认 0.2 */
  temperature?: number;
  /** 最大输出 token */
  maxTokens?: number;
  /** 超时 ms，默认 60s */
  timeoutMs?: number;
}

/**
 * 发起一次视觉聊天请求。
 * @param images data: URL 数组（base64 编码图片）
 * @param prompt 文本提示
 * @returns 模型输出的文本
 */
export async function visionChat(
  images: string[],
  prompt: string,
  opts: VisionChatOptions = {},
): Promise<string> {
  const cfg = useAiConfigStore();
  if (!cfg.isConfigured) {
    throw new Error("请先配置 AI（baseURL/apiKey/model）");
  }
  if (!cfg.config.vision) {
    throw new Error("当前模型不支持图片输入，请在 AI 配置页选择视觉模型");
  }
  if (!images.length) {
    throw new Error("未提供图片");
  }

  const baseURL = cfg.config.baseURL.replace(/\/+$/, "");
  const url = `${baseURL}/chat/completions`;
  const body: Record<string, unknown> = {
    model: cfg.config.model,
    messages: [
      ...(opts.systemPrompt
        ? [{ role: "system", content: opts.systemPrompt }]
        : []),
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((img) => ({
            type: "image_url",
            image_url: { url: img },
          })),
        ],
      },
    ],
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`视觉模型请求失败 (${res.status}): ${text || res.statusText}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export interface TextCompleteOptions {
  /** 温度，默认 0.2 */
  temperature?: number;
  /** 最大输出 token */
  maxTokens?: number;
  /** 超时 ms，默认 60s */
  timeoutMs?: number;
}

/**
 * 发起一次纯文本聊天补全请求（无图片），复用 aiConfigStore 配置。
 * 直接 POST 到 OpenAI 兼容的 /chat/completions，不经过 pi-agent。
 * @param prompt 用户消息文本
 * @returns 模型输出的文本
 */
export async function textComplete(
  prompt: string,
  opts: TextCompleteOptions = {},
): Promise<string> {
  const cfg = useAiConfigStore();
  if (!cfg.isConfigured) {
    throw new Error("请先配置 AI（baseURL/apiKey/model）");
  }

  const baseURL = cfg.config.baseURL.replace(/\/+$/, "");
  const url = `${baseURL}/chat/completions`;
  const body: Record<string, unknown> = {
    model: cfg.config.model,
    messages: [{ role: "user", content: prompt }],
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI 请求失败 (${res.status}): ${text || res.statusText}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}
