/**
 * OpenAI 兼容客户端
 * - fetchModels: GET {baseURL}/models
 * - chatCompletion: POST {baseURL}/chat/completions (支持 tools / 流式关闭 / vision)
 *
 * 不依赖 SDK，直接 fetch，避免引入额外体积。
 */

import type { ModelInfo } from "@/types/ai";

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  tools?: ChatCompletionTool[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** 调用 /models 接口 */
export async function fetchModels(baseURL: string, apiKey: string): Promise<ModelInfo[]> {
  const url = joinUrl(baseURL, "models");
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

/** 由模型 id 推测能力（vision 关键字粗略匹配） */
function inferCapabilities(modelId: string): string[] {
  const id = modelId.toLowerCase();
  const caps: string[] = ["text"];
  if (
    id.includes("vision") ||
    id.includes("gpt-4o") ||
    id.includes("gpt-4.1") ||
    id.includes("claude-3") ||
    id.includes("claude-sonnet") ||
    id.includes("claude-opus") ||
    id.includes("claude-haiku") ||
    id.includes("gemini-1.5") ||
    id.includes("gemini-2") ||
    id.includes("qwen-vl") ||
    id.includes("vl-")
  ) {
    caps.push("vision");
  }
  return caps;
}

export function checkVisionSupport(modelId: string, models: ModelInfo[]): boolean {
  const m = models.find((x) => x.id === modelId);
  if (m?.capabilities?.length) {
    return m.capabilities.includes("vision");
  }
  return inferCapabilities(modelId).includes("vision");
}

/** 调用 /chat/completions */
export async function chatCompletion(
  baseURL: string,
  apiKey: string,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const url = joinUrl(baseURL, "chat/completions");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...req, stream: false }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`聊天请求失败 (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as ChatCompletionResponse;
}
