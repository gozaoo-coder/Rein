/* ============================================================
   Rein · 自绘超范围回弹（overscroll band）
   ------------------------------------------------------------
   背景：Android 12+ 的系统级边缘滚动效果由 glow 改为 stretch，WebView（Chromium）
   会把它作用在根滚动容器上，表现为滚动到边界时整页 scaleY 拉伸。原生层已在
   MainActivity 关闭（webView.overScrollMode = OVER_SCROLL_NEVER）；这里在 Web 层
   自绘替代手感：到边后继续拖 = 超范围平移，位移走对数阻尼（初始 1:1、越拖越沉），
   松手弹回。

   曲线（两条硬约束都精确成立）：
     f(x) = ln(1 + x·lnB) / lnB ≡ k·ln(1 + x/k)，k = 1/lnB
     f(0) = 0；f'(x) = 1/(1 + x·lnB) → f'(0) = 1
     ——「overOffset=0 时平移速率与拖动速率一致」，与原生滚动交接无速度突变；
     x ≫ k 后渐近 log_B(x)，即需求里的 log(x)/log(衰减指数)，越拖越拖不动。

   接入（全应用只挂一份 window 监听，容器增删 / 弹层动态挂载自动适配）：
     data-rubber-page    文档滚动页层（App.vue，唯一）
     data-rubber-content 容器内容层（解析规则 scroller > [data-rubber-content]，
                         或给现成的单一内容子节点直接打标）
     data-rubber-self    把滚动容器自身当层（横向条 / 纯文本盒）

   判定（逐 move 增量累加，链式语义与原生一致）：
     1) 从触摸目标向上收集「可滚动祖先」；任一节点 touch-action:none → 整个手势
        放弃（浮条拖拽 / 跑步地图 / 待办芯片这些子树自管手势）；输入类控件不接管；
     2) 首个超过 4px 的累计位移定轴（锁轴那一刻把此前位移一次性计入，不丢行程）；
     3) 链上（到第一个 overscroll-behavior: contain/none 为止）还有容器能吃掉该
        方向位移 → 完全交给原生（含链式滚动）；
     4) 否则取链上「已到边且有层」的最深容器开始 band；
     5) band 中反向拖回 overOffset=0 → 立即清层交还原生（f'(0)=1 保证交接无跳变）。

   约定：只监听 touch（pointer 事件无法在滚动手势中途 preventDefault，先例
   SheetModal）；prefers-reduced-motion 下整体不接管（原生硬停）。
   ============================================================ */

type Axis = 'x' | 'y'

/* ---------- 手感参数（真机验证的调参入口都收在这里） ---------- */
/** 衰减指数 B（>1）：1.01=软 … 1.05=硬；1.02 ⇒ k≈50.5px（手指 100px → 平移 55px） */
const DECAY_BASE = 1.02
/** 回弹弹簧（半隐式欧拉）：与 useDragDock 同参（ζ≈0.87、ωn≈12.6rad/s ≈ 0.48s） */
const SPRING = { stiffness: 160, damping: 22 }
/** 指速采样窗：显示空间初速 = 指速 × f'(over) */
const VELOCITY_WINDOW_MS = 100
/** 轴锁：累计位移超过它才定轴 */
const AXIS_LOCK_PX = 4
/** band 峰值超过它就吞掉随后一次 click（防拖拽后的幽灵点击） */
const CLICK_SWALLOW_PX = 8
const CLICK_SWALLOW_MS = 400
/** 边界容差：Android 的 scrollTop 是小数 */
const EDGE_EPS = 1
/** 弹簧收尾阈值（位移 px / 速度 px·s⁻¹） */
const SETTLE_PX = 0.5
const SETTLE_V = 20

const SOFTNESS = 1 / Math.log(DECAY_BASE)

interface Candidate {
  el: HTMLElement
  /** 该轴「可滚」：overflow auto|scroll 且有溢出 */
  x: boolean
  y: boolean
  /** 平移层；null = 该容器不接管 */
  layer: HTMLElement | null
  /** overscroll-behavior 含 contain/none：滚动链到此截断 */
  blockX: boolean
  blockY: boolean
}

interface Band {
  layer: HTMLElement
  axis: Axis
  /** 越界的边：start=顶/左，end=底/右 */
  edge: 'start' | 'end'
  /** 方向符号：start 边越界为正、end 边为负（transform 的符号） */
  dir: 1 | -1
  /** 超出边界的「手指累计位移」（px，≥0） */
  over: number
  /** 本次手势的峰值（决定是否吞幽灵点击） */
  peak: number
}

/* ---------- 单例状态 ---------- */
let started = false
let candidates: Candidate[] = []
let tracking = false
let axis: Axis | null = null
let startX = 0
let startY = 0
let lastX = 0
let lastY = 0
let band: Band | null = null
let samples: Array<{ t: number; over: number }> = []
let raf = 0
let springLayer: HTMLElement | null = null

/* ---------- 曲线 ---------- */
/** 超范围位移 → 平移量（f(0)=0、f'(0)=1、对数阻尼自限，无需封顶） */
function offset(over: number): number {
  return over <= 0 ? 0 : SOFTNESS * Math.log1p(over / SOFTNESS)
}

/** f'(x)：显示空间速度 = 指速 × 本值（松手初速用；x=0 时为 1） */
function slope(over: number): number {
  return SOFTNESS / (SOFTNESS + over)
}

/* ---------- 滚动度量 ---------- */
function scrollPos(el: HTMLElement, a: Axis): number {
  return a === 'y' ? el.scrollTop : el.scrollLeft
}

function scrollMax(el: HTMLElement, a: Axis): number {
  return a === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
}

/** 该容器还能吃掉这个方向的位移吗（链式滚动由调用方按顺序检查） */
function canConsume(c: Candidate, a: Axis, d: number): boolean {
  if (!(a === 'y' ? c.y : c.x)) return false
  const pos = scrollPos(c.el, a)
  return d > 0 ? pos > EDGE_EPS : pos < scrollMax(c.el, a) - EDGE_EPS
}

/** 该容器是否已停在「这个方向要越出的那条边」上 */
function atEdge(c: Candidate, a: Axis, d: number): boolean {
  const pos = scrollPos(c.el, a)
  return d > 0 ? pos <= EDGE_EPS : pos >= scrollMax(c.el, a) - EDGE_EPS
}

/* ---------- 层解析 ---------- */
function layerFor(scroller: HTMLElement): HTMLElement | null {
  if (scroller === document.scrollingElement) {
    return document.querySelector<HTMLElement>('[data-rubber-page]')
  }
  if (scroller.hasAttribute('data-rubber-self')) return scroller
  return scroller.querySelector<HTMLElement>(':scope > [data-rubber-content]')
}

/**
 * 触摸目标 → 可滚动祖先链（内层在前；文档根滚动最后补上）。
 * 任一节点 touch-action:none → 返回 null：该子树自管手势，整个手势放弃。
 */
function collectCandidates(target: EventTarget | null): Candidate[] | null {
  if (!(target instanceof Element)) return null
  // 文本选择 / 编辑手势不接管
  if (target.closest('input, textarea, select, [contenteditable]')) return null
  const out: Candidate[] = []
  for (let el: Element | null = target; el; el = el.parentElement) {
    const cs = getComputedStyle(el)
    if (cs.touchAction === 'none') return null
    const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + EDGE_EPS
    const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + EDGE_EPS
    if (!x && !y) continue
    out.push({
      el: el as HTMLElement,
      x,
      y,
      layer: layerFor(el as HTMLElement),
      blockX: /(contain|none)/.test(cs.overscrollBehaviorX),
      blockY: /(contain|none)/.test(cs.overscrollBehaviorY),
    })
  }
  const doc = document.scrollingElement as HTMLElement | null
  if (doc && !out.some((c) => c.el === doc)) {
    const cs = getComputedStyle(doc)
    // 文档滚动被显式锁住（弹层锁背景 overflow:hidden）或本身不可滚 → 不参与：
    // 后者也避免固定定位整页（如 RunPage）在 band 期间被改包含块
    const scrollable =
      !/(hidden|clip)/.test(cs.overflowY) && doc.scrollHeight > doc.clientHeight + EDGE_EPS
    if (scrollable) {
      out.push({
        el: doc,
        x: false,
        y: true,
        layer: layerFor(doc),
        blockX: /(contain|none)/.test(cs.overscrollBehaviorX),
        blockY: /(contain|none)/.test(cs.overscrollBehaviorY),
      })
    }
  }
  return out
}

/** 该轴的滚动链：遇到 overscroll-behavior: contain/none 截断（与原生链式语义一致） */
function chainFor(a: Axis): Candidate[] {
  const out: Candidate[] = []
  for (const c of candidates) {
    out.push(c)
    if (a === 'y' ? c.blockY : c.blockX) break
  }
  return out
}

/* ---------- 层读写 ---------- */
function writeLayer(b: Band, signed: number): void {
  b.layer.style.transform =
    b.axis === 'y' ? `translate3d(0, ${signed}px, 0)` : `translate3d(${signed}px, 0, 0)`
}

function clearLayer(el: HTMLElement): void {
  el.style.transform = ''
  el.style.willChange = ''
}

/* ---------- 回弹弹簧 ---------- */
function stopSpring(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  if (springLayer) {
    clearLayer(springLayer)
    springLayer = null
  }
}

function startSpring(b: Band, pos: number, v: number): void {
  const layer = b.layer
  springLayer = layer
  let x = b.dir * pos
  let vv = v
  let last = performance.now()
  const step = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.032)
    last = now
    vv += (-SPRING.stiffness * x - SPRING.damping * vv) * dt
    x += vv * dt
    if (!layer.isConnected || (Math.abs(x) < SETTLE_PX && Math.abs(vv) < SETTLE_V)) {
      clearLayer(layer)
      springLayer = null
      raf = 0
      return
    }
    writeLayer(b, x)
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}

/* ---------- 速度采样 ---------- */
function trimSamples(): void {
  const cut = performance.now() - VELOCITY_WINDOW_MS
  while (samples.length > 2 && samples[0]!.t < cut) samples.shift()
}

/** 松手初速（显示空间、有符号，px/s）：指速 × f'(over) */
function releaseVelocity(b: Band): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]!
  let first = samples[0]!
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!
    if (last.t - s.t <= VELOCITY_WINDOW_MS) first = s
    else break
  }
  const dt = (last.t - first.t) / 1000
  if (dt <= 0) return 0
  return b.dir * slope(b.over) * ((last.over - first.over) / dt)
}

/* ---------- 幽灵点击吞咽（照抄 useDragDock：抓过后短暂窗口内的 click 吞掉） ---------- */
function swallowNextClick(): void {
  const swallow = (ev: Event): void => {
    ev.preventDefault()
    ev.stopPropagation()
  }
  document.addEventListener('click', swallow, { capture: true, once: true })
  window.setTimeout(
    () => document.removeEventListener('click', swallow, { capture: true }),
    CLICK_SWALLOW_MS,
  )
}

/* ---------- 手势 ---------- */
function releaseBand(): void {
  const b = band
  band = null
  if (!b) return
  if (b.peak >= CLICK_SWALLOW_PX) swallowNextClick()
  const pos = offset(b.over)
  const v = releaseVelocity(b)
  if (reducedMotion() || (pos < SETTLE_PX && Math.abs(v) < SETTLE_V)) {
    clearLayer(b.layer)
    return
  }
  startSpring(b, pos, v)
}

function cancelGesture(): void {
  tracking = false
  if (band) releaseBand()
  samples = []
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function onTouchStart(e: TouchEvent): void {
  stopSpring() // 打断上一轮回弹（残留只有几 px，直接归零）
  tracking = false
  axis = null
  band = null
  samples = []
  if (e.touches.length !== 1) return
  if (reducedMotion()) return
  const found = collectCandidates(e.target)
  if (!found || !found.length) return
  candidates = found
  const t = e.touches[0]!
  startX = lastX = t.clientX
  startY = lastY = t.clientY
  tracking = true
}

function onTouchMove(e: TouchEvent): void {
  if (!tracking) return
  if (e.touches.length !== 1) {
    cancelGesture() // 多指（捏合 / 误触）：中止本手势
    return
  }
  if (e.defaultPrevented) {
    cancelGesture() // 别人（弹层拖拽 / 地图 / 芯片）已经接管
    return
  }
  const t = e.touches[0]!

  if (!axis) {
    const totalX = t.clientX - startX
    const totalY = t.clientY - startY
    if (Math.abs(totalX) < AXIS_LOCK_PX && Math.abs(totalY) < AXIS_LOCK_PX) return
    axis = Math.abs(totalX) > Math.abs(totalY) ? 'x' : 'y'
    // 锁轴那一刻不更新 last：把此前全部行程一次性计入，不丢位移
  }

  const d = axis === 'y' ? t.clientY - lastY : t.clientX - lastX
  lastX = t.clientX
  lastY = t.clientY
  if (d === 0) return

  if (band) {
    const b = band
    b.over = Math.max(0, b.over + b.dir * d)
    // band 期间的位移一律由 band 吃掉（含反向拖回、over 归零的那一下）：
    // 不拦的话浏览器会把这同一段位移再当成滚动，展开动画与原生滚动叠加
    if (e.cancelable) e.preventDefault()
    if (b.over > 0) {
      b.peak = Math.max(b.peak, b.over)
      samples.push({ t: performance.now(), over: b.over })
      trimSamples()
      writeLayer(b, b.dir * offset(b.over))
    } else {
      // 反向拖回边界：清层，后续位移交还原生（f'(0)=1，交接无速度突变）
      clearLayer(b.layer)
      band = null
      samples = []
    }
    return
  }

  const chain = chainFor(axis)
  // 链上还有容器能吃掉这个方向 → 交给原生（含链式滚动），什么都不做
  for (const c of chain) if (canConsume(c, axis, d)) return
  // 否则取「已到边且有层」的最深容器开始 band
  for (const c of chain) {
    if (!c.layer || !(axis === 'y' ? c.y : c.x) || !atEdge(c, axis, d)) continue
    band = {
      layer: c.layer,
      axis,
      edge: d > 0 ? 'start' : 'end',
      dir: d > 0 ? 1 : -1,
      over: Math.abs(d),
      peak: Math.abs(d),
    }
    c.layer.style.willChange = 'transform'
    samples = [{ t: performance.now(), over: band.over }]
    writeLayer(band, band.dir * offset(band.over))
    if (e.cancelable) e.preventDefault()
    return
  }
}

function onTouchEnd(e: TouchEvent): void {
  if (!tracking) return
  if (e.touches.length > 0) return // 还有手指没抬：等全部抬起
  tracking = false
  if (band) releaseBand()
  samples = []
}

/** 启动（main.ts 调用一次；只挂一份 window 监听） */
export function initRubberScroll(): void {
  if (started) return
  started = true
  window.addEventListener('touchstart', onTouchStart, { passive: true })
  window.addEventListener('touchmove', onTouchMove, { passive: false })
  window.addEventListener('touchend', onTouchEnd)
  window.addEventListener('touchcancel', onTouchEnd)
}
