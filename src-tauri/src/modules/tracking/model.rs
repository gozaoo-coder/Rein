//! 跑步采集的两类纯逻辑（可单测、无 Android 依赖）：
//!
//! 1. 命令入参归一化：`sanitize_run_id` / `normalize_auto_pause` / `validate_notify_payload`；
//! 2. K/L 口径的**规格验证器**（`spec`）：把「被接受 fix / 三分支空窗 / 自动暂停状态机」
//!    按契约数值实现一遍，并跑 K 的向量表。
//!
//! 关于 `spec`：运行时真源是 Kotlin `RunAutoPause.kt`（同一个类在真机上实时跑），
//! 这里只是同一张向量表的第二份可执行实现 —— 让「Kotlin 与 Rust 对同一向量是否同结论」
//! 能在 CI 上（`cargo test --lib tracking`）锁住。**它不参与任何运行时路径**；
//! 两份实现同源同数值但互为镜像，漂移风险已知（Kotlin 侧只能靠 selfTest 的真机 logcat 取证）。

use serde_json::Value;

/* ---------- 入参归一化 ---------- */

/// runId → 文件名安全片段：`[A-Za-z0-9._-]` 之外一律换成 `_`。
pub fn sanitize_run_id(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // 全部字符都被换掉时文件名会退化成「.jsonl」这种隐藏文件；截断防超长名字撑爆文件系统。
    // 替换后只剩 ASCII，按字节截断是安全的。
    if out.is_empty() {
        out.push_str("run");
    }
    out.truncate(128);
    out
}

/// 自动暂停阈值归一化：0/负 = 关闭（(0,0)）；否则进入 300..=1200 秒/km、
/// 退出 300..=(进入-30)。缺省 600/540 由前端给定（autoPausePaceSec 600、退出 540），
/// 这里只做区间收口。
pub fn normalize_auto_pause(enter_sec_per_km: i32, exit_sec_per_km: i32) -> (i32, i32) {
    if enter_sec_per_km <= 0 {
        return (0, 0);
    }
    let enter = enter_sec_per_km.clamp(300, 1200);
    // 进入被夹到 300 时上界会低于下界（clamp 会 panic），把上界抬回下限
    let hi = (enter - 30).max(300);
    (enter, exit_sec_per_km.clamp(300, hi))
}

/// 通知载荷校验：必须是 JSON 对象且 ≤8192 字节。不合法返回 None ——
/// 调用方记日志丢弃（原生只渲染、不判断）。
pub fn validate_notify_payload(payload: &str) -> Option<&str> {
    if payload.len() > 8192 {
        return None;
    }
    match serde_json::from_str::<Value>(payload) {
        Ok(Value::Object(_)) => Some(payload),
        _ => None,
    }
}

/* ---------- K/L 口径的规格验证器 ---------- */

/// 规格验证器：只被 `cargo test --lib tracking` 使用，**不参与运行时**（运行时真源是 Kotlin）。
/// 因此这里从常量到 Core 在非测试构建下都是 dead code —— 统一放过，免得真警告被淹掉。
#[allow(dead_code)]
pub mod spec {
    use std::collections::VecDeque;

    /* ===== K/L 唯一数值表（与 RunAutoPause.kt 逐字同值；改这里必须同步改那边） ===== */

    /// 精度门：所有 fix 共用，>30m 丢弃、不参与任何判定/落盘
    pub const ACC_GATE_M: f64 = 30.0;
    /// 被接受 fix 的最大间隔
    pub const DT_ACCEPT_SEC: f64 = 10.0;
    /// 单跳上限 max(40, 8×dt)
    pub const DMAX_MIN_M: f64 = 40.0;
    pub const DMAX_DT_FACTOR: f64 = 8.0;
    /// 距上一个 fix >5s：本次判定跳过（暂停中保持暂停、未暂停不进入）
    pub const STALE_SKIP_SEC: f64 = 5.0;
    /// >10s 空窗走三分支
    pub const GAP_MIN_SEC: f64 = 10.0;
    /// 空窗 slow/fast 分界 1.6667 m/s（=300 s/km，与 autoPauseOn 无关）
    pub const GAP_SLOW_MPS: f64 = 1.6667;
    /// 空窗 drop 判定的自适应上限 vMax = clamp(max(6.0, 1.5×vPrev60), 6.0, 10.0)
    pub const VMAX_FLOOR_MPS: f64 = 6.0;
    pub const VMAX_CEIL_MPS: f64 = 10.0;
    pub const VMAX_FACTOR: f64 = 1.5;
    pub const VMAX_BACK_SEC: f64 = 60.0;
    /// 常规路径 1s 窗口的距离地板（只滤距离，不滤时间）
    pub const DIST_FLOOR_MPS: f64 = 0.5;
    /// 瞬时配速（L5）：W10 可用 且 入账距离 ≥2m 且弦速 ≥0.8333 m/s
    pub const PACE_MIN_MPS: f64 = 0.8333;
    pub const PACE_MIN_DIST_M: f64 = 2.0;
    pub const PACE_STALE_SEC: f64 = 15.0;
    /// 进入判定（W10）
    pub const ENTER_WINDOW_SEC: f64 = 10.0;
    pub const ENTER_HOLD_SEC: f64 = 8.0;
    pub const ENTER_MIN_FIXES: usize = 3;
    pub const ENTER_MIN_SPAN_SEC: f64 = 6.0;
    pub const ENTER_STREAK: usize = 3;
    /// 退出判定（Wrec：自锚点起、独立窗口、不含暂停前的点）
    pub const EXIT_WINDOW_SEC: f64 = 6.0;
    pub const EXIT_MIN_FIXES: usize = 2;
    pub const EXIT_MIN_SPAN_SEC: f64 = 3.0;
    pub const EXIT_HOLD_SEC: f64 = 5.0;
    pub const EXIT_STREAK: usize = 2;
    pub const EXIT_ANCHOR_M: f64 = 10.0;
    pub const EXIT_CREDIT_MAX_M: f64 = 60.0;
    /// 4 点方向防抖（用户口径）：最近 4 个被接受 fix 连成 3 段，各段航向转角之和
    /// > 90° 即判为异常抖动（原地漂移的之字形）→ 最早 3 点取均值压成一个有效点。
    /// 距离、瞬时配速、自动暂停都只吃这条防抖后的流。
    pub const JITTER_WINDOW: usize = 4;
    pub const JITTER_MAX_TURN_DEG: f64 = 90.0;

    /// 与前端 `utils/geo.ts` 同式（R=6371000）
    pub fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        let r = 6_371_000.0f64;
        let rad = std::f64::consts::PI / 180.0;
        let d_lat = (lat2 - lat1) * rad;
        let d_lon = (lon2 - lon1) * rad;
        let a = (d_lat / 2.0).sin().powi(2)
            + (lat1 * rad).cos() * (lat2 * rad).cos() * (d_lon / 2.0).sin().powi(2);
        2.0 * r * a.sqrt().asin()
    }

    #[derive(Clone, Copy, Debug)]
    pub struct Fix {
        pub t: i64,
        pub lat: f64,
        pub lon: f64,
        pub acc: f64,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum GapKind {
        Slow,
        Fast,
        Drop,
    }

    /// 一次 fix 的完整结论。字段名与 Kotlin `RunCore.Outcome` 一一对应：
    /// 服务端据此落盘 / 推 live / 打 logcat。
    #[derive(Clone, Debug, Default)]
    pub struct Outcome {
        /// 精度门未过：不判定、不落盘
        pub dropped: bool,
        /// 单跳 d>dMax 丢弃（jumpCount++）
        pub jumped: bool,
        /// 被接受 fix：落点 + 写轨迹 + 计距离时长
        pub accepted: bool,
        /// 该点 brk=true（空窗后 / 自动暂停恢复后的第一个点）
        pub brk: bool,
        pub gap: Option<GapKind>,
        /// 本段空窗墙钟（进对应 gap 桶）
        pub gap_bucket_ms: i64,
        /// fast 空窗补记的距离
        pub gap_credit_m: f64,
        pub auto_paused: bool,
        pub entered: bool,
        pub exited: bool,
        /// 退出一次性补距（clamp 到 0..60）
        pub exit_credit_m: f64,
        /// 退出时结账的自动暂停墙钟
        pub auto_pause_settle_ms: i64,
        /// 瞬时配速（口径见 L5）
        pub pace_sec_per_km: Option<f64>,
        /// 累计量（含本次）
        pub dist_m: f64,
        pub elapsed_ms: i64,
        /// 快通道（显示专用低滞后距离）：恒 = `RunCore.disp_m` —— 在 on_fix 的每条返回路径上搬运。
        /// 单调不减、跨段不重置；只喂 hero 距离数字，不参与任何判定/结算。
        pub disp_m: f64,
        /// 本次入账量
        pub dist_delta_m: f64,
        pub elapsed_delta_ms: i64,
        /// 本次 fix 与上一个通过精度门 fix 的直线距离（logcat 的 d=）
        pub step_m: f64,
        /// 空窗均速（logcat 的 gapSpeed=）
        pub gap_speed_mps: f64,
        /// 判定取证（apcheck 行用）
        pub chord_mps: f64,
        pub in_streak: usize,
        pub out_streak: usize,
        pub step2_mps: f64,
        pub anchor_m: f64,
        /// 4 点方向防抖：本次窗口三段累计转角（度）与是否触发校正（logcat jt=/jc=）
        pub jitter_turn_deg: f64,
        pub jitter_corrected: bool,
    }

    /// 防抖窗口里的一个待确认点（还不是有效路径的一部分）
    #[derive(Clone, Copy)]
    struct GuardPoint {
        t: i64,
        lat: f64,
        lon: f64,
    }

    /// 一次防抖确认的结果：有效步长、真实间隔、确认点时刻
    #[derive(Clone, Copy)]
    struct GuardStep {
        m: f64,
        dt_sec: f64,
        at_ms: i64,
    }

    #[derive(Clone, Copy)]
    struct WinFix {
        t: i64,
        /// 与上一个通过精度门 fix 的直线距离（Wrec 弦速用）
        d: f64,
        /// 本次入账距离（W10 弦速用）
        credit: f64,
        /// 是否被接受 fix（自动暂停期的点不进 W10）
        accepted: bool,
    }

    #[derive(Clone, Copy)]
    struct Judge {
        t: i64,
        ok: bool,
    }

    #[derive(Clone, Copy)]
    struct Recent {
        t: i64,
        credit: f64,
    }

    fn d_max(dt_sec: f64) -> f64 {
        DMAX_MIN_M.max(DMAX_DT_FACTOR * dt_sec)
    }

    /// 连续满足的判定数（从队尾往回数）——即 apcheck 的 in=/out=
    fn streak(q: &VecDeque<Judge>) -> usize {
        let mut n = 0usize;
        for j in q.iter().rev() {
            if j.ok {
                n += 1;
            } else {
                break;
            }
        }
        n
    }

    /// 采集核心：K/L 口径的唯一实现（Rust 侧为规格验证器，Kotlin 侧为运行时）。
    pub struct Core {
        enter_sec_per_km: i32,
        exit_sec_per_km: i32,
        enabled: bool,
        /* 累计量（真源） */
        pub elapsed_ms: i64,
        pub dist_m: f64,
        /// 快通道（显示专用）：见 `Outcome.disp_m` / `bump_disp`
        pub disp_m: f64,
        pub auto_paused: bool,
        pub pace_sec_per_km: Option<f64>,
        /* 计数器（四类桶逐段互斥，见 H） */
        pub auto_pause_count: u32,
        pub auto_pause_ms: i64,
        pub gap_ms: i64,
        pub gap_slow_count: u32,
        pub gap_fast_count: u32,
        pub gap_drop_count: u32,
        pub gap_slow_ms: i64,
        pub gap_fast_ms: i64,
        pub gap_drop_ms: i64,
        pub jump_count: u32,
        /* 内部状态 */
        last_acc: Option<Fix>,
        win: VecDeque<WinFix>,
        judge_in: VecDeque<Judge>,
        judge_out: VecDeque<Judge>,
        steps: VecDeque<f64>,
        anchor: Option<Fix>,
        recent: VecDeque<Recent>,
        pending_d: f64,
        pending_t0: Option<i64>,
        last_move_ms: i64,
        pending_brk: bool,
        manual_paused: bool,
        /* 4 点方向防抖 */
        guard: VecDeque<GuardPoint>,
        valid_tail: Option<GuardPoint>,
        pub jitter_corrections: u32,
        /* 快通道：当前 running 段的显示锚点；初值 null（首个被接受 fix 自动落座） */
        seg_anchor: Option<(f64, f64)>,
    }

    impl Core {
        /// baseline 用于恢复续跑：累计量初值 = 已恢复的值
        pub fn new(
            enter_sec_per_km: i32,
            exit_sec_per_km: i32,
            baseline_elapsed_ms: i64,
            baseline_dist_m: f64,
        ) -> Self {
            Self {
                enter_sec_per_km,
                exit_sec_per_km,
                enabled: enter_sec_per_km > 0,
                elapsed_ms: baseline_elapsed_ms.max(0),
                dist_m: baseline_dist_m.max(0.0),
                // 与 dist_m 同一 clamp：恢复续跑时 hero 不闪 0
                disp_m: baseline_dist_m.max(0.0),
                auto_paused: false,
                pace_sec_per_km: None,
                auto_pause_count: 0,
                auto_pause_ms: 0,
                gap_ms: 0,
                gap_slow_count: 0,
                gap_fast_count: 0,
                gap_drop_count: 0,
                gap_slow_ms: 0,
                gap_fast_ms: 0,
                gap_drop_ms: 0,
                jump_count: 0,
                last_acc: None,
                win: VecDeque::new(),
                judge_in: VecDeque::new(),
                judge_out: VecDeque::new(),
                steps: VecDeque::new(),
                anchor: None,
                recent: VecDeque::new(),
                pending_d: 0.0,
                pending_t0: None,
                last_move_ms: 0,
                pending_brk: false,
                manual_paused: false,
                guard: VecDeque::new(),
                valid_tail: None,
                jitter_corrections: 0,
                seg_anchor: None,
            }
        }

        pub fn enabled(&self) -> bool {
            self.enabled
        }

        fn v_enter(&self) -> f64 {
            1000.0 / self.enter_sec_per_km.max(1) as f64
        }

        fn v_exit(&self) -> f64 {
            1000.0 / self.exit_sec_per_km.max(1) as f64
        }

        /// 最近两次单步速度的较小值（apcheck 的 step2；全无取 0）
        fn step2(&self) -> f64 {
            if self.steps.is_empty() {
                0.0
            } else {
                self.steps.iter().copied().fold(f64::INFINITY, f64::min)
            }
        }

        /// 窗口内三段航向的累计转角（度）：各段转角归一化到 (-180,180] 后求和。
        /// 零位移段不计航向 —— 两个 fix 重合时航向纯属噪声，算进去会让「站着不动」
        /// 变成随机值而不是「抖动」。
        fn guard_turn_deg(&self) -> f64 {
            let mut total = 0.0;
            let mut prev: Option<f64> = None;
            for i in 0..self.guard.len().saturating_sub(1) {
                let a = self.guard[i];
                let b = self.guard[i + 1];
                let north = b.lat - a.lat;
                let east = (b.lon - a.lon) * ((a.lat + b.lat) / 2.0).to_radians().cos();
                if north == 0.0 && east == 0.0 {
                    continue;
                }
                let brg = east.atan2(north).to_degrees(); // 0=正北，顺时针为正
                if let Some(p) = prev {
                    let mut diff = brg - p;
                    while diff > 180.0 {
                        diff -= 360.0;
                    }
                    while diff < -180.0 {
                        diff += 360.0;
                    }
                    total += diff.abs();
                }
                prev = Some(brg);
            }
            total
        }

        /// 把一个点确认为有效点：返回「上一个有效点 → 它」的步长与真实间隔
        fn commit_valid(&mut self, p: GuardPoint) -> GuardStep {
            match self.valid_tail.replace(p) {
                None => GuardStep { m: 0.0, dt_sec: 0.0, at_ms: p.t },
                Some(q) => GuardStep {
                    m: haversine_m(q.lat, q.lon, p.lat, p.lon),
                    dt_sec: ((p.t - q.t) as f64 / 1000.0).max(0.0),
                    at_ms: p.t,
                },
            }
        }

        /// 4 点方向防抖：喂进一个被接受 fix，返回有效步长（dt_sec=0 = 还在攒窗口）。
        /// 转角 ≤90° 确认窗口最早那点；>90° 把最早 3 点取均值压成一个有效点，只留
        /// 「均值点 + 最后一点」等下一个点 —— 与 Kotlin RunCore.guardStep 逐行同口径。
        fn guard_step(&mut self, f: Fix, out: &mut Outcome) -> GuardStep {
            self.guard.push_back(GuardPoint { t: f.t, lat: f.lat, lon: f.lon });
            while self.guard.len() > JITTER_WINDOW {
                self.guard.pop_front();
            }
            if self.guard.len() < JITTER_WINDOW {
                return GuardStep { m: 0.0, dt_sec: 0.0, at_ms: f.t };
            }
            let turn = self.guard_turn_deg();
            out.jitter_turn_deg = turn;
            if turn > JITTER_MAX_TURN_DEG {
                let a = self.guard[0];
                let b = self.guard[1];
                let c = self.guard[2];
                let last = self.guard[3];
                let mean = GuardPoint {
                    t: last.t,
                    lat: (a.lat + b.lat + c.lat) / 3.0,
                    lon: (a.lon + b.lon + c.lon) / 3.0,
                };
                self.guard.clear();
                self.guard.push_back(mean);
                self.guard.push_back(last);
                self.jitter_corrections += 1;
                out.jitter_corrected = true;
                return self.commit_valid(mean);
            }
            match self.guard.pop_front() {
                Some(confirmed) => self.commit_valid(confirmed),
                None => GuardStep { m: 0.0, dt_sec: 0.0, at_ms: f.t },
            }
        }

        /// 复位防抖窗口；seed 非空时以它为新的有效起点（暂停/空窗后接管位移基准）
        fn reset_guard(&mut self, seed: Option<Fix>) {
            self.guard.clear();
            self.valid_tail = seed.map(|f| GuardPoint { t: f.t, lat: f.lat, lon: f.lon });
        }

        /// 快通道（显示专用低滞后距离）：**仅在被接受的 fix 上调用**。
        ///   steady = 本 fix 处理完后的 `dist_m + pending_d`（已入账 + 已确认未提交段）
        ///   net    = 当前 running 段锚点 → 本 fix 的净位移（起步 ≤1s 就能给出非零）
        ///   disp_m = max(disp_m, net, steady)
        /// 两项都是真路径长度的下界 ⇒ disp_m 恒 ≤ 1Hz 采样折线长度（不会重复计距）；
        /// 单调不减 ⇒ 显示值永不回退。brk（空窗后 / 自动暂停恢复后首个点）与「本段首个
        /// 被接受 fix」都把锚点复位到本 fix；`set_manual_paused` / `settle_auto_pause` 置
        /// `None`（**enter() 不动锚点**：进入后无被接受 fix，退出由 brk 覆盖）。
        fn bump_disp(&mut self, f: Fix, brk: bool) -> f64 {
            if self.seg_anchor.is_none() || brk {
                self.seg_anchor = Some((f.lat, f.lon));
            }
            let (alat, alon) = self.seg_anchor.expect("anchor seated above");
            let net = haversine_m(alat, alon, f.lat, f.lon);
            let steady = self.dist_m + self.pending_d;
            let v = net.max(steady);
            if v > self.disp_m {
                self.disp_m = v;
            }
            self.disp_m
        }

        /// 防抖步长并进「最近两次单步速度」；攒窗口期（dt=0）不产生速度
        fn apply_guard_step(&mut self, gs: GuardStep, out: &mut Outcome) {
            if gs.dt_sec <= 0.0 {
                return;
            }
            self.steps.push_back(gs.m / gs.dt_sec);
            while self.steps.len() > 2 {
                self.steps.pop_front();
            }
            out.step2_mps = self.step2();
        }

        fn trim_windows(&mut self, now: i64) {
            while let Some(w) = self.win.front() {
                if (now - w.t) as f64 / 1000.0 > ENTER_WINDOW_SEC {
                    self.win.pop_front();
                } else {
                    break;
                }
            }
            while let Some(j) = self.judge_in.front() {
                if (now - j.t) as f64 / 1000.0 > ENTER_HOLD_SEC {
                    self.judge_in.pop_front();
                } else {
                    break;
                }
            }
            while let Some(j) = self.judge_out.front() {
                if (now - j.t) as f64 / 1000.0 > EXIT_HOLD_SEC {
                    self.judge_out.pop_front();
                } else {
                    break;
                }
            }
        }

        fn push_recent(&mut self, t: i64, credit: f64) {
            self.recent.push_back(Recent { t, credit });
            while let Some(r) = self.recent.front() {
                if (t - r.t) as f64 / 1000.0 > VMAX_BACK_SEC {
                    self.recent.pop_front();
                } else {
                    break;
                }
            }
        }

        /// 空窗前 60s 内被接受 fix 的平均速度（无数据则 0）——vMax 自适应的输入
        fn v_prev60(&self, before_t: i64) -> f64 {
            let lo = before_t - (VMAX_BACK_SEC * 1000.0) as i64;
            let it: Vec<&Recent> = self.recent.iter().filter(|r| r.t >= lo).collect();
            if it.len() < 2 {
                return 0.0;
            }
            let span = (it[it.len() - 1].t - it[0].t) as f64 / 1000.0;
            if span <= 0.0 {
                return 0.0;
            }
            it.iter().map(|r| r.credit).sum::<f64>() / span
        }

        /// W10 切片：墙钟最近 10s 内、被接受的 fix（含当前）
        fn w10(&self, now: i64) -> Vec<&WinFix> {
            let lo = now - (ENTER_WINDOW_SEC * 1000.0) as i64;
            self.win.iter().filter(|w| w.accepted && w.t >= lo).collect()
        }

        /// 一次 fix 的完整处理。顺序即契约顺序：精度门 → 手动暂停 → 自动暂停 →
        /// 空窗三分支 → 常规路径（L1/L4/L5 + 进入判定）。
        pub fn on_fix(&mut self, f: Fix) -> Outcome {
            let mut out = Outcome {
                auto_paused: self.auto_paused,
                dist_m: self.dist_m,
                elapsed_ms: self.elapsed_ms,
                pace_sec_per_km: self.pace_sec_per_km,
                disp_m: self.disp_m,
                ..Default::default()
            };
            // 精度门（NaN 也落这里）
            if !(f.acc <= ACC_GATE_M) {
                out.dropped = true;
                out.disp_m = self.disp_m;
                return out;
            }
            let prev = self.last_acc;
            let dt_sec = prev.map(|p| (f.t - p.t) as f64 / 1000.0).unwrap_or(0.0);
            let d = prev
                .map(|p| haversine_m(p.lat, p.lon, f.lat, f.lon))
                .unwrap_or(0.0);
            out.step_m = d;
            let stale = prev.is_some() && dt_sec > STALE_SKIP_SEC;
            out.step2_mps = self.step2();
            // L5：距上一个被接受 fix >15s，瞬时配速失效
            if self.last_move_ms > 0 && (f.t - self.last_move_ms) > (PACE_STALE_SEC * 1000.0) as i64
            {
                self.pace_sec_per_km = None;
            }

            // 手动暂停：全部判定跳过（链/锚点已由 set_manual_paused 清），只让窗口自然滑动
            if self.manual_paused {
                self.win.push_back(WinFix { t: f.t, d, credit: 0.0, accepted: false });
                self.trim_windows(f.t);
                self.last_acc = Some(f);
                out.pace_sec_per_km = self.pace_sec_per_km;
                out.disp_m = self.disp_m;
                return out;
            }

            // 自动暂停中：不是被接受 fix（不落点/不写文件/不进 W10），通过精度门者进 Wrec
            if self.auto_paused {
                let gs = self.guard_step(f, &mut out);
                self.apply_guard_step(gs, &mut out);
                // credit 只给退出判定用（防抖后的流）；暂停期入账恒为 0，不进 dist_m
                self.win.push_back(WinFix { t: f.t, d, credit: gs.m, accepted: false });
                self.trim_windows(f.t);
                if !stale && self.enabled {
                    self.eval_exit(f, &mut out);
                }
                self.last_acc = Some(f);
                out.auto_paused = self.auto_paused;
                out.dist_m = self.dist_m;
                out.elapsed_ms = self.elapsed_ms;
                out.pace_sec_per_km = self.pace_sec_per_km;
                out.disp_m = self.disp_m;
                return out;
            }

            // >10s 空窗：不走 L1，走三分支（d=两端直线距离、gapSpeed=d/dt）
            if let Some(p) = prev {
                if dt_sec > GAP_MIN_SEC {
                    self.handle_gap(f, p, dt_sec, d, &mut out);
                    return out;
                }
            }

            // 单跳 d>dMax：丢弃该 fix（契约字面「丢弃」——参考点不跟进；漂移是瞬时的，
            // 下一个真实 fix 若回到附近会照常入账）
            if prev.is_some() && d > d_max(dt_sec) {
                self.jump_count += 1;
                out.jumped = true;
                out.disp_m = self.disp_m;
                return out;
            }

            // —— 常规路径：被接受 fix（距离/配速/判定都只吃 4 点防抖后的步长）——
            let gs = self.guard_step(f, &mut out);
            self.apply_guard_step(gs, &mut out);
            if let Some(_p) = prev {
                let dt_ms = (dt_sec * 1000.0).round() as i64;
                self.elapsed_ms += dt_ms;
                out.elapsed_delta_ms = dt_ms;
                // L4：攒满 1s 提交一次；窗口均速 ≥0.5 m/s 才入账距离（地板只滤距离）。
                // 窗口起止取「有效点」的时间轴，免得防抖预热把窗口拉长、把均速摊薄。
                if gs.dt_sec > 0.0 {
                    let t0 = match self.pending_t0 {
                        Some(v) => v,
                        None => {
                            let v = gs.at_ms - (gs.dt_sec * 1000.0).round() as i64;
                            self.pending_t0 = Some(v);
                            v
                        }
                    };
                    self.pending_d += gs.m;
                    let win_sec = (gs.at_ms - t0) as f64 / 1000.0;
                    if win_sec >= 1.0 {
                        if self.pending_d / win_sec >= DIST_FLOOR_MPS {
                            out.dist_delta_m = self.pending_d;
                            self.dist_m += self.pending_d;
                            self.last_move_ms = gs.at_ms;
                        }
                        self.pending_d = 0.0;
                        self.pending_t0 = None;
                    }
                }
            }
            out.accepted = true;
            out.brk = std::mem::take(&mut self.pending_brk);
            // 快通道插入点 A：pending_d 已由上面的 L4 更新完、win 尚未入队
            out.disp_m = self.bump_disp(f, out.brk);
            self.win.push_back(WinFix {
                t: f.t,
                d,
                credit: out.dist_delta_m,
                accepted: true,
            });
            self.push_recent(f.t, out.dist_delta_m);
            self.trim_windows(f.t);

            // L5 + 进入判定共用同一个 W10 弦速
            if !stale {
                let w10 = self.w10(f.t);
                if w10.len() >= ENTER_MIN_FIXES {
                    let span = (w10[w10.len() - 1].t - w10[0].t) as f64 / 1000.0;
                    if span >= ENTER_MIN_SPAN_SEC {
                        let sum: f64 = w10.iter().map(|w| w.credit).sum();
                        let chord = sum / span;
                        out.chord_mps = chord;
                        if sum >= PACE_MIN_DIST_M && chord >= PACE_MIN_MPS {
                            let inst = 1000.0 / chord;
                            self.pace_sec_per_km = Some(match self.pace_sec_per_km {
                                Some(p) => p * 0.7 + inst * 0.3,
                                None => inst,
                            });
                        }
                        if self.enabled {
                            self.judge_in.push_back(Judge { t: f.t, ok: chord < self.v_enter() });
                        }
                    }
                }
            }
            out.in_streak = streak(&self.judge_in);
            if self.enabled && !stale && streak(&self.judge_in) >= ENTER_STREAK {
                self.enter(f, &mut out);
            }
            self.last_acc = Some(f);
            out.auto_paused = self.auto_paused;
            out.dist_m = self.dist_m;
            out.elapsed_ms = self.elapsed_ms;
            out.pace_sec_per_km = self.pace_sec_per_km;
            out.disp_m = self.disp_m;
            out
        }

        fn handle_gap(&mut self, f: Fix, p: Fix, dt_sec: f64, d: f64, out: &mut Outcome) {
            let gap_ms = f.t - p.t;
            let gap_speed = if dt_sec > 0.0 { d / dt_sec } else { 0.0 };
            let vmax = (VMAX_FACTOR * self.v_prev60(p.t))
                .max(VMAX_FLOOR_MPS)
                .clamp(VMAX_FLOOR_MPS, VMAX_CEIL_MPS);
            let kind = if gap_speed < GAP_SLOW_MPS {
                GapKind::Slow
            } else if gap_speed <= vmax {
                GapKind::Fast
            } else {
                GapKind::Drop
            };
            self.gap_ms += gap_ms;
            match kind {
                GapKind::Slow => {
                    // 不计时不计距，只进 gap 桶（与 autoPauseOn 无关）
                    self.gap_slow_count += 1;
                    self.gap_slow_ms += gap_ms;
                }
                GapKind::Fast => {
                    let credit = d.min(d_max(dt_sec));
                    self.gap_fast_count += 1;
                    self.gap_fast_ms += gap_ms;
                    self.dist_m += credit;
                    self.elapsed_ms += gap_ms;
                    self.last_move_ms = f.t;
                    out.dist_delta_m = credit;
                    out.elapsed_delta_ms = gap_ms;
                    out.gap_credit_m = credit;
                }
                GapKind::Drop => {
                    self.gap_drop_count += 1;
                    self.gap_drop_ms += gap_ms;
                }
            }
            out.gap = Some(kind);
            out.gap_bucket_ms = gap_ms;
            out.gap_speed_mps = gap_speed;
            out.accepted = true;
            out.brk = true;
            self.pending_d = 0.0;
            self.pending_t0 = None;
            self.pending_brk = false;
            self.reset_guard(Some(f)); // 空窗是新一段的起点：防抖窗口从它重新攒
            // 快通道插入点 B：pending_d 已清零、brk=true（锚点已复位）→ disp_m 取 max(旧值, dist_m)
            out.disp_m = self.bump_disp(f, out.brk);
            self.win.push_back(WinFix {
                t: f.t,
                d,
                credit: out.dist_delta_m,
                accepted: true,
            });
            self.push_recent(f.t, out.dist_delta_m);
            self.trim_windows(f.t);
            self.last_acc = Some(f);
            out.auto_paused = self.auto_paused;
            out.dist_m = self.dist_m;
            out.elapsed_ms = self.elapsed_ms;
            out.pace_sec_per_km = self.pace_sec_per_km;
        }

        fn enter(&mut self, f: Fix, out: &mut Outcome) {
            self.auto_paused = true;
            self.auto_pause_count += 1;
            self.anchor = Some(f);
            self.pending_d = 0.0;
            self.pending_t0 = None;
            // 暂停点即新的有效起点：退出判定的位移从它起算（防抖窗口也在这里重攒）
            self.reset_guard(Some(f));
            // 翻转后两条链都从头累计，防旧判定把状态立刻推回去
            self.judge_in.clear();
            self.judge_out.clear();
            out.entered = true;
        }

        fn eval_exit(&mut self, f: Fix, out: &mut Outcome) {
            let Some(anchor) = self.anchor else {
                return;
            };
            let lo = f.t - (EXIT_WINDOW_SEC * 1000.0) as i64;
            let w: Vec<&WinFix> = self
                .win
                .iter()
                .filter(|x| x.t >= anchor.t && x.t >= lo)
                .collect();
            let anchor_m = haversine_m(anchor.lat, anchor.lon, f.lat, f.lon);
            out.anchor_m = anchor_m;
            if w.len() >= EXIT_MIN_FIXES {
                let span = (w[w.len() - 1].t - w[0].t) as f64 / 1000.0;
                if span >= EXIT_MIN_SPAN_SEC {
                    // credit = 防抖后的步长（暂停期照样在算，只是不入 dist_m）
                    let sum: f64 = w.iter().map(|x| x.credit).sum();
                    let chord = sum / span;
                    out.chord_mps = chord;
                    self.judge_out.push_back(Judge { t: f.t, ok: chord >= self.v_exit() });
                }
            }
            out.out_streak = streak(&self.judge_out);
            let cond1 = streak(&self.judge_out) >= EXIT_STREAK;
            let cond2 = self.steps.len() >= 2 && self.steps.iter().all(|s| *s >= self.v_exit());
            let cond3 = anchor_m >= EXIT_ANCHOR_M;
            if cond1 && cond2 && cond3 {
                // 一次性补距：暂停期累计量是冻结的，字面「累计距离_now − 锚点累计距离」恒为 0；
                // 按契约意图补「暂停段位移」（clamp 0..60），即 2 m/s 走 5s → 10m。
                let credit = anchor_m.clamp(0.0, EXIT_CREDIT_MAX_M);
                self.dist_m += credit;
                let settle = (f.t - anchor.t).max(0);
                self.auto_pause_ms += settle;
                out.exit_credit_m = credit;
                out.auto_pause_settle_ms = settle;
                out.dist_delta_m = credit;
                self.auto_paused = false;
                self.anchor = None;
                self.pending_brk = true; // 恢复后的第一个点 brk=true
                self.judge_in.clear();
                self.judge_out.clear();
                out.exited = true;
            }
            out.auto_paused = self.auto_paused;
        }

        /// 结账当前自动暂停段（退出之外的路径：手动暂停 / 结束 / 服务停）：返回结账墙钟
        pub fn settle_auto_pause(&mut self, now_ms: i64) -> i64 {
            if !self.auto_paused {
                return 0;
            }
            let ms = self.anchor.map(|a| (now_ms - a.t).max(0)).unwrap_or_default();
            self.auto_pause_ms += ms;
            self.auto_paused = false;
            self.anchor = None;
            self.judge_in.clear();
            self.judge_out.clear();
            self.pending_d = 0.0;
            self.pending_t0 = None;
            self.reset_guard(None);
            // 快通道：结账暂停段，显示锚点清空，恢复后的首个被接受 fix 重新落座
            self.seg_anchor = None;
            ms
        }

        /// 手动相位（B4）：暂停 = 判定全跳过 + 链清零 + 锚点清空 + autoPaused 置 false；
        /// 继续 = 判定器复位（W10/Wrec 按滑动自然刷新）。
        pub fn set_manual_paused(&mut self, paused: bool) {
            self.manual_paused = paused;
            if paused {
                self.auto_paused = false;
                self.anchor = None;
            }
            self.judge_in.clear();
            self.judge_out.clear();
            self.steps.clear();
            self.pending_d = 0.0;
            self.pending_t0 = None;
            self.reset_guard(None);
            // 快通道：手动暂停期间不推进 disp_m；锚点清空，继续后重新落座（跨段位移不计入）
            if paused {
                self.seg_anchor = None;
            }
        }

        /// live 快照用的计数：gapCount = slow+fast+drop
        pub fn gap_count(&self) -> u32 {
            self.gap_slow_count + self.gap_fast_count + self.gap_drop_count
        }
    }

    /* ===== K 向量表（同一张表镜像在 RunAutoPause.selfTest()） ===== */

    pub struct VectorResult {
        pub name: &'static str,
        pub ok: bool,
        pub detail: String,
    }

    /// 真机量级的 epoch ms
    pub const START_T: i64 = 1_760_000_000_000;
    pub const LAT0: f64 = 31.2301;
    pub const LON0: f64 = 121.4702;
    /// 站立抖动（≤1m，相邻位移 0.6~0.8m —— 真机常见量级：
    /// 步长低于 L4 的 0.5 m/s 地板时距离不入账，退出窗口的弦速也会晚一步跨过阈值）
    pub const JITTER: [f64; 8] = [0.0, 0.8, 0.1, 0.9, 0.2, 0.8, 0.0, 0.7];
    /// 站立游走 ±3m（相邻位移 ≤1.3m）
    pub const WANDER: [f64; 28] = [
        0.0, 0.9, 1.8, 2.7, 1.9, 1.0, 0.2, -0.7, -1.6, -2.5, -3.0, -2.1, -1.2, -0.3, 0.6, 1.5, 2.4,
        3.0, 2.2, 1.3, 0.4, -0.5, -1.4, -2.3, -1.4, -0.5, 0.4, 1.3,
    ];

    /// 沿经线位移：haversine 沿经线恰为 R×Δφ，用它生成的点距离可控
    pub fn move_lat(lat: f64, north_m: f64) -> f64 {
        lat + north_m / 6_371_000.0 * (180.0 / std::f64::consts::PI)
    }

    /// 匀速直线：fix i 在 start_lat 往北 i×speed×dt 米处；
    /// 返回 (fixes, 末尾继续沿该方向的下一纬度)
    pub fn run_fixes(
        t0: i64,
        dt_ms: i64,
        n: usize,
        speed_mps: f64,
        start_lat: f64,
    ) -> (Vec<Fix>, f64) {
        let step_m = speed_mps * (dt_ms as f64 / 1000.0);
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(Fix {
                t: t0 + i as i64 * dt_ms,
                lat: move_lat(start_lat, step_m * i as f64),
                lon: LON0,
                acc: 5.0,
            });
        }
        (out, move_lat(start_lat, step_m * n as f64))
    }

    /// 站立：按固定偏移表在中心附近游走
    pub fn stand_fixes(t0: i64, dt_ms: i64, n: usize, offsets: &[f64], center_lat: f64) -> Vec<Fix> {
        (0..n)
            .map(|i| Fix {
                t: t0 + i as i64 * dt_ms,
                lat: move_lat(center_lat, offsets[i % offsets.len()]),
                lon: LON0,
                acc: 5.0,
            })
            .collect()
    }

    /// V1/V2 的公共前缀：跑 3 m/s 20s → 回到起点附近静止抖动 25s；返回（core, 停跑时刻, 末尾纬度）
    fn stop_prefix() -> (Core, i64, f64) {
        let mut core = Core::new(600, 540, 0, 0.0);
        let (run, _) = run_fixes(START_T, 1000, 20, 3.0, LAT0);
        let last_lat = run.last().map(|f| f.lat).unwrap_or(LAT0);
        for f in run {
            core.on_fix(f);
        }
        let stop_t = START_T + 20_000;
        let stand = stand_fixes(stop_t, 1000, 25, &JITTER, last_lat);
        for f in stand {
            core.on_fix(f);
        }
        (core, stop_t, last_lat)
    }

    /// V1 跑 3 m/s 20s → 静止（抖动 ≤1m）→ 8~12s 进入
    pub fn v1() -> VectorResult {
        let mut core = Core::new(600, 540, 0, 0.0);
        let (run, _) = run_fixes(START_T, 1000, 20, 3.0, LAT0);
        let last_lat = run.last().map(|f| f.lat).unwrap_or(LAT0);
        for f in run {
            core.on_fix(f);
        }
        let stop_t = START_T + 20_000;
        let stand = stand_fixes(stop_t, 1000, 25, &JITTER, last_lat);
        let mut enter_at = None;
        for f in stand {
            if core.on_fix(f).entered {
                enter_at = Some(f.t);
            }
        }
        let delay = enter_at.map(|t| t - stop_t);
        let ok = matches!(delay, Some(d) if (8_000..=12_000).contains(&d));
        VectorResult {
            name: "V1 停跑 3m/s→静止 8~12s 进入",
            ok,
            detail: format!("enterDelay={delay:?}ms autoPaused={}", core.auto_paused),
        }
    }

    /// V2 接 V1 走 2 m/s → 位移 ≥10m 且在 11s 内退出（防抖把确认滞后约 3 个点）
    pub fn v2() -> VectorResult {
        let (mut core, _stop_t, last_lat) = stop_prefix();
        let entered = core.auto_paused;
        let walk_start_t = START_T + 20_000 + 25_000;
        let move_t0 = walk_start_t - 1000; // 走动从上一个静止点起算
        let (walk, _) = run_fixes(walk_start_t, 1000, 12, 2.0, move_lat(last_lat, 2.0));
        let mut exit_at = None;
        let mut credit = 0.0;
        for f in walk {
            let o = core.on_fix(f);
            if o.exited {
                exit_at = Some(f.t);
                credit = o.exit_credit_m;
            }
        }
        let delay = exit_at.map(|t| t - move_t0);
        let ok = entered && matches!(delay, Some(d) if d <= 11_000) && (10.0..=60.0).contains(&credit);
        VectorResult {
            name: "V2 2m/s 走动 位移≥10m 且 ≤11s 退出",
            ok,
            detail: format!("entered={entered} exitDelay={delay:?}ms exitCredit={credit:.1}m"),
        }
    }

    /// V3 运行中 6s 无 fix → 不进不出
    pub fn v3() -> VectorResult {
        let mut core = Core::new(600, 540, 0, 0.0);
        let (a, after_a) = run_fixes(START_T, 1000, 10, 3.0, LAT0);
        let mut entered = false;
        let mut exited = false;
        for f in a {
            let o = core.on_fix(f);
            entered |= o.entered;
            exited |= o.exited;
        }
        // 6s 无 fix 后继续跑（位移连续：最后一格在 after_a - 3m，6s 后到 after_a + 15m）
        let t_gap = START_T + 10_000 + 6_000;
        let gap_lat = move_lat(after_a, 15.0);
        let o = core.on_fix(Fix { t: t_gap, lat: gap_lat, lon: LON0, acc: 5.0 });
        entered |= o.entered;
        exited |= o.exited;
        let (b, _) = run_fixes(t_gap + 1000, 1000, 20, 3.0, gap_lat);
        for f in b {
            let o = core.on_fix(f);
            entered |= o.entered;
            exited |= o.exited;
        }
        VectorResult {
            name: "V3 运行中 6s 无 fix → 不进不出",
            ok: !entered && !exited,
            detail: format!("entered={entered} exited={exited}"),
        }
    }

    /// V4 手动暂停 30s → 不进
    pub fn v4() -> VectorResult {
        let mut core = Core::new(600, 540, 0, 0.0);
        let (run, after) = run_fixes(START_T, 1000, 20, 3.0, LAT0);
        for f in run {
            core.on_fix(f);
        }
        core.set_manual_paused(true);
        let stand = stand_fixes(START_T + 20_000, 1000, 30, &JITTER, move_lat(after, -3.0));
        let mut entered = false;
        for f in stand {
            entered |= core.on_fix(f).entered;
        }
        VectorResult {
            name: "V4 手动暂停 30s → 不进",
            ok: !entered && !core.auto_paused,
            detail: format!("entered={entered} autoPaused={}", core.auto_paused),
        }
    }

    /// V5 站立 ±3m 游走 120s → 0 次退出
    pub fn v5() -> VectorResult {
        let mut core = Core::new(600, 540, 0, 0.0);
        let fixes = stand_fixes(START_T, 1000, 120, &WANDER, LAT0);
        let mut enters = 0u32;
        let mut exits = 0u32;
        for f in fixes {
            let o = core.on_fix(f);
            if o.entered {
                enters += 1;
            }
            if o.exited {
                exits += 1;
            }
        }
        VectorResult {
            name: "V5 站立 ±3m 游走 120s → 0 次退出",
            ok: exits == 0 && enters > 0,
            detail: format!("enters={enters} exits={exits}"),
        }
    }

    /// V6 起步即停（收点稀疏 3s）→ 约 12s 进入
    pub fn v6() -> VectorResult {
        let mut core = Core::new(600, 540, 0, 0.0);
        let fixes = stand_fixes(START_T, 3000, 20, &JITTER, LAT0);
        let mut enter_at = None;
        for f in fixes {
            if core.on_fix(f).entered {
                enter_at = Some(f.t);
            }
        }
        let delay = enter_at.map(|t| t - START_T);
        let ok = matches!(delay, Some(d) if (11_000..=13_000).contains(&d));
        VectorResult {
            name: "V6 起步即停（3s 收点）约 12s 进入",
            ok,
            detail: format!("enterDelay={delay:?}ms"),
        }
    }

    /// 跑整张向量表（Kotlin selfTest 的镜像）
    /// V7 站立 ±3m 游走 120s → 距离被 4 点方向防抖抹平（旧行为会把之字形一路累加）
    pub fn v7() -> VectorResult {
        let mut core = Core::new(600, 540, 0, 0.0);
        for f in stand_fixes(START_T, 1000, 120, &WANDER, LAT0) {
            core.on_fix(f);
        }
        let ok = core.dist_m <= 6.0 && core.jitter_corrections > 0;
        VectorResult {
            name: "V7 站立 ±3m 游走 120s → 距离≤6m（防抖抹平之字形）",
            ok,
            detail: format!("dist={:.1} jc={}", core.dist_m, core.jitter_corrections),
        }
    }

    /// V8 直线 3m/s 30 点 → 距离≈26 段（只丢窗口预热的第 1 段），0 次校正
    pub fn v8() -> VectorResult {
        let mut core = Core::new(600, 540, 0, 0.0);
        let (run, _) = run_fixes(START_T, 1000, 30, 3.0, LAT0);
        for f in run {
            core.on_fix(f);
        }
        let expect = 3.0 * (30.0 - 4.0);
        let ok = core.dist_m >= expect * 0.9
            && core.dist_m <= expect * 1.05
            && core.jitter_corrections == 0;
        VectorResult {
            name: "V8 直线 3m/s 30 点 → 距离≈78m 且 0 次校正",
            ok,
            detail: format!("dist={:.1} jc={}", core.dist_m, core.jitter_corrections),
        }
    }

    /* ===== 快通道 / 呈现常量（规格 §3.2） ===== */

    /// hero 显示非零门（呈现层）：dispM ≥ 1m 才显示数字
    pub const DISP_MIN_M: f64 = 1.0;
    /// hero 显示单位分档：<100m 显整数米，≥100m 显 km 2 位小数
    pub const HERO_METER_MAX_M: f64 = 100.0;

    /* ===== 2D 生成器（与 .zcode/tmp 的 JS 取证脚本逐位同式） ===== */

    /// 拓扑向量统一参数：100s @1Hz、3 m/s、i=0..100 共 101 个点
    pub const V_TOPO: f64 = 3.0;
    pub const N_TOPO: usize = 101;

    /// 平面 ENU 米 → lat/lon（与 JS `enuToLatLon` 同式：lon 用新 lat；R=6371000）
    pub fn enu_to_lat_lon(east_m: f64, north_m: f64) -> (f64, f64) {
        let r = 6_371_000.0f64;
        let r2d = 180.0 / std::f64::consts::PI;
        let lat = LAT0 + north_m / r * r2d;
        let lon = LON0 + east_m / (r * (lat * std::f64::consts::PI / 180.0).cos()) * r2d;
        (lat, lon)
    }

    /// JS `mulberry32`（Math.imul 语义）逐位复刻；全程 u32 包装 ⇒ 与 int32 位模式一致
    pub struct Mulberry32 {
        a: u32,
    }

    impl Mulberry32 {
        pub fn new(seed: i64) -> Self {
            Self { a: seed as u32 }
        }

        pub fn next_f64(&mut self) -> f64 {
            self.a = self.a.wrapping_add(0x6D2B_79F5);
            let t1 = (self.a ^ (self.a >> 15)).wrapping_mul(self.a | 1);
            let t = t1.wrapping_add((t1 ^ (t1 >> 7)).wrapping_mul(t1 | 61)) ^ t1;
            ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
        }
    }

    /// 折返：幅度 A 米的三角波（1Hz 按弧长 s=V·i 取值）
    pub fn gen_turnback(a_amp: f64) -> Vec<(f64, f64)> {
        let leg_t = a_amp / V_TOPO;
        (0..N_TOPO)
            .map(|i| {
                let cyc = i as f64 / leg_t;
                let k = cyc.floor() as i64;
                let f = cyc - k as f64;
                let x = if k % 2 == 0 { a_amp * f } else { a_amp * (1.0 - f) };
                (0.0, x)
            })
            .collect()
    }

    /// 绕圈：半径 r 的圆（切向速度恒 V）
    pub fn gen_circle(r: f64) -> Vec<(f64, f64)> {
        let w = V_TOPO / r;
        (0..N_TOPO)
            .map(|i| {
                let th = w * i as f64;
                (r * th.sin(), r * (1.0 - th.cos()))
            })
            .collect()
    }

    /// 400m 标准场：直道 84.39m + 两个 180° 半圆（半径 36.5m）
    pub fn gen_track() -> Vec<(f64, f64)> {
        let l = 84.39;
        let rr = 36.5;
        let pi = std::f64::consts::PI;
        let lap = 2.0 * l + 2.0 * pi * rr;
        (0..N_TOPO)
            .map(|i| {
                let s = (V_TOPO * i as f64) % lap;
                if s < l {
                    (0.0, s)
                } else if s < l + pi * rr {
                    let a = (s - l) / rr;
                    (rr * (1.0 - a.cos()), l + rr * a.sin())
                } else if s < 2.0 * l + pi * rr {
                    let d = s - (l + pi * rr);
                    (2.0 * rr, l - d)
                } else {
                    let a = (s - (2.0 * l + pi * rr)) / rr;
                    (2.0 * rr * a.cos(), -rr * a.sin())
                }
            })
            .collect()
    }

    /// 直线：沿北 3 m/s
    pub fn gen_straight() -> Vec<(f64, f64)> {
        (0..N_TOPO).map(|i| (0.0, V_TOPO * i as f64)).collect()
    }

    /// 自由跑：每步航向随机游走 ±sigma 度
    pub fn gen_random(seed: i64, sigma_deg: f64) -> Vec<(f64, f64)> {
        let mut rnd = Mulberry32::new(seed);
        let (mut hd, mut e, mut n) = (0.0f64, 0.0f64, 0.0f64);
        let mut pts = vec![(0.0f64, 0.0f64)];
        for _ in 1..N_TOPO {
            hd += (rnd.next_f64() - 0.5) * 2.0 * sigma_deg;
            e += V_TOPO * (hd * std::f64::consts::PI / 180.0).sin();
            n += V_TOPO * (hd * std::f64::consts::PI / 180.0).cos();
            pts.push((e, n));
        }
        pts
    }

    /// ENU 点列 → Fix 列（t 自 t0 起每 dt_ms 一个）
    pub fn fixes_from_enu(t0: i64, dt_ms: i64, pts: &[(f64, f64)], acc: f64) -> Vec<Fix> {
        pts.iter()
            .enumerate()
            .map(|(i, p)| {
                let (lat, lon) = enu_to_lat_lon(p.0, p.1);
                Fix { t: t0 + i as i64 * dt_ms, lat, lon, acc }
            })
            .collect()
    }

    /// 1Hz 采样折线长度：任何只看位置的方法都受此下界约束
    pub fn polyline_len(pts: &[(f64, f64)]) -> f64 {
        let mut s = 0.0;
        for i in 1..pts.len() {
            let (la1, lo1) = enu_to_lat_lon(pts[i - 1].0, pts[i - 1].1);
            let (la2, lo2) = enu_to_lat_lon(pts[i].0, pts[i].1);
            s += haversine_m(la1, lo1, la2, lo2);
        }
        s
    }

    /// 一次拓扑跑的汇总（V10/V11/V12/V13/V17/V18/V19 共用；独占一个 Core）
    pub struct TopoRun {
        pub disp_m: f64,
        pub dist_m: f64,
        pub first_steady_nz_ms: Option<i64>,
        pub distinct_disp: usize,
        pub enters: u32,
        pub exits: u32,
        pub jc: u32,
    }

    pub fn run_topo(pts: &[(f64, f64)], acc: f64) -> TopoRun {
        let mut core = Core::new(600, 540, 0, 0.0);
        let fixes = fixes_from_enu(START_T, 1000, pts, acc);
        let mut r = TopoRun {
            disp_m: 0.0,
            dist_m: 0.0,
            first_steady_nz_ms: None,
            distinct_disp: 0,
            enters: 0,
            exits: 0,
            jc: 0,
        };
        let mut last = -1.0f64;
        for f in &fixes {
            let o = core.on_fix(*f);
            if r.first_steady_nz_ms.is_none() && core.dist_m > 0.0 {
                r.first_steady_nz_ms = Some(f.t - START_T);
            }
            if core.disp_m != last {
                r.distinct_disp += 1;
                last = core.disp_m;
            }
            if o.entered {
                r.enters += 1;
            }
            if o.exited {
                r.exits += 1;
            }
        }
        r.disp_m = core.disp_m;
        r.dist_m = core.dist_m;
        r.jc = core.jitter_corrections;
        r
    }

    /// 2D 圆盘静止：每步在半径 r 的圆盘内独立均匀取一点（非游走）
    /// 返回 (稳通道 >6m 的 seed 数, 快通道 >6m 的 seed 数, 稳 max, 快 max)
    pub fn disk_stat(r: f64, seed_base: i64, n_seeds: usize, steps: usize) -> (usize, usize, f64, f64) {
        let (mut over6_comm, mut over6_disp) = (0usize, 0usize);
        let (mut max_comm, mut max_disp) = (0.0f64, 0.0f64);
        for seed in 0..n_seeds {
            let mut rnd = Mulberry32::new(seed_base + seed as i64 * 7 + 1);
            let mut core = Core::new(600, 540, 0, 0.0);
            for i in 0..steps {
                let ang = rnd.next_f64() * 2.0 * std::f64::consts::PI;
                let rad = r * rnd.next_f64().sqrt();
                let (lat, lon) = enu_to_lat_lon(rad * ang.cos(), rad * ang.sin());
                core.on_fix(Fix { t: START_T + i as i64 * 1000, lat, lon, acc: 5.0 });
            }
            if core.dist_m > 6.0 {
                over6_comm += 1;
            }
            if core.disp_m > 6.0 {
                over6_disp += 1;
            }
            max_comm = max_comm.max(core.dist_m);
            max_disp = max_disp.max(core.disp_m);
        }
        (over6_comm, over6_disp, max_comm, max_disp)
    }

    /// 2D r=8m 静止 + 每 20s 偶发跳变（i%20==0 → 东偏 +25m/acc25；i%20==10 → 北偏 +22m/acc28）
    /// 返回 (稳>6 数, 快>6 数, 稳 max, 快 max, 累计 jumpCount)
    pub fn disk_stat_jump(n_seeds: usize, steps: usize) -> (usize, usize, f64, f64, u32) {
        let (mut over6_comm, mut over6_disp) = (0usize, 0usize);
        let (mut max_comm, mut max_disp) = (0.0f64, 0.0f64);
        let mut jumps = 0u32;
        for seed in 0..n_seeds {
            let mut rnd = Mulberry32::new(300_000 + seed as i64 * 13 + 1);
            let mut core = Core::new(600, 540, 0, 0.0);
            for i in 0..steps {
                let ang = rnd.next_f64() * 2.0 * std::f64::consts::PI;
                let rad = 8.0 * rnd.next_f64().sqrt();
                let mut e = rad * ang.cos();
                let mut n = rad * ang.sin();
                let mut acc = 5.0;
                if i > 0 && i % 20 == 0 {
                    e += 25.0;
                    acc = 25.0;
                } else if i > 0 && i % 20 == 10 {
                    n += 22.0;
                    acc = 28.0;
                }
                let (lat, lon) = enu_to_lat_lon(e, n);
                core.on_fix(Fix { t: START_T + i as i64 * 1000, lat, lon, acc });
            }
            if core.dist_m > 6.0 {
                over6_comm += 1;
            }
            if core.disp_m > 6.0 {
                over6_disp += 1;
            }
            max_comm = max_comm.max(core.dist_m);
            max_disp = max_disp.max(core.disp_m);
            jumps += core.jump_count;
        }
        (over6_comm, over6_disp, max_comm, max_disp, jumps)
    }

    /// V9 快通道起步时效：直线 3m/s、1Hz、acc5 → 1000ms 即出现非零（且 ≥1m）
    pub fn v9() -> VectorResult {
        let mut core = Core::new(600, 540, 0, 0.0);
        let fixes = fixes_from_enu(START_T, 1000, &gen_straight(), 5.0);
        let (mut first_nz, mut first_ge1) = (None, None);
        let mut vals = [0.0f64; 3];
        for (i, f) in fixes.iter().enumerate() {
            core.on_fix(*f);
            if first_nz.is_none() && core.disp_m > 0.0 {
                first_nz = Some(f.t - START_T);
            }
            if first_ge1.is_none() && core.disp_m >= DISP_MIN_M {
                first_ge1 = Some(f.t - START_T);
            }
            if (1..=3).contains(&i) {
                vals[i - 1] = core.disp_m;
            }
        }
        let near = |a: f64, b: f64| (a - b).abs() <= 0.5;
        let ok = first_nz == Some(1000)
            && first_ge1 == Some(1000)
            && near(vals[0], 3.0)
            && near(vals[1], 6.0)
            && near(vals[2], 9.0);
        VectorResult {
            name: "V9 快通道起步时效（直线 3m/s,1Hz,acc5）→ 1000ms 首个非零",
            ok,
            detail: format!(
                "firstDisplay={first_nz:?}ms first>=1m={first_ge1:?}ms t=1/2/3s dispM={:.2}/{:.2}/{:.2}",
                vals[0], vals[1], vals[2]
            ),
        }
    }

    /// V10 快通道五拓扑 100s 末值（acc5, clean）
    pub fn v10() -> VectorResult {
        let tb = run_topo(&gen_turnback(5.0), 5.0).disp_m;
        let ci = run_topo(&gen_circle(5.0), 5.0).disp_m;
        let tr = run_topo(&gen_track(), 5.0).disp_m;
        let st = run_topo(&gen_straight(), 5.0).disp_m;
        let rd = run_topo(&gen_random(1, 15.0), 5.0).disp_m;
        let rng = |v: f64| (285.0..=315.0).contains(&v);
        let ok = (4.5..=5.5).contains(&tb) && rng(ci) && rng(tr) && rng(rd) && (st - 300.0).abs() <= 0.5;
        VectorResult {
            name: "V10 快通道五拓扑 100s 末值（acc5,clean）",
            ok,
            detail: format!("dispM 折返={tb:.1} 绕圈={ci:.1} 跑道={tr:.1} 直线={st:.1} 随便跑={rd:.1}"),
        }
    }

    /// V11 稳通道四拓扑 100s 累计 ≤5%（acc5, clean）
    pub fn v11() -> VectorResult {
        let ci = run_topo(&gen_circle(5.0), 5.0).dist_m;
        let tr = run_topo(&gen_track(), 5.0).dist_m;
        let st = run_topo(&gen_straight(), 5.0).dist_m;
        let rd = run_topo(&gen_random(1, 15.0), 5.0).dist_m;
        let rng = |v: f64| (285.0..=315.0).contains(&v);
        let ok = rng(ci) && rng(tr) && rng(st) && rng(rd);
        VectorResult {
            name: "V11 稳通道四拓扑 ≤5%（acc5,clean,100s）",
            ok,
            detail: format!("distM 绕圈={ci:.1} 跑道={tr:.1} 直线={st:.1} 随便跑={rd:.1}"),
        }
    }

    /// V12 折返 5m@3m/s 100s：1Hz 折线信息上限 −26.7%，稳/快通道都远低于真值（documented-fail）
    pub fn v12() -> VectorResult {
        let pts = gen_turnback(5.0);
        let r = run_topo(&pts, 5.0);
        let pl = polyline_len(&pts);
        let ok = r.dist_m < 30.0 && r.disp_m < 30.0;
        VectorResult {
            name: "V12 折返 5m@3m/s 100s：1Hz 折线≈220m（−26.7%），稳 distM≈1.1m / 快 dispM≈5.0m",
            ok,
            detail: format!(
                "polyline1Hz={pl:.1}m 稳distM={:.1} 快dispM={:.1} 稳首个入账={:?}ms",
                r.dist_m, r.disp_m, r.first_steady_nz_ms
            ),
        }
    }

    /// V13 静止 1D WANDER ±3m 120s：稳≈0、快≈2.7（都 ≤6m）
    pub fn v13() -> VectorResult {
        let pts: Vec<(f64, f64)> = (0..120).map(|i| (0.0, WANDER[i % WANDER.len()])).collect();
        let r = run_topo(&pts, 5.0);
        let ok = r.dist_m <= 6.0 && r.disp_m <= 6.0 && r.enters >= 1;
        VectorResult {
            name: "V13 静止 1D WANDER ±3m 120s：稳≤6 且 快≤6 且 enters≥1",
            ok,
            detail: format!("稳distM={:.1} 快dispM={:.1} enters={}", r.dist_m, r.disp_m, r.enters),
        }
    }

    /// V14 静止 2D 圆盘 r=3m 100s×100seed（acc5）：两通道无一超 6m
    pub fn v14() -> VectorResult {
        let (oc, od, mc, md) = disk_stat(3.0, 100_000, 100, 100);
        let ok = oc == 0 && od == 0;
        VectorResult {
            name: "V14 静止 2D 圆盘 r=3m 100s×100seed（acc5）：稳>6=0/100 快>6=0/100",
            ok,
            detail: format!("稳>6={oc}/100(max {mc:.1}) 快>6={od}/100(max {md:.1})"),
        }
    }

    /// V15 静止 2D 圆盘 r=8m 100s×100seed（acc5）：两通道都超 6m（documented-fail）
    pub fn v15() -> VectorResult {
        let (oc, od, mc, md) = disk_stat(8.0, 200_000, 100, 100);
        let ok = oc > 0 && od > 0;
        VectorResult {
            name: "V15 静止 2D 圆盘 r=8m 100s×100seed（acc5）：稳/快都超 6m（documented-fail）",
            ok,
            detail: format!("稳>6={oc}/100(max {mc:.1}) 快>6={od}/100(max {md:.1})"),
        }
    }

    /// V16 静止 2D r=8m + 每 20s 偶发跳变（+25/acc25、+22/acc28）100s×50seed：都超 6m 且无跳变丢弃（documented-fail）
    pub fn v16() -> VectorResult {
        let (oc, od, mc, md, jumps) = disk_stat_jump(50, 100);
        let ok = oc > 0 && od > 0 && jumps == 0;
        VectorResult {
            name: "V16 静止 2D r=8m+偶发跳变 ×50seed：稳/快都超 6m 且 jumpCount=0（documented-fail）",
            ok,
            detail: format!("稳>6={oc}/50(max {mc:.1}) 快>6={od}/50(max {md:.1}) jumpCount={jumps}"),
        }
    }

    /// V17 刷新节奏（限四拓扑）：100s 内 dispM 变化次数 ≥90
    pub fn v17() -> VectorResult {
        let ci = run_topo(&gen_circle(5.0), 5.0).distinct_disp;
        let tr = run_topo(&gen_track(), 5.0).distinct_disp;
        let st = run_topo(&gen_straight(), 5.0).distinct_disp;
        let rd = run_topo(&gen_random(1, 15.0), 5.0).distinct_disp;
        let ok = ci >= 90 && tr >= 90 && st >= 90 && rd >= 90;
        VectorResult {
            name: "V17 刷新节奏（四拓扑）：100s 内 dispM 变化次数 ≥90",
            ok,
            detail: format!("变化次数 绕圈={ci} 跑道={tr} 直线={st} 随便跑={rd}"),
        }
    }

    /// V18 快通道下界性：dispM ≤ 1Hz 采样折线长度
    pub fn v18() -> VectorResult {
        let ci_pts = gen_circle(5.0);
        let tr_pts = gen_track();
        let st_pts = gen_straight();
        let ci = run_topo(&ci_pts, 5.0).disp_m;
        let tr = run_topo(&tr_pts, 5.0).disp_m;
        let st = run_topo(&st_pts, 5.0).disp_m;
        let (ci_pl, tr_pl, st_pl) =
            (polyline_len(&ci_pts), polyline_len(&tr_pts), polyline_len(&st_pts));
        let eps = 1e-6;
        let ok = st <= st_pl + eps && ci <= ci_pl + eps && tr <= tr_pl + eps;
        VectorResult {
            name: "V18 快通道下界性：dispM ≤ 1Hz 折线长度",
            ok,
            detail: format!("直线 {st:.1}≤{st_pl:.1} 绕圈 {ci:.1}≤{ci_pl:.1} 跑道 {tr:.1}≤{tr_pl:.1}"),
        }
    }

    /// V19 acc 值无关/精度门：直线 acc5=acc15=acc29.9 → 291.0；acc31 → 0
    pub fn v19() -> VectorResult {
        let pts = gen_straight();
        let d5 = run_topo(&pts, 5.0).dist_m;
        let d15 = run_topo(&pts, 15.0).dist_m;
        let d299 = run_topo(&pts, 29.9).dist_m;
        let d31 = run_topo(&pts, 31.0).dist_m;
        let ok = (d5 - d15).abs() < 1e-6
            && (d15 - d299).abs() < 1e-6
            && (d5 - 291.0).abs() <= 0.5
            && d31 == 0.0;
        VectorResult {
            name: "V19 acc 值无关/精度门：直线 acc5=acc15=acc29.9=291.0；acc31=0.0",
            ok,
            detail: format!("distM acc5={d5:.3} acc15={d15:.3} acc29.9={d299:.3} acc31={d31:.3}"),
        }
    }

    /// V20 回归锁：精度门 acc35→dropped；单跳 100m@1s→jumped；空窗 slow/fast/drop；手动暂停不进
    /// （与 `mod tracking_tests` 的同名断言逐条同结论）
    pub fn v20() -> VectorResult {
        let mut ok = true;
        let mut detail = String::new();

        // 精度门 acc35 → dropped（参考点不更新）；随后单跳 100m@1s → jumped
        {
            let mut core = Core::new(600, 540, 0, 0.0);
            let o = core.on_fix(Fix { t: START_T, lat: LAT0, lon: LON0, acc: 35.0 });
            ok &= o.dropped && !o.accepted;
            detail.push_str(&format!("acc35.dropped={} ", o.dropped));
            core.on_fix(Fix { t: START_T + 1000, lat: LAT0, lon: LON0, acc: 8.0 });
            let o = core.on_fix(Fix { t: START_T + 2000, lat: move_lat(LAT0, 100.0), lon: LON0, acc: 8.0 });
            ok &= o.jumped && core.jump_count == 1;
            detail.push_str(&format!("jump100m.jumped={} ", o.jumped));
        }

        // 空窗三分支：slow / fast / drop
        {
            let mk = || {
                let mut core = Core::new(0, 0, 0, 0.0);
                let (run, _) = run_fixes(START_T, 1000, 6, 3.0, LAT0);
                let last = *run.last().unwrap();
                for f in run {
                    core.on_fix(f);
                }
                (core, last)
            };
            let (mut core, last) = mk();
            let bd = core.dist_m;
            let o = core.on_fix(Fix { t: last.t + 20_000, lat: move_lat(last.lat, 3.0), lon: LON0, acc: 5.0 });
            ok &= o.gap == Some(GapKind::Slow) && core.dist_m == bd && core.gap_slow_count == 1;
            detail.push_str(&format!("gapSlow={} ", o.gap == Some(GapKind::Slow)));
            let (mut core, last) = mk();
            let o = core.on_fix(Fix { t: last.t + 20_000, lat: move_lat(last.lat, 40.0), lon: LON0, acc: 5.0 });
            ok &= o.gap == Some(GapKind::Fast) && (o.gap_credit_m - 40.0).abs() < 1.0;
            detail.push_str(&format!("gapFast={} ", o.gap == Some(GapKind::Fast)));
            let (mut core, last) = mk();
            let bd = core.dist_m;
            let o = core.on_fix(Fix { t: last.t + 20_000, lat: move_lat(last.lat, 300.0), lon: LON0, acc: 5.0 });
            ok &= o.gap == Some(GapKind::Drop) && core.dist_m == bd && core.jump_count == 0;
            detail.push_str(&format!("gapDrop={} ", o.gap == Some(GapKind::Drop)));
        }

        // 手动暂停 30s → 不进自动暂停
        {
            let mut core = Core::new(600, 540, 0, 0.0);
            let (run, after) = run_fixes(START_T, 1000, 20, 3.0, LAT0);
            for f in run {
                core.on_fix(f);
            }
            core.set_manual_paused(true);
            let mut entered = false;
            for f in stand_fixes(START_T + 20_000, 1000, 30, &JITTER, move_lat(after, -3.0)) {
                entered |= core.on_fix(f).entered;
            }
            ok &= !entered && !core.auto_paused;
            detail.push_str(&format!("manualPause.entered={entered}"));
        }

        VectorResult {
            name: "V20 回归锁：精度门/单跳/空窗三分支/手动暂停（与 tracking_tests 同断言）",
            ok,
            detail,
        }
    }

    /// V21 快通道段首复位：自动暂停进入/退出、>10s 空窗 fast、手动暂停——无跨段重复计距
    pub fn v21() -> VectorResult {
        let mut ok = true;
        let mut detail = String::new();

        // A) 跑 3m/s 20s → 静止抖动 25s → 走 2m/s 15s
        {
            let mut core = Core::new(600, 540, 0, 0.0);
            let t = START_T;
            for i in 0..20i64 {
                core.on_fix(Fix { t: t + i * 1000, lat: move_lat(LAT0, 3.0 * i as f64), lon: LON0, acc: 5.0 });
            }
            let stop_lat = move_lat(LAT0, 3.0 * 19.0);
            let (mut enters, mut exits) = (0u32, 0u32);
            let (mut enter_disp, mut enter_comm) = (0.0f64, 0.0f64);
            for i in 0..25i64 {
                let o = core.on_fix(Fix {
                    t: t + (20 + i) * 1000,
                    lat: move_lat(stop_lat, JITTER[i as usize % JITTER.len()]),
                    lon: LON0,
                    acc: 5.0,
                });
                if o.entered {
                    enters += 1;
                    enter_disp = core.disp_m;
                    enter_comm = core.dist_m;
                }
            }
            let walk_t = t + 45_000;
            let walk_start = move_lat(stop_lat, 2.0);
            let (mut brk_disp, mut brk_comm) = (0.0f64, 0.0f64);
            for i in 0..15i64 {
                let o = core.on_fix(Fix {
                    t: walk_t + i * 1000,
                    lat: move_lat(walk_start, 2.0 * i as f64),
                    lon: LON0,
                    acc: 5.0,
                });
                if o.exited {
                    exits += 1;
                }
                if o.brk {
                    brk_disp = core.disp_m;
                    brk_comm = core.dist_m;
                }
            }
            let (end_disp, end_comm) = (core.disp_m, core.dist_m);
            ok &= enters == 1
                && exits == 1
                && (brk_disp - brk_comm).abs() <= 0.5
                && (end_disp - end_comm).abs() <= 0.5
                && (enter_disp - 57.9).abs() <= 1.0
                && (end_disp - 87.2).abs() <= 1.5;
            detail.push_str(&format!(
                "A: ENTER dispM={enter_disp:.1}/comm={enter_comm:.1} brk {brk_disp:.1}/{brk_comm:.1} 末 {end_disp:.1}/{end_comm:.1}; "
            ));
        }

        // B) >10s 空窗（fast：20s 空窗内位移 40m）
        {
            let mut core = Core::new(600, 540, 0, 0.0);
            for i in 0..6i64 {
                core.on_fix(Fix { t: START_T + i * 1000, lat: move_lat(LAT0, 3.0 * i as f64), lon: LON0, acc: 5.0 });
            }
            let last = move_lat(LAT0, 3.0 * 5.0);
            let o = core.on_fix(Fix { t: START_T + 25_000, lat: move_lat(last, 40.0), lon: LON0, acc: 5.0 });
            let (gap_disp, gap_comm, gap_brk) = (core.disp_m, core.dist_m, o.brk);
            for i in 1..=5i64 {
                core.on_fix(Fix {
                    t: START_T + 25_000 + i * 1000,
                    lat: move_lat(last, 40.0 + 3.0 * i as f64),
                    lon: LON0,
                    acc: 5.0,
                });
            }
            let (end_disp, end_comm) = (core.disp_m, core.dist_m);
            ok &= gap_brk
                && (gap_disp - gap_comm).abs() <= 0.5
                && (end_disp - end_comm).abs() <= 0.5
                && (end_disp - 52.0).abs() <= 1.5;
            detail.push_str(&format!(
                "B: gap dispM={gap_disp:.1}/comm={gap_comm:.1} 末 {end_disp:.1}/{end_comm:.1}; "
            ));
        }

        // C) 手动暂停：跑 3m/s 10s → 暂停（点位跳到 100m 外）10s → 继续 3m/s 5s
        {
            let mut core = Core::new(600, 540, 0, 0.0);
            for i in 0..10i64 {
                core.on_fix(Fix { t: START_T + i * 1000, lat: move_lat(LAT0, 3.0 * i as f64), lon: LON0, acc: 5.0 });
            }
            core.set_manual_paused(true);
            for i in 0..10i64 {
                core.on_fix(Fix { t: START_T + (10 + i) * 1000, lat: move_lat(LAT0, 100.0 + i as f64), lon: LON0, acc: 5.0 });
            }
            core.set_manual_paused(false);
            for i in 0..6i64 {
                core.on_fix(Fix { t: START_T + (20 + i) * 1000, lat: move_lat(LAT0, 110.0 + 3.0 * i as f64), lon: LON0, acc: 5.0 });
            }
            let (end_disp, end_comm) = (core.disp_m, core.dist_m);
            ok &= end_disp < 30.0 && end_comm < 30.0 && (end_disp - 27.0).abs() <= 1.5;
            detail.push_str(&format!("C: 末 dispM={end_disp:.1}/comm={end_comm:.1}（100m 跨段不计入）"));
        }

        VectorResult {
            name: "V21 快通道段首复位：自动暂停进入/退出、空窗 fast、手动暂停",
            ok,
            detail,
        }
    }

    pub fn run_vectors() -> Vec<VectorResult> {
        vec![
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
}

/* ---------- 测试 ---------- */

#[cfg(test)]
mod tracking_tests {
    use super::*;

    #[test]
    fn tracking_sanitize_run_id_replaces_unsafe_chars() {
        assert_eq!(
            sanitize_run_id("2026-10-13T07:30:00.000Z"),
            "2026-10-13T07_30_00.000Z"
        );
        assert_eq!(sanitize_run_id("a/b\\c d"), "a_b_c_d");
        assert_eq!(sanitize_run_id(""), "run");
        // 中文/emoji 逐字符换成 '_'，不按字节切断
        assert_eq!(sanitize_run_id("跑"), "_");
        assert!(sanitize_run_id(&"x".repeat(300)).len() <= 128);
    }

    #[test]
    fn tracking_normalize_auto_pause_ranges() {
        // 关闭
        assert_eq!(normalize_auto_pause(0, 540), (0, 0));
        assert_eq!(normalize_auto_pause(-5, 100), (0, 0));
        // 缺省 600/540 原样通过
        assert_eq!(normalize_auto_pause(600, 540), (600, 540));
        // 进入区间收口
        assert_eq!(normalize_auto_pause(100, 540).0, 300);
        assert_eq!(normalize_auto_pause(99_999, 540).0, 1200);
        // 退出必须留出 30s 间隔，且不低于 300
        assert_eq!(normalize_auto_pause(600, 600), (600, 570));
        assert_eq!(normalize_auto_pause(1200, 5000), (1200, 1170));
        assert_eq!(normalize_auto_pause(600, 10), (600, 300));
        // 进入被夹到 300 时上界抬回下限，不 panic
        assert_eq!(normalize_auto_pause(300, 600), (300, 300));
    }

    #[test]
    fn tracking_validate_notify_payload_shape() {
        assert!(validate_notify_payload(r#"{"kind":"run","text":"x"}"#).is_some());
        assert!(validate_notify_payload("[]").is_none());
        assert!(validate_notify_payload("not json").is_none());
        assert!(validate_notify_payload("123").is_none());
        let big = format!(r#"{{"text":"{}"}}"#, "x".repeat(8200));
        assert!(validate_notify_payload(&big).is_none());
    }

    #[test]
    fn tracking_autopause_vector_table() {
        let results = spec::run_vectors();
        let lines: Vec<String> = results
            .iter()
            .map(|r| {
                format!(
                    "{} {} — {}",
                    if r.ok { "pass" } else { "FAIL" },
                    r.name,
                    r.detail
                )
            })
            .collect();
        let failed: Vec<&str> = results.iter().filter(|r| !r.ok).map(|r| r.name).collect();
        println!("{}", lines.join("\n"));
        assert!(failed.is_empty(), "K 向量表失败：{failed:?}\n{}", lines.join("\n"));
        println!(
            "apvector pass={} fail={}",
            results.iter().filter(|r| r.ok).count(),
            results.iter().filter(|r| !r.ok).count()
        );
    }

    #[test]
    fn tracking_gap_branches_slow_fast_drop() {
        // slow：>10s 空窗内几乎没动 → 不计时不计距，只进 slow 桶
        let mut core = spec::Core::new(0, 0, 0, 0.0);
        let (run, _) = spec::run_fixes(spec::START_T, 1000, 6, 3.0, spec::LAT0);
        let last = *run.last().unwrap();
        for f in run {
            core.on_fix(f);
        }
        let before_dist = core.dist_m;
        let before_elapsed = core.elapsed_ms;
        let o = core.on_fix(spec::Fix {
            t: last.t + 20_000,
            lat: spec::move_lat(last.lat, 3.0),
            lon: spec::LON0,
            acc: 5.0,
        });
        assert_eq!(o.gap, Some(spec::GapKind::Slow));
        assert_eq!(core.dist_m, before_dist);
        assert_eq!(core.elapsed_ms, before_elapsed);
        assert_eq!(core.gap_slow_count, 1);
        assert!(o.brk, "空窗后第一个点必须 brk=true");

        // fast：2 m/s 走 20s（40m）→ min(d, dMax) 入账 + 整段计时
        let mut core = spec::Core::new(0, 0, 0, 0.0);
        let (run, _) = spec::run_fixes(spec::START_T, 1000, 6, 3.0, spec::LAT0);
        let last = *run.last().unwrap();
        for f in run {
            core.on_fix(f);
        }
        let before_elapsed = core.elapsed_ms;
        let o = core.on_fix(spec::Fix {
            t: last.t + 20_000,
            lat: spec::move_lat(last.lat, 40.0),
            lon: spec::LON0,
            acc: 5.0,
        });
        assert_eq!(o.gap, Some(spec::GapKind::Fast));
        assert!(
            (o.gap_credit_m - 40.0).abs() < 1.0,
            "fast 补距 = min(d, dMax)：{}",
            o.gap_credit_m
        );
        assert_eq!(core.elapsed_ms - before_elapsed, 20_000);
        assert_eq!(core.gap_fast_count, 1);

        // drop：空窗内 300m/20s = 15 m/s > vMax(6) → 不计时不计距
        let mut core = spec::Core::new(0, 0, 0, 0.0);
        let (run, _) = spec::run_fixes(spec::START_T, 1000, 6, 3.0, spec::LAT0);
        let last = *run.last().unwrap();
        for f in run {
            core.on_fix(f);
        }
        let before_dist = core.dist_m;
        let before_elapsed = core.elapsed_ms;
        let o = core.on_fix(spec::Fix {
            t: last.t + 20_000,
            lat: spec::move_lat(last.lat, 300.0),
            lon: spec::LON0,
            acc: 5.0,
        });
        assert_eq!(o.gap, Some(spec::GapKind::Drop));
        assert_eq!(core.dist_m, before_dist);
        assert_eq!(core.elapsed_ms, before_elapsed);
        assert_eq!(core.gap_drop_count, 1);
        assert_eq!(core.jump_count, 0, "空窗分支不走跳变丢弃");
    }

    #[test]
    fn tracking_accuracy_gate_and_jump_drop() {
        let mut core = spec::Core::new(600, 540, 0, 0.0);
        // 精度门：>30m 的 fix 丢弃，连参考点都不更新
        let o = core.on_fix(spec::Fix {
            t: spec::START_T,
            lat: spec::LAT0,
            lon: spec::LON0,
            acc: 80.0,
        });
        assert!(o.dropped && !o.accepted);
        let o = core.on_fix(spec::Fix {
            t: spec::START_T,
            lat: spec::LAT0,
            lon: spec::LON0,
            acc: 8.0,
        });
        assert!(o.accepted, "首个通过精度门的 fix 是轨迹起点");
        // 单跳 >dMax(40)：丢弃并计数
        let o = core.on_fix(spec::Fix {
            t: spec::START_T + 1000,
            lat: spec::move_lat(spec::LAT0, 100.0),
            lon: spec::LON0,
            acc: 8.0,
        });
        assert!(o.jumped && !o.accepted);
        assert_eq!(core.jump_count, 1);
        assert_eq!(core.dist_m, 0.0);
    }

    #[test]
    fn tracking_settle_auto_pause_credits_wall_clock() {
        let mut core = spec::Core::new(600, 540, 0, 0.0);
        let (run, after) = spec::run_fixes(spec::START_T, 1000, 20, 3.0, spec::LAT0);
        for f in run {
            core.on_fix(f);
        }
        let stand = spec::stand_fixes(
            spec::START_T + 20_000,
            1000,
            15,
            &spec::JITTER,
            spec::move_lat(after, -3.0),
        );
        for f in stand {
            core.on_fix(f);
        }
        assert!(core.auto_paused, "停跑后应进入自动暂停");
        let settle = core.settle_auto_pause(spec::START_T + 35_000);
        assert!(settle > 0);
        assert!(!core.auto_paused);
        assert_eq!(core.auto_pause_ms, settle);
        assert_eq!(core.auto_pause_count, 1);
    }
}
