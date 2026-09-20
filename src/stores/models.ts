/** AI 模型配置：列表、CRUD、默认项与能力探测（探测由 src/ai/probe.ts 执行）。
 *  本机成本账本（`ai_usage`）也在这里汇总：模型卡片要显示各自花了多少。 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { aiService } from '@/services/aiService'
import type { AiModel, AiModelInput, AiUsageSummary, AiUsageTotals } from '@/types'

export const useModelsStore = defineStore('ai-models', () => {
  const models = ref<AiModel[]>([])
  const loaded = ref(false)
  /** 正在探测的模型 id 集合（键值便于代理追踪） */
  const probing = ref<Record<number, boolean>>({})
  /** 本机账本汇总（最近 30 天） */
  const usage = ref<AiUsageSummary | null>(null)

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    models.value = await aiService.aiModelList()
    loaded.value = true
  }

  /** 拉本机账本：模型列表加载后调用，失败不影响列表 */
  async function loadUsage(days = 30): Promise<void> {
    usage.value = await aiService.aiUsageSummary(days).catch(() => null)
  }

  /** 某个模型的本机累计花费（按模型名 + 模型 ID 聚合，删了模型也留账） */
  function usageOf(m: AiModel): AiUsageTotals | null {
    if (!usage.value) return null
    return usage.value.byModel.find((x) => x.modelId === m.modelId && x.modelName === m.name) ?? null
  }

  /** 本机累计总花费（纳元） */
  const totalCostNano = computed(() => usage.value?.total.costTotalNano ?? 0)
  /** 本机累计模型费 / 流量费（分开看，才知道流量有没有在花钱） */
  const totalModelNano = computed(() => usage.value?.total.costModelNano ?? 0)
  const totalTrafficNano = computed(() => usage.value?.total.costTrafficNano ?? 0)

  /** 默认模型；无默认时首条兜底（与 Rust 的删除提升逻辑一致） */
  function defaultModel(): AiModel | null {
    return models.value.find((m) => m.isDefault) ?? models.value[0] ?? null
  }

  /** 用于照片识别的模型：默认项里选视觉已确认的，否则任意视觉已确认的 */
  function defaultVisionModel(): AiModel | null {
    const vision = models.value.filter((m) => m.vision === true)
    return vision.find((m) => m.isDefault) ?? vision[0] ?? null
  }

  /** 需要看图的任务选模（自动降级链）：默认模型已证实视觉 → 直接用；
   * 否则用任一已证实视觉的；全都没探测过时退回默认模型硬试（探测只是标记，不拦人）。 */
  function bestVisionModel(): AiModel | null {
    const d = defaultModel()
    if (d?.vision === true) return d
    return models.value.find((m) => m.vision === true) ?? d
  }

  async function add(input: AiModelInput): Promise<AiModel> {
    const created = await aiService.aiModelAdd(input)
    await load(true)
    return created
  }

  async function update(id: number, input: AiModelInput): Promise<void> {
    await aiService.aiModelUpdate(id, input)
    await load(true)
  }

  async function remove(id: number): Promise<void> {
    await aiService.aiModelDelete(id)
    await load(true)
  }

  async function setDefault(id: number): Promise<void> {
    await aiService.aiModelSetDefault(id)
    await load(true)
  }

  /** 执行 max_tokens=1 能力探测并写回结果 */
  async function runProbe(id: number): Promise<void> {
    const cfg = models.value.find((m) => m.id === id)
    if (!cfg || probing.value[id]) return
    probing.value[id] = true
    try {
      const { probeModel } = await import('@/ai/probe')
      const result = await probeModel(cfg)
      await aiService.aiModelSaveProbe(id, result)
      const m = models.value.find((x) => x.id === id)
      if (m) {
        m.vision = result.vision
        m.thinking = result.thinking
        m.effort = result.effort
        m.lastError = result.error
        m.updatedAt = new Date().toISOString()
      }
    } finally {
      probing.value[id] = false
    }
  }

  return {
    models,
    loaded,
    probing,
    usage,
    totalCostNano,
    totalModelNano,
    totalTrafficNano,
    load,
    loadUsage,
    usageOf,
    defaultModel,
    defaultVisionModel,
    bestVisionModel,
    add,
    update,
    remove,
    setDefault,
    runProbe,
  }
})
