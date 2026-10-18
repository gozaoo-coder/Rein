import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from 'vue'

import { useFeaturesStore } from '@/stores/features'

/* ============================================================
   桌面便当总览 · 自定义布局（顺序 / 尺寸 / 落盘 / 拖动手势）
   ------------------------------------------------------------
   便当从前是一张写死的 grid-template-areas：12 栏命名区域把「能量 / 待办 / 侧栏 /
   快捷 / 记账 / 运动 / 饮食」钉在固定的格子里，运动模块一关就得再写一份区域表
   （.no-sports）。现在把它拆成**稳定 id 的独立项**，布局由这份状态算出来：

     items = [{ id, span, order }]   span ∈ {3,4,6,12}（12 栏制的列数）
                                     order = 升序，即渲染顺序

   三条边界：
     · **项可增可减**（模块开关决定哪些项在不在，见 MODULE_ITEMS）——所以持久化里
       只认「已知 id」，未知 id 丢弃；本版本新增的 id 按缺省位补齐；缺字段回落缺省。
       隐藏的项仍留在状态里（只不渲染），模块再打开时位置还在。
     · **缺省排布**要和原区域表长得一样：hero/todo 是 4 列 × 2 行的「大砖」，
       番茄钟 + AI 各占 4 列叠在右上（靠栅格的 dense 回填实现），四磁贴各 3 列，
       记账 / 本周运动各 6 列，今日饮食通栏。
     · **模块关掉时不留空洞**：快捷入口少几个就几个（自动摊满这一行）、记账在本周运动
       不在时独占一行 —— 原实现靠第二份 grid-template-areas（`.no-sports`）做到，
       这里在渲染期把「还在缺省值上」的那几项自动摊开（用户自己调过尺寸的项一律尊重用户）。

   状态是**模块单例**：BentoOverview（栅格）与 BentoLayoutSheet（面板）两处消费同一份，
   各自 useBentoLayout() 拿到的是同一组 ref/computed，谁改另一边立刻跟上。
   ============================================================ */

export type BentoItemId =
  | 'hero'
  | 'todo'
  | 'pomodoro'
  | 'ai'
  | 'qa-food'
  | 'qa-workout'
  | 'qa-focus'
  | 'qa-ai'
  | 'led'
  | 'wk'
  | 'diet'

/** 12 栏制下的列宽档：3=四分之一、4=三分之一、6=半栏、12=通栏 */
export type BentoSpan = 3 | 4 | 6 | 12

export interface BentoItem {
  id: BentoItemId
  span: BentoSpan
  order: number
}

export interface BentoSpec {
  id: BentoItemId
  /** 布局面板里显示的名字 */
  label: string
  /** 缺省列宽 */
  span: BentoSpan
  /** 缺省行高（几格行）：大砖占 2 格，其余 1 格 */
  rows: 1 | 2
}

/** 渲染一个格子所需的一切（顺序 = 渲染顺序，span 已按可用项收敛） */
export interface BentoCell {
  id: BentoItemId
  label: string
  span: BentoSpan
  rows: 1 | 2
}

export const BENTO_STORAGE_KEY = 'rein.homeBento.v1'
/** 载荷版本：结构一变就抬版本号，旧数据整份丢弃回缺省（而不是猜着迁移） */
const STORAGE_VERSION = 1

export const BENTO_SPANS: readonly BentoSpan[] = [3, 4, 6, 12]

/** 规格表**同时就是缺省顺序**（数组下标 = order） */
export const BENTO_SPECS: readonly BentoSpec[] = [
  { id: 'hero', label: '能量与营养', span: 4, rows: 2 },
  { id: 'todo', label: '待办', span: 4, rows: 2 },
  { id: 'pomodoro', label: '番茄钟', span: 4, rows: 1 },
  { id: 'ai', label: 'AI 助手', span: 4, rows: 1 },
  { id: 'qa-food', label: '快捷 · 记饮食', span: 3, rows: 1 },
  { id: 'qa-workout', label: '快捷 · 记运动', span: 3, rows: 1 },
  { id: 'qa-focus', label: '快捷 · 专注', span: 3, rows: 1 },
  { id: 'qa-ai', label: '快捷 · AI 助手', span: 3, rows: 1 },
  { id: 'led', label: '记账', span: 6, rows: 1 },
  { id: 'wk', label: '本周运动', span: 6, rows: 1 },
  { id: 'diet', label: '今日饮食', span: 12, rows: 1 },
]

const SPEC_BY_ID = new Map<BentoItemId, BentoSpec>(BENTO_SPECS.map((s) => [s.id, s]))

const DEFAULT_ORDER = new Map<BentoItemId, number>(BENTO_SPECS.map((s, i) => [s.id, i]))

/**
 * 模块 → 便当里跟着一起消失的项。判据是「这块卡的内容完全来自那个模块」：
 * 关掉模块之后留着它，就是一块读不出任何内容的空壳（原实现只有运动一份，
 * 写死成 `.no-sports` 的第二份区域表；现在按插件开关逐模块摊开）。
 */
const MODULE_ITEMS: Record<string, readonly BentoItemId[]> = {
  sports: ['wk', 'qa-workout'],
  nutrition: ['hero', 'qa-food', 'diet'],
  focus: ['pomodoro', 'qa-focus'],
  ledger: ['led'],
}

function isBentoItemId(v: unknown): v is BentoItemId {
  return typeof v === 'string' && SPEC_BY_ID.has(v as BentoItemId)
}

function isSpan(v: unknown): v is BentoSpan {
  return BENTO_SPANS.includes(v as BentoSpan)
}

function defaultList(): BentoItem[] {
  return BENTO_SPECS.map((s, i) => ({ id: s.id, span: s.span, order: i }))
}

/**
 * 读持久化：未知 id 丢弃、缺字段回落、本版本新增的 id 按缺省位补齐。
 *
 * 「按缺省位补齐」= 在缺省顺序里，插到它**前一个已知项**的后面（用 order + 0.5 占位，
 * 排完再统一重编号）。这样以后新增一张卡（或用户关掉运动模块再打开）时，卡片回到
 * 设计者放它的位置，而不是甩到队尾。
 */
function loadItems(): BentoItem[] {
  const fallback = defaultList()
  try {
    const raw = localStorage.getItem(BENTO_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as { v?: unknown; items?: unknown }
    if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.items)) return fallback

    const saved = new Map<BentoItemId, { span: BentoSpan; order: number }>()
    for (const entry of parsed.items) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as { id?: unknown; span?: unknown; order?: unknown }
      if (!isBentoItemId(e.id)) continue // 未知 id 丢弃
      const spec = SPEC_BY_ID.get(e.id)!
      saved.set(e.id, {
        span: isSpan(e.span) ? e.span : spec.span, // 缺字段 / 越界值回落缺省
        order: Number.isFinite(e.order) ? Number(e.order) : (DEFAULT_ORDER.get(e.id) ?? 0),
      })
    }

    const list: BentoItem[] = []
    let cursor: number | null = null
    for (const spec of BENTO_SPECS) {
      const hit = saved.get(spec.id)
      if (hit) {
        list.push({ id: spec.id, span: hit.span, order: hit.order })
        cursor = hit.order
        continue
      }
      const prev: number | null = cursor
      const order: number = prev === null ? (list.length ? list[0]!.order : 1) - 0.5 : prev + 0.5
      list.push({ id: spec.id, span: spec.span, order })
      cursor = order
    }
    list.sort(
      (a, b) =>
        a.order - b.order || (DEFAULT_ORDER.get(a.id) ?? 0) - (DEFAULT_ORDER.get(b.id) ?? 0),
    )
    return list.map((it, i) => ({ ...it, order: i }))
  } catch {
    /* 存储不可用 / 载荷损坏：回缺省，绝不因为一份坏布局让首屏挂掉 */
    return fallback
  }
}

/* ---------- 单例状态 ---------- */
const items = ref<BentoItem[]>(loadItems())

function persist(): void {
  try {
    localStorage.setItem(
      BENTO_STORAGE_KEY,
      // 只写 id/span/order：将来结构再变，读侧仍按「未知丢弃 + 缺省补齐」兜住
      JSON.stringify({ v: STORAGE_VERSION, items: items.value.map((it) => ({ ...it })) }),
    )
  } catch {
    /* 私隐模式等存储不可用：布局退化为内存态 */
  }
}

function hiddenOf(features: ReturnType<typeof useFeaturesStore>): Set<BentoItemId> {
  const out = new Set<BentoItemId>()
  for (const [plugin, ids] of Object.entries(MODULE_ITEMS)) {
    if (!features.isEnabled(plugin)) for (const id of ids) out.add(id)
  }
  return out
}

/** 可见顺序（渲染顺序）：隐藏项只留在状态里占位，不参与排布与拖动 */
function orderOf(hidden: Set<BentoItemId>): BentoItemId[] {
  return items.value.filter((it) => !hidden.has(it.id)).map((it) => it.id)
}

/**
 * 把「可见项的新顺序」写回完整列表：隐藏项**留在原槽位**（它们的相对位置不动），
 * 可见槽位按新顺序依次填入。用 id→item 映射搬运整条记录，span 跟着卡走。
 */
function applyVisibleOrder(next: BentoItemId[], hidden: Set<BentoItemId>): void {
  const byId = new Map(items.value.map((it) => [it.id, it]))
  let k = 0
  const rebuilt: BentoItem[] = []
  for (const it of items.value) {
    if (hidden.has(it.id)) {
      rebuilt.push(it)
      continue
    }
    const moved = byId.get(next[k++])
    if (!moved) continue
    rebuilt.push({ ...moved })
  }
  items.value = rebuilt.map((it, i) => ({ ...it, order: i }))
}

export function useBentoLayout(): {
  /** 渲染顺序 + 已收敛的列宽（栅格按它渲染） */
  cells: ComputedRef<BentoCell[]>
  /** 用户视角的顺序（= cells 的 id 序），拖动手势与面板都用它 */
  ids: ComputedRef<BentoItemId[]>
  /** 顺序/尺寸都还在缺省值上 */
  isDefault: ComputedRef<boolean>
  move: (id: BentoItemId, to: number) => void
  resize: (id: BentoItemId, span: BentoSpan) => void
  reset: () => void
  snapshot: () => BentoItem[]
  restore: (snap: BentoItem[]) => void
} {
  const features = useFeaturesStore()
  const hidden = computed(() => hiddenOf(features))

  const ids = computed<BentoItemId[]>(() => orderOf(hidden.value))

  const cells = computed<BentoCell[]>(() => {
    const vis = ids.value
    const qaCount = vis.filter((id) => id.startsWith('qa-')).length
    // 快捷入口不是 4 个时把这一行摊满（3 个 → 各 4 列、2 个 → 各 6 列、1 个 → 通栏）
    const qaAutoNum = qaCount > 0 && qaCount < 4 ? 12 / qaCount : 0
    const qaAuto: BentoSpan | null = isSpan(qaAutoNum) ? qaAutoNum : null
    const wkOn = vis.includes('wk')
    return vis.map((id) => {
      const spec = SPEC_BY_ID.get(id)!
      const cur = items.value.find((it) => it.id === id)
      let span = cur?.span ?? spec.span
      // 只在「用户没动过这一项」时接管（动过尺寸就原样尊重用户）
      if (cur && cur.span === spec.span) {
        if (id.startsWith('qa-') && qaAuto) span = qaAuto
        else if (id === 'led' && !wkOn) span = 12
      }
      return { id, label: spec.label, span, rows: spec.rows }
    })
  })

  const isDefault = computed(() => {
    const def = defaultList()
    return (
      items.value.length === def.length &&
      items.value.every((it, i) => it.id === def[i]!.id && it.span === def[i]!.span)
    )
  })

  /** 把 id 插到「去掉它之后的可见列表」的第 to 位（拖动与面板共用这一套语义） */
  function move(id: BentoItemId, to: number): void {
    const vis = ids.value
    const from = vis.indexOf(id)
    if (from < 0) return
    const others = vis.filter((x) => x !== id)
    const at = Math.max(0, Math.min(others.length, Math.round(to)))
    const next = others.slice()
    next.splice(at, 0, id)
    if (next.every((x, i) => x === vis[i])) return
    applyVisibleOrder(next, hidden.value)
    persist()
  }

  function resize(id: BentoItemId, span: BentoSpan): void {
    if (!isSpan(span)) return
    const cur = items.value.find((it) => it.id === id)
    if (!cur || cur.span === span) return
    items.value = items.value.map((it) => (it.id === id ? { ...it, span } : it))
    persist()
  }

  function reset(): void {
    items.value = defaultList()
    persist()
  }

  function snapshot(): BentoItem[] {
    return items.value.map((it) => ({ ...it }))
  }

  /** 拖动被取消（Esc / pointercancel）时整体回滚到按下前的排布 */
  function restore(snap: BentoItem[]): void {
    items.value = snap.map((it) => ({ ...it }))
    persist()
  }

  return { cells, ids, isDefault, move, resize, reset, snapshot, restore }
}

/* ============================================================
   拖动换位（不引库）—— 手势骨架照 useDragDock：
   pointerdown 只登记，位移越过 8px slop 才算抓住（此前松手仍是点按）；
   抓住后 setPointerCapture，event 一直回到抓手柄；松手吞掉随后一次 click，
   免得拖完落在卡片上把卡片点开（幽灵点击）。
   ------------------------------------------------------------
   与其他拖拽实现的差别：这里**不给被拖的卡片做绝对定位**。落点靠 elementFromPoint
   找目标项，越过分界线就当场改顺序（live reorder）——于是**被拖项自己的格子就是
   插入位**：卡片被 translate 带走、格子空出来，空洞会跟着手指在网格里走，
   松手时卡片正好落回自己那一格。「插入位指示器」因此不需要额外元素，
   也不会出现「指示器在这、卡片却落在两行外」的错位。

   被拖的是项里的**卡面**（.b-surf）而不是项本身：项的盒子留在网格里当占位
   （虚线框 + 浅底），卡面跟着手指走。
   ============================================================ */
const SLOP_PX = 8
/** 拖后吞 click 的窗口：与 useDragDock 同值 */
const CLICK_SWALLOW_MS = 400
/** 拖到滚动容器上下缘多少像素内开始自动滚（bento 比一屏高时才用得上） */
const EDGE_BAND = 56
const EDGE_SPEED = 14

export interface BentoDragApi {
  /** 正在被拖的项（null = 没在拖） */
  dragId: Ref<BentoItemId | null>
  /** 刚松手、正在回位的项（走 --dur-fast 的位移动画，别在拖动中挂 transition） */
  settleId: Ref<BentoItemId | null>
  onHandleDown: (e: PointerEvent, id: BentoItemId) => void
}

export function useBentoDrag(options: {
  /** 栅格容器（找项、找滚动宿主） */
  listEl: Ref<HTMLElement | null>
  /** 当前可见顺序 */
  orderIds: () => BentoItemId[]
  move: (id: BentoItemId, to: number) => void
  snapshot: () => BentoItem[]
  restore: (snap: BentoItem[]) => void
}): BentoDragApi {
  const dragId = ref<BentoItemId | null>(null)
  const settleId = ref<BentoItemId | null>(null)

  let pointerId: number | null = null
  let pendingId: BentoItemId | null = null
  let startX = 0
  let startY = 0
  /** 抓住点相对卡面左上角的偏移：跟手时用它把卡钉在手指下的同一点 */
  let grabX = 0
  let grabY = 0
  let tx = 0
  let ty = 0
  let snap: BentoItem[] | null = null
  let prevUserSelect = ''
  let settleTimer = 0
  let scrollRaf = 0
  let scrollHostEl: HTMLElement | null = null
  /** 抓住那一刻宿主真实的滚动上限（拖拽中被撑大的 scrollHeight 不算数，见 scrollStep） */
  let scrollLimit = 0
  let pointerY = 0

  function itemEl(id: BentoItemId): HTMLElement | null {
    return options.listEl.value?.querySelector<HTMLElement>(`[data-bento-id="${id}"]`) ?? null
  }

  function surfEl(id: BentoItemId): HTMLElement | null {
    return itemEl(id)?.querySelector<HTMLElement>(':scope > .b-surf') ?? null
  }

  /** 最近的可滚动祖先（桌面下就是 .desk-main）：自动滚的宿主 */
  function findScrollHost(): HTMLElement | null {
    let el: HTMLElement | null = options.listEl.value
    while (el) {
      const cs = getComputedStyle(el)
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) return el
      el = el.parentElement
    }
    return null
  }

  function writeGhost(px: number, py: number): void {
    const el = dragId.value ? surfEl(dragId.value) : null
    if (!el) return
    // 读数含当前 transform，先减掉它还原「未被位移时的左上角」，再算新的位移量。
    // 顺序每变一次网格位置就跳一格，直接累加旧 delta 会让卡片跟着跳 —— 这里每帧重基准。
    const r = el.getBoundingClientRect()
    tx = px - grabX - (r.left - tx)
    ty = py - grabY - (r.top - ty)
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`
  }

  function clearGhost(id: BentoItemId, animate: boolean): void {
    const el = surfEl(id)
    if (!el) return
    if (!animate) {
      el.style.transform = ''
      return
    }
    settleId.value = id
    requestAnimationFrame(() => {
      el.style.transform = ''
    })
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      if (settleId.value === id) settleId.value = null
    }, 220)
  }

  /* ---------- 自动滚：拖到滚动容器上下缘时按帧推 ----------
     两条夹子都必须有：
       · 位移夹在带宽内 —— 指针拖到视口外时 d 会是几百像素，不夹就是每帧几百像素的狂奔；
       · 滚动位置夹在**抓住那一刻**的真实上限 —— 被拖的卡面 translate 出去会撑大宿主的
         scrollHeight（滚动溢出），照它滚能一路滚进那片虚高区，松手时卡面归位、scrollHeight
         缩回，滚动位置被浏览器夹回来，整页当着用户的面跳一下。 */
  function scrollStep(): void {
    scrollRaf = 0
    const host = scrollHostEl
    if (!host || dragId.value === null) return
    const r = host.getBoundingClientRect()
    const d =
      pointerY < r.top + EDGE_BAND
        ? pointerY - (r.top + EDGE_BAND)
        : pointerY > r.bottom - EDGE_BAND
          ? pointerY - (r.bottom - EDGE_BAND)
          : 0
    if (!d) return
    const step = (Math.max(-EDGE_BAND, Math.min(EDGE_BAND, d)) / EDGE_BAND) * EDGE_SPEED
    host.scrollTop = Math.max(0, Math.min(scrollLimit, host.scrollTop + step))
    scrollRaf = requestAnimationFrame(scrollStep)
  }

  function armEdgeScroll(): void {
    if (!scrollRaf) scrollRaf = requestAnimationFrame(scrollStep)
  }

  function stopEdgeScroll(): void {
    if (scrollRaf) cancelAnimationFrame(scrollRaf)
    scrollRaf = 0
  }

  /* ---------- 幽灵点击：抓过之后的第一次 click 吞掉 ---------- */
  let swallowedAt = 0
  function armClickSwallow(): void {
    swallowedAt = Date.now()
    document.addEventListener('click', onClickSwallow, { capture: true, once: true })
  }

  function onClickSwallow(e: MouseEvent): void {
    if (Date.now() - swallowedAt < CLICK_SWALLOW_MS) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  /** 落点解算：指针下的那一项 + 越过它中线的哪一侧 → 插到它前/后 */
  function dropTarget(px: number, py: number): number | null {
    const id = dragId.value
    if (!id) return null
    const hit = document.elementFromPoint(px, py)?.closest<HTMLElement>('[data-bento-id]')
    const over = hit?.dataset.bentoId
    if (!over || over === id) return null
    const others = options.orderIds().filter((x) => x !== id)
    const i = others.indexOf(over as BentoItemId)
    if (i < 0) return null
    const r = hit!.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // 用「归一化后的偏移谁更大」定轴：同排邻居比 x、上下排邻居比 y
    const useX = Math.abs(px - cx) * Math.max(r.height, 1) > Math.abs(py - cy) * Math.max(r.width, 1)
    const after = useX ? px > cx : py > cy
    return after ? i + 1 : i
  }

  function engage(px: number, py: number): void {
    const id = pendingId
    if (!id) return
    const el = surfEl(id)
    if (el) {
      const r = el.getBoundingClientRect()
      grabX = px - r.left
      grabY = py - r.top
    }
    tx = 0
    ty = 0
    snap = options.snapshot()
    dragId.value = id
    scrollHostEl = findScrollHost()
    scrollLimit = scrollHostEl ? scrollHostEl.scrollHeight - scrollHostEl.clientHeight : 0
    prevUserSelect = document.body.style.userSelect
    // 拖过卡片文字时不许选词：拖动期间整页禁选，松手还原（点按不受影响）
    document.body.style.userSelect = 'none'
    armClickSwallow()
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    if (dragId.value === null) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= SLOP_PX) return
      engage(e.clientX, e.clientY)
    }
    const id = dragId.value
    if (!id) return
    pointerY = e.clientY
    writeGhost(e.clientX, e.clientY)
    const to = dropTarget(e.clientX, e.clientY)
    if (to !== null) options.move(id, to)
    armEdgeScroll()
  }

  function finish(cancelled: boolean): void {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    stopEdgeScroll()
    scrollHostEl = null
    const id = dragId.value
    const wasDragging = id !== null
    pointerId = null
    pendingId = null
    dragId.value = null
    document.body.style.userSelect = prevUserSelect
    prevUserSelect = ''
    if (!wasDragging || !id) return
    if (cancelled && snap) options.restore(snap)
    snap = null
    tx = 0
    ty = 0
    clearGhost(id, true)
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    finish(false)
  }

  function onCancel(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    finish(true)
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || dragId.value === null) return
    e.preventDefault()
    finish(true)
  }

  function onHandleDown(e: PointerEvent, id: BentoItemId): void {
    if (e.button !== 0) return // 只认主键（右键/中键不抓）
    if (pointerId !== null) return // 多指保护：拖拽中忽略第二根手指
    pointerId = e.pointerId
    pendingId = id
    startX = e.clientX
    startY = e.clientY
    pointerY = e.clientY
    const handle = e.currentTarget as HTMLElement
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已失效等极端时序：事件仍沿元素冒泡到 window，手势照常走 */
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('click', onClickSwallow, { capture: true })
    stopEdgeScroll()
  })

  return { dragId, settleId, onHandleDown }
}
