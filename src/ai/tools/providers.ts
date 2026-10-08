/**
 * 提供商 / 服务模型域工具：让用户「在聊天里把 Key 填好、把模型拉出来、把模型切过去」。
 *
 * 与模型配置工具（models.ts）同一分组（`models`，按需装载：命中「模型 / 密钥 /
 * 提供商 / 向量 / 语音识别」等词或模型主动 load_tools 时才挂上来），所以这一整套
 * 不占常驻上下文；用户开口要配服务商时它才出现。
 *
 * 三条约定：
 * - **适配器与接入方式只能从注册表里选**（工具结果里带清单），地址缺省用注册表默认值；
 * - **密钥不回传明文**（与 models.ts 同一隐私约定），只给末 4 位；
 * - **启用 = 写到执行位**：对话/视觉进 ai_models，识别写语音配置，向量写知识库设置，
 *   返回结果里带上「现在生效的是什么」，用户不必再去别处确认。
 */

import { Type } from '@earendil-works/pi-ai'

import { KIND_LABEL, parseModelMeta } from '@/ai/providerCatalog'
import { useModelRolesStore } from '@/stores/modelRoles'
import { useModelsStore } from '@/stores/models'
import { useProvidersStore } from '@/stores/providers'
import type { AiProvider, AiProviderModel, ModelRole, ProviderModelKind } from '@/types'
import { defineTool, type AppTool } from './types'

/** 末 4 位（不回传密钥明文） */
function keyTail(v: string): string {
  const t = (v || '').trim()
  return t ? `****${t.slice(-4)}` : '（未填）'
}

/** extra 是手填 / 历史数据，坏一条不该让整份投影（乃至整个工具）抛错 */
function extraKeysOf(p: AiProvider): string[] {
  if (!p.extra) return []
  try {
    const parsed = JSON.parse(p.extra) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>)
      : []
  } catch {
    return []
  }
}

/** 提供商投影：账号信息 + 目录（按类别分组，便于模型直接挑） */
function briefProvider(p: AiProvider) {
  const byKind: Record<string, string[]> = {}
  for (const m of p.models) {
    const label = `${m.modelId}${m.origin === 'preset' ? '（内置参考）' : m.origin === 'manual' ? '（手填）' : ''}`
    byKind[m.kind] = [...(byKind[m.kind] ?? []), label]
  }
  return {
    id: p.id,
    adapter: p.adapter,
    name: p.name,
    apiStyle: p.apiStyle,
    baseUrl: p.baseUrl,
    apiKeyTail: keyTail(p.apiKey),
    extraKeys: extraKeysOf(p),
    lastSyncAt: p.lastSyncAt,
    lastError: p.lastError ? p.lastError.slice(0, 200) : null,
    models: byKind,
  }
}

/** 目录行投影 */
function briefModel(m: AiProviderModel) {
  const meta = parseModelMeta(m.meta)
  return {
    modelId: m.modelId,
    kind: m.kind,
    kindLabel: KIND_LABEL[m.kind],
    origin: m.origin,
    dim: meta.dim ?? null,
    note: meta.note ?? null,
  }
}

export const providerTools: AppTool[] = [
  defineTool({
    name: 'list_providers',
    group: 'models',
    label: '查看提供商与模型目录',
    description:
      '查看全部提供商（服务商账号）：适配器、接入方式、地址、密钥末 4 位、已拉取的模型目录（按类别分组）。返回里也带「可用适配器清单」（每个适配器支持哪些模型类别、有哪些接入方式与默认地址），配置新提供商时照它选。密钥不回传明文。',
    parameters: Type.Object({}),
    async execute() {
      const providers = useProvidersStore()
      await providers.load(true)
      return {
        adapters: providers.adapters.map((a) => ({
          id: a.id,
          label: a.label,
          kinds: a.kinds.map((k) => `${k}(${KIND_LABEL[k]})`),
          styles: a.styles.map((s) => ({ id: s.id, label: s.label, defaultBaseUrl: s.baseUrl })),
          extraFields: a.extraFields.map((f) => ({ key: f.key, label: f.label, hint: f.hint })),
          keyHint: a.keyHint,
        })),
        count: providers.providers.length,
        providers: providers.providers.map(briefProvider),
        message: providers.providers.length
          ? '要启用某个模型用 activate_provider_model（providerId + modelId）。'
          : '还没有提供商：用 save_provider 加一个（adapter 从 adapters 里选），再用 fetch_provider_models 拉目录。',
      }
    },
  }),

  defineTool({
    name: 'save_provider',
    group: 'models',
    label: '添加/修改提供商',
    description:
      '新建或修改一个提供商账号（适配器 + 接入方式 + 地址 + 密钥）。同适配器 + 同地址视为同一个账号（改凭据而不是又建一条）。baseUrl 不传时用该接入方式的默认地址；火山方舟的语音凭据可放 extraFields（appId / accessToken）。保存后建议接着 fetch_provider_models 拉模型目录。',
    parameters: Type.Object({
      id: Type.Optional(Type.Number({ description: '要修改的提供商 id（list_providers 返回）；不传 = 新建' })),
      adapter: Type.String({ description: '适配器 id，如 volc-ark / dashscope / deepseek / siliconflow / openai-compatible' }),
      apiKey: Type.String({ description: 'API Key（明文，仅存本机）' }),
      apiStyle: Type.Optional(Type.String({ description: '接入方式 id（如方舟的 ark / agent-plan）；缺省用该适配器第一个' })),
      name: Type.Optional(Type.String({ description: '昵称（模型名前缀与折叠分组用）；缺省用适配器名' })),
      baseUrl: Type.Optional(Type.String({ description: '服务地址；缺省用接入方式的默认地址' })),
      extraFields: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: '适配器专属字段，如 {"appId":"…","accessToken":"…"}（火山语音识别用）',
        }),
      ),
    }),
    async execute(args) {
      const providers = useProvidersStore()
      await providers.load()
      const adapter = providers.adapterOf(args.adapter.trim())
      if (!adapter) {
        throw new Error(
          `未知适配器：${args.adapter}。可选：${providers.adapters.map((a) => a.id).join(' / ')}`,
        )
      }
      const style =
        adapter.styles.find((s) => s.id === args.apiStyle) ?? adapter.styles[0]
      const baseUrl = (args.baseUrl ?? style?.baseUrl ?? '').trim()
      if (!baseUrl) throw new Error('baseUrl 不能为空（该适配器没有默认地址，请提供服务地址）')
      const key = args.apiKey.trim()
      if (!key) throw new Error('apiKey 不能为空')
      const extra =
        args.extraFields && Object.keys(args.extraFields).length > 0
          ? JSON.stringify(args.extraFields)
          : null
      const saved = await providers.save({
        id: args.id ?? null,
        adapter: adapter.id,
        name: (args.name ?? '').trim() || adapter.nickname,
        baseUrl,
        apiKey: key,
        apiStyle: style?.id ?? '',
        extra,
      })
      return {
        provider: saved ? briefProvider(saved) : null,
        message: `已保存提供商「${saved?.name}」（${adapter.label} · ${style?.label}，id=${saved?.id}）。接着调 fetch_provider_models 拉模型目录。`,
      }
    },
  }),

  defineTool({
    name: 'fetch_provider_models',
    group: 'models',
    label: '拉取提供商模型目录',
    description:
      '请求该提供商的 /models 接口拉取模型清单并落库（按模型 ID 推断类别：对话/视觉/识别/向量）。接口不通时返回内置参考目录与失败原因，此时可以用 add_provider_model 手填模型 ID。',
    parameters: Type.Object({
      providerId: Type.Number({ description: 'list_providers 返回的提供商 id' }),
    }),
    async execute(args) {
      const providers = useProvidersStore()
      await providers.load()
      const p = providers.providerOf(args.providerId)
      if (!p) throw new Error(`提供商不存在（id=${args.providerId}）。先调 list_providers 看现有 id。`)
      const result = await providers.fetchModels(args.providerId)
      if (!result) throw new Error('拉取失败：看提供商卡片上的错误原文')
      const after = providers.providerOf(args.providerId) ?? p
      return {
        ok: result.ok,
        status: result.status,
        endpoint: result.endpoint,
        fromPreset: result.fromPreset,
        error: result.error,
        models: after.models.map(briefModel),
        message: result.ok
          ? `拉到 ${after.models.length} 个模型（${result.elapsedMs}ms）。用 activate_provider_model 启用其中一个。`
          : `接口没通（${result.error ?? result.status}）：列的是内置参考目录，可用 add_provider_model 手填模型 ID。`,
      }
    },
  }),

  defineTool({
    name: 'add_provider_model',
    group: 'models',
    label: '手填提供商模型',
    description:
      '往提供商目录里手填一条模型（接口清单里没有、或该服务商没有 /models 接口时用）。kind 决定「启用」写到哪个执行位：llm/vision = 对话模型，asr = 语音识别，embedding = 向量。不传 kind 时按模型 ID 推断。',
    parameters: Type.Object({
      providerId: Type.Number({ description: 'list_providers 返回的提供商 id' }),
      modelId: Type.String({ description: '模型 ID（服务商文档里的名字）' }),
      kind: Type.Optional(
        Type.String({ description: 'llm | vision | asr | embedding；缺省按模型 ID 推断' }),
      ),
    }),
    async execute(args) {
      const providers = useProvidersStore()
      await providers.load()
      const p = providers.providerOf(args.providerId)
      if (!p) throw new Error(`提供商不存在（id=${args.providerId}）`)
      const adapter = providers.adapterOf(p.adapter)
      const asked = (args.kind ?? '').trim() as ProviderModelKind
      const kind: ProviderModelKind =
        asked && adapter?.kinds.includes(asked) ? asked : (adapter?.kinds[0] ?? 'llm')
      await providers.addModel(args.providerId, args.modelId.trim(), kind)
      const after = providers.providerOf(args.providerId)
      const row = after?.models.find((m) => m.modelId === args.modelId.trim())
      return {
        model: row ? briefModel(row) : null,
        message: `已加入「${p.name}」的目录：${args.modelId}（${KIND_LABEL[row?.kind ?? kind]}）。用 activate_provider_model 启用。`,
      }
    },
  }),

  defineTool({
    name: 'remove_provider',
    group: 'models',
    label: '删除提供商',
    description:
      '删除提供商账号及其模型目录。已启用的模型不受影响（它们已经写进 ai_models / 语音配置 / 知识库设置）。仅限用户明确要求删除时使用。',
    dangerous: true,
    parameters: Type.Object({ providerId: Type.Number({ description: 'list_providers 返回的提供商 id' }) }),
    async execute(args) {
      const providers = useProvidersStore()
      await providers.load()
      const p = providers.providerOf(args.providerId)
      if (!p) throw new Error(`提供商不存在（id=${args.providerId}）`)
      await providers.remove(args.providerId)
      return { ok: true, message: `已删除提供商「${p.name}」及其目录（已启用的模型仍在）。` }
    },
  }),

  defineTool({
    name: 'list_model_roles',
    group: 'models',
    label: '查看服务模型与候选',
    description:
      '查看四个「服务模型」槽位当前用的是什么（主 LLM / 多模态备选 / 语音识别 ASR / 向量），并列出每个槽位可选的候选（带 ref 与说明）。换模型用 set_model_role，ref 直接取这里的值。',
    parameters: Type.Object({}),
    async execute() {
      const roles = useModelRolesStore()
      await roles.load(true)
      const dump = (role: ModelRole) => ({
        role,
        current: {
          value: roles.slots.find((s) => s.role === role)?.value,
          sub: roles.slots.find((s) => s.role === role)?.sub,
          interactive: roles.slots.find((s) => s.role === role)?.interactive,
        },
        candidates: roles.candidatesFor(role).map((c) => ({
          ref: c.ref,
          label: c.label,
          provider: c.provider,
          note: c.sub,
          disabled: c.disabled ?? false,
        })),
      })
      return {
        slots: [dump('llm'), dump('vision'), dump('asr'), dump('embedding')],
        message:
          '换模型：set_model_role(role, ref)。ref 形如 model:3（对话模型）/ voice（沿用语音服务那套）/ provider:2:qwen-audio-3.0-asr-flash-streaming / local:bge-base-zh-v1.5-int8 / cloud:1:text-embedding-v4 / keyword（不用向量模型）。',
      }
    },
  }),

  defineTool({
    name: 'set_model_role',
    group: 'models',
    label: '切换服务模型',
    description:
      '把某个服务模型槽位切到指定候选（ref 从 list_model_roles 拿）。主 LLM 与多模态立即对下一条消息生效；识别会写进语音配置；向量会写进知识库设置（旧向量按新模型重算）。',
    parameters: Type.Object({
      role: Type.String({ description: 'llm | vision | asr | embedding' }),
      ref: Type.String({ description: '候选的 ref（见 list_model_roles）' }),
    }),
    async execute(args) {
      const role = args.role.trim() as ModelRole
      if (!['llm', 'vision', 'asr', 'embedding'].includes(role)) {
        throw new Error(`role 只能是 llm / vision / asr / embedding，收到 ${args.role}`)
      }
      const roles = useModelRolesStore()
      await roles.load(true)
      const known = roles.candidatesFor(role)
      const ref = args.ref.trim()
      const hit = known.find((c) => c.ref === ref)
      if (!hit) {
        throw new Error(
          `这个 ref 不在候选里：${ref}。当前候选：${known.map((c) => c.ref).join(' / ') || '（无）'}`,
        )
      }
      if (hit.disabled) throw new Error(`该候选当前不可用：${hit.label}（${hit.sub}）`)
      await roles.apply(role, ref)
      const slot = roles.slots.find((s) => s.role === role)
      return {
        ok: true,
        role,
        ref,
        current: { value: slot?.value, sub: slot?.sub },
        message: `「${slot?.label ?? role}」已切到 ${slot?.value}（${slot?.sub}）。`,
      }
    },
  }),

  defineTool({
    name: 'activate_provider_model',
    group: 'models',
    label: '启用提供商模型',
    description:
      '把提供商目录里的某个模型落到执行位：对话/视觉模型导入成可用模型（并自动探测能力），识别模型写进语音配置，向量模型写进知识库设置。启用后可在 list_model_roles 里看到当前值。',
    parameters: Type.Object({
      providerId: Type.Number({ description: 'list_providers 返回的提供商 id' }),
      modelId: Type.String({ description: '目录里的模型 ID（list_providers 的 models 字段里有）' }),
      setAsMain: Type.Optional(
        Type.Boolean({ description: '对话模型启用后是否顺带设为主模型；缺省 false' }),
      ),
    }),
    async execute(args) {
      const providers = useProvidersStore()
      const roles = useModelRolesStore()
      await providers.load(true)
      const p = providers.providerOf(args.providerId)
      if (!p) throw new Error(`提供商不存在（id=${args.providerId}）`)
      const model = p.models.find((m) => m.modelId === args.modelId.trim())
      if (!model) {
        throw new Error(
          `目录里没有这个模型：${args.modelId}。先 fetch_provider_models 或 add_provider_model；现有：${p.models
            .map((m) => m.modelId)
            .join(' / ') || '（空）'}`,
        )
      }
      const msg = await roles.activate(p, model)
      let extra = ''
      if (args.setAsMain && (model.kind === 'llm' || model.kind === 'vision')) {
        const models = useModelsStore()
        await models.load(true)
        const row = models.models.find(
          (m) => m.modelId === model.modelId && m.baseUrl.replace(/\/+$/, '') === p.baseUrl.replace(/\/+$/, ''),
        )
        if (row) {
          await models.setDefault(row.id)
          extra = `，并已设为主模型（${row.name}）`
        }
      }
      return { ok: true, kind: model.kind, kindLabel: KIND_LABEL[model.kind], message: `${msg}${extra}。` }
    },
  }),
]
