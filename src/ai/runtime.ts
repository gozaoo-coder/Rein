/**
 * pi-ai 运行时装配：把用户添加的模型配置（Rust ai_models）编译成 pi-ai 的
 * Models 集合。每个模型独立一个 Provider（携带各自 baseUrl / apiKey），
 * 请求参数格式（thinking 的 deepseek 写法、max_tokens 字段等）由 pi-ai
 * 按 baseUrl 自动探测，无需手工指定。
 *
 * 注意：pi 内置目录只有 deepseek-v4-flash/pro，视觉模型 deepseek-v4-flash-vision-exp
 * 不在其中，所以这里全部按「自建单模型 Provider」注册。
 */

import { createModels, createProvider, type Model, type Models } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

import type { AiModel } from '@/types'

/** 前端声明的模型属性（探测/识别侧共享） */
export interface CompiledModel {
  config: AiModel
  providerId: string
  model: Model<'openai-completions'>
}

export interface AiRuntime {
  models: Models
  byId: Map<number, CompiledModel>
  /** 默认模型；无默认时取第一条（探测后由 UI 决定哪个用于识别） */
  default: CompiledModel | null
}

export function buildRuntime(configs: AiModel[]): AiRuntime {
  const models = createModels()
  const byId = new Map<number, CompiledModel>()

  for (const c of configs) {
    const providerId = `rein-ai-${c.id}`
    const model: Model<'openai-completions'> = {
      id: c.modelId,
      name: c.name,
      api: 'openai-completions',
      provider: providerId,
      baseUrl: c.baseUrl,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // 未知上下文给中等安全值；maxTokens 仅决定单次默认上限，探测时用 maxTokens=1 覆盖
      contextWindow: 128_000,
      maxTokens: 8192,
    }
    models.setProvider(
      createProvider({
        id: providerId,
        name: c.name,
        baseUrl: c.baseUrl,
        auth: {
          apiKey: {
            name: c.name,
            resolve: async () => ({ auth: { apiKey: c.apiKey } }),
          },
        },
        models: [model],
        api: openAICompletionsApi(),
      }),
    )
    byId.set(c.id, { config: c, providerId, model })
  }

  const defaultEntry =
    configs.find((c) => c.isDefault) ?? configs[0]
  return { models, byId, default: defaultEntry ? (byId.get(defaultEntry.id) ?? null) : null }
}

/** 按模型 ID 找编译好的运行时（空模型集合时返回 null） */
export function getModelFromRuntime(rt: AiRuntime, id: number): CompiledModel | null {
  return rt.byId.get(id) ?? null
}
