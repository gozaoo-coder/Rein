/**
 * useAiVisionEstimate — 通过配置的 OpenAI 兼容视觉模型估算食物份量（克）。
 *
 * 直接 fetch {baseURL}/chat/completions，不经过 pi-agent（轻量、无副作用）。
 * 需要 config.vision 或模型支持图像。
 */
import { useAiConfigStore } from "@/stores/aiConfigStore";

export interface EstimateResult {
  grams: number;
  reasoning?: string;
}

/** 把 File 转 data URL（base64） */
export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

/**
 * 估算图片中食物的克数。
 * @param foodName 食物名（提示词锚点）
 * @param imageDataURL data:image/...;base64,...
 */
export async function estimateGramsByVision(
  foodName: string,
  imageDataURL: string,
): Promise<EstimateResult> {
  const cfg = useAiConfigStore();
  const { baseURL, apiKey, model } = cfg.config;
  if (!baseURL || !apiKey || !model) {
    throw new Error("未配置 AI，请先在 AI 配置页填写 baseURL / apiKey / model");
  }

  const url = baseURL.replace(/\/$/, "") + "/chat/completions";
  const prompt = `你是营养估重助手。图片中的食物是「${foodName}」。请估算图中这份食物的克数(g)。
只返回一个 JSON 对象，格式：{"grams": <数字>, "reasoning": "<简短理由>"}。不要输出其他内容。`;

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataURL } },
        ],
      },
    ],
    max_tokens: 200,
    temperature: 0.2,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`AI 请求失败 ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI 未返回有效结果");
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("AI 结果解析失败");
  }
  const grams = Number(parsed.grams);
  if (!Number.isFinite(grams) || grams <= 0) throw new Error("AI 估算克数无效");
  return { grams: Math.round(grams), reasoning: parsed.reasoning };
}
