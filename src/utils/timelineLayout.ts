/**
 * 时间轴块布局（纯函数）：日画布 / 周甘特共用。
 * - 按分钟区间贪心分列（≤2 列并排；≥3 列收成一个叠层簇）；
 * - 并排的门槛还能按**实际像素宽度**收严：列太窄时并排会把每块压到放不下一个字
 *   （周甘特一列只有 80px，两列并排 = 每块 37px，标题区不足 11px，只能一字一行），
 *   这时退化成叠层卡 —— 卡面独占整列，标题才读得出来。不传 `colWidth` 就只看列数（日画布行为不变）。
 * - 输入仅依赖分钟值，不依赖像素 → 缩放变化无需重算，坐标换算留给视图层。
 */
import type { Todo } from '@/types'

/** 待办有效时长（分钟）：未填按 30 分钟，至少可点 */
export const durationOf = (t: Todo): number => Math.max(10, t.durationMin ?? 30)

/** 单个块的基本几何（分钟域） */
export interface BlockGeom {
  todo: Todo
  /** 距 00:00 分钟 */
  startMin: number
  /** 时长分钟 */
  durationMin: number
  /** 并排列索引（0 起） */
  col: number
  /** 该簇共几列 */
  cols: number
}

/** 叠层簇（≥3 条同时段）：收成一张卡面，其余进清单 */
export interface StackGroup {
  items: Todo[]
  startMin: number
}

export interface DayLayout {
  blocks: BlockGeom[]
  stacks: StackGroup[]
}

/** 布局的宽度策略（可省略；省略 = 只按列数决定并排 / 叠层） */
export interface LayoutOptions {
  /** 单列可用宽度（px） */
  colWidth?: number
  /** 并排时每块的最小可读宽度（px）；`colWidth / 列数` 低于它就不并排 */
  minBlockPx?: number
}

/**
 * 分完列后每块还放得下字吗？放不下就别并排。
 * 只传了 `colWidth` 或只传了 `minBlockPx` 时视为「没给策略」，不拦（避免半套参数悄悄改行为）。
 */
function tooNarrowToSplit(cols: number, opts: LayoutOptions): boolean {
  const { colWidth, minBlockPx } = opts
  if (!colWidth || !minBlockPx) return false
  return colWidth / cols < minBlockPx
}

/**
 * 单日重叠布局：按开始时间排序 → 连通簇 → 簇内贪心分配最左可用列。
 * ≤2 列：块并排（col/cols 定位）；≥3 列：整簇收成叠层卡。
 * 给了 `colWidth` + `minBlockPx` 时，并排还要过一道宽度关：分完列后每块放不下字就同样收成叠层卡。
 */
export function layoutDayBlocks(todos: Todo[], opts: LayoutOptions = {}): DayLayout {
  const items = [...todos]
    .filter((t) => t.startMin != null)
    .sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0) || a.id - b.id)

  const blocks: BlockGeom[] = []
  const stacks: StackGroup[] = []
  let cluster: { t: Todo; end: number }[] = []
  let clusterEnd = -1

  const flush = (): void => {
    if (!cluster.length) return
    const colEnds: number[] = []
    const assigned: { t: Todo; col: number }[] = []
    for (const c of cluster) {
      let col = colEnds.findIndex((e) => e <= c.t.startMin!)
      if (col === -1) {
        colEnds.push(c.end)
        col = colEnds.length - 1
      } else {
        colEnds[col] = c.end
      }
      assigned.push({ t: c.t, col })
    }
    if (colEnds.length <= 2 && !tooNarrowToSplit(colEnds.length, opts)) {
      for (const a of assigned) {
        blocks.push({
          todo: a.t,
          startMin: a.t.startMin!,
          durationMin: durationOf(a.t),
          col: a.col,
          cols: colEnds.length,
        })
      }
    } else {
      stacks.push({ items: cluster.map((c) => c.t), startMin: cluster[0]!.t.startMin! })
    }
    cluster = []
    clusterEnd = -1
  }

  for (const t of items) {
    const end = t.startMin! + durationOf(t)
    if (cluster.length && t.startMin! >= clusterEnd) flush()
    cluster.push({ t, end })
    clusterEnd = Math.max(clusterEnd, end)
  }
  flush()

  return { blocks, stacks }
}

/** 块高折算可完整显示的标题行数（至少 1 行，放不下由 line-clamp 省略） */
export function titleLinesFor(blockHeightPx: number, lineHeightPx: number, padY: number): number {
  return Math.max(1, Math.floor((blockHeightPx - padY) / lineHeightPx))
}
