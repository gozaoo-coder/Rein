/** 服务模型（四个角色槽位）：当前值、候选与「启用」。
 *
 * 四行对应全应用四个模型接口：
 * - **主 LLM**：真源就是 `ai_models.is_default`（全应用选模都读它），这里只是视图；
 * - **多模态备选**：只在主模型没有视觉能力时才需要，绑定存 ai_model_prefs.visionRef，
 *   由 `stores/models.ts::bestVisionModel()` 消费（绑定优先，其次既有降级链）；
 * - **ASR**：真源是语音配置（`voice_config`），启用某个提供商的识别模型 = 把它的
 *   适配器/端点/Resource-Id/凭据写进去；
 * - **向量**：真源是知识库设置（`kb_settings`），启用 = 切到云端端点（或换本地模型）。
 *
 * 所以「启用」不是往一个中间表写一行，而是**写到那个执行位**：写完之后全应用
 * （聊天、语音、检索）立刻按新配置跑，不需要别处再同步一次。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { KIND_LABEL, parseModelMeta, parseRef } from '@/ai/providerCatalog'
import { useToast } from '@/composables/useToast'
import { kbService } from '@/services/kbService'
import { voiceService } from '@/services/voiceService'
import { useModelsStore } from '@/stores/models'
import { useProvidersStore } from '@/stores/providers'
import type {
  AiModel,
  AiProvider,
  AiProviderModel,
  KbEmbedCatalog,
  KbSettings,
  ModelCandidate,
  ModelRole,
  VoiceConfig,
} from '@/types'

/** 提供商适配器 → 本机语音管线的适配器（Rust voice/asr.rs 支持的那两个） */
const ASR_ADAPTER_MAP: Record<string, { adapter: 'doubao' | 'qwen'; label: string }> = {
  'volc-ark': { adapter: 'doubao', label: '豆包' },
  dashscope: { adapter: 'qwen', label: 'Qwen' },
}

/** 提供商 extra JSON → 对象（坏了当空） */
function parseExtra(extra: string | null): Record<string, string> {
  if (!extra) return {}
  try {
    const v = JSON.parse(extra) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v ?? {})) out[k] = String(val ?? '')
    return out
  } catch {
    return {}
  }
}

/** 两个地址是否指同一个端点（忽略结尾斜杠与大小写；`/v1` 有无都算同一个） */
export function sameEndpoint(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1$/i, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

/** 一行槽位的当前值（卡片直接渲染） */
export interface RoleSlot {
  role: ModelRole
  label: string
  /** 主值（模型名 / 「未配置」） */
  value: string
  /** 副值（提供商 · 模型 ID · 状态） */
  sub: string
  /** 已就绪（凭据/下载齐全） */
  ok: boolean
  /** 可点开选择 */
  interactive: boolean
  /** 不可点时的说明（如「主模型已具备视觉能力」） */
  lockedNote?: string
  /** 提醒（如朗读需另配凭据） */
  warn?: string
}

export const useModelRolesStore = defineStore('ai-model-roles', () => {
  const models = useModelsStore()
  const providers = useProvidersStore()
  const toast = useToast()

  const voiceConfig = ref<VoiceConfig | null>(null)
  const kbSettings = ref<KbSettings | null>(null)
  const embedCatalog = ref<KbEmbedCatalog | null>(null)
  const loaded = ref(false)
  const busy = ref(false)

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    await Promise.all([models.load(force), providers.load(force)])
    // 语音与知识库读失败不致命（未配置时也是正常态）
    const [v, s, c] = await Promise.all([
      voiceService.configGet().catch(() => null),
      kbService.settingsGet().catch(() => null),
      kbService.embedModels().catch(() => null),
    ])
    voiceConfig.value = v
    kbSettings.value = s
    embedCatalog.value = c
    loaded.value = true
  }

  /** 重新读执行位（启用之后调） */
  async function refreshTargets(): Promise<void> {
    const [v, s, c] = await Promise.all([
      voiceService.configGet().catch(() => null),
      kbService.settingsGet().catch(() => null),
      kbService.embedModels().catch(() => null),
    ])
    voiceConfig.value = v
    kbSettings.value = s
    embedCatalog.value = c
  }

  /* ---------- 主 LLM ---------- */

  const mainModel = computed<AiModel | null>(() => models.defaultModel())

  /* ---------- 多模态备选 ---------- */

  /** 主模型已证实有视觉能力时，这一行不需要另配（暗着） */
  const visionNeeded = computed(() => mainModel.value?.vision !== true)

  /** 绑定的备选模型（visionRef = model:<id> 且该模型确实有视觉能力才算数） */
  const visionBound = computed<AiModel | null>(() => {
    const { scheme, a } = parseRef(providers.prefs.visionRef)
    if (scheme !== 'model') return null
    const m = models.models.find((x) => x.id === Number(a))
    return m && m.vision === true ? m : null
  })

  /** 实际会用于看图的模型（与 models.bestVisionModel 同一口径） */
  const visionEffective = computed<AiModel | null>(() => {
    if (providers.prefs.visionRef === 'off') return null
    return visionBound.value ?? models.bestVisionModel()
  })

  /* ---------- ASR ---------- */

  /** ASR 当前生效的模型（实配为准；绑定只用于显示来源） */
  const asrCurrent = computed(() => {
    const c = voiceConfig.value
    if (!c) return { model: '', adapterLabel: '', configured: false, providerName: '' }
    const mapped = c.asrAdapter === 'auto' ? '' : c.asrAdapter
    const adapterLabel = mapped === 'doubao' ? '豆包' : mapped === 'qwen' ? 'Qwen' : '自动识别'
    const parsed = parseRef(providers.prefs.asrRef)
    let providerName = ''
    if (parsed.scheme === 'provider' && parsed.b === c.asrResourceId) {
      providerName = providers.providerOf(Number(parsed.a))?.name ?? ''
    }
    return {
      model: c.asrResourceId,
      adapterLabel,
      configured: c.mode === 'new' ? !!c.appKey.trim() : !!c.appKey.trim() && !!c.accessKey.trim(),
      providerName,
    }
  })

  /* ---------- 向量 ---------- */

  const embeddingCurrent = computed(() => {
    const s = kbSettings.value
    if (!s) return { ref: '', label: '未读取到知识库设置', sub: '', ok: false }
    if (s.embeddingMode === 'keyword') {
      return { ref: 'keyword', label: '关键词检索（未用向量模型）', sub: '知识库设置里当前是关键词模式', ok: true }
    }
    if (s.embeddingMode === 'local') {
      const m = embedCatalog.value?.models.find((x) => x.id === s.localModel)
      const installed = m?.installed ?? false
      return {
        ref: `local:${s.localModel}`,
        label: m?.label ?? s.localModel,
        sub: `本机运行 · ${m?.dim ?? '?'} 维${installed ? '' : ' · 未下载'}`,
        ok: installed,
      }
    }
    const parsed = parseRef(providers.prefs.embeddingRef)
    let providerName = ''
    if (parsed.scheme === 'cloud' && parsed.b === s.cloudModel) {
      providerName = providers.providerOf(Number(parsed.a))?.name ?? ''
    }
    // 候选 ref 是 cloud:<pid>:<model>，这里按「提供商目录里同端点同模型」反查出 pid，
    // 选择抽屉里才能正确打勾（在知识库页手填的云端端点反查不到就退回无 pid 的 ref）
    const hit = providers.allModels.find(
      (r) =>
        r.model.kind === 'embedding' &&
        r.model.modelId === s.cloudModel &&
        sameEndpoint(r.provider.baseUrl, s.cloudBaseUrl ?? ''),
    )
    return {
      ref: hit ? `cloud:${hit.provider.id}:${hit.model.modelId}` : s.cloudModel ? `cloud:${s.cloudModel}` : '',
      label: s.cloudModel ?? '云端向量（未选模型）',
      sub: `${providerName ? `${providerName} · ` : ''}${s.cloudBaseUrl ?? ''} · ${s.cloudDim ?? '?'} 维`,
      ok: !!s.cloudModel && !!s.cloudBaseUrl,
    }
  })

  /* ---------- 四行槽位 ---------- */

  const slots = computed<RoleSlot[]>(() => {
    const main = mainModel.value
    const vision = visionEffective.value
    const asr = asrCurrent.value
    const emb = embeddingCurrent.value
    return [
      {
        role: 'llm',
        label: '主 LLM 模型',
        value: main?.name ?? '未配置',
        sub: main ? `${providers.nickname(main.provider)} · ${main.modelId}` : '点这里选一个对话模型',
        ok: !!main,
        interactive: true,
      },
      {
        role: 'vision',
        label: '多模态 LLM（备选）',
        value: visionNeeded.value ? (vision?.name ?? '未指定') : '无需另配',
        sub: visionNeeded.value
          ? vision
            ? `${providers.nickname(vision.provider)} · ${vision.modelId}`
            : '主模型没有视觉能力，建议指定一个能看图的模型'
          : '主模型已具备视觉能力，拍照识别直接用它',
        ok: !visionNeeded.value || !!vision,
        interactive: visionNeeded.value,
        lockedNote: visionNeeded.value ? undefined : '主模型已具备视觉能力',
      },
      {
        role: 'asr',
        label: 'ASR 语音识别模型',
        value: asr.model || '未配置',
        sub: asr.model
          ? `${asr.providerName ? `${asr.providerName} · ` : ''}${asr.adapterLabel} 适配器${asr.configured ? '' : ' · 缺凭据'}`
          : '语音对话与纪要转写用，先在提供商里启用识别模型',
        ok: asr.configured,
        interactive: true,
        warn: asr.adapterLabel === 'Qwen' ? '识别走 Qwen：朗读需另配豆包凭据（语音服务里填）' : undefined,
      },
      {
        role: 'embedding',
        label: '向量模型',
        value: emb.label,
        sub: emb.sub || '知识库与长期记忆的语义检索用',
        ok: emb.ok,
        interactive: true,
      },
    ]
  })

  /* ---------- 候选（选择抽屉的数据源） ---------- */

  /** 主 LLM / 多模态：已配置的对话模型（ai_models） */
  function llmCandidates(kind: 'llm' | 'vision'): ModelCandidate[] {
    const main = mainModel.value
    return models.models.map((m) => ({
      ref: `model:${m.id}`,
      label: m.name,
      sub: `${m.modelId}${m.lastError ? ' · 上次探测有备注' : ''}`,
      provider: providers.nickname(m.provider),
      kind: 'llm',
      badge:
        m.id === main?.id
          ? '主模型'
          : kind === 'vision'
            ? m.vision === true
              ? '支持视觉'
              : m.vision === null
                ? '未探测'
                : '无视觉'
            : m.isDefault
              ? '默认'
              : undefined,
      disabled: kind === 'vision' && m.vision === false,
    }))
  }

  /** ASR：语音服务里那套 + 各提供商目录里的识别模型 */
  function asrCandidates(): ModelCandidate[] {
    const out: ModelCandidate[] = []
    const asr = asrCurrent.value
    // 当前这条如果是「从提供商启用的」，就不该在语音服务那一行标「当前」
    const bound = parseRef(providers.prefs.asrRef)
    const fromProvider = bound.scheme === 'provider' && bound.b === asr.model
    if (asr.model) {
      out.push({
        ref: 'voice',
        label: asr.model,
        sub: `${asr.adapterLabel} 适配器 · 语音服务里配置的凭据`,
        provider: '语音服务',
        kind: 'asr',
        badge: fromProvider ? undefined : asr.configured ? '当前' : '缺凭据',
      })
    }
    for (const { provider, model } of providers.modelsByKind('asr')) {
      const mapped = ASR_ADAPTER_MAP[provider.adapter]
      out.push({
        ref: `provider:${provider.id}:${model.modelId}`,
        label: model.modelId,
        sub: mapped
          ? `${mapped.label} 适配器 · 用「${provider.name}」的凭据`
          : '该适配器暂不支持本机语音管线',
        provider: provider.name,
        kind: 'asr',
        badge: asr.model === model.modelId ? '使用中' : undefined,
        disabled: !mapped,
      })
    }
    return out
  }

  /** 向量：关键词档 + 本机模型 + 各提供商目录里的向量模型 */
  function embeddingCandidates(): ModelCandidate[] {
    const out: ModelCandidate[] = [
      {
        ref: 'keyword',
        label: '关键词检索（不用向量模型）',
        sub: '不下载、不联网；只按词命中，语义近似搜不到',
        provider: '本机',
        kind: 'embedding',
        badge: embeddingCurrent.value.ref === 'keyword' ? '当前' : undefined,
      },
    ]
    for (const m of embedCatalog.value?.models ?? []) {
      out.push({
        ref: `local:${m.id}`,
        label: m.label,
        sub: `${m.dim} 维 · ${m.note}`,
        provider: '本机模型',
        kind: 'embedding',
        badge: m.installed ? (embeddingCurrent.value.ref === `local:${m.id}` ? '当前' : undefined) : '未下载',
      })
    }
    for (const { provider, model } of providers.modelsByKind('embedding')) {
      const meta = parseModelMeta(model.meta)
      out.push({
        ref: `cloud:${provider.id}:${model.modelId}`,
        label: model.modelId,
        sub: `${provider.name} · 云端端点${meta.dim ? ` · ${meta.dim} 维` : ''}`,
        provider: provider.name,
        kind: 'embedding',
        badge: embeddingCurrent.value.ref === `cloud:${model.modelId}` ? '当前' : undefined,
      })
    }
    return out
  }

  function candidatesFor(role: ModelRole): ModelCandidate[] {
    switch (role) {
      case 'llm':
        return llmCandidates('llm')
      case 'vision':
        return llmCandidates('vision')
      case 'asr':
        return asrCandidates()
      case 'embedding':
        return embeddingCandidates()
    }
  }

  /* ---------- 启用提供商模型 ---------- */

  /** 目录里这条模型是否已经在执行位上（列表里的「使用中」标记） */
  function isActive(provider: AiProvider, model: AiProviderModel): boolean {
    if (model.kind === 'llm' || model.kind === 'vision') {
      return models.models.some(
        (m) => m.modelId === model.modelId && sameEndpoint(m.baseUrl, provider.baseUrl),
      )
    }
    if (model.kind === 'asr') {
      const mapped = ASR_ADAPTER_MAP[provider.adapter]
      return !!mapped && asrCurrent.value.model === model.modelId
    }
    if (model.kind === 'embedding') {
      const s = kbSettings.value
      return (
        s?.embeddingMode === 'cloud' &&
        s.cloudModel === model.modelId &&
        sameEndpoint(s.cloudBaseUrl ?? '', provider.baseUrl)
      )
    }
    return false
  }

  /** 把目录里的一条模型落到执行位。返回给用户看的一句话。 */
  async function activate(provider: AiProvider, model: AiProviderModel): Promise<string> {
    const adapter = providers.adapterOf(provider.adapter)
    if (model.kind === 'llm' || model.kind === 'vision') {
      const existing = models.models.find(
        (m) => m.modelId === model.modelId && sameEndpoint(m.baseUrl, provider.baseUrl),
      )
      const input = {
        name: `${provider.name} · ${model.modelId}`,
        provider: provider.adapter,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        modelId: model.modelId,
        isDefault: existing?.isDefault ?? models.models.length === 0,
        imageMaxEdge: null,
        priceIn: null,
        priceOut: null,
      }
      if (existing) {
        await models.update(existing.id, input)
        void models.runProbe(existing.id)
        return `已更新「${input.name}」（凭据/地址按提供商刷新），正在重新探测能力`
      }
      const created = await models.add(input)
      void models.runProbe(created.id)
      return `已启用「${input.name}」${created.isDefault ? '（首个模型，已设为默认）' : ''}，正在探测能力`
    }

    if (model.kind === 'asr') {
      const mapped = ASR_ADAPTER_MAP[provider.adapter]
      if (!mapped) {
        throw new Error(`${adapter?.label ?? provider.adapter} 的识别接口还没适配到本机语音管线，先用「语音服务」里的豆包/Qwen`)
      }
      const extra = parseExtra(provider.extra)
      const legacy = mapped.adapter === 'doubao' && !!extra.appId?.trim() && !!extra.accessToken?.trim()
      const cur = voiceConfig.value ?? (await voiceService.configGet())
      const next: VoiceConfig = {
        ...cur,
        mode: legacy ? 'legacy' : 'new',
        appKey: legacy ? extra.appId!.trim() : provider.apiKey.trim(),
        accessKey: legacy ? extra.accessToken!.trim() : '',
        asrAdapter: mapped.adapter,
        asrAdapterUserPicked: true,
        // 空 = 用适配器默认端点（火山/百炼的官方地址）
        asrBaseUrl: '',
        asrResourceId: model.modelId,
      }
      await voiceService.configSave(next)
      await refreshTargets()
      const tail = mapped.adapter === 'qwen' ? '；朗读（TTS）要另配豆包凭据' : ''
      return `语音识别已切到「${model.modelId}」（${mapped.label} 适配器，用 ${provider.name} 的凭据）${tail}`
    }

    if (model.kind === 'embedding') {
      const meta = parseModelMeta(model.meta)
      await kbService.settingsSet({
        embeddingMode: 'cloud',
        cloudBaseUrl: provider.baseUrl,
        cloudApiKey: provider.apiKey,
        cloudModel: model.modelId,
        ...(meta.dim ? { cloudDim: meta.dim } : {}),
      })
      await refreshTargets()
      return `向量模型已切到「${model.modelId}」（${provider.name}），旧向量会按新模型重算`
    }

    throw new Error(`这类模型（${KIND_LABEL[model.kind]}）暂不支持一键启用`)
  }

  /** 选择抽屉里点一行 → 应用（含 prefs 绑定） */
  async function apply(role: ModelRole, ref_: string): Promise<void> {
    busy.value = true
    try {
      if (role === 'llm') {
        const { scheme, a } = parseRef(ref_)
        if (scheme !== 'model') throw new Error('主模型要从已配置的模型里选')
        await models.setDefault(Number(a))
        const m = models.models.find((x) => x.id === Number(a))
        toast.toast(`主模型已切换为「${m?.name ?? ref_}」，从下一条消息起生效`)
        return
      }

      if (role === 'vision') {
        await providers.savePrefs({ visionRef: ref_ })
        toast.toast(ref_ === 'auto' ? '已设为自动（用任一支持视觉的模型）' : '已指定多模态备选模型')
        return
      }

      if (role === 'asr') {
        if (ref_ === 'voice') {
          await providers.savePrefs({ asrRef: 'voice' })
          toast.toast('识别模型沿用「语音服务」里配置的那套')
          return
        }
        const { scheme, a, b } = parseRef(ref_)
        if (scheme !== 'provider') throw new Error('识别模型要从提供商目录里选')
        const provider = providers.providerOf(Number(a))
        const model = provider?.models.find((x) => x.modelId === b)
        if (!provider || !model) throw new Error('提供商或模型不存在，先拉一次模型清单')
        const msg = await activate(provider, model)
        await providers.savePrefs({ asrRef: ref_ })
        toast.toast(msg)
        return
      }

      // embedding
      if (ref_ === 'keyword') {
        await kbService.settingsSet({ embeddingMode: 'keyword' })
        await providers.savePrefs({ embeddingRef: '' })
        await refreshTargets()
        toast.toast('已切到关键词检索（不下载、不联网）')
        return
      }
      const { scheme, a, b } = parseRef(ref_)
      if (scheme === 'local') {
        await kbService.settingsSet({ embeddingMode: 'local', localModel: a })
        await providers.savePrefs({ embeddingRef: ref_ })
        await refreshTargets()
        toast.toast('本地向量模型已切换，旧向量会按新模型重算')
        return
      }
      if (scheme === 'cloud') {
        const provider = providers.providerOf(Number(a))
        const model = provider?.models.find((x) => x.modelId === b)
        if (!provider || !model) throw new Error('提供商或模型不存在，先拉一次模型清单')
        const msg = await activate(provider, model)
        await providers.savePrefs({ embeddingRef: ref_ })
        toast.toast(msg)
        return
      }
      throw new Error(`认不出的模型引用：${ref_}`)
    } finally {
      busy.value = false
    }
  }

  return {
    voiceConfig,
    kbSettings,
    embedCatalog,
    loaded,
    busy,
    mainModel,
    visionNeeded,
    visionBound,
    visionEffective,
    asrCurrent,
    embeddingCurrent,
    slots,
    load,
    refreshTargets,
    candidatesFor,
    isActive,
    activate,
    apply,
  }
})
