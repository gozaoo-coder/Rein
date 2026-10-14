/** 练够分装载 · 两个数据源一次取齐（对应 strength_recent_sets + list_workouts） */

import { exerciseService } from '@/services/exerciseService'
import { sessionService } from '@/services/sessionService'
import { addDays } from '@/utils/date'
import type { StrengthSetRecord, Workout } from '@/types'

/**
 * 输入窗口（天）。与 `strength_recent_sets(42)` 的既有窗口一致：
 * 练够分本体只看最近 7 天，但重量基线要往前再取 4 周；有氧记录跟着同一窗口走，
 * 免得「两个源各取各的窗口」导致同一张卡上的数字对不上时间范围。
 */
export const SCORE_INPUT_DAYS = 42

/**
 * 装载练够分的两条原料。
 *
 * 为什么放 service 层而不是各组件里各调一次：三处调用点（运动页热力图卡、主页练卡、
 * 说明抽屉的宿主）必须看到**同一份输入**，否则同一时刻两张卡会显示不同的分数；
 * 以后换窗口 / 加数据源也只有这一处要改。失败按各自的既有约定上抛，由调用方兜住。
 */
export async function loadScoreInput(
  today: string,
): Promise<{ sets: StrengthSetRecord[]; workouts: Workout[] }> {
  const [sets, workouts] = await Promise.all([
    sessionService.strengthRecentSets(SCORE_INPUT_DAYS),
    exerciseService.listWorkouts(addDays(today, -(SCORE_INPUT_DAYS - 1)), today),
  ])
  return { sets, workouts }
}
