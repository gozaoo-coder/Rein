/** 训练课程 store：课程列表 CRUD 与「最近使用的三个课程」派生。 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { planService } from '@/services/planService'
import type { WorkoutPlanInput, WorkoutPlanRecord } from '@/types'

export const usePlanStore = defineStore('plan', () => {
  const plans = ref<WorkoutPlanRecord[]>([])
  const loaded = ref(false)
  const loading = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      plans.value = await planService.list()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 首次访问时惰性加载（页面/恢复流程共用，避免重复拉取） */
  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await load()
  }

  async function reload(): Promise<void> {
    await load()
  }

  function byId(id: string): WorkoutPlanRecord | undefined {
    return plans.value.find((p) => p.id === id)
  }

  /** 最近使用的三个课程（后端已按 last_used_at 排序，直接取前三） */
  const recent = computed<WorkoutPlanRecord[]>(() => plans.value.slice(0, 3))

  async function upsert(input: WorkoutPlanInput): Promise<WorkoutPlanRecord> {
    const rec = await planService.upsert(input)
    await reload()
    return rec
  }

  async function remove(id: string): Promise<void> {
    await planService.remove(id)
    await reload()
  }

  /** 开始训练时维护最近使用；乐观更新本地排序，失败不阻塞训练 */
  async function touch(id: string): Promise<void> {
    try {
      await planService.touch(id)
      await reload()
    } catch (e) {
      console.warn('[plan] touch 失败', e)
    }
  }

  return { plans, loaded, loading, load, ensureLoaded, reload, byId, recent, upsert, remove, touch }
})
