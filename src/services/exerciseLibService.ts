/** 动作库 IPC 封装 · 对应 modules/exercise_lib/commands.rs */

import type { ExerciseCategory, ExerciseInput, ExerciseKind, ExerciseRecord } from '@/types'
import { invoke } from './transport'

export const exerciseLibService = {
  /** 库内动作（默认按最近使用排序；内置动作默认不含被隐藏的） */
  list: (p?: {
    kind?: ExerciseKind
    category?: ExerciseCategory
    query?: string
    includeHidden?: boolean
  }) =>
    invoke<ExerciseRecord[]>('list_exercises', {
      kind: p?.kind ?? null,
      category: p?.category ?? null,
      query: p?.query ?? null,
      includeHidden: p?.includeHidden ?? false,
    }),

  get: (id: string) => invoke<ExerciseRecord>('get_exercise', { id }),

  /** 新建 / 更新自建动作（内置动作只读，提交会被后端拒绝） */
  upsert: (input: ExerciseInput) => invoke<ExerciseRecord>('upsert_exercise', { input }),

  /** 自建动作真删；内置动作只做隐藏（历史做组记录都保留） */
  remove: (id: string) => invoke<void>('delete_exercise', { id }),

  restore: (id: string) => invoke<void>('restore_exercise', { id }),
}
