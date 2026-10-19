import type { PeriodSlot, ScheduleEntry } from '@/types'

/**
 * 课表时间轴适配层。
 *
 * 各校作息不一样：有的学校一上就是两节（第1-2节 08:00-09:25），有的是四十分钟一节
 * （第1节 08:00-08:40、第2节 08:45-09:25），节与节之间的休息也长短不一。
 * 周视图左列是**行轴**，行轴必须因此是**派生**的，而不是「按区间去重」——
 * 后者在第1-2节 与 第2-3节 并存时会画出两行，第2节被画两遍。
 *
 * 这里产出两样东西，组件只管画：
 * 1. [`buildAxisRows`] —— 行轴本身：把「学校公布的节次表」与「实际排课的节次区间」
 *    归一化成一组**互斥片段**（可能是一节，也可能是若干节的合并）。与 Rust 侧
 *    `campus::commands::build_time_axis` 同口径（就像 `expand_entries` ↔ `campusExpand`），
 *    mock 用它造轴、后端同步出的 `timeSlots` 也是这个形状。
 * 2. [`buildTimeAxis`] —— 把每门课落到行轴上，给出它占的**起始行**与**跨几行**。
 *    同一行同时有课（真冲突）就并成一个「冲突组」，一个组一个格子。
 *
 * **绝不插值编时刻**：拿不到逐节真读数时，用覆盖该片段的最紧封套
 * （覆盖者里最晚的开始 / 最早的结束），那也是教务给的数。
 */

/** 节次表的一行：第 `unit` 节的起止时刻（学校公布的真读数）。 */
export interface PeriodTableRow {
  unit: number
  startTime: string
  endTime: string
}

/** 行轴需要从「一次课」上读到的全部信息（`CampusSession` / mock 的演示形状都满足） */
interface SessionLike {
  startUnit: number
  endUnit: number
  startTime: string
  endTime: string
}

/** 行轴的一行 —— 与 IPC 的 `PeriodSlot` 同形，逐字段对应 */
export type AxisRow = PeriodSlot

/** 一个格子：一天里同一时段的一组课（`entries.length > 1` = 真冲突，并排画） */
export interface AxisCell {
  /** 该组占的第一行（`AxisRow` 下标，0 基） */
  row: number
  /** 该组跨几行（≥ 1）—— 课块靠它跨行绘制 */
  span: number
  entries: ScheduleEntry[]
}

export interface TimeAxis {
  rows: AxisRow[]
  /**
   * `${date}|${row}` → 覆盖该行的格子。
   * **组内的每一行都指着同一个格子**（`cell.row` 才是组的起点行）——
   * 「被跨行课块盖住的行」与「这天没课的行」因此能分开：前者不画（画了会压在课块上，
   * 组内的分隔线由课块自己收口），后者要画（不然网格线断掉）。
   */
  cells: Map<string, AxisCell>
}

/** `"08:40"` → 520。解析不出来返回 null（不猜）。 */
function hhmmToMin(s: string): number | null {
  const [h, m] = s.split(':')
  const hh = Number(h)
  const mm = Number(m)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  return hh * 60 + mm
}

export function rowKey(row: { startUnit: number; endUnit: number }): string {
  return `${row.startUnit}-${row.endUnit}`
}

/** 行轴的键（跨行课块与 `v-for` 的 key 都用它） */
export function cellKey(date: string, row: number): string {
  return `${date}|${row}`
}

/** 「第5节」/「第8-10节」—— 单节不写成「第5-5节」 */
export function unitLabel(startUnit: number, endUnit: number): string {
  return startUnit === endUnit ? `第${startUnit}节` : `第${startUnit}-${endUnit}节`
}

/** 覆盖 `[p, q]` 的那组课里最紧的一层封套（最晚开始 / 最早结束），全不可解析时给 null */
function tightestEnvelope(covering: SessionLike[]): { startTime: string; endTime: string } | null {
  let startTime: string | null = null
  let endTime: string | null = null
  let startMin = -1
  let endMin = Number.POSITIVE_INFINITY
  for (const s of covering) {
    const a = hhmmToMin(s.startTime)
    if (a !== null && a > startMin) {
      startMin = a
      startTime = s.startTime
    }
    const b = hhmmToMin(s.endTime)
    if (b !== null && b < endMin) {
      endMin = b
      endTime = s.endTime
    }
  }
  return startTime !== null && endTime !== null ? { startTime, endTime } : null
}

/**
 * 行轴 = 互斥片段。
 *
 * 口径（与 Rust `build_time_axis` 逐条对应）：
 * 1. 候选区间 = 节次表的每一节 `(u, u)` ∪ 每个时段的 `(startUnit, endUnit)`；
 * 2. 断点 = 所有区间的 `start` 与 `end + 1`，去重升序；
 * 3. 相邻断点构成片段 —— 天然互斥、首尾相接，同一节次只会出现一次；
 * 4. **没课的片段不画**（第5节没课就没有第5节那一行），行数与「那天上了几节」对齐；
 * 5. 时刻：片段内每一节在表里都有 → 用表里的逐节真读数；否则退回最紧封套。
 */
export function buildAxisRows(
  periodTable: PeriodTableRow[],
  sessions: SessionLike[],
): AxisRow[] {
  const table = new Map<number, PeriodTableRow>()
  const bounds = new Set<number>()
  for (const p of periodTable) {
    // 时刻解析不出来的行不收：半张表会给出半截真读数，那比整段退回封套更误导
    if (p.unit > 0 && hhmmToMin(p.startTime) !== null && hhmmToMin(p.endTime) !== null) {
      table.set(p.unit, p)
      bounds.add(p.unit)
      bounds.add(p.unit + 1)
    }
  }
  for (const s of sessions) {
    if (s.startUnit > 0 && s.endUnit >= s.startUnit) {
      bounds.add(s.startUnit)
      bounds.add(s.endUnit + 1)
    }
  }
  const edges = [...bounds].sort((a, b) => a - b)

  const rows: AxisRow[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const p = edges[i]!
    const q = edges[i + 1]! - 1
    const covering = sessions.filter((s) => s.startUnit > 0 && s.startUnit <= p && s.endUnit >= q)
    if (covering.length === 0) continue

    // 逐节真读数优先：片段内每一节都要在表里；否则退回最紧封套（全是教务给的真实时刻）
    const fromTable = [...Array(q - p + 1).keys()].every((k) => table.has(p + k))
    const window: { startTime: string; endTime: string } | null = fromTable
      ? { startTime: table.get(p)!.startTime, endTime: table.get(q)!.endTime }
      : tightestEnvelope(covering)
    if (window === null) continue

    const startMin = hhmmToMin(window.startTime)
    const endMin = hhmmToMin(window.endTime)
    if (startMin === null || endMin === null) continue
    rows.push({
      startUnit: p,
      endUnit: q,
      startTime: window.startTime,
      endTime: window.endTime,
      startMin,
      durationMin: Math.max(0, endMin - startMin),
    })
  }
  return rows
}

/**
 * 把课落到行轴上：每门课 → (起行, 跨几行)，同一天重叠的课并成一个冲突组。
 *
 * 重叠才并组（相邻不并）：第1-2节 与 第2-3节 在第2节上真冲突，该并；
 * 第1-2节 与 第3-4节 只是挨着，各占各的格子。
 */
export function buildTimeAxis(rows: AxisRow[], entries: ScheduleEntry[]): TimeAxis {
  const rowOf = new Map<number, number>()
  rows.forEach((r, i) => {
    for (let u = r.startUnit; u <= r.endUnit; u++) rowOf.set(u, i)
  })

  const byDate = new Map<string, ScheduleEntry[]>()
  for (const e of entries) {
    const list = byDate.get(e.date)
    if (list) list.push(e)
    else byDate.set(e.date, [e])
  }

  const cells = new Map<string, AxisCell>()
  for (const [date, list] of byDate) {
    // 落在轴上的课 → [起行, 止行]；轴外的（实践课 startUnit=0、或本区间没排课）直接跳过
    const placed: { row: number; endRow: number; entry: ScheduleEntry }[] = []
    for (const e of list) {
      const first = rowOf.get(e.session.startUnit)
      const last = rowOf.get(e.session.endUnit)
      if (first === undefined || last === undefined) continue
      const row = Math.min(first, last)
      placed.push({ row, endRow: Math.max(first, last), entry: e })
    }
    placed.sort((a, b) => a.row - b.row || a.endRow - b.endRow)

    let group: { row: number; endRow: number; entries: ScheduleEntry[] } | null = null
    const flush = (): void => {
      if (!group) return
      const cell: AxisCell = {
        row: group.row,
        span: group.endRow - group.row + 1,
        entries: group.entries,
      }
      // 组内每一行都登记到同一个格子：起点行靠它画课块，其余行靠它「不画空格子」
      for (let r = group.row; r <= group.endRow; r++) cells.set(cellKey(date, r), cell)
      group = null
    }
    for (const p of placed) {
      if (group && p.row <= group.endRow) {
        group.endRow = Math.max(group.endRow, p.endRow)
        group.entries.push(p.entry)
      } else {
        flush()
        group = { row: p.row, endRow: p.endRow, entries: [p.entry] }
      }
    }
    flush()
  }
  return { rows, cells }
}

/** 行高权重的上限：再长的连排课也不该把一屏撑成两屏 */
const MAX_WEIGHT = 2.6

/**
 * 行高权重（fr）—— **按真实时长成比例**，最短的那一行 = 1fr。
 *
 * 「时间不对称」的观感就是从这儿来的：40 分钟的一节和 130 分钟的连排不该一样高。
 * 上下限都留着：太短的节读不出来（下限由 CSS 的 `minmax` 兜），太长的行会挤掉邻行。
 */
export function rowWeights(rows: AxisRow[]): number[] {
  if (rows.length === 0) return []
  const base = Math.min(...rows.map((r) => Math.max(r.durationMin, 1)))
  return rows.map((r) =>
    Math.min(MAX_WEIGHT, Math.max(1, Math.round((Math.max(r.durationMin, 1) / base) * 100) / 100)),
  )
}
