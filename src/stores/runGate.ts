/**
 * 跑步采集闸门（K/L 口径）的纯逻辑实现 —— 与 Kotlin `RunAutoPause.kt::RunCore` /
 * Rust `modules/tracking/model.rs::spec` 逐字同值。
 *
 * 为什么单独一个模块：它是**纯逻辑**（无 Vue / 无 pinia / 无 window / 无 localStorage），
 * 所以 `node scripts/run-vectors.mjs` 能直接把冻结向量表 V1..V21 打在这份代码上跑，
 * 让「三镜像同表同值」在 TS 侧也有一条可执行的证据。stores/run.ts 的 web 采集路径
 * （桌面 / 浏览器 / 原生降级后）就是它的唯一消费者。
 *
 * 两条通道（冻结规格 §2）：
 *  · 稳通道 = `distM`（唯一权威）：精度门 30m → 单跳门 max(40,8·dt) → 4 点方向防抖 →
 *    1s 聚合窗 + 0.5 m/s 地板；空窗三分支；自动暂停 enter/exit。入账/持久化/成绩单/
 *    轨迹比对/自动暂停都吃它。
 *  · 快通道 = `dispM`（显示专用，**不做任何判定**）：= max(distM + pendingD,
 *    haversine(段锚点, 当前点))，单调不减、恒 ≤ 1Hz 采样折线长度。只喂 hero 距离数字。
 *
 * 常量表见下方 §K/L；名字与取值同时是 Kotlin/Rust/TS 三处的唯一数值表。
 */

/* ===== K/L 唯一数值表（与 RunAutoPause.kt L33-80 逐字同值；改这里必须同步改那边） ===== */

/** 精度门：所有 fix 共用，>30m 丢弃、不参与任何判定/落盘 */
export const ACC_GATE_M = 30.0
/** 被接受 fix 的最大间隔 */
export const DT_ACCEPT_SEC = 10.0
/** 单跳上限 max(40, 8×dt) */
export const DMAX_MIN_M = 40.0
export const DMAX_DT_FACTOR = 8.0
/** 距上一个 fix >5s：本次判定跳过（暂停中保持暂停、未暂停不进入） */
export const STALE_SKIP_SEC = 5.0
/** >10s 空窗走三分支 */
export const GAP_MIN_SEC = 10.0
/** 空窗 slow/fast 分界 1.6667 m/s（=300 s/km，与 autoPauseOn 无关） */
export const GAP_SLOW_MPS = 1.6667
/** 空窗 drop 判定的自适应上限 vMax = clamp(max(6.0, 1.5×vPrev60), 6.0, 10.0) */
export const VMAX_FLOOR_MPS = 6.0
export const VMAX_CEIL_MPS = 10.0
export const VMAX_FACTOR = 1.5
export const VMAX_BACK_SEC = 60.0
/** 常规路径 1s 窗口的距离地板（只滤距离，不滤时间） */
export const DIST_FLOOR_MPS = 0.5
/** 瞬时配速（L5）：W10 可用 且 入账距离 ≥2m 且 弦速 ≥0.8333 m/s */
export const PACE_MIN_MPS = 0.8333
export const PACE_MIN_DIST_M = 2.0
export const PACE_STALE_SEC = 15.0
/** 进入判定（W10） */
export const ENTER_WINDOW_SEC = 10.0
export const ENTER_HOLD_SEC = 8.0
export const ENTER_MIN_FIXES = 3
export const ENTER_MIN_SPAN_SEC = 6.0
export const ENTER_STREAK = 3
/** 退出判定（Wrec：自锚点起、独立窗口、不含暂停前的点） */
export const EXIT_WINDOW_SEC = 6.0
export const EXIT_MIN_FIXES = 2
export const EXIT_MIN_SPAN_SEC = 3.0
export const EXIT_HOLD_SEC = 5.0
export const EXIT_STREAK = 2
export const EXIT_ANCHOR_M = 10.0
export const EXIT_CREDIT_MAX_M = 60.0
/** 4 点方向防抖：最近 4 个被接受 fix 连成 3 段，各段航向转角之和 > 90° 即判为异常抖动 */
export const JITTER_WINDOW = 4
export const JITTER_MAX_TURN_DEG = 90.0

/** 呈现层：hero 显示非零门（米）与「<100m 显整数米」的分界 */
export const DISP_MIN_M = 1.0
export const HERO_METER_MAX_M = 100.0

/** 与前端 `utils/geo.ts` 同式（R=6371000） */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6_371_000.0
  const rad = Math.PI / 180.0
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2.0 * r * Math.asin(Math.sqrt(a))
}

export interface Fix {
  /** 墙钟 epoch ms */
  t: number
  lat: number
  lon: number
  /** 水平精度（米） */
  acc: number
}

export type GapKind = 'slow' | 'fast' | 'drop'

/** 一次 fix 的完整结论（字段名与 Kotlin `RunCore.Outcome` 一一对应） */
export interface Outcome {
  /** 精度门未过：不判定、不落盘 */
  dropped: boolean
  /** 单跳 d>dMax 丢弃（jumpCount++） */
  jumped: boolean
  /** 被接受 fix：落点 + 写轨迹 + 计距离时长 */
  accepted: boolean
  /** 该点 brk=true（空窗后 / 自动暂停恢复后的第一个点） */
  brk: boolean
  gap: GapKind | null
  /** 本段空窗墙钟（进对应 gap 桶） */
  gapBucketMs: number
  /** fast 空窗补记的距离 */
  gapCreditM: number
  autoPaused: boolean
  entered: boolean
  exited: boolean
  /** 退出一次性补距（clamp 到 0..60） */
  exitCreditM: number
  /** 退出时结账的自动暂停墙钟 */
  autoPauseSettleMs: number
  /** 瞬时配速（口径见 L5） */
  paceSecPerKm: number | null
  /** 累计量（含本次） */
  distM: number
  elapsedMs: number
  /** 本次入账量 */
  distDeltaM: number
  elapsedDeltaMs: number
  /** 本次 fix 与上一个通过精度门 fix 的直线距离 */
  stepM: number
  /** 空窗均速 */
  gapSpeedMps: number
  /** 判定取证：W10/Wrec 弦速 */
  chordMps: number
  inStreak: number
  outStreak: number
  step2Mps: number
  anchorM: number
  /** 4 点方向防抖：本次窗口三段累计转角（度）与是否触发校正 */
  jitterTurnDeg: number
  jitterCorrected: boolean
  /** 快通道累计值（显示专用，搬运副本；权威读数是 RunGate.dispM） */
  dispM: number
}

interface GuardPoint {
  t: number
  lat: number
  lon: number
}

interface GuardStep {
  m: number
  dtSec: number
  atMs: number
}

interface WinFix {
  t: number
  /** 与上一个通过精度门 fix 的直线距离（Wrec 弦速用） */
  d: number
  /** 本次入账距离（W10 弦速用） */
  credit: number
  /** 是否被接受 fix（自动暂停期的点不进 W10） */
  accepted: boolean
}

interface Judge {
  t: number
  ok: boolean
}

interface Recent {
  t: number
  credit: number
}

function dMax(dtSec: number): number {
  return Math.max(DMAX_MIN_M, DMAX_DT_FACTOR * dtSec)
}

/** 连续满足的判定数（从队尾往回数） */
function streak(q: Judge[]): number {
  let n = 0
  for (let i = q.length - 1; i >= 0; i--) {
    if (q[i]!.ok) n++
    else break
  }
  return n
}

function emptyOutcome(distM: number, elapsedMs: number, pace: number | null, autoPaused: boolean, dispM: number): Outcome {
  return {
    dropped: false,
    jumped: false,
    accepted: false,
    brk: false,
    gap: null,
    gapBucketMs: 0,
    gapCreditM: 0,
    autoPaused,
    entered: false,
    exited: false,
    exitCreditM: 0,
    autoPauseSettleMs: 0,
    paceSecPerKm: pace,
    distM,
    elapsedMs,
    distDeltaM: 0,
    elapsedDeltaMs: 0,
    stepM: 0,
    gapSpeedMps: 0,
    chordMps: 0,
    inStreak: 0,
    outStreak: 0,
    step2Mps: 0,
    anchorM: 0,
    jitterTurnDeg: 0,
    jitterCorrected: false,
    dispM,
  }
}

/**
 * 采集核心：K/L 口径的唯一实现（Kotlin 是运行时真源，本文件是 TS 镜像）。
 * 顺序即契约顺序：精度门 → 手动暂停 → 自动暂停 → 空窗三分支 → 常规路径。
 */
export class RunGate {
  private enterSecPerKm: number
  private exitSecPerKm: number
  private enabled: boolean

  /* 累计量（真源） */
  elapsedMs: number
  distM: number
  autoPaused: boolean
  paceSecPerKm: number | null

  /* 快通道（显示专用；不是真源，不参与任何判定） */
  dispM: number

  /* 计数器（四类桶逐段互斥） */
  autoPauseCount = 0
  autoPauseMs = 0
  gapMs = 0
  gapSlowCount = 0
  gapFastCount = 0
  gapDropCount = 0
  gapSlowMs = 0
  gapFastMs = 0
  gapDropMs = 0
  jumpCount = 0
  jitterCorrections = 0

  /* 内部状态 */
  private lastAcc: Fix | null = null
  private win: WinFix[] = []
  private judgeIn: Judge[] = []
  private judgeOut: Judge[] = []
  private steps: number[] = []
  private anchor: Fix | null = null
  private recent: Recent[] = []
  private pendingD = 0
  private pendingT0: number | null = null
  private lastMoveMs = 0
  private pendingBrk = false
  private manualPaused = false

  /* 4 点方向防抖 */
  private guard: GuardPoint[] = []
  private validTail: GuardPoint | null = null

  /* 快通道段锚点：段内第一个 accepted fix / brk（空窗、自动暂停恢复）/ 手动暂停后落座 */
  private segAnchor: { lat: number; lon: number } | null = null

  /** baseline 用于恢复续跑：累计量初值 = 已恢复的值（dispM 同 clamp） */
  constructor(enterSecPerKm: number, exitSecPerKm: number, baselineElapsedMs = 0, baselineDistM = 0) {
    this.enterSecPerKm = enterSecPerKm
    this.exitSecPerKm = exitSecPerKm
    this.enabled = enterSecPerKm > 0
    this.elapsedMs = Math.max(0, baselineElapsedMs)
    this.distM = Math.max(0, baselineDistM)
    this.autoPaused = false
    this.paceSecPerKm = null
    this.dispM = Math.max(0, baselineDistM)
  }

  /** 阈值变更（UI 改自动暂停配速）：只影响后续判定，不改已累计量 */
  setThresholds(enterSecPerKm: number, exitSecPerKm: number): void {
    this.enterSecPerKm = enterSecPerKm
    this.exitSecPerKm = exitSecPerKm
    this.enabled = enterSecPerKm > 0
  }

  isEnabled(): boolean {
    return this.enabled
  }

  isManualPaused(): boolean {
    return this.manualPaused
  }

  private vEnter(): number {
    return 1000.0 / Math.max(1, this.enterSecPerKm)
  }

  private vExit(): number {
    return 1000.0 / Math.max(1, this.exitSecPerKm)
  }

  /** 最近两次单步速度的较小值（全无取 0） */
  private step2(): number {
    if (this.steps.length === 0) return 0
    let m = Number.POSITIVE_INFINITY
    for (const s of this.steps) m = Math.min(m, s)
    return m
  }

  /** 窗口内三段航向的累计转角（度）：各段转角归一化到 (-180,180] 后求和；零位移段不计航向 */
  private guardTurnDeg(): number {
    let total = 0
    let prev: number | null = null
    for (let i = 0; i + 1 < this.guard.length; i++) {
      const a = this.guard[i]!
      const b = this.guard[i + 1]!
      const north = b.lat - a.lat
      const east = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
      if (north === 0 && east === 0) continue
      const brg = (Math.atan2(east, north) * 180) / Math.PI // 0=正北，顺时针为正
      if (prev != null) {
        let diff = brg - prev
        while (diff > 180) diff -= 360
        while (diff < -180) diff += 360
        total += Math.abs(diff)
      }
      prev = brg
    }
    return total
  }

  /** 把一个点确认为有效点：返回「上一个有效点 → 它」的步长与真实间隔 */
  private commitValid(p: GuardPoint): GuardStep {
    const prev = this.validTail
    this.validTail = p
    if (!prev) return { m: 0, dtSec: 0, atMs: p.t }
    return {
      m: haversineM(prev.lat, prev.lon, p.lat, p.lon),
      dtSec: Math.max(0, (p.t - prev.t) / 1000),
      atMs: p.t,
    }
  }

  /** 4 点方向防抖（与 Kotlin RunCore.guardStep 逐行同口径）；dt_sec=0 = 还在攒窗口 */
  private guardStep(f: Fix, out: Outcome): GuardStep {
    this.guard.push({ t: f.t, lat: f.lat, lon: f.lon })
    while (this.guard.length > JITTER_WINDOW) this.guard.shift()
    if (this.guard.length < JITTER_WINDOW) return { m: 0, dtSec: 0, atMs: f.t }
    const turn = this.guardTurnDeg()
    out.jitterTurnDeg = turn
    if (turn > JITTER_MAX_TURN_DEG) {
      const a = this.guard[0]!
      const b = this.guard[1]!
      const c = this.guard[2]!
      const last = this.guard[3]!
      const mean: GuardPoint = {
        t: last.t,
        lat: (a.lat + b.lat + c.lat) / 3,
        lon: (a.lon + b.lon + c.lon) / 3,
      }
      this.guard = [mean, last]
      this.jitterCorrections++
      out.jitterCorrected = true
      return this.commitValid(mean)
    }
    return this.commitValid(this.guard.shift()!)
  }

  /** 复位防抖窗口；seed 非空时以它为新的有效起点（暂停/空窗后接管位移基准） */
  private resetGuard(seed: Fix | null): void {
    this.guard = []
    this.validTail = seed ? { t: seed.t, lat: seed.lat, lon: seed.lon } : null
  }

  /**
   * 复位采集窗口但**保留累计量**（distM/elapsedMs/计数/快通道 dispM 不动）：
   * 用于「停采集后再开」（开始/继续）——距离与时长不因换源或恢复而倒退。
   */
  resetWindows(): void {
    this.lastAcc = null
    this.pendingD = 0
    this.pendingT0 = null
    this.pendingBrk = false
    this.win = []
    this.judgeIn = []
    this.judgeOut = []
    this.steps = []
    this.recent = []
    this.guard = []
    this.validTail = null
    this.segAnchor = null
  }

  /**
   * 降级播种：原生正处于自动暂停时，web 闸门接着从当前坐标起算退出窗口
   * （等价于 Kotlin `enter()` 的前半：锚点就位 + 防抖窗口重攒 + 链清零）。
   */
  seedAutoPause(lat: number, lon: number, t: number): void {
    const f: Fix = { t, lat, lon, acc: 0 }
    this.autoPaused = true
    this.anchor = f
    this.pendingD = 0
    this.pendingT0 = null
    this.resetGuard(f)
    this.judgeIn = []
    this.judgeOut = []
  }

  /** 防抖步长并进「最近两次单步速度」；攒窗口期（dt=0）不产生速度 */
  private applyGuardStep(gs: GuardStep, out: Outcome): void {
    if (gs.dtSec <= 0) return
    this.steps.push(gs.m / gs.dtSec)
    while (this.steps.length > 2) this.steps.shift()
    out.step2Mps = this.step2()
  }

  private trimWindows(now: number): void {
    while (this.win.length > 0 && (now - this.win[0]!.t) / 1000 > ENTER_WINDOW_SEC) this.win.shift()
    while (this.judgeIn.length > 0 && (now - this.judgeIn[0]!.t) / 1000 > ENTER_HOLD_SEC)
      this.judgeIn.shift()
    while (this.judgeOut.length > 0 && (now - this.judgeOut[0]!.t) / 1000 > EXIT_HOLD_SEC)
      this.judgeOut.shift()
  }

  private pushRecent(t: number, credit: number): void {
    this.recent.push({ t, credit })
    while (this.recent.length > 0 && (t - this.recent[0]!.t) / 1000 > VMAX_BACK_SEC)
      this.recent.shift()
  }

  /** 空窗前 60s 内被接受 fix 的平均速度（无数据则 0）——vMax 自适应的输入 */
  private vPrev60(beforeT: number): number {
    const lo = beforeT - VMAX_BACK_SEC * 1000
    const it = this.recent.filter((r) => r.t >= lo)
    if (it.length < 2) return 0
    const span = (it[it.length - 1]!.t - it[0]!.t) / 1000
    if (span <= 0) return 0
    let sum = 0
    for (const r of it) sum += r.credit
    return sum / span
  }

  /** W10 切片：墙钟最近 10s 内、被接受的 fix */
  private w10(now: number): WinFix[] {
    const lo = now - ENTER_WINDOW_SEC * 1000
    return this.win.filter((w) => w.accepted && w.t >= lo)
  }

  /** 快通道：段锚点落座 + dispM = max(dispM, net, steady)（两项皆为下界） */
  private bumpDisp(f: Fix, brk: boolean): void {
    if (this.segAnchor === null || brk) this.segAnchor = { lat: f.lat, lon: f.lon }
    const a = this.segAnchor
    const net = haversineM(a.lat, a.lon, f.lat, f.lon)
    const steady = this.distM + this.pendingD
    const v = Math.max(net, steady)
    if (v > this.dispM) this.dispM = v
  }

  /** 一次 fix 的完整处理 */
  onFix(f: Fix): Outcome {
    const out = emptyOutcome(this.distM, this.elapsedMs, this.paceSecPerKm, this.autoPaused, this.dispM)
    // 精度门（NaN 也落这里）
    if (!(f.acc <= ACC_GATE_M)) {
      out.dropped = true
      return out
    }
    const prev = this.lastAcc
    const dtSec = prev ? (f.t - prev.t) / 1000 : 0
    const d = prev ? haversineM(prev.lat, prev.lon, f.lat, f.lon) : 0
    out.stepM = d
    const stale = prev !== null && dtSec > STALE_SKIP_SEC
    out.step2Mps = this.step2()
    // L5：距上一个被接受 fix >15s，瞬时配速失效
    if (this.lastMoveMs > 0 && f.t - this.lastMoveMs > PACE_STALE_SEC * 1000) {
      this.paceSecPerKm = null
    }

    // 手动暂停：全部判定跳过（链/锚点已由 setManualPaused 清），只让窗口自然滑动
    if (this.manualPaused) {
      this.win.push({ t: f.t, d, credit: 0, accepted: false })
      this.trimWindows(f.t)
      this.lastAcc = f
      out.paceSecPerKm = this.paceSecPerKm
      return out
    }

    // 自动暂停中：不是被接受 fix（不落点/不写文件/不进 W10），通过精度门者进 Wrec
    if (this.autoPaused) {
      const gs = this.guardStep(f, out)
      this.applyGuardStep(gs, out)
      this.win.push({ t: f.t, d, credit: gs.m, accepted: false })
      this.trimWindows(f.t)
      if (!stale && this.enabled) this.evalExit(f, out)
      this.lastAcc = f
      out.autoPaused = this.autoPaused
      out.distM = this.distM
      out.elapsedMs = this.elapsedMs
      out.paceSecPerKm = this.paceSecPerKm
      return out
    }

    // >10s 空窗：不走 L1，走三分支（d=两端直线距离、gapSpeed=d/dt）
    if (prev !== null && dtSec > GAP_MIN_SEC) {
      this.handleGap(f, prev, dtSec, d, out)
      return out
    }

    // 单跳 d>dMax：丢弃该 fix（参考点不跟进）
    if (prev !== null && d > dMax(dtSec)) {
      this.jumpCount++
      out.jumped = true
      return out
    }

    // —— 常规路径：被接受 fix（距离/配速/判定都只吃 4 点防抖后的步长）——
    const gs = this.guardStep(f, out)
    this.applyGuardStep(gs, out)
    if (prev !== null) {
      const dtMs = Math.round(dtSec * 1000)
      this.elapsedMs += dtMs
      out.elapsedDeltaMs = dtMs
      // L4：攒满 1s 提交一次；窗口均速 ≥0.5 m/s 才入账距离（地板只滤距离）
      if (gs.dtSec > 0) {
        let t0 = this.pendingT0
        if (t0 === null) {
          t0 = gs.atMs - Math.round(gs.dtSec * 1000)
          this.pendingT0 = t0
        }
        this.pendingD += gs.m
        const winSec = (gs.atMs - t0) / 1000
        if (winSec >= 1.0) {
          if (this.pendingD / winSec >= DIST_FLOOR_MPS) {
            out.distDeltaM = this.pendingD
            this.distM += this.pendingD
            this.lastMoveMs = gs.atMs
          }
          this.pendingD = 0
          this.pendingT0 = null
        }
      }
    }
    out.accepted = true
    out.brk = this.pendingBrk
    this.pendingBrk = false
    // 快通道插入点 A：pendingD 已更新完、win.push 之前
    this.bumpDisp(f, out.brk)
    this.win.push({ t: f.t, d, credit: out.distDeltaM, accepted: true })
    this.pushRecent(f.t, out.distDeltaM)
    this.trimWindows(f.t)

    // L5 + 进入判定共用同一个 W10 弦速
    if (!stale) {
      const w = this.w10(f.t)
      if (w.length >= ENTER_MIN_FIXES) {
        const span = (w[w.length - 1]!.t - w[0]!.t) / 1000
        if (span >= ENTER_MIN_SPAN_SEC) {
          let sum = 0
          for (const x of w) sum += x.credit
          const chord = sum / span
          out.chordMps = chord
          if (sum >= PACE_MIN_DIST_M && chord >= PACE_MIN_MPS) {
            const inst = 1000.0 / chord
            this.paceSecPerKm =
              this.paceSecPerKm == null ? inst : this.paceSecPerKm * 0.7 + inst * 0.3
          }
          if (this.enabled) this.judgeIn.push({ t: f.t, ok: chord < this.vEnter() })
        }
      }
    }
    out.inStreak = streak(this.judgeIn)
    if (this.enabled && !stale && streak(this.judgeIn) >= ENTER_STREAK) {
      this.enter(f, out)
    }
    this.lastAcc = f
    out.autoPaused = this.autoPaused
    out.distM = this.distM
    out.elapsedMs = this.elapsedMs
    out.paceSecPerKm = this.paceSecPerKm
    out.dispM = this.dispM
    return out
  }

  private handleGap(f: Fix, p: Fix, dtSec: number, d: number, out: Outcome): void {
    const gapMs = f.t - p.t
    const gapSpeed = dtSec > 0 ? d / dtSec : 0
    const vmax = Math.min(Math.max(VMAX_FACTOR * this.vPrev60(p.t), VMAX_FLOOR_MPS), VMAX_CEIL_MPS)
    const kind: GapKind = gapSpeed < GAP_SLOW_MPS ? 'slow' : gapSpeed <= vmax ? 'fast' : 'drop'
    this.gapMs += gapMs
    if (kind === 'slow') {
      this.gapSlowCount++
      this.gapSlowMs += gapMs
    } else if (kind === 'fast') {
      const credit = Math.min(d, dMax(dtSec))
      this.gapFastCount++
      this.gapFastMs += gapMs
      this.distM += credit
      this.elapsedMs += gapMs
      this.lastMoveMs = f.t
      out.distDeltaM = credit
      out.elapsedDeltaMs = gapMs
      out.gapCreditM = credit
    } else {
      this.gapDropCount++
      this.gapDropMs += gapMs
    }
    out.gap = kind
    out.gapBucketMs = gapMs
    out.gapSpeedMps = gapSpeed
    out.accepted = true
    out.brk = true
    this.pendingD = 0
    this.pendingT0 = null
    this.pendingBrk = false
    this.resetGuard(f) // 空窗是新一段的起点：防抖窗口从它重新攒
    // 快通道插入点 B：pendingD 清零之后、win.push 之前
    this.bumpDisp(f, out.brk)
    this.win.push({ t: f.t, d, credit: out.distDeltaM, accepted: true })
    this.pushRecent(f.t, out.distDeltaM)
    this.trimWindows(f.t)
    this.lastAcc = f
    out.autoPaused = this.autoPaused
    out.distM = this.distM
    out.elapsedMs = this.elapsedMs
    out.paceSecPerKm = this.paceSecPerKm
    out.dispM = this.dispM
  }

  private enter(f: Fix, out: Outcome): void {
    this.autoPaused = true
    this.autoPauseCount++
    this.anchor = f
    this.pendingD = 0
    this.pendingT0 = null
    // 暂停点即新的有效起点：退出判定的位移从它起算（防抖窗口也在这里重攒）
    // 快通道的段锚点**不复位**（B3）：进入后无 accepted fix，跨段由恢复点的 brk 覆盖
    this.resetGuard(f)
    this.judgeIn = []
    this.judgeOut = []
    out.entered = true
  }

  private evalExit(f: Fix, out: Outcome): void {
    const anchor = this.anchor
    if (!anchor) return
    const lo = f.t - EXIT_WINDOW_SEC * 1000
    const w = this.win.filter((x) => x.t >= anchor.t && x.t >= lo)
    const anchorM = haversineM(anchor.lat, anchor.lon, f.lat, f.lon)
    out.anchorM = anchorM
    if (w.length >= EXIT_MIN_FIXES) {
      const span = (w[w.length - 1]!.t - w[0]!.t) / 1000
      if (span >= EXIT_MIN_SPAN_SEC) {
        let sum = 0
        for (const x of w) sum += x.credit
        const chord = sum / span
        out.chordMps = chord
        this.judgeOut.push({ t: f.t, ok: chord >= this.vExit() })
      }
    }
    out.outStreak = streak(this.judgeOut)
    const cond1 = streak(this.judgeOut) >= EXIT_STREAK
    const cond2 = this.steps.length >= 2 && this.steps.every((s) => s >= this.vExit())
    const cond3 = anchorM >= EXIT_ANCHOR_M
    if (cond1 && cond2 && cond3) {
      const credit = Math.min(Math.max(anchorM, 0), EXIT_CREDIT_MAX_M)
      this.distM += credit
      const settle = Math.max(0, f.t - anchor.t)
      this.autoPauseMs += settle
      out.exitCreditM = credit
      out.autoPauseSettleMs = settle
      out.distDeltaM = credit
      this.autoPaused = false
      this.anchor = null
      this.pendingBrk = true // 恢复后的第一个点 brk=true
      this.judgeIn = []
      this.judgeOut = []
      out.exited = true
    }
    out.autoPaused = this.autoPaused
  }

  /** 结账当前自动暂停段（退出之外的路径：手动暂停 / 结束 / 服务停）：返回结账墙钟 */
  settleAutoPause(nowMs: number): number {
    if (!this.autoPaused) return 0
    const ms = this.anchor ? Math.max(0, nowMs - this.anchor.t) : 0
    this.autoPauseMs += ms
    this.autoPaused = false
    this.anchor = null
    this.judgeIn = []
    this.judgeOut = []
    this.pendingD = 0
    this.pendingT0 = null
    this.resetGuard(null)
    this.segAnchor = null
    return ms
  }

  /** 手动相位：暂停 = 判定全跳过 + 链清零 + 锚点清空 + autoPaused 置 false；继续 = 判定器复位 */
  setManualPaused(paused: boolean): void {
    this.manualPaused = paused
    if (paused) {
      this.autoPaused = false
      this.anchor = null
      this.segAnchor = null
    }
    this.judgeIn = []
    this.judgeOut = []
    this.steps = []
    this.pendingD = 0
    this.pendingT0 = null
    this.resetGuard(null)
  }

  /** live 快照用的计数：gapCount = slow+fast+drop */
  gapCount(): number {
    return this.gapSlowCount + this.gapFastCount + this.gapDropCount
  }
}

/* ===== 向量表生成器（node runner 与 cargo/Kotlin selfTest 同表） ===== */

export interface VectorResult {
  name: string
  ok: boolean
  detail: string
}

/** 真机量级的 epoch ms */
export const START_T = 1_760_000_000_000
export const LAT0 = 31.2301
export const LON0 = 121.4702

/** 站立抖动（≤1m，相邻位移 0.6~0.8m） */
export const JITTER: number[] = [0.0, 0.8, 0.1, 0.9, 0.2, 0.8, 0.0, 0.7]
/** 站立游走 ±3m（相邻位移 ≤1.3m） */
export const WANDER: number[] = [
  0.0, 0.9, 1.8, 2.7, 1.9, 1.0, 0.2, -0.7, -1.6, -2.5, -3.0, -2.1, -1.2, -0.3, 0.6, 1.5, 2.4, 3.0,
  2.2, 1.3, 0.4, -0.5, -1.4, -2.3, -1.4, -0.5, 0.4, 1.3,
]

const R_EARTH = 6_371_000.0
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/** ENU 米 → lat/lon（与 _core.mjs / 仓库同式） */
export function enuToLatLon(east: number, north: number): [number, number] {
  const lat = LAT0 + (north / R_EARTH) * R2D
  const lon = LON0 + (east / (R_EARTH * Math.cos(lat * D2R))) * R2D
  return [lat, lon]
}

/** 沿经线位移：haversine 沿经线恰为 R×Δφ，用它生成的点距离可控 */
export function moveLat(lat: number, northM: number): number {
  return lat + (northM / R_EARTH) * R2D
}

/** mulberry32（与冻结取证脚本逐位一致） */
export function mulberry32(a: number): () => number {
  let s = a | 0
  return function () {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 标准正态（Box–Muller，逐位复刻冻结脚本） */
export function gauss(rnd: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rnd()
  while (v === 0) v = rnd()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** 匀速直线：fix i 在 startLat 往北 i×speed×dt 米处；返回 (fixes, 末尾继续沿该方向的下一纬度) */
export function runFixes(
  t0: number,
  dtMs: number,
  n: number,
  speedMps: number,
  startLat: number,
  acc = 5.0,
): { fixes: Fix[]; endLat: number } {
  const stepM = speedMps * (dtMs / 1000)
  const out: Fix[] = []
  for (let i = 0; i < n; i++) {
    out.push({ t: t0 + i * dtMs, lat: moveLat(startLat, stepM * i), lon: LON0, acc })
  }
  return { fixes: out, endLat: moveLat(startLat, stepM * n) }
}

/** 站立：按固定偏移表在中心附近游走 */
export function standFixes(
  t0: number,
  dtMs: number,
  n: number,
  offsets: number[],
  centerLat: number,
  acc = 5.0,
): Fix[] {
  const out: Fix[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      t: t0 + i * dtMs,
      lat: moveLat(centerLat, offsets[i % offsets.length]!),
      lon: LON0,
      acc,
    })
  }
  return out
}

/** ENU 米坐标序列 → Fix[]（1Hz 合成几何） */
export function fixesFromEnu(t0: number, dtMs: number, pts: [number, number][], acc = 5.0): Fix[] {
  return pts.map((p, i) => {
    const [lat, lon] = enuToLatLon(p[0], p[1])
    return { t: t0 + i * dtMs, lat, lon, acc }
  })
}

/** 折线长度（1Hz 采样折线 = 任何只看位置的方法的下界） */
export function polylineLen(pts: [number, number][]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = enuToLatLon(pts[i - 1]![0], pts[i - 1]![1])
    const [c, d] = enuToLatLon(pts[i]![0], pts[i]![1])
    s += haversineM(a, b, c, d)
  }
  return s
}

/* ---- 五拓扑几何（按弧长 s=3*i 米取值；1Hz，N=101 = 0..100s） ---- */
const V_TOPO = 3.0
const N_TOPO = 101

/** 幅度 A 米的三角波折返 */
export function genTurnback(A: number): [number, number][] {
  const pts: [number, number][] = []
  const legT = A / V_TOPO
  for (let i = 0; i < N_TOPO; i++) {
    const cyc = i / legT
    const k = Math.floor(cyc)
    const f = cyc - k
    pts.push([0, k % 2 === 0 ? A * f : A * (1 - f)])
  }
  return pts
}

/** 半径 r 米的圆周 */
export function genCircle(r: number): [number, number][] {
  const w = V_TOPO / r
  const pts: [number, number][] = []
  for (let i = 0; i < N_TOPO; i++) {
    const th = w * i
    pts.push([r * Math.sin(th), r * (1 - Math.cos(th))])
  }
  return pts
}

/** 400m 标准场：直道 84.39m + 半径 36.5m 的两个半圆 */
export function genTrack(): [number, number][] {
  const L = 84.39
  const Rr = 36.5
  const lap = 2 * L + 2 * Math.PI * Rr
  const pts: [number, number][] = []
  for (let i = 0; i < N_TOPO; i++) {
    const s = (V_TOPO * i) % lap
    let e: number
    let n: number
    if (s < L) {
      e = 0
      n = s
    } else if (s < L + Math.PI * Rr) {
      const a = (s - L) / Rr
      e = Rr * (1 - Math.cos(a))
      n = L + Rr * Math.sin(a)
    } else if (s < 2 * L + Math.PI * Rr) {
      const dd = s - (L + Math.PI * Rr)
      e = 2 * Rr
      n = L - dd
    } else {
      const a = (s - (2 * L + Math.PI * Rr)) / Rr
      e = 2 * Rr * Math.cos(a)
      n = -Rr * Math.sin(a)
    }
    pts.push([e, n])
  }
  return pts
}

export function genStraight(): [number, number][] {
  const p: [number, number][] = []
  for (let i = 0; i < N_TOPO; i++) p.push([0, V_TOPO * i])
  return p
}

/** 随机自由跑：每步航向随机游走 σ 度 */
export function genRandom(seed: number, sigmaDegPerSec: number): [number, number][] {
  const rnd = mulberry32(seed)
  let hd = 0
  let e = 0
  let n = 0
  const pts: [number, number][] = [[0, 0]]
  for (let i = 1; i < N_TOPO; i++) {
    hd += (rnd() - 0.5) * 2 * sigmaDegPerSec
    e += V_TOPO * Math.sin(hd * D2R)
    n += V_TOPO * Math.cos(hd * D2R)
    pts.push([e, n])
  }
  return pts
}

/* ---- 公共前缀 / 工具 ---- */

/** V1/V2 的公共前缀：跑 3 m/s 20s → 回到起点附近静止抖动 25s */
function stopPrefix(): { core: RunGate; stopT: number; lastLat: number } {
  const core = new RunGate(600, 540)
  const { fixes } = runFixes(START_T, 1000, 20, 3.0, LAT0)
  const lastLat = fixes[fixes.length - 1]!.lat
  for (const f of fixes) core.onFix(f)
  const stopT = START_T + 20_000
  for (const f of standFixes(stopT, 1000, 25, JITTER, lastLat)) core.onFix(f)
  return { core, stopT, lastLat }
}

function vr(name: string, ok: boolean, detail: string): VectorResult {
  return { name, ok, detail }
}

/* ===== V1..V8（与 cargo `apvector` / Kotlin selfTest 同表） ===== */

/** V1 跑 3 m/s 20s → 静止（抖动 ≤1m）→ 8~12s 进入 */
export function v1(): VectorResult {
  const core = new RunGate(600, 540)
  const { fixes } = runFixes(START_T, 1000, 20, 3.0, LAT0)
  const lastLat = fixes[fixes.length - 1]!.lat
  for (const f of fixes) core.onFix(f)
  const stopT = START_T + 20_000
  let enterAt: number | null = null
  for (const f of standFixes(stopT, 1000, 25, JITTER, lastLat)) {
    if (core.onFix(f).entered) enterAt = f.t
  }
  const delay = enterAt === null ? null : enterAt - stopT
  const ok = delay !== null && delay >= 8_000 && delay <= 12_000
  return vr('V1 停跑 3m/s→静止 8~12s 进入', ok, `enterDelay=${delay}ms autoPaused=${core.autoPaused}`)
}

/** V2 接 V1 走 2 m/s → 位移 ≥10m 且在 11s 内退出 */
export function v2(): VectorResult {
  const { core, lastLat } = stopPrefix()
  const entered = core.autoPaused
  const walkStartT = START_T + 20_000 + 25_000
  const moveT0 = walkStartT - 1000
  const { fixes: walk } = runFixes(walkStartT, 1000, 12, 2.0, moveLat(lastLat, 2.0))
  let exitAt: number | null = null
  let credit = 0
  for (const f of walk) {
    const o = core.onFix(f)
    if (o.exited) {
      exitAt = f.t
      credit = o.exitCreditM
    }
  }
  const delay = exitAt === null ? null : exitAt - moveT0
  const ok = entered && delay !== null && delay <= 11_000 && credit >= 10 && credit <= 60
  return vr(
    'V2 2m/s 走动 位移≥10m 且 ≤11s 退出',
    ok,
    `entered=${entered} exitDelay=${delay}ms exitCredit=${credit.toFixed(1)}m`,
  )
}

/** V3 运行中 6s 无 fix → 不进不出 */
export function v3(): VectorResult {
  const core = new RunGate(600, 540)
  const { fixes: a, endLat: afterA } = runFixes(START_T, 1000, 10, 3.0, LAT0)
  let entered = false
  let exited = false
  for (const f of a) {
    const o = core.onFix(f)
    entered = entered || o.entered
    exited = exited || o.exited
  }
  const tGap = START_T + 10_000 + 6_000
  const gapLat = moveLat(afterA, 15.0)
  {
    const o = core.onFix({ t: tGap, lat: gapLat, lon: LON0, acc: 5.0 })
    entered = entered || o.entered
    exited = exited || o.exited
  }
  for (const f of runFixes(tGap + 1000, 1000, 20, 3.0, gapLat).fixes) {
    const o = core.onFix(f)
    entered = entered || o.entered
    exited = exited || o.exited
  }
  return vr('V3 运行中 6s 无 fix → 不进不出', !entered && !exited, `entered=${entered} exited=${exited}`)
}

/** V4 手动暂停 30s → 不进 */
export function v4(): VectorResult {
  const core = new RunGate(600, 540)
  const { fixes: run, endLat: after } = runFixes(START_T, 1000, 20, 3.0, LAT0)
  for (const f of run) core.onFix(f)
  core.setManualPaused(true)
  let entered = false
  for (const f of standFixes(START_T + 20_000, 1000, 30, JITTER, moveLat(after, -3.0))) {
    entered = entered || core.onFix(f).entered
  }
  return vr(
    'V4 手动暂停 30s → 不进',
    !entered && !core.autoPaused,
    `entered=${entered} autoPaused=${core.autoPaused}`,
  )
}

/** V5 站立 ±3m 游走 120s → 0 次退出且至少进入 1 次 */
export function v5(): VectorResult {
  const core = new RunGate(600, 540)
  let enters = 0
  let exits = 0
  for (const f of standFixes(START_T, 1000, 120, WANDER, LAT0)) {
    const o = core.onFix(f)
    if (o.entered) enters++
    if (o.exited) exits++
  }
  return vr('V5 站立 ±3m 游走 120s → 0 次退出', exits === 0 && enters > 0, `enters=${enters} exits=${exits}`)
}

/** V6 起步即停（收点稀疏 3s）→ 约 12s 进入 */
export function v6(): VectorResult {
  const core = new RunGate(600, 540)
  let enterAt: number | null = null
  for (const f of standFixes(START_T, 3000, 20, JITTER, LAT0)) {
    if (core.onFix(f).entered) enterAt = f.t
  }
  const delay = enterAt === null ? null : enterAt - START_T
  const ok = delay !== null && delay >= 11_000 && delay <= 13_000
  return vr('V6 起步即停（3s 收点）约 12s 进入', ok, `enterDelay=${delay}ms`)
}

/** V7 站立 ±3m 游走 120s → 距离被 4 点方向防抖抹平 */
export function v7(): VectorResult {
  const core = new RunGate(600, 540)
  for (const f of standFixes(START_T, 1000, 120, WANDER, LAT0)) core.onFix(f)
  const ok = core.distM <= 6.0 && core.jitterCorrections > 0
  return vr(
    'V7 站立 ±3m 游走 120s → 距离≤6m（防抖抹平之字形）',
    ok,
    `dist=${core.distM.toFixed(1)} jc=${core.jitterCorrections}`,
  )
}

/** V8 直线 3m/s 30 点 → 距离≈78m 且 0 次校正 */
export function v8(): VectorResult {
  const core = new RunGate(600, 540)
  for (const f of runFixes(START_T, 1000, 30, 3.0, LAT0).fixes) core.onFix(f)
  const expect = 3.0 * (30.0 - 4.0)
  const ok =
    core.distM >= expect * 0.9 && core.distM <= expect * 1.05 && core.jitterCorrections === 0
  return vr('V8 直线 3m/s 30 点 → 距离≈78m 且 0 次校正', ok, `dist=${core.distM.toFixed(1)} jc=${core.jitterCorrections}`)
}

/* ===== V9..V21（快通道 / 五拓扑 / 静止族 / 暂停复位 / 不回归） ===== */

interface GateRun {
  gate: RunGate
  firstDisp: number | null
  firstSteady: number | null
  distinct: number
  enters: number
  exits: number
}

/** 跑一串 fix，收集快通道与稳通道的诊断量 */
function drive(fixes: Fix[], enter = 600, exit = 540): GateRun {
  const gate = new RunGate(enter, exit)
  const t0 = fixes.length > 0 ? fixes[0]!.t : 0
  let firstDisp: number | null = null
  let firstSteady: number | null = null
  let distinct = 0
  let last = -1
  let enters = 0
  let exits = 0
  for (const f of fixes) {
    const o = gate.onFix(f)
    if (firstDisp === null && gate.dispM > 0) firstDisp = f.t - t0
    if (firstSteady === null && gate.distM > 0) firstSteady = f.t - t0
    if (gate.dispM !== last) {
      distinct++
      last = gate.dispM
    }
    if (o.entered) enters++
    if (o.exited) exits++
  }
  return { gate, firstDisp, firstSteady, distinct, enters, exits }
}

/** V9 快通道起步时效（直线 3m/s,1Hz,acc5）→ 1000ms 首个非零；t=1/2/3s dispM=3/6/9 */
export function v9(): VectorResult {
  const fixes = fixesFromEnu(START_T, 1000, genStraight())
  const gate = new RunGate(600, 540)
  const dispAt: number[] = []
  let firstDisplay: number | null = null
  for (let i = 0; i < fixes.length; i++) {
    gate.onFix(fixes[i]!)
    if (firstDisplay === null && gate.dispM >= DISP_MIN_M) firstDisplay = fixes[i]!.t - START_T
    if (i >= 1 && i <= 3) dispAt.push(gate.dispM)
  }
  const ok =
    firstDisplay !== null &&
    firstDisplay <= 2000 &&
    Math.abs(dispAt[0]! - 3.0) <= 0.5 &&
    Math.abs(dispAt[1]! - 6.0) <= 0.5 &&
    Math.abs(dispAt[2]! - 9.0) <= 0.5
  return vr(
    'V9 快通道起步时效：dispM≥1m @1000ms（t=1/2/3s=3/6/9）',
    ok,
    `firstDisplay=${firstDisplay}ms t1/2/3=${dispAt.map((x) => x.toFixed(2)).join('/')}`,
  )
}

/** V10 快通道五拓扑 100s 末值（acc5, clean） */
export function v10(): VectorResult {
  const tb = drive(fixesFromEnu(START_T, 1000, genTurnback(5))).gate.dispM
  const ci = drive(fixesFromEnu(START_T, 1000, genCircle(5))).gate.dispM
  const tr = drive(fixesFromEnu(START_T, 1000, genTrack())).gate.dispM
  const st = drive(fixesFromEnu(START_T, 1000, genStraight())).gate.dispM
  const rd = drive(fixesFromEnu(START_T, 1000, genRandom(1, 15))).gate.dispM
  const inBand = (x: number): boolean => x >= 285 && x <= 315
  const ok =
    tb < 30 &&
    inBand(ci) &&
    inBand(tr) &&
    Math.abs(st - 300.0) <= 0.5 &&
    inBand(rd)
  return vr(
    'V10 快通道五拓扑 100s 末值：折返<30/绕圈/跑道/直线300/随便跑∈[285,315]',
    ok,
    `折返${tb.toFixed(1)} 绕圈${ci.toFixed(1)} 跑道${tr.toFixed(1)} 直线${st.toFixed(1)} 随便跑${rd.toFixed(1)}`,
  )
}

/** V11 稳通道四拓扑 ≤5%（acc5, clean, 100s） */
export function v11(): VectorResult {
  const ci = drive(fixesFromEnu(START_T, 1000, genCircle(5))).gate.distM
  const tr = drive(fixesFromEnu(START_T, 1000, genTrack())).gate.distM
  const st = drive(fixesFromEnu(START_T, 1000, genStraight())).gate.distM
  const rd = drive(fixesFromEnu(START_T, 1000, genRandom(1, 15))).gate.distM
  const inBand = (x: number): boolean => x >= 285 && x <= 315
  const ok = inBand(ci) && inBand(tr) && inBand(st) && inBand(rd)
  return vr(
    'V11 稳通道四拓扑 ≤5%（100s, acc5, clean）',
    ok,
    `绕圈${ci.toFixed(1)} 跑道${tr.toFixed(1)} 直线${st.toFixed(1)} 随便跑${rd.toFixed(1)}`,
  )
}

/** V12 折返 5m@3m/s 100s：1Hz 折线信息上限 −26.7%（documented-fail 证据） */
export function v12(): VectorResult {
  const pts = genTurnback(5)
  const pl = polylineLen(pts)
  const r = drive(fixesFromEnu(START_T, 1000, pts))
  const ok = r.gate.distM < 30 && r.gate.dispM < 30
  return vr(
    'V12 折返 5m@3m/s：1Hz 折线=220.0m(−26.7%)，稳/快通道均 <30m（documented-fail 证据）',
    ok,
    `折线=${pl.toFixed(1)}m 稳distM=${r.gate.distM.toFixed(1)} 快dispM=${r.gate.dispM.toFixed(1)} 稳首个入账=${r.firstSteady}ms`,
  )
}

/** V13 静止 1D WANDER ±3m 120s：稳/快 ≤6m 且 enters≥1 */
export function v13(): VectorResult {
  const r = drive(standFixes(START_T, 1000, 120, WANDER, LAT0))
  const ok = r.gate.distM <= 6 && r.gate.dispM <= 6 && r.enters >= 1
  return vr(
    'V13 静止 1D WANDER ±3m 120s：稳≤6 / 快≤6 / enters≥1',
    ok,
    `distM=${r.gate.distM.toFixed(1)} dispM=${r.gate.dispM.toFixed(1)} enters=${r.enters}`,
  )
}

/** 2D 圆盘静止：每步随机点 */
function diskSeeds(
  rr: number,
  seedBase: number,
  n: number,
  steps: number,
): { over6disp: number; over6steady: number; maxDisp: number; maxSteady: number } {
  let over6disp = 0
  let over6steady = 0
  let maxDisp = 0
  let maxSteady = 0
  for (let s = 0; s < n; s++) {
    const rnd = mulberry32(seedBase + s * 7 + 1)
    const g = new RunGate(600, 540)
    for (let i = 0; i < steps; i++) {
      const ang = rnd() * 2 * Math.PI
      const rad = rr * Math.sqrt(rnd())
      const [la, lo] = enuToLatLon(rad * Math.cos(ang), rad * Math.sin(ang))
      g.onFix({ t: START_T + i * 1000, lat: la, lon: lo, acc: 5 })
    }
    if (g.dispM > 6) over6disp++
    if (g.distM > 6) over6steady++
    maxDisp = Math.max(maxDisp, g.dispM)
    maxSteady = Math.max(maxSteady, g.distM)
  }
  return { over6disp, over6steady, maxDisp, maxSteady }
}

/** V14 静止 2D 圆盘 r=3m 100s×100seed（acc5）：两通道超 6m 的 seed 数=0 */
export function v14(): VectorResult {
  const d = diskSeeds(3, 100000, 100, 100)
  const ok = d.over6steady === 0 && d.over6disp === 0
  return vr(
    'V14 静止 2D 圆盘 r=3m 100s×100seed：稳>6=0/100，快>6=0/100',
    ok,
    `稳>6=${d.over6steady}/100 (max ${d.maxSteady.toFixed(1)})  快>6=${d.over6disp}/100 (max ${d.maxDisp.toFixed(1)})`,
  )
}

/** V15 静止 2D 圆盘 r=8m 100s×100seed：>6m 成立 → documented-fail */
export function v15(): VectorResult {
  const d = diskSeeds(8, 200000, 100, 100)
  const ok = d.over6steady > 0 && d.over6disp > 0
  return vr(
    'V15 静止 2D 圆盘 r=8m 100s×100seed：>6m 成立（documented-fail）',
    ok,
    `稳>6=${d.over6steady}/100 (max ${d.maxSteady.toFixed(1)})  快>6=${d.over6disp}/100 (max ${d.maxDisp.toFixed(1)})`,
  )
}

/** V16 静止 2D r=8m + 偶发跳变(+25m acc25/+22m acc28，每20s) 100s×50seed：>6m 成立 → documented-fail */
export function v16(): VectorResult {
  let over6disp = 0
  let over6steady = 0
  let maxDisp = 0
  let maxSteady = 0
  let jumpTotal = 0
  for (let s = 0; s < 50; s++) {
    const rnd = mulberry32(300000 + s * 13 + 1)
    const g = new RunGate(600, 540)
    for (let i = 0; i < 100; i++) {
      const ang = rnd() * 2 * Math.PI
      const rad = 8 * Math.sqrt(rnd())
      let e = rad * Math.cos(ang)
      let nn = rad * Math.sin(ang)
      let acc = 5
      if (i > 0 && i % 20 === 0) {
        e += 25
        acc = 25
      } else if (i > 0 && i % 20 === 10) {
        nn += 22
        acc = 28
      }
      const [la, lo] = enuToLatLon(e, nn)
      g.onFix({ t: START_T + i * 1000, lat: la, lon: lo, acc })
    }
    if (g.dispM > 6) over6disp++
    if (g.distM > 6) over6steady++
    maxDisp = Math.max(maxDisp, g.dispM)
    maxSteady = Math.max(maxSteady, g.distM)
    jumpTotal += g.jumpCount
  }
  const ok = over6steady > 0 && over6disp > 0 && jumpTotal === 0
  return vr(
    'V16 静止 2D r=8m + 跳变 100s×50seed：>6m 成立且 jumpCount=0（documented-fail）',
    ok,
    `稳>6=${over6steady}/50 (max ${maxSteady.toFixed(1)})  快>6=${over6disp}/50 (max ${maxDisp.toFixed(1)})`,
  )
}

/** V17 刷新节奏（限四拓扑）：100s 内 dispM 变化次数 ≥90 */
export function v17(): VectorResult {
  const ci = drive(fixesFromEnu(START_T, 1000, genCircle(5))).distinct
  const tr = drive(fixesFromEnu(START_T, 1000, genTrack())).distinct
  const st = drive(fixesFromEnu(START_T, 1000, genStraight())).distinct
  const rd = drive(fixesFromEnu(START_T, 1000, genRandom(1, 15))).distinct
  const tb = drive(fixesFromEnu(START_T, 1000, genTurnback(5))).distinct
  const ok = ci >= 90 && tr >= 90 && st >= 90 && rd >= 90
  return vr(
    'V17 显示刷新节奏（四拓扑）：100s 内 dispM 变化次数 ≥90',
    ok,
    `绕圈${ci}/100 跑道${tr}/100 直线${st}/100 随便跑${rd}/100 折返${tb}/100(不列入)`,
  )
}

/** 随机走位搜索反例：dispM / 稳通道 是否可能超过 1Hz 折线长度 */
function boundSearch(): { worstDisp: number; worstSteady: number } {
  const gen = (seed: number, sd: number, turnProb: number): [number, number][] => {
    const rnd = mulberry32(seed)
    let hd = 0
    let e = 0
    let n = 0
    const pts: [number, number][] = [[0, 0]]
    for (let i = 1; i < N_TOPO; i++) {
      hd += (rnd() - 0.5) * 2 * sd
      if (rnd() < turnProb) hd += 180 * (rnd() < 0.5 ? -1 : 1)
      const step = V_TOPO * (0.5 + rnd())
      e += step * Math.sin(hd * D2R)
      n += step * Math.cos(hd * D2R)
      pts.push([e, n])
    }
    return pts
  }
  let worstDisp = Number.NEGATIVE_INFINITY
  let worstSteady = Number.NEGATIVE_INFINITY
  for (const sd of [10, 30, 60, 90, 140]) {
    for (const tp of [0, 0.1, 0.25, 0.5, 0.75]) {
      for (let seed = 1; seed <= 200; seed++) {
        const pts = gen(seed, sd, tp)
        const pl = polylineLen(pts)
        const g = new RunGate(600, 540)
        for (const fx of fixesFromEnu(START_T, 1000, pts)) g.onFix(fx)
        worstDisp = Math.max(worstDisp, g.dispM - pl)
        worstSteady = Math.max(worstSteady, g.distM - pl)
      }
    }
  }
  return { worstDisp, worstSteady }
}

/** V18 快通道下界性：dispM ≤ 1Hz 折线长度（附 5000 组搜索 0 反例） */
export function v18(): VectorResult {
  const stPts = genStraight()
  const ciPts = genCircle(5)
  const trPts = genTrack()
  const st = drive(fixesFromEnu(START_T, 1000, stPts)).gate
  const ci = drive(fixesFromEnu(START_T, 1000, ciPts)).gate
  const tr = drive(fixesFromEnu(START_T, 1000, trPts)).gate
  const plS = polylineLen(stPts)
  const plC = polylineLen(ciPts)
  const plT = polylineLen(trPts)
  const b = boundSearch()
  const ok =
    st.dispM <= plS + 1e-6 &&
    ci.dispM <= plC + 1e-6 &&
    tr.dispM <= plT + 1e-6 &&
    b.worstDisp <= 1e-6 &&
    b.worstSteady <= 1e-6
  return vr(
    'V18 快通道下界性：dispM ≤ 1Hz 折线长度（5000 组搜索 0 反例）',
    ok,
    `直线 ${st.dispM.toFixed(1)}≤${plS.toFixed(1)} 绕圈 ${ci.dispM.toFixed(1)}≤${plC.toFixed(1)} 跑道 ${tr.dispM.toFixed(1)}≤${plT.toFixed(1)} 搜索最大超量=${b.worstDisp.toFixed(3)}`,
  )
}

/** V19 acc 值无关/精度门：直线 acc≤30 → 291.0；acc31 → 0 */
export function v19(): VectorResult {
  const runAt = (acc: number): number =>
    drive(runFixes(START_T, 1000, 101, 3.0, LAT0, acc).fixes).gate.distM
  const a5 = runAt(5)
  const a15 = runAt(15)
  const a299 = runAt(29.9)
  const a31 = runAt(31)
  const ok =
    Math.abs(a5 - 291.0) <= 0.5 &&
    Math.abs(a15 - 291.0) <= 0.5 &&
    Math.abs(a299 - 291.0) <= 0.5 &&
    a31 === 0
  return vr(
    'V19 acc 值无关/精度门：acc5=15=29.9→291.0；acc31→0',
    ok,
    `acc5=${a5.toFixed(3)} acc15=${a15.toFixed(3)} acc29.9=${a299.toFixed(3)} acc31=${a31.toFixed(3)}`,
  )
}

/** V20 回归锁：精度门 / 单跳 / 空窗三分支 / 手动暂停 */
export function v20(): VectorResult {
  const notes: string[] = []
  let ok = true
  // 精度门：>30m 的 fix 丢弃，连参考点都不更新
  {
    const g = new RunGate(600, 540)
    const o1 = g.onFix({ t: START_T, lat: LAT0, lon: LON0, acc: 35 })
    const o2 = g.onFix({ t: START_T, lat: LAT0, lon: LON0, acc: 8 })
    ok = ok && o1.dropped && !o1.accepted && o2.accepted
    notes.push(`acc35→dropped=${o1.dropped}`)
  }
  // 单跳：100m@1s > dMax(40) → jumped
  {
    const g = new RunGate(600, 540)
    g.onFix({ t: START_T, lat: LAT0, lon: LON0, acc: 8 })
    const o = g.onFix({ t: START_T + 1000, lat: moveLat(LAT0, 100), lon: LON0, acc: 8 })
    ok = ok && o.jumped && !o.accepted && g.jumpCount === 1 && g.distM === 0
    notes.push(`jump100m→jumped=${o.jumped}`)
  }
  // 空窗三分支（slow/fast/drop）
  {
    const mk = (): { g: RunGate; last: Fix } => {
      const g = new RunGate(0, 0)
      const { fixes } = runFixes(START_T, 1000, 6, 3.0, LAT0)
      const last = fixes[fixes.length - 1]!
      for (const f of fixes) g.onFix(f)
      return { g, last }
    }
    const s = mk()
    const beforeS = { d: s.g.distM, e: s.g.elapsedMs }
    const os = s.g.onFix({ t: s.last.t + 20_000, lat: moveLat(s.last.lat, 3.0), lon: LON0, acc: 5 })
    ok = ok && os.gap === 'slow' && s.g.distM === beforeS.d && s.g.elapsedMs === beforeS.e && os.brk
    const f = mk()
    const beforeF = f.g.elapsedMs
    const of = f.g.onFix({ t: f.last.t + 20_000, lat: moveLat(f.last.lat, 40.0), lon: LON0, acc: 5 })
    ok = ok && of.gap === 'fast' && Math.abs(of.gapCreditM - 40.0) < 1.0 && f.g.elapsedMs - beforeF === 20_000
    const d = mk()
    const beforeD = d.g.distM
    const od = d.g.onFix({ t: d.last.t + 20_000, lat: moveLat(d.last.lat, 300.0), lon: LON0, acc: 5 })
    ok = ok && od.gap === 'drop' && d.g.distM === beforeD && d.g.jumpCount === 0
    notes.push(`gap slow/fast/drop=${os.gap}/${of.gap}/${od.gap}`)
  }
  // 手动暂停：不进自动暂停
  {
    const g = new RunGate(600, 540)
    const { fixes: run, endLat: after } = runFixes(START_T, 1000, 20, 3.0, LAT0)
    for (const f of run) g.onFix(f)
    g.setManualPaused(true)
    let entered = false
    for (const f of standFixes(START_T + 20_000, 1000, 30, JITTER, moveLat(after, -3.0)))
      entered = entered || g.onFix(f).entered
    ok = ok && !entered && !g.autoPaused
    notes.push(`manual→entered=${entered}`)
  }
  return vr('V20 回归锁：精度门/单跳/空窗三分支/手动暂停', ok, notes.join(' '))
}

/** V21 快通道段首复位（补 brk 的内核）：自动暂停进入/退出、空窗 fast、手动暂停 */
export function v21(): VectorResult {
  const log: string[] = []
  let ok = true
  // A) 跑 3m/s 20s → 静止跳动 25s → 走 2m/s 15s
  {
    type Ev = { t: number; dispM: number; comm: number; ev: string }
    const events: Ev[] = []
    const g = new RunGate(600, 540)
    const logFix = (t: number, ev: string): void => {
      events.push({ t, dispM: g.dispM, comm: g.distM, ev })
    }
    for (let i = 0; i < 20; i++) g.onFix({ t: START_T + i * 1000, lat: moveLat(LAT0, 3 * i), lon: LON0, acc: 5 })
    const stopLat = moveLat(LAT0, 3 * 19)
    for (let i = 0; i < 25; i++) {
      const o = g.onFix({ t: START_T + (20 + i) * 1000, lat: moveLat(stopLat, JITTER[i % 8]!), lon: LON0, acc: 5 })
      if (o.entered) logFix(START_T + (20 + i) * 1000, 'ENTER')
    }
    const walkT = START_T + 45_000
    const walkStart = moveLat(stopLat, 2.0)
    for (let i = 0; i < 15; i++) {
      const o = g.onFix({ t: walkT + i * 1000, lat: moveLat(walkStart, 2 * i), lon: LON0, acc: 5 })
      if (o.exited) logFix(walkT + i * 1000, 'EXIT')
      if (o.brk) logFix(walkT + i * 1000, 'brk')
    }
    const enter = events.find((e) => e.ev === 'ENTER')
    const exit = events.find((e) => e.ev === 'EXIT')
    const brk = events.find((e) => e.ev === 'brk')
    const okA =
      enter != null &&
      Math.abs(enter.dispM - 57.9) <= 0.6 &&
      Math.abs(enter.comm - 57.3) <= 0.6 &&
      exit != null &&
      Math.abs(exit.dispM - 57.9) <= 0.6 &&
      brk != null &&
      Math.abs(brk.dispM - brk.comm) <= 0.6 &&
      Math.abs(g.dispM - g.distM) <= 0.6
    ok = ok && okA
    log.push(
      `A ENTER dispM=${enter ? enter.dispM.toFixed(1) : 'n/a'}/comm=${enter ? enter.comm.toFixed(1) : 'n/a'} EXIT dispM=${exit ? exit.dispM.toFixed(1) : 'n/a'} brk dispM=${brk ? brk.dispM.toFixed(1) : 'n/a'} 末 ${g.dispM.toFixed(1)}/${g.distM.toFixed(1)}`,
    )
  }
  // B) >10s 空窗（fast 分支：20s 空窗内位移 40m）
  {
    const g = new RunGate(600, 540)
    const pre: number[] = []
    for (let i = 0; i < 6; i++) {
      g.onFix({ t: START_T + i * 1000, lat: moveLat(LAT0, 3 * i), lon: LON0, acc: 5 })
      if (i === 5) pre.push(g.dispM, g.distM)
    }
    const last = moveLat(LAT0, 3 * 5)
    const og = g.onFix({ t: START_T + 5_000 + 20_000, lat: moveLat(last, 40), lon: LON0, acc: 5 })
    const afterGap = { dispM: g.dispM, comm: g.distM }
    for (let i = 1; i <= 5; i++)
      g.onFix({ t: START_T + 25_000 + i * 1000, lat: moveLat(last, 40 + 3 * i), lon: LON0, acc: 5 })
    const okB = og.gap === 'fast' && Math.abs(afterGap.dispM - afterGap.comm) <= 0.6 && Math.abs(afterGap.dispM - 46.0) <= 0.6
    ok = ok && okB
    log.push(`B 空窗 fast pre ${pre[0]!.toFixed(1)}/${pre[1]!.toFixed(1)} 后 dispM=${afterGap.dispM.toFixed(1)}=comm${afterGap.comm.toFixed(1)}`)
  }
  // C) 手动暂停：跑 3m/s 10s → 暂停（点位跳到 100m 外）10s → 继续 3m/s 5s
  {
    const g = new RunGate(600, 540)
    for (let i = 0; i < 10; i++) g.onFix({ t: START_T + i * 1000, lat: moveLat(LAT0, 3 * i), lon: LON0, acc: 5 })
    g.setManualPaused(true)
    for (let i = 0; i < 10; i++)
      g.onFix({ t: START_T + (10 + i) * 1000, lat: moveLat(LAT0, 100 + i), lon: LON0, acc: 5 })
    g.setManualPaused(false)
    for (let i = 0; i < 6; i++)
      g.onFix({ t: START_T + (20 + i) * 1000, lat: moveLat(LAT0, 110 + 3 * i), lon: LON0, acc: 5 })
    const okC = Math.abs(g.dispM - 27.0) <= 0.6 && Math.abs(g.distM - 24.0) <= 0.6
    ok = ok && okC
    log.push(`C 手动暂停末 dispM=${g.dispM.toFixed(1)}/comm=${g.distM.toFixed(1)}（100m 不计入）`)
  }
  return vr('V21 快通道段首复位（自动暂停/空窗/手动暂停无跨段重复计距）', ok, log.join(' | '))
}

/** 跑整张向量表（Kotlin selfTest / Rust spec::run_vectors 的 TS 镜像） */
export function runVectors(): VectorResult[] {
  return [
    v1(),
    v2(),
    v3(),
    v4(),
    v5(),
    v6(),
    v7(),
    v8(),
    v9(),
    v10(),
    v11(),
    v12(),
    v13(),
    v14(),
    v15(),
    v16(),
    v17(),
    v18(),
    v19(),
    v20(),
    v21(),
  ]
}
