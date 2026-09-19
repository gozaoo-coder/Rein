/**
 * 动作库（0025）：全部运动动作的唯一真源。
 *
 * 课程的展示名 / 肌群 / 要点一律先查这里，查不到才回落课程条目里的名称快照 ——
 * 所以库内改名（内置动作随种子刷新）全端跟随，重量曲线也不会因改名而断成两条。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { resolveActivation } from '@/config/muscles'
import { exerciseLibService } from '@/services/exerciseLibService'
import type {
  ExerciseCategory,
  ExerciseInput,
  ExerciseKind,
  ExerciseRecord,
  PlanExercise,
} from '@/types'

export const useExerciseLibStore = defineStore('exerciseLib', () => {
  const list = ref<ExerciseRecord[]>([])
  const loaded = ref(false)
  const loading = ref(false)

  const byId = computed(() => {
    const map = new Map<string, ExerciseRecord>()
    for (const e of list.value) map.set(e.id, e)
    return map
  })

  async function load(includeHidden = false): Promise<void> {
    loading.value = true
    try {
      list.value = await exerciseLibService.list({ includeHidden })
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await load()
  }

  async function upsert(input: ExerciseInput): Promise<ExerciseRecord> {
    const rec = await exerciseLibService.upsert(input)
    await load(true)
    return rec
  }

  /** 自建动作真删 / 内置动作隐藏（后端按 is_custom 分派） */
  async function remove(id: string): Promise<void> {
    await exerciseLibService.remove(id)
    await load(true)
  }

  async function restore(id: string): Promise<void> {
    await exerciseLibService.restore(id)
    await load(true)
  }

  function get(id: string): ExerciseRecord | null {
    return byId.value.get(id) ?? null
  }

  /** 展示名：库内名优先（改名跟随），缺失回落课程条目里的名称快照 */
  function resolveName(item: Pick<PlanExercise, 'exerciseId' | 'name'>): string {
    return get(item.exerciseId)?.name ?? item.name
  }

  /**
   * 展示用肌群激活表：库内显式数据优先，其次课程条目自带（AI 写入），
   * 最后按动作名关键词识别（自建动作没填肌群时的兜底）。
   */
  function musclesOf(item: PlanExercise): ReturnType<typeof resolveActivation> {
    const lib = get(item.exerciseId)
    if (lib && Object.keys(lib.muscles ?? {}).length) return lib.muscles
    if (item.muscles && Object.keys(item.muscles).length) return item.muscles
    return resolveActivation(resolveName(item))
  }

  /** 动作要点：库内优先（课程条目的 tips 允许被课程覆盖时仍以课程为准） */
  function tipsOf(item: PlanExercise): string {
    return item.tips || get(item.exerciseId)?.tips || ''
  }

  /** 按类型取库内动作（沉浸页「更换动作」用） */
  function forKind(kind: ExerciseKind, excludeId?: string): ExerciseRecord[] {
    return list.value.filter((e) => e.kind === kind && !e.hidden && e.id !== excludeId)
  }

  /** 本地检索：picker 实时过滤（名称/别名/分类）；隐藏的内置动作默认不出现在结果里 */
  function search(
    query: string,
    opts?: { kind?: ExerciseKind; category?: ExerciseCategory; includeHidden?: boolean },
  ): ExerciseRecord[] {
    const q = query.trim().toLowerCase()
    return list.value.filter((e) => {
      if (e.hidden && !opts?.includeHidden) return false
      if (opts?.kind && e.kind !== opts.kind) return false
      if (opts?.category && e.category !== opts.category) return false
      if (!q) return true
      return (
        e.name.toLowerCase().includes(q) ||
        e.aliases.some((a) => a.toLowerCase().includes(q))
      )
    })
  }

  return {
    list,
    loaded,
    loading,
    byId,
    load,
    ensureLoaded,
    upsert,
    remove,
    restore,
    get,
    resolveName,
    musclesOf,
    tipsOf,
    forKind,
    search,
  }
})
