/** 健康方案域 IPC 封装 · 对应 modules/program/commands.rs */

import type {
  ProgramCreateInput,
  ProgramDayMeals,
  ProgramRecord,
  ScheduleTodoInput,
  ShoppingCheck,
} from '@/types'
import { invoke } from './transport'

export const programService = {
  /** 方案历史（含归档），新的在前 */
  listPrograms: () => invoke<ProgramRecord[]>('program_list'),

  /** 当前生效方案；没有时返回 null */
  getActiveProgram: () => invoke<ProgramRecord | null>('program_get_active'),

  /** 启用一套方案（旧 active 自动归档）；随后应调 replaceSchedule 写入日程 */
  createProgram: (input: ProgramCreateInput) =>
    invoke<ProgramRecord>('program_create', { input }),

  /** 应用一次调整：整体替换内容快照，版本号后端自增 */
  updateProgramParams: (id: number, paramsJson: string, adjustmentsJson: string) =>
    invoke<ProgramRecord>('program_update_params', { id, input: { paramsJson, adjustmentsJson } }),

  /** 归档方案并回收日程：fromDate（含）起未完成日程一并清除，返回清除条数 */
  archiveProgram: (id: number, fromDate: string) =>
    invoke<number>('program_archive', { id, fromDate }),

  /** 删除方案并清掉其未完成日程待办；返回清除条数（已完成待办保留、脱离关联） */
  deleteProgram: (id: number) => invoke<number>('program_delete', { id }),

  /** 重排日程：删除该方案 fromDate 起未完成待办后整批写入；返回写入条数 */
  replaceSchedule: (id: number, fromDate: string, todos: ScheduleTodoInput[]) =>
    invoke<number>('program_schedule_replace', { id, fromDate, todos }),

  /** 某天已生成的 AI 菜单缓存；没有时返回 null */
  getProgramMeals: (programId: number, date: string) =>
    invoke<ProgramDayMeals | null>('program_meals_get', { programId, date }),

  /** 区间读取已生成的菜单缓存（闭区间，日期升序）；采购清单聚合用 */
  getProgramMealsRange: (programId: number, startDate: string, endDate: string) =>
    invoke<ProgramDayMeals[]>('program_meals_range', { programId, startDate, endDate }),

  /** 写入/覆盖某天的 AI 菜单 */
  setProgramMeals: (programId: number, date: string, mealsJson: string) =>
    invoke<ProgramDayMeals>('program_meals_set', { programId, date, mealsJson }),

  /** 清除 fromDate（含）起的缓存菜单（方案调整后按新参数重新生成） */
  clearProgramMeals: (programId: number, fromDate: string) =>
    invoke<number>('program_meals_clear', { programId, fromDate }),

  /** 采购清单勾选状态（清单由前端实时聚合，这里只存已买标记） */
  listShoppingChecks: () => invoke<ShoppingCheck[]>('shopping_checks_list'),

  /** 勾选/取消一个采购项（key = 聚合行 key） */
  setShoppingCheck: (itemKey: string, checked: boolean) =>
    invoke<void>('shopping_check_set', { itemKey, checked }),

  /** 清空全部勾选；返回清除条数 */
  clearShoppingChecks: () => invoke<number>('shopping_checks_clear'),
}
