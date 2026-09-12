/**
 * 模型配置域工具：AI 可查看并维护自己的模型列表（ai_models 表）。
 * 走 useModelsStore 的增删改通道（内部已做 service 调用 + 强制刷新），
 * 保证聊天下一轮选模与「模型」页看到的一定是最新配置。
 *
 * 隐私约定：工具结果一律不回传 apiKey 明文（避免用户其他 provider 的密钥
 * 随对话上下文流向当前模型的服务器），只给末 4 位 keyTail 供指认。
 */

import { Type } from '@earendil-works/pi-ai'

import { useModelsStore } from '@/stores/models'
import type { AiModel, AiModelInput } from '@/types'
import { defineTool, type AppTool } from './types'

/** 能力三态 → 模型可读标签 */
function cap(v: boolean | null): string {
  return v === true ? '支持' : v === false ? '不支持' : '未探测'
}

/** 列表投影：裁剪 + 掩码密钥 */
function brief(m: AiModel) {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    modelId: m.modelId,
    baseUrl: m.baseUrl,
    isDefault: m.isDefault,
    vision: cap(m.vision),
    thinking: cap(m.thinking),
    effort: cap(m.effort),
    imageMaxEdge: m.imageMaxEdge,
    apiKeyTail: `****${m.apiKey.slice(-4)}`,
    lastError: m.lastError ? m.lastError.slice(0, 160) : null,
  }
}

/** 确保列表已加载并取出目标模型；不存在时抛可重试的中文错误 */
async function mustGet(store: ReturnType<typeof useModelsStore>, id: number): Promise<AiModel> {
  if (!store.loaded) await store.load()
  const m = store.models.find((x) => x.id === id)
  if (!m) throw new Error(`模型不存在（id=${id}）。先调用 list_models 查看现有配置的 id。`)
  return m
}

function nonEmpty(label: string, v: string | undefined, fallback: string): string {
  const t = v?.trim()
  if (!t) {
    if (v === undefined || v === '') return fallback
    throw new Error(`${label}不能为空`)
  }
  return t
}

/** 图片最长边：undefined=保持 fallback，null=恢复应用默认，数值钳到 256~8192 */
function optEdge(v: number | null | undefined, fallback: number | null): number | null {
  if (v === undefined) return fallback
  if (v === null) return null
  if (!Number.isFinite(v)) throw new Error(`imageMaxEdge 应为像素数值，收到 ${v}`)
  return Math.min(8192, Math.max(256, Math.round(v)))
}

export const modelTools: AppTool[] = [
  defineTool({
    name: 'list_models',
    group: 'models',
    label: '查看 AI 模型列表',
    description:
      '查看当前已配置的全部 AI 模型（名称、接口地址、模型 ID、默认项、能力探测结果）。apiKey 只返回末 4 位（apiKeyTail）。',
    parameters: Type.Object({}),
    async execute() {
      const store = useModelsStore()
      if (!store.loaded) await store.load()
      return {
        count: store.models.length,
        defaultId: store.defaultModel()?.id ?? null,
        models: store.models.map(brief),
      }
    },
  }),

  defineTool({
    name: 'add_model',
    group: 'models',
    label: '添加 AI 模型',
    description:
      '添加一条 AI 模型配置（OpenAI 兼容接口；DeepSeek 地址会自动适配其思考参数格式）。provider 只作 UI 预设标识，传 deepseek 或 openai-compatible。第一个添加的模型自动成为默认。添加后建议接着 probe_model 验证能力。',
    parameters: Type.Object({
      name: Type.String({ description: '显示名称，如「DeepSeek 视觉」' }),
      baseUrl: Type.String({ description: '接口地址，如 https://api.deepseek.com' }),
      apiKey: Type.String({ description: 'API Key（明文，仅存本地）' }),
      modelId: Type.String({ description: '模型 ID，如 deepseek-v4-flash-vision-exp' }),
      provider: Type.Optional(Type.String({ description: 'UI 预设标识：deepseek | openai-compatible，缺省 openai-compatible' })),
      isDefault: Type.Optional(Type.Boolean({ description: '设为默认模型，缺省 false' })),
      imageMaxEdge: Type.Optional(
        Type.Number({ description: '发给该模型的图片最长边像素（1024~4096），缺省用应用默认' }),
      ),
    }),
    async execute(args) {
      const name = args.name.trim()
      const baseUrl = args.baseUrl.trim()
      const apiKey = args.apiKey.trim()
      const modelId = args.modelId.trim()
      for (const [label, v] of [
        ['名称', name],
        ['接口地址', baseUrl],
        ['API Key', apiKey],
        ['模型 ID', modelId],
      ] as const) {
        if (!v) throw new Error(`${label}不能为空`)
      }
      const input: AiModelInput = {
        name,
        baseUrl,
        apiKey,
        modelId,
        provider: args.provider?.trim() || 'openai-compatible',
        isDefault: args.isDefault ?? false,
        imageMaxEdge: optEdge(args.imageMaxEdge, null),
      }
      const store = useModelsStore()
      const created = await store.add(input)
      return {
        model: brief(created),
        message: `已添加「${created.name}」（id=${created.id}）${created.isDefault ? '，已设为默认模型' : ''}。建议接着调用 probe_model（id=${created.id}）探测能力，探测只发送 max_tokens=1 的最小请求。`,
      }
    },
  }),

  defineTool({
    name: 'update_model',
    group: 'models',
    label: '修改 AI 模型',
    description:
      '修改一条模型配置；只传要改的字段，未传的字段保持原值，apiKey 不传则保留原密钥。修改后探测结果会清空，建议接着 probe_model 重新探测。',
    parameters: Type.Object({
      id: Type.Number({ description: 'list_models 返回的模型 id' }),
      name: Type.Optional(Type.String({ description: '新显示名称' })),
      baseUrl: Type.Optional(Type.String({ description: '新接口地址' })),
      apiKey: Type.Optional(Type.String({ description: '新 API Key（明文）；不传 = 保留原 Key' })),
      modelId: Type.Optional(Type.String({ description: '新模型 ID' })),
      provider: Type.Optional(Type.String({ description: 'UI 预设标识：deepseek | openai-compatible' })),
      isDefault: Type.Optional(Type.Boolean({ description: '是否默认模型；不传保持原状' })),
      imageMaxEdge: Type.Optional(
        Type.Union([Type.Null(), Type.Number({ description: '图片最长边像素；null = 恢复应用默认' })]),
      ),
    }),
    async execute(args) {
      const store = useModelsStore()
      const cur = await mustGet(store, args.id)
      const input: AiModelInput = {
        name: nonEmpty('名称', args.name, cur.name),
        baseUrl: nonEmpty('接口地址', args.baseUrl, cur.baseUrl),
        apiKey: nonEmpty('API Key', args.apiKey, cur.apiKey),
        modelId: nonEmpty('模型 ID', args.modelId, cur.modelId),
        provider: args.provider?.trim() || cur.provider,
        isDefault: args.isDefault ?? cur.isDefault,
        imageMaxEdge: optEdge(args.imageMaxEdge, cur.imageMaxEdge),
      }
      await store.update(args.id, input)
      if (!store.loaded) await store.load()
      const updated = store.models.find((x) => x.id === args.id) ?? cur
      return {
        model: brief(updated),
        message: `已更新「${updated.name}」（id=${updated.id}）${args.apiKey ? '，API Key 已替换' : ''}。探测结果已重置，建议接着调用 probe_model（id=${updated.id}）。`,
      }
    },
  }),

  defineTool({
    name: 'set_default_model',
    group: 'models',
    label: '切换默认模型',
    description: '把某条模型配置设为默认；之后的新对话/识别任务默认用它。改动从下一条消息起生效。',
    parameters: Type.Object({ id: Type.Number({ description: 'list_models 返回的模型 id' }) }),
    async execute(args) {
      const store = useModelsStore()
      const cur = await mustGet(store, args.id)
      await store.setDefault(args.id)
      return { ok: true, message: `默认模型已切换为「${cur.name}」（id=${cur.id}），从下一条消息起生效。` }
    },
  }),

  defineTool({
    name: 'probe_model',
    group: 'models',
    label: '探测模型能力',
    description:
      '对指定模型发送 6 个 max_tokens=1 的最小测试请求，验证连通性并探测视觉 / 思考 / effort 档位支持；结果写回配置。添加或修改模型后建议执行。认证失败会中止整轮并给出原因。',
    parameters: Type.Object({ id: Type.Number({ description: 'list_models 返回的模型 id' }) }),
    async execute(args) {
      const store = useModelsStore()
      const cfg = await mustGet(store, args.id)
      if (store.probing[args.id]) throw new Error(`「${cfg.name}」正在探测中，请稍后再试。`)
      await store.runProbe(args.id)
      const m = await mustGet(store, args.id)
      const err = m.lastError
      return {
        id: m.id,
        name: m.name,
        vision: cap(m.vision),
        thinking: cap(m.thinking),
        effort: cap(m.effort),
        error: err ? err.slice(0, 300) : null,
        message: err
          ? `「${m.name}」探测有备注：${err.slice(0, 160)}`
          : `「${m.name}」探测完成：视觉 ${cap(m.vision)}、思考 ${cap(m.thinking)}、effort 档位 ${cap(m.effort)}。`,
      }
    },
  }),

  defineTool({
    name: 'delete_model',
    group: 'models',
    label: '删除 AI 模型',
    description: '删除一条模型配置。仅限用户明确要求删除时使用；删的是默认项时会自动把最早一条提升为默认。',
    dangerous: true,
    parameters: Type.Object({ id: Type.Number({ description: 'list_models 返回的模型 id' }) }),
    async execute(args) {
      const store = useModelsStore()
      const cur = await mustGet(store, args.id)
      await store.remove(args.id)
      const rest = store.models
      if (rest.length === 0) {
        return { ok: true, message: `已删除「${cur.name}」。模型列表已清空，AI 功能将不可用，直到重新添加模型。` }
      }
      const newDefault = rest.find((x) => x.isDefault) ?? rest[0]
      const promoted = cur.isDefault ? `，默认模型已自动切换为「${newDefault?.name}」` : ''
      return { ok: true, message: `已删除「${cur.name}」（剩余 ${rest.length} 条）${promoted}。` }
    },
  }),
]
