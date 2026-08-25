/** AI 模型配置：列表、CRUD、默认项与能力探测（探测由 src/ai/probe.ts 执行）。 */

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { aiService } from '@/services/aiService'
import type { AiModel, AiModelInput } from '@/types'

export const useModelsStore = defineStore('ai-models', () => {
  const models = ref<AiModel[]>([])
  const loaded = ref(false)
  /** 正在探测的模型 id 集合（键值便于代理追踪） */
  const probing = ref<Record<number, boolean>>({})

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    models.value = await aiService.aiModelList()
    loaded.value = true
  }

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
    load,
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
