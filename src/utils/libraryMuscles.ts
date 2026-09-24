/**
 * 动作库展示用的肌群表。
 *
 * 课程侧的统一入口是 `stores/exerciseLib.musclesOf`（库记录 → 课程条目 → 名称规则），
 * 动作库页面手里只有库记录本身，这里保持同一口径：
 * 显式肌群表优先，空表按动作名关键词兜底（自建动作没标肌群时至少别整块空白）。
 */

import { normalizeActivation, resolveActivation, type ActivationMap } from '@/config/muscles'
import type { ExerciseRecord } from '@/types'

type MuscledExercise = Pick<ExerciseRecord, 'name' | 'muscles'>

export function libraryMuscles(e: MuscledExercise | null | undefined): ActivationMap {
  if (!e) return {}
  const explicit = normalizeActivation(e.muscles)
  if (Object.keys(explicit).length) return explicit
  return resolveActivation(e.name) ?? {}
}
