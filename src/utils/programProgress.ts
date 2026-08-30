/**
 * 方案周期进度：把 blob.days 与方案日程待办（todos.programId）左连接，
 * 算出每一天在「28 天地图」上的状态，以及整体完成率。
 *
 * 统计口径与 utils/programReport.ts 保持一致（同按 programId 过滤、
 * category==='workout' 视为训练日），避免两处算法漂移。
 *
 * 纯函数：不依赖 store / IPC，便于在组件外复用与测试。
 */

import type { ProgramBlob, ProgramDay, Todo } from '@/types'

/** 地图格子的六种状态 */
export type CellState =
  /** 过去 · 训练已完成 */
  | 'done'
  /** 过去 · 训练未完成（错过） */
  | 'missed'
  /** 今天 */
  | 'today'
  /** 未来 · 训练日 */
  | 'future'
  /** 过去 · 休息日（无需完成） */
  | 'restPast'
  /** 未来 · 休息日 */
  | 'restFuture'

export interface DayCell {
  date: string
  /** 方案内的天序（0 起） */
  dayIndex: number
  /** 展示用的第几天（1 起） */
  dayNo: number
  state: CellState
  rest: boolean
  courseName: string | null
  courseId: string | null
  /** 当日菜单总热量 */
  kcal: number
}

export interface CycleStats {
  /** 方案总天数 */
  total: number
  /** 训练日总数（不含休息日） */
  planned: number
  /** 已完成训练 */
  done: number
  /** 已错过训练 */
  missed: number
  /** 休息日（含已过与未到） */
  rest: number
  /** 尚未到来的训练日 */
  future: number
  /** 完成率 0-1（分母只算已发生的训练日，未到的不计入） */
  rate: number
}

/** 判断某天相对今天的位置 */
type Rel = 'past' | 'today' | 'future'

function relOf(date: string, today: string): Rel {
  if (date === today) return 'today'
  return date < today ? 'past' : 'future'
}

/**
 * 生成周期地图格子。
 *
 * @param blob    方案内容快照
 * @param todos   全部待办（调用方负责按 programId 预筛选或传入全量）
 * @param programId 当前方案 id
 * @param today   本地日期 YYYY-MM-DD
 */
export function buildDayCells(
  blob: ProgramBlob,
  todos: Todo[],
  programId: number,
  today: string,
): DayCell[] {
  // 同一天可能有多条方案待办（训练 + 饮食锚点），这里按日期归并出「当天是否完成训练」
  const byDate = new Map<string, { hasTraining: boolean; trainingDone: boolean }>()
  for (const t of todos) {
    if (t.programId !== programId || t.category !== 'workout' || !t.date) continue
    const cur = byDate.get(t.date) ?? { hasTraining: false, trainingDone: false }
    cur.hasTraining = true
    if (t.status === 'done') cur.trainingDone = true
    byDate.set(t.date, cur)
  }

  return blob.days.map((d: ProgramDay) => {
    const rel = relOf(d.date, today)
    const rec = byDate.get(d.date)
    let state: CellState

    if (rel === 'today') {
      state = 'today'
    } else if (rel === 'future') {
      state = d.rest ? 'restFuture' : 'future'
    } else if (d.rest) {
      state = 'restPast'
    } else {
      // 过去的训练日：以待办状态为准；无待办记录（如方案刚启用/日程被清）按错过处理
      state = rec?.trainingDone ? 'done' : 'missed'
    }

    return {
      date: d.date,
      dayIndex: d.dayIndex,
      dayNo: d.dayIndex + 1,
      state,
      rest: d.rest,
      courseName: d.courseName,
      courseId: d.courseId,
      kcal: d.meals.reduce((s, m) => s + m.kcal, 0),
    }
  })
}

/** 汇总完成率等统计（分母只算已发生的训练日） */
export function cycleStats(cells: DayCell[]): CycleStats {
  let planned = 0
  let done = 0
  let missed = 0
  let rest = 0
  let future = 0

  for (const c of cells) {
    if (c.rest) {
      rest++
      continue
    }
    planned++
    if (c.state === 'done') done++
    else if (c.state === 'missed') missed++
    else if (c.state === 'future') future++
    // 'today' 不计入已发生，等当天结束自然转为 done / missed
  }

  const occurred = done + missed
  return {
    total: cells.length,
    planned,
    done,
    missed,
    rest,
    future,
    rate: occurred === 0 ? 0 : done / occurred,
  }
}

/** 按自然周切分（每 7 天一行，与方案的「周」对齐，因为方案总是从起始日连续铺开） */
export function groupByWeek(cells: DayCell[]): DayCell[][] {
  const weeks: DayCell[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7))
  }
  return weeks
}

/**
 * 阶段名：按周序给出训练学上的分期叫法。
 * 4 周方案 → 适应 / 强化 / 强化 / 冲刺；更短或更长的方案按比例分配。
 */
export function phaseLabel(weekIndex: number, totalWeeks: number): string {
  if (totalWeeks <= 1) return '适应期'
  if (weekIndex === 0) return '适应期'
  if (weekIndex === totalWeeks - 1 && totalWeeks >= 3) return '冲刺期'
  return '强化期'
}

/** 格子的展示文案：训练日画课程名首两字，休息日画「休」 */
export function cellText(cell: DayCell): string {
  if (cell.rest) return '休'
  const name = cell.courseName ?? ''
  return name.length > 2 ? name.slice(0, 2) : name || '练'
}
