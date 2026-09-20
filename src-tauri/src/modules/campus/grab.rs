//! 自动抢课引擎：**预设任务单 → 到点自动出手 → 没抢到按策略接着抢**。
//!
//! # 为什么这段逻辑必须在 Rust 里
//!
//! 抢课不是「点一下等结果」，是**跟时间赛跑**：窗口由教务处定时开放，开的那一刻几百人同时点。
//! 赢的条件只有两条 —— 出手够准（贴着开窗那一秒）、够有耐心（满员了就守着，等别人退）。
//! 这两件事都不能交给页面：
//!
//! - 页面会被切走、被系统回收、被 WebView 节流（后台标签页的定时器普遍降到 1 次/分钟），
//!   而**抢课恰恰发生在用户放下手机去干别的时候**；
//! - 用户可能提前一晚就把任务排好，第二天早上开机它得接着抢 —— 状态必须落库。
//!
//! 所以形状与 `modules/kb/worker.rs` 一致：一个进程内的后台线程 + 一张 SQLite 任务表 +
//! 一条推给前端的事件流。页面只是**显示器**，关掉页面不影响任何事。
//!
//! # 单线程 + 全局节流
//!
//! 引擎一轮只发一个请求（见 [`step`]），且所有请求共用一个最小间隔闸门
//! （[`GrabHub::pace`]）。并发提交在这里是负收益：对面是同一台教务服务器，
//! 并发既抢不到更多，又最容易触发风控，还会让「为什么被拒」变得无法解释。
//! 单线程 + 全局节流 = 请求速率完全可预测，这是能长期守着一个名额的前提。
//!
//! # 一个任务要过的关
//!
//! ```text
//! 等窗口（本机时钟 + 服务器偏差校正）
//!   └─ 开窗前 lead_ms 出手
//!        ├─ [占位模式] add-predicate（不花意愿值）→ 轮询 predicate-response
//!        └─ [直接模式] 跳过
//!        └─ add-request → 轮询 add-drop-response
//!             ├─ success    → 到手，收工
//!             ├─ needAttend → 时间冲突，需要人去网页端办免听
//!             └─ 失败       → 分级处理：满员就守着 / 未知就退避 / 明确了就停
//! ```
//!
//! # 几条不肯让步的鲁棒性规矩
//!
//! 1. **永不信任本机时钟。** 开火时刻一律用「教务墙上时间 − 实测偏差」换算（[`fire_at_ms`]）。
//!    学生电脑的时间经常偏几分钟，而窗口只开几小时 —— 偏了就是白等。
//! 2. **结果不明时先核对，再决定重投。** 轮询超了上限不等于失败：请求可能早就成功了，
//!    只是回执没回来。重投之前一定先用 `simplest-lessons` 看一眼这门课是不是已经在自己名下
//!    （[`reconcile_lost_request`]）—— 不然会把到手的名额当失败再抢一次。
//! 3. **换令牌不算失败。** 令牌过期是最常见的中途故障，换一张就能接着干，
//!    绝不能让它吃掉任务的重试次数。
//! 4. **窗口一关就收手。** 不靠「教务回一句选课已结束」来停手 —— 那句话的具体措辞
//!    我们没样本，赌不起。窗口闭区间是教务自己给的，用它。
//! 5. **崩溃重启能接着干。** 任务落在 `campus_grab_tasks`，启动时把 `running` 归位成
//!    「等一会再动」，并且**优先去核对上一次那张受理单**，而不是重新投一次。

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
use rusqlite::{Connection, Row};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{ReinError, Result};
use crate::state::{AppState, CampusHub};

use super::course_select::TOKEN_EXPIRED;
use super::matcher::{self, LessonHit};
use super::models::*;

/// 事件名：与前端 `campusService.onGrab` 的监听对应。
pub const GRAB_EVENT: &str = "campus://grab";

/// 没有任何任务时的轮询间隔。够慢，不浪费电。
const IDLE_WAIT_MS: i64 = 2000;
/// 有任务但不着急时的最大睡眠。太长了会让「刚入队一个任务」响应变钝。
const MAX_WAIT_MS: i64 = 5000;
/// 临近开火时的睡眠上限（进入 [`APPROACH_MS`] 之后用）
const APPROACH_WAIT_MS: i64 = 25;
/// 距开火多久算「临近」：这段时间内的睡眠要细，一秒里要能醒好几回。
const APPROACH_MS: i64 = 3000;
/// 探测完窗口之后的小憩。**只用于窗口探测那条路径** ——
/// 提交/轮询之后不再睡固定值，而是按节流闸门睡（见 `step` 末尾），
/// 否则「最小间隔」调得再小也会被这个固定值压住。
const BUSY_WAIT_MS: i64 = 30;
/// 服务器时间重采样间隔（毫秒）。偏差是缓变量，不必每轮都问。
const TIME_RESAMPLE_MS: i64 = 30_000;
/// 会话失效后的重试间隔：不硬停，而是隔一会再试一次 ——
/// 用户可能去「课表配置」重登了一下，引擎应当自己活过来。
const SESSION_RETRY_MS: i64 = 60_000;
/// 拿不到选课客户端（非会话问题）时的重试间隔
const CLIENT_RETRY_MS: i64 = 10_000;
/// 未知错误的最大连败次数。满员/繁忙这类**已知可重试**的不受此限，未知的不能无限撞。
const UNKNOWN_STRIKE_LIMIT: i64 = 8;
/// 去 `open-turns` 问「窗口公布了没有」的间隔。分钟级足够 ——
/// 窗口是教务处按分钟公布的，不是按毫秒。
const TURN_PROBE_MS: i64 = 60_000;
/// [`fire_at_ms`] 的「闸门未知」返回值：不是没有闸门，而是我们还不知道开窗时刻。
/// 用它把任务挡在门外，交给 [`probe_windows`] 去把时刻问出来。
const GATE_UNKNOWN: i64 = i64::MAX;
/// 教学班名单的缓存时长。解析计划与输入预览共用；名单是分钟级才变的东西。
const LESSON_CACHE_MS: i64 = 60_000;
/// 计划解析失败（批次没出现 / 名单拉不到 / 一个班都没匹配上）之后的重试间隔。
/// 比满员重试慢得多：这几件事都是分钟级才可能变。
const INTENT_RETRY_MS: i64 = 60_000;
/// 一条计划最多往界面带多少个候选教学班。查询写得很宽时（比如只敲了一个「学」）
/// 可能匹配上百个班，而快照是每秒都可能推一次的 —— 不能让一屏垃圾拖着事件流走。
const INTENT_CANDIDATE_CAP: usize = 12;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/* ─────────────────────────── 错误分级 ─────────────────────────── */

/// 一次失败该怎么对待。抢课引擎的全部「耐心」都集中在这个判断上。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 换张令牌接着干，**不计入尝试次数**
    TokenRefresh,
    /// 教务会话失效：引擎降速，并把它暴露到界面上等用户处理
    SessionLost,
    /// 时间冲突：必须人去教务网页端办免听，本地重试一万次也没用
    Conflict,
    /// 名额满了。名额释放是稀疏事件，值得一直守着，但节奏要慢。
    Full,
    /// 明确不会再成功（已选过 / 不在时段 / 无权限）。停止，别浪费对方带宽。
    Fatal,
    /// 一般性可重试：繁忙、超时、网络抖动、以及**认不出来的错误**。
    Retry,
}

impl Verdict {
    /// 落库用的短标识，同时是「同类连败」的比较键。
    fn kind(self) -> &'static str {
        match self {
            Verdict::TokenRefresh => "token",
            Verdict::SessionLost => "session",
            Verdict::Conflict => "conflict",
            Verdict::Full => "full",
            Verdict::Fatal => "fatal",
            Verdict::Retry => "retry",
        }
    }

    /// 这一类失败该不该重置「连败」计数。换令牌是引擎内务，与任务本身无关。
    fn resets_strikes(self) -> bool {
        matches!(self, Verdict::TokenRefresh)
    }
}

/// 教务的错误文案 → 应对方式。
///
/// **关键词顺序是有讲究的**：先判「满员」再判「已选过」，因为满员的文案里常常带「已选」
/// （「已选人数已达上限」）。反过来判的话，满员会被当成「已选过」直接停手 ——
/// 那是抢课里最贵的 bug：你以为在守着，其实早就放弃了。
///
/// 认不出来的一律按 [`Verdict::Retry`]（可重试）处理：抢课里误停的代价远大于多试几次，
/// 而「无限撞同一个未知错误」由 [`UNKNOWN_STRIKE_LIMIT`] 兜底。
pub fn verdict_of(message: &str) -> Verdict {
    let m = message.trim();
    if m.is_empty() {
        return Verdict::Retry;
    }
    if m.contains(TOKEN_EXPIRED) || m.contains("选课令牌") {
        return Verdict::TokenRefresh;
    }
    if m.contains("会话已过期") || m.contains("重新登录") || m.contains("登录已过期") {
        return Verdict::SessionLost;
    }

    // ① 满员（必须在「已选过」之前判）
    for kw in [
        "人数已满",
        "已满",
        "满员",
        "名额",
        "已达上限",
        "达到上限",
        "超出容量",
        "余量不足",
        "限选人数",
        "容量已",
    ] {
        if m.contains(kw) {
            return Verdict::Full;
        }
    }

    // ② 时间冲突（教务常在文案里直接说「免听」）
    for kw in ["免听", "时间冲突", "上课时间冲突", "冲突"] {
        if m.contains(kw) {
            return Verdict::Conflict;
        }
    }

    // ③ 明确不会再成功
    for kw in [
        "已经选过",
        "已选过",
        "已经选中",
        "已选中",
        "重复提交",
        "请不要重复",
        "不在选课时间",
        "选课时间已",
        "选课已结束",
        "未开放",
        "已结束",
        "没有权限",
        "无权限",
        "无权选",
        "禁止选",
        "不允许选",
        "学籍",
        "欠费",
        "未缴费",
        "已停开",
        "已撤销",
        "教学班不存在",
        "课程不存在",
        "培养方案",
    ] {
        if m.contains(kw) {
            return Verdict::Fatal;
        }
    }

    Verdict::Retry
}

/* ─────────────────────────── 墙上时间 ─────────────────────────── */

/// 教务墙钟文本 → 本机时区下的 unix 毫秒。
///
/// 只在**同一个参照系**里做差（服务器时间 vs 开窗时间），所以这里的时区选择无害：
/// 本机时区对这两个值的影响完全一致，做差时抵消。真正重要的是别把
/// 「教务墙上时间」直接当成「本机时间」去比 —— 那才会偏出时区差。
///
/// 教务的写法五花八门（秒可有可无、分隔符有 `-` `/` `年` 之分），所以先归一化再逐个格式试。
pub fn wall_to_ms(text: &str) -> Option<i64> {
    let cleaned = text
        .trim()
        .replace(['年', '月'], "-")
        .replace(['日', '号'], " ")
        .replace('：', ":")
        .replace('／', "/")
        .replace('T', " ");
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return None;
    }

    const DATETIME: &[&str] = &[
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S %z",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
    ];
    for fmt in DATETIME {
        if let Ok(dt) = NaiveDateTime::parse_from_str(&cleaned, fmt) {
            return Local
                .from_local_datetime(&dt)
                .single()
                .map(|d| d.timestamp_millis());
        }
    }
    // 只给了日期（如 `2026-09-17`）：按当天 00:00 处理
    const DATE: &[&str] = &["%Y-%m-%d", "%Y/%m/%d"];
    for fmt in DATE {
        if let Ok(d) = NaiveDate::parse_from_str(&cleaned, fmt) {
            return d
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| Local.from_local_datetime(&dt).single())
                .map(|d| d.timestamp_millis());
        }
    }
    None
}

/// 任务的开火时刻（本机 unix 毫秒）。
///
/// `skew_ms = 教务墙钟 − 本机时钟`（采样时测得），于是
/// `本机开火时刻 = 教务开窗时刻 − skew − lead`。
/// `lead` 是提前量：请求要在路上走一会，早一点出手才能让**请求本身**
/// 落在开窗那一瞬间，而不是排在开窗之后。
///
/// 返回 `None` = **没有窗口闸门**，任务完全由重试节奏支配。两种情况都算「已经出过手」：
/// 正式提交过（`attempts > 0`），或占位已经交过（`predicate_done`）——
/// 窗口闸门只管**第一枪**，打出去之后就不该再拿它挡路。
pub fn fire_at_ms(task: &GrabTask, skew_ms: i64, lead_ms: i64) -> Option<i64> {
    if task.attempts > 0 || task.predicate_done {
        return None;
    }
    match task.window_wall.as_deref() {
        Some(wall) => Some(wall_to_ms(wall)? - skew_ms - lead_ms),
        // 窗口还没公布：**不是「没有闸门」，是「闸门未知」**。
        // 这里若返回 None（= 立刻开火），任务会一头撞上「不在选课时间」被判终态，
        // 提前一晚的预设就白做了。挡住它，让 [`probe_windows`] 去把时刻问出来。
        None if task.await_window => Some(GATE_UNKNOWN),
        None => None,
    }
}

/// 窗口是否已经关闭。关闭之后无论多想要都不该再打教务 —— 那是纯粹的无用功。
pub fn window_closed(task: &GrabTask, skew_ms: i64) -> bool {
    match task.window_end_wall.as_deref().and_then(wall_to_ms) {
        Some(end) => now_ms() >= end - skew_ms,
        None => false,
    }
}

/* ─────────────────────────── 引擎 ─────────────────────────── */

/// 抢课引擎的把手：挂在 Tauri state 上，命令层通过它叫醒线程 / 读上次的故障。
#[derive(Default)]
pub struct GrabHub {
    wake: Mutex<Option<Sender<()>>>,
    /// 上一次推给前端的快照。内容没变就不重复推 —— 引擎每秒醒若干次，
    /// 不加这个闸门会把事件总线刷满。
    last_emit: Mutex<String>,
    last_error: Mutex<Option<String>>,
    /// 上一次真正发出请求的时刻（本机 ms）。**全局节流闸门**：
    /// 不管任务单上有几门课，打向教务的请求速率都由它唯一决定。
    last_request: AtomicI64,
    /// 教学班名单缓存（解析计划用）。见 [`GrabHub::lessons_cached`]。
    lessons: Mutex<Option<LessonCache>>,
}

/// 一份缓存下来的教学班名单。
struct LessonCache {
    turn_id: String,
    at: i64,
    lessons: Vec<CourseSelectLesson>,
    /// 「进批次」拿到的批次 id（提交体要用的那个），拿不到时为 None
    assoc: Option<String>,
}

impl GrabHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 叫醒引擎立刻重算（入队/取消/改设置后调它，界面因此是「即时」的）。
    pub fn notify(&self) {
        if let Ok(guard) = self.wake.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(());
            }
        }
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    fn set_error(&self, msg: Option<String>) {
        if let Ok(mut e) = self.last_error.lock() {
            *e = msg;
        }
    }

    /// 距下一次可发请求还有多久。0 = 现在就能发。
    fn pace_gap_ms(&self, min_interval_ms: i64) -> i64 {
        let last = self.last_request.load(Ordering::Relaxed);
        (min_interval_ms - (now_ms() - last)).max(0)
    }

    fn mark_request(&self) {
        self.last_request.store(now_ms(), Ordering::Relaxed);
    }

    /// 拿一个批次的教学班名单（60 秒缓存）。
    ///
    /// 「计划解析」与界面上的「输入预览」都要看**教务现在有哪些班**，所以两边共用这一份缓存：
    /// 名单是分钟级才变的东西，而人敲一次预览不该变成一次全量查询。
    ///
    /// 顺带把 `assoc`（提交体要用的批次 id）也带回来 —— 它同样是「进批次」才拿得到的，
    /// 而解析出来的任务马上要用，不想在开窗前那一秒再多一次往返。
    pub(crate) fn lessons_cached(
        &self,
        ctx: &super::commands::SelectContext,
        turn_id: &str,
    ) -> Result<(Vec<CourseSelectLesson>, Option<String>)> {
        if let Ok(guard) = self.lessons.lock() {
            if let Some(c) = guard.as_ref() {
                if c.turn_id == turn_id && now_ms() - c.at < LESSON_CACHE_MS {
                    return Ok((c.lessons.clone(), c.assoc.clone()));
                }
            }
        }

        let query = LessonQuery {
            has_count: Some(true),
            ..Default::default()
        };
        let lessons = match ctx.client.query_lesson(ctx.student_id, turn_id, &query) {
            Ok(l) => l,
            // 教务若在这个轮次的表单里没有 `hasCount`，整条查询可能被拒。
            // 名额只是排序的加分项 —— **宁可没有名额，也不能拿不到名单**。
            Err(e)
                if !matches!(
                    verdict_of(&e.to_string()),
                    Verdict::TokenRefresh | Verdict::SessionLost
                ) =>
            {
                ctx.client
                    .query_lesson(ctx.student_id, turn_id, &LessonQuery::default())?
            }
            Err(e) => return Err(e),
        };
        let assoc = ctx.client.turn_assoc(ctx.student_id, turn_id);

        if let Ok(mut guard) = self.lessons.lock() {
            *guard = Some(LessonCache {
                turn_id: turn_id.to_string(),
                at: now_ms(),
                lessons: lessons.clone(),
                assoc: Some(assoc.clone()),
            });
        }
        Ok((lessons, Some(assoc)))
    }

    /// 启动后台线程。与 `KbHub::start` 同形：先 manage 好状态再调它。
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let (tx, rx) = mpsc::channel::<()>();
        if let Ok(mut guard) = self.wake.lock() {
            *guard = Some(tx);
        }
        // 启动对账：上一次进程若在请求途中被杀，任务会停在 running。
        // 把它们归位成「稍后重试」，并按「先核对受理单」的顺序继续 —— 见模块头第 5 条。
        reconcile_on_start(&app);

        let hub = Arc::clone(self);
        std::thread::Builder::new()
            .name("rein-grab-engine".into())
            .spawn(move || worker_loop(app, hub, rx))
            .expect("启动抢课引擎线程失败");
    }
}

/// 启动对账：把中断的 running 任务放回队列。
///
/// **不重置 `request_id` / `polls`** —— 中断很可能发生在「刚刚提交成功、还没轮询到结果」
/// 之间，那张受理单可能已经把事情办了。留着它，下一步会先去核对。
fn reconcile_on_start(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        let _ = conn.execute(
            "UPDATE campus_grab_tasks SET status = 'waiting', phase = 'idle', next_at = ?1 \
             WHERE status = 'running'",
            [now_ms()],
        );
    }

    // 关机期间投进来的预定点也要落库 —— 开机就该接着抢，而不是等下一次心跳。
    // 锁要分开拿：`drain_intake` 自己会去锁库。
    let account_id = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        active_account_id(&conn).ok().flatten()
    };
    if let Some(id) = account_id {
        let _ = drain_intake(app, id);
    }
}

fn worker_loop(app: AppHandle, hub: Arc<GrabHub>, rx: mpsc::Receiver<()>) {
    loop {
        let wait = match step(&app, &hub) {
            Ok(w) => {
                if hub.last_error().is_some() {
                    hub.set_error(None);
                }
                w
            }
            Err(e) => {
                hub.set_error(Some(e.to_string()));
                // 引擎级故障也要让界面看到（例如任务表读不出来）
                emit(&app, &hub);
                Duration::from_millis(2000)
            }
        };
        // 有信号立刻醒；否则睡到下次该动的时候
        match rx.recv_timeout(wait) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// 引擎的一次心跳：算出「现在最该动哪个任务的哪一步」，做掉它，然后返回该睡多久。
///
/// **一轮只发一个请求**，且受 [`GrabHub::pace_gap_ms`] 的全局闸门约束。
fn step(app: &AppHandle, hub: &GrabHub) -> Result<Duration> {
    let state = app.state::<AppState>();

    // ── 短锁：读设置 + 账号。出了这个块就没有锁了。
    let (settings, account_id, probed_at) = {
        let conn = state.db.lock().unwrap();
        let settings = load_settings(&conn)?;
        let Some(account_id) = active_account_id(&conn)? else {
            // 没登录：静默待命，什么都不做（界面会提示去配置）
            return Ok(Duration::from_millis(IDLE_WAIT_MS as u64));
        };
        let probed = read_meta(&conn, PROBED_KEY).and_then(|s| s.parse::<i64>().ok());
        (settings, account_id, probed)
    };
    let probe_due = probed_at.map(|at| now_ms() - at >= TURN_PROBE_MS).unwrap_or(true);

    // ── 投递口：外部（开机监控脚本 / 人）投进来的抢课意图先落库，
    //    **落完再读任务** —— 这样这一轮就能把它当普通任务处理，不必等下一次心跳。
    if let Some(e) = drain_intake(app, account_id) {
        hub.set_error(Some(e));
    }
    let tasks = {
        let conn = state.db.lock().unwrap();
        load_active_tasks(&conn, account_id)?
    };

    let campus = app.state::<CampusHub>();

    // ── 窗口监听。**不再只在「有人排队等窗口」时才探测。**
    //    窗口开放前连该排什么课都不知道，而「窗口开了」这件事恰恰必须让
    //    没停在选课页面上的人也马上知道。所以只要账号在、开关开着，
    //    就每分钟安静地问一次 `open-turns`（照旧走全局节流，不额外加压）。
    let watching = settings.watch_window
        && (tasks.is_empty()
            || tasks.iter().any(|t| t.await_window && t.window_wall.is_none()));
    if watching && probe_due {
        hub.mark_request();
        let ctx = super::commands::select_context(&state.db, &campus);
        match ctx {
            Ok(ctx) => {
                if let Err(e) = probe_windows(&state, &ctx, &tasks) {
                    hub.set_error(Some(e.to_string()));
                }
            }
            Err(e) => return park_everything(app, hub, &state, &tasks, e.to_string()),
        }
        emit(app, hub);
        return Ok(Duration::from_millis(BUSY_WAIT_MS as u64));
    }

    // ── 计划解析：把「我想抢 高数 张」落成具体的教学班任务。
    //    **排在任务之前**：一条没解析的计划在任务单上一个字都没有，用户看到的是「没反应」；
    //    而解析只花一次名单查询（60 秒缓存），不该等任务都忙完才轮到它。
    //    与任务共用同一个节流闸门 —— 「一轮一个请求」这条规矩对解析同样成立。
    let due_intent = {
        let conn = state.db.lock().unwrap();
        load_due_intent(&conn, account_id, now_ms())?
    };
    if let Some(mut intent) = due_intent {
        let gap = hub.pace_gap_ms(settings.min_interval_ms);
        if gap > 0 {
            return Ok(Duration::from_millis(gap as u64));
        }
        hub.mark_request();
        match super::commands::select_context(&state.db, &campus) {
            // 账号对不上（用户切了账号）：计划留着给人看，但不动手
            Ok(ctx) if ctx.account_id != account_id => {}
            Ok(ctx) => {
                if let Err(e) = resolve_intent(&state, hub, &ctx, &mut intent) {
                    // 解析失败不判死计划：写一句能看懂的话，等下一次重试
                    let msg = e.to_string();
                    let status = if intent.status == INTENT_EMPTY {
                        INTENT_EMPTY
                    } else {
                        INTENT_PENDING
                    };
                    let _ = park_intent(&state, &mut intent, status, msg, INTENT_RETRY_MS);
                }
            }
            Err(e) => {
                let _ = park_intent(
                    &state,
                    &mut intent,
                    INTENT_PENDING,
                    e.to_string(),
                    INTENT_RETRY_MS,
                );
            }
        }
        emit(app, hub);
        return Ok(Duration::from_millis(
            hub.pace_gap_ms(settings.min_interval_ms).max(1) as u64,
        ));
    }

    if tasks.is_empty() {
        emit(app, hub);
        return Ok(Duration::from_millis(IDLE_WAIT_MS as u64));
    }

    // ── 服务器时钟偏差（缓变量，30 秒一次；网络失败就沿用旧值）
    let (skew_ms, _) = sample_clock(app, &state, &campus);

    // ── 挑一个「已经到点」的任务：谁最急先管谁
    let now = now_ms();
    let mut best: Option<(i64, usize)> = None;
    let mut soonest = i64::MAX;
    for (i, t) in tasks.iter().enumerate() {
        // 志愿组里还没轮到它：不出手，**也不参与「谁最急」** ——
        // 否则它会把自己算成 soonest，让引擎一直为它空醒。
        if !armed(t, &tasks, &settings, now) {
            continue;
        }
        let when = if window_closed(t, skew_ms) {
            // 窗口关了：立刻让它进入收尾，界面不该继续显示「在抢」
            now
        } else {
            fire_at_ms(t, skew_ms, settings.lead_ms)
                .unwrap_or(i64::MIN)
                .max(t.next_at)
        };
        if when <= now && best.map(|(k, _)| when < k).unwrap_or(true) {
            best = Some((when, i));
        }
        soonest = soonest.min(when.max(now));
    }

    let Some((_, idx)) = best else {
        // 都还没到点：睡到最近的那个时刻，但别超过 MAX_WAIT_MS
        let delta = (soonest - now).max(0);
        let wait = if delta <= APPROACH_MS {
            delta.clamp(APPROACH_WAIT_MS, 200)
        } else {
            delta.clamp(50, MAX_WAIT_MS)
        };
        emit(app, hub);
        return Ok(Duration::from_millis(wait as u64));
    };

    // ── 全局节流：最近发得太密就先歇一下，这是防封的主要旋钮
    let gap = hub.pace_gap_ms(settings.min_interval_ms);
    if gap > 0 {
        return Ok(Duration::from_millis(gap as u64));
    }

    // ── 无锁：拿选课客户端（缓存命中则零网络；未命中要去门户换令牌，约一秒）
    // 会话过期时 `select_context` 会自己静默重登一次 —— 抢课最怕的就是
    // 「人到齐了、窗口开了，结果会话掉了要等用户手动重登」。
    let ctx = match super::commands::select_context(&state.db, &campus) {
        Ok(c) => c,
        Err(e) => return park_everything(app, hub, &state, &tasks, e.to_string()),
    };

    // 账号对不上（例如用户切了账号）：旧任务留着给人看，但不动手
    if ctx.account_id != account_id {
        return Ok(Duration::from_millis(IDLE_WAIT_MS as u64));
    }

    // ── 无锁：执行一步
    let mut task = tasks[idx].clone();
    hub.mark_request();
    act(&ctx, &settings, &mut task, skew_ms);

    // 令牌被服务端拒了：**立刻清掉进程内的缓存**，否则下一轮还会拿着这张死令牌撞上去，
    // 而 `CampusHub::cached_select_token` 只看 JWT 的 exp —— 它不知道服务端已经不认了。
    if task.strike_kind.as_deref() == Some("token") {
        if let Ok(mut slot) = campus.select_token.lock() {
            *slot = None;
        }
    }

    // ── 短锁：写回。**写回前重新读一次状态** —— 用户在这一次网络往返里
    //    可能已经取消或暂停了这个任务，不能把结果盖回去让它复活。
    {
        let conn = state.db.lock().unwrap();
        let keep = match load_task(&conn, task.id)? {
            Some(c) => c.status != GRAB_PAUSED && c.status != GRAB_CANCELLED,
            None => false,
        };
        if keep {
            save_task(&conn, &task)?;
            // 中了就顺手收组。同组的备选与它是**互斥**的，继续抢下去只会
            // 多抢到一门时间冲突的课 —— 那正是志愿组要防的事。
            if task.status == GRAB_SUCCESS {
                let _ = close_group(&conn, &task)?;
            }
        }
    }

    emit(app, hub);
    // 干完活之后按**节流闸门**睡，而不是睡一个固定值。
    //
    // 这里原来是固定的 `BUSY_WAIT_MS`（30ms），等于把速率硬压在 ~33 次/秒 ——
    // 于是「最小间隔调成 10ms」在界面上看着生效、实际完全不起作用（最阴的那种谎）。
    // 闸门开着就只睡 1ms（把 CPU 让出去），闸门关着就睡够剩下的时间。
    Ok(Duration::from_millis(
        hub.pace_gap_ms(settings.min_interval_ms).max(1) as u64,
    ))
}

/// 去 `open-turns` 把「窗口什么时候开」问出来，填进那些还在等的任务。
///
/// 这一步是「提前预设」能成立的关键：教务处很少一次就把窗口时间给全，
/// 用户往往提前一晚就把课排好了。与其让任务去盲撞（撞出「不在选课时间」会被判终态），
/// 不如每分钟安静地问一次，拿到就转成精确开火。
fn probe_windows(
    state: &tauri::State<'_, AppState>,
    ctx: &super::commands::SelectContext,
    tasks: &[GrabTask],
) -> Result<()> {
    // 强制拉一次：这个调用点本来就是「到点了，去问一次」。
    // 计划解析走的是 [`turn_briefs`]，同一个一分钟内不会再打一遍教务。
    let briefs = fetch_turn_briefs(state, ctx)?;
    let conn = state.db.lock().unwrap();

    for t in tasks.iter().filter(|t| t.await_window && t.window_wall.is_none()) {
        let Some(brief) = briefs.iter().find(|b| b.id == t.turn_id) else {
            continue; // 批次还没出现在列表里，继续等
        };
        match (brief.window_start.as_deref(), brief.window_end.as_deref()) {
            // 窗口时间有了 → 转成精确开火
            (Some(open), end) => {
                conn.execute(
                    "UPDATE campus_grab_tasks SET window_wall = ?2, window_end_wall = ?3, \
                     await_window = 0, next_at = ?4, last_message = ?5 WHERE id = ?1",
                    rusqlite::params![
                        t.id,
                        open,
                        end,
                        now_ms(),
                        format!("已获知选课窗口：{open} 开放")
                    ],
                )?;
            }
            // 没有时间但允许进入 → 窗口就是现在开着的，立刻出手
            (None, _) if brief.allow_enter => {
                conn.execute(
                    "UPDATE campus_grab_tasks SET await_window = 0, next_at = ?2, \
                     last_message = ?3 WHERE id = ?1",
                    rusqlite::params![t.id, now_ms(), "选课窗口已开放，立即开抢"],
                )?;
            }
            // 批次在列表里但还没公布时间：继续等，把状态讲给用户听
            _ => {
                conn.execute(
                    "UPDATE campus_grab_tasks SET last_message = ?2 WHERE id = ?1",
                    rusqlite::params![t.id, "等待教务公布选课窗口"],
                )?;
            }
        }
    }
    Ok(())
}

/// 教务当前有哪些批次，**一分钟内复用上回的结果**。
///
/// 窗口监听与计划解析都要它，而「有哪些批次、窗口开没开」是分钟级才变的东西；
/// 两边各打一次只会让开窗那一分钟多出无谓的请求。
fn turn_briefs(
    state: &tauri::State<'_, AppState>,
    ctx: &super::commands::SelectContext,
) -> Result<Vec<GrabTurnBrief>> {
    let cached = {
        let conn = state.db.lock().unwrap();
        read_meta(&conn, PROBED_KEY)
            .and_then(|s| s.parse::<i64>().ok())
            .map(|at| (read_turns(&conn), at))
    };
    if let Some((briefs, at)) = cached {
        if now_ms() - at < TURN_PROBE_MS {
            return Ok(briefs);
        }
    }
    fetch_turn_briefs(state, ctx)
}

/// 真的去 `open-turns` 问一次，并把结果落库 —— 界面要显示「窗口开没开」，
/// 而这件事不该只活在某一轮心跳的内存里（关掉 App 再打开，它得还在）。
fn fetch_turn_briefs(
    state: &tauri::State<'_, AppState>,
    ctx: &super::commands::SelectContext,
) -> Result<Vec<GrabTurnBrief>> {
    let turns = ctx.client.open_turns(ctx.student_id)?;
    let briefs: Vec<GrabTurnBrief> = turns.iter().map(turn_brief).collect();
    {
        let conn = state.db.lock().unwrap();
        let _ = write_meta(
            &conn,
            TURNS_KEY,
            &serde_json::to_string(&briefs).unwrap_or_default(),
        );
        let _ = write_meta(&conn, PROBED_KEY, &now_ms().to_string());
    }
    Ok(briefs)
}

/// 拿不到选课客户端时：**不判死任何任务**，只把整批降速重排。
///
/// 会话失效是最好修的一种故障 —— 用户去「课表配置」重登一下就好，
/// 所以引擎该做的是隔一分钟再试，而不是把用户排了一晚上的任务单清空。
fn park_everything(
    app: &AppHandle,
    hub: &GrabHub,
    state: &tauri::State<'_, AppState>,
    tasks: &[GrabTask],
    message: String,
) -> Result<Duration> {
    let kind = verdict_of(&message);
    let delay = if kind == Verdict::SessionLost {
        SESSION_RETRY_MS
    } else {
        CLIENT_RETRY_MS
    };
    let until = now_ms() + delay;
    {
        let conn = state.db.lock().unwrap();
        for t in tasks {
            park(&conn, t, until, &message, kind)?;
        }
    }
    hub.set_error(Some(message));
    emit(app, hub);
    Ok(Duration::from_millis(delay.min(2000) as u64))
}

/// 执行一个任务的一步。就地修改 `task`（调用方负责落库）。
///
/// 一次调用 = 一个网络请求，要么轮询、要么提交。
fn act(ctx: &super::commands::SelectContext, settings: &GrabSettings, task: &mut GrabTask, skew_ms: i64) {
    // 窗口已关：收手，并说清为什么
    if window_closed(task, skew_ms) {
        finish(task, GRAB_FAILED, "选课窗口已关闭，未能抢到");
        return;
    }

    task.status = GRAB_RUNNING.into();
    task.queued_at.get_or_insert_with(now_ms);

    if task.phase == PHASE_POLL && task.request_id.is_some() {
        poll(ctx, settings, task);
    } else {
        submit(ctx, settings, task);
    }
}

/// 这一步该交占位，还是该交正式请求？
///
/// 抽成一个函数是因为它是**最容易写错的一处判断**：显式用 `predicate_done`，
/// 绝不可以用 `attempts == 0` 反推 —— 占位落定到正式提交之间 `attempts` 仍然是 0，
/// 那样的推断会让任务在「占位 → 轮询 → 占位」里打转，正式请求一辈子发不出去。
/// （真出过这个 bug，是 `scripts/e2e-auto-grab.mjs` 逮到的。）
fn needs_predicate(task: &GrabTask) -> bool {
    task.mode == "predicate" && !task.predicate_done
}

/// 提交一步：按模式决定先占位还是直接投。
fn submit(ctx: &super::commands::SelectContext, settings: &GrabSettings, task: &mut GrabTask) {
    let items = vec![AddItem {
        lesson_assoc: task.lesson_id.clone(),
        virtual_cost: task.virtual_cost,
        schedule_group_assoc: task.schedule_group_id.clone(),
        need_attend: None,
    }];
    // 提交类接口的批次 id 只在**请求体**里（路径上没有），且用的是「进批次」那个
    // （见 `GrabTask::turn_assoc`）。先拷出来，免得与后面的可变借用打架。
    let turn = task.turn_assoc().to_string();

    // ① 占位优先：开窗瞬间先占住队列位次（不花意愿值），落定后再正式确认。
    //    只交一次 —— 交过之后每次重试都直接投正式请求，
    //    否则每轮重试都要多打一个请求，白白拉长出手间隔。
    if needs_predicate(task) {
        match ctx
            .client
            .add_predicate(ctx.student_id, &turn, items, None)
        {
            Ok(rid) if !rid.is_empty() => {
                task.request_id = Some(rid);
                task.predicate_done = true;
                task.phase = PHASE_POLL.into();
                task.polls = 0;
                task.status = GRAB_RUNNING.into();
                task.last_message = Some("已占位，等待教务受理".into());
                task.next_at = now_ms() + settings.poll_interval_ms;
                task.strikes = 0;
                task.strike_kind = None;
                return;
            }
            Ok(_) => {
                // 占位没给受理号：没交上，下一轮再试
                task.next_at = now_ms();
                return;
            }
            Err(e) => return absorb_error(task, settings, e.to_string()),
        }
    }

    // ② 正式提交
    task.attempts += 1;
    match ctx.client.add_request(ctx.student_id, &turn, items, None) {
        Ok(rid) if !rid.is_empty() => {
            task.request_id = Some(rid);
            task.phase = PHASE_POLL.into();
            task.polls = 0;
            task.status = GRAB_RUNNING.into();
            task.last_message = Some(if task.attempts == 1 {
                "已提交，等待教务处理".into()
            } else {
                format!("第 {} 次提交，等待教务处理", task.attempts)
            });
            task.next_at = now_ms() + settings.poll_interval_ms;
            task.strikes = 0;
            task.strike_kind = None;
        }
        // 提交成功但没给受理号：无法跟踪，当作一次失败重新来过
        Ok(_) => absorb_error(
            task,
            settings,
            "提交未返回受理号，无法跟踪结果".to_string(),
        ),
        Err(e) => absorb_error(task, settings, e.to_string()),
    }
}

/// 轮询一步。占位阶段盯 `predicate-response`，正式提交盯 `add-drop-response`。
fn poll(ctx: &super::commands::SelectContext, settings: &GrabSettings, task: &mut GrabTask) {
    let rid = task.request_id.clone().unwrap_or_default();
    if rid.is_empty() {
        // 受理号丢了：回到提交那一步
        task.phase = PHASE_IDLE.into();
        task.next_at = now_ms();
        return;
    }
    // 手上这张是占位单还是正式单，取决于占位交没交过
    let is_predicate = needs_predicate(task);

    let raw = if is_predicate {
        ctx.client.predicate_response(ctx.student_id, &rid)
    } else {
        ctx.client.add_drop_response(ctx.student_id, &rid)
    };
    let raw = match raw {
        Ok(v) => v,
        Err(e) => return absorb_error(task, settings, e.to_string()),
    };

    // `data` 为空 = 服务端还在处理
    if raw.is_null() {
        task.polls += 1;
        if task.polls >= settings.max_polls {
            return reconcile_lost_request(ctx, task);
        }
        task.next_at = now_ms() + settings.poll_interval_ms;
        task.last_message = Some("教务处理中".into());
        return;
    }

    let r: CourseSelectResult = serde_json::from_value(raw).unwrap_or(CourseSelectResult {
        success: false,
        error_message: None,
        resend: false,
    });

    // 占位落定 → 立刻转正式确认。这是抢课里最要紧的一次衔接，不留间隔。
    if is_predicate && r.success {
        task.phase = PHASE_SUBMIT.into();
        task.request_id = None;
        task.polls = 0;
        task.next_at = now_ms();
        task.last_message = Some("占位成功，正在正式确认".into());
        task.strikes = 0;
        task.strike_kind = None;
        return;
    }

    if r.success {
        finish(task, GRAB_SUCCESS, "已抢到");
        task.request_id = None;
        return;
    }

    if r.resend {
        finish(
            task,
            GRAB_CONFLICT,
            "与已选课程时间冲突，需到教务网页端办理免听",
        );
        return;
    }

    let msg = r
        .error_message
        .and_then(|m| m.text)
        .unwrap_or_else(|| "教务未说明原因".into());
    absorb_error(task, settings, msg);
}

/// 「结果不明」的兜底：**先核对，再重投**。
///
/// 这是整个引擎里最要紧的一处保守：轮询超了上限只说明「我们没拿到回执」，
/// 不说明没选上。如果这时直接重投，可能把已经到手的名额当成失败再来一次，
/// 而教务对重复提交的反应（报错？还是又占一个？）我们没有样本。
///
/// 所以顺序永远是：先问一句「这门课现在在我名下吗」，是就收工，不是才重投。
fn reconcile_lost_request(ctx: &super::commands::SelectContext, task: &mut GrabTask) {
    if verify_picked(ctx, task).unwrap_or(false) {
        finish(task, GRAB_SUCCESS, "已抢到（受理结果未回，核对课表确认）");
        task.request_id = None;
        return;
    }
    // 确实没选上：清掉这张作废的受理单，重新投
    task.request_id = None;
    task.phase = PHASE_IDLE.into();
    task.polls = 0;
    task.next_at = now_ms();
    task.last_message = Some("受理结果长时间未返回，正在重新提交".into());
}

/// 这门课现在是不是已经在自己名下？用最轻的接口问，出错就当「不知道」。
///
/// 两个来源，**只在拿到正面证据时返回 true**：这个函数的结果决定「要不要重投」，
/// 把「不确定」说成「没选上」只是回到老路（重投一次），说成「选上了」却会漏掉一门课。
/// 所以宁可返回 false（= 不知道）也不要猜。
fn verify_picked(ctx: &super::commands::SelectContext, task: &GrabTask) -> Result<bool> {
    let want = task.lesson_id.to_string();
    let hits = |v: &serde_json::Value| {
        ["lessonId", "id", "lessonAssoc", "lesson_id"]
            .iter()
            .filter_map(|k| v.get(*k))
            .any(|x| x.to_string().trim_matches('"') == want)
    };

    // ① 首选 `selected-lessons` —— 它就是「我已选上的课」这份名单本身，最准也最便宜
    if let Ok(list) = ctx.client.selected_lessons(&task.turn_id, ctx.student_id) {
        if list.iter().any(hits) {
            return Ok(true);
        }
    }

    // ② 退一步：拉一遍教学班，看见 `selectedLesson` 非空也算数
    let lessons = ctx.client.simplest_lessons(&task.turn_id)?;
    Ok(lessons
        .iter()
        .any(|l| l.id == want && l.selected_lesson.is_some()))
}

/// 收尾：写终态、定时间戳。
fn finish(task: &mut GrabTask, status: &str, message: &str) {
    task.status = status.into();
    task.phase = PHASE_IDLE.into();
    task.finished_at = Some(now_ms());
    task.last_message = Some(message.into());
    // 进终态了，「连续满员了多久」这件事不再有读的人
    task.stuck_since = None;
}

/* ─────────────────────── 志愿组（互斥备选） ───────────────────────
 *
 * 同一个组里的课程是**备选**：时间冲突、或一轮只能选一门，所以只会中一个。
 *
 * 两条规矩：
 * 1. **一次只主攻一个** —— 组内 `(priority, id)` 最小的那个非终态成员。
 *    分散出手在这里是负收益：全局节流本来一轮只发一个请求，铺开只会让
 *    「最想要的那门」出手变慢，还可能先中了第二志愿、白丢第一志愿。
 * 2. **中选即收组** —— 有人中了，同组其余立刻取消。这是「不会同时抢到两门
 *    冲突课」的唯一保证，也是志愿组存在的理由。
 *
 * 「当前志愿」**不是状态机**，而是每轮从任务表现算出来的派生量：第一志愿一进终态，
 * 第二志愿下一轮自动成为当前志愿。少一处要同步的中间状态，就少一处能跑偏的地方。
 */

/// 任务所属的志愿组（空串/空白按「不在组里」处理）。
fn group_of(t: &GrabTask) -> Option<&str> {
    t.group_key.as_deref().map(str::trim).filter(|g| !g.is_empty())
}

/// 是否已经「让贤」：连续满员超过了期限。
///
/// `cede_after_ms == 0`（默认）时**恒为 false** —— 那正是「死守当前志愿」：
/// 只有它进终态或窗口关闭才轮到下一个。设成 >0 才会因满员而让位。
fn has_ceded(t: &GrabTask, settings: &GrabSettings, now: i64) -> bool {
    if settings.cede_after_ms <= 0 {
        return false;
    }
    t.stuck_since.is_some_and(|since| now - since >= settings.cede_after_ms)
}

/// 组里的**当前志愿**：还没结束的成员里 `(priority, id)` 最小的那个。
fn group_lead<'a>(
    group: &str,
    tasks: &'a [GrabTask],
    settings: &GrabSettings,
    now: i64,
) -> Option<&'a GrabTask> {
    let alive: Vec<&GrabTask> = tasks
        .iter()
        .filter(|t| group_of(t) == Some(group))
        .filter(|t| !grab_is_terminal(&t.status) && t.status != GRAB_PAUSED)
        .collect();
    if alive.is_empty() {
        return None;
    }
    // 先挑没让贤的；整组都让贤了（罕见）就退回纯志愿序 —— 否则整组会僵住，谁都不出手
    alive
        .iter()
        .copied()
        .filter(|t| !has_ceded(t, settings, now))
        .min_by_key(|t| (t.priority, t.id))
        .or_else(|| alive.iter().copied().min_by_key(|t| (t.priority, t.id)))
}

/// 这个任务现在轮得到出手吗？不在组里的一律轮得到。
fn armed(t: &GrabTask, tasks: &[GrabTask], settings: &GrabSettings, now: i64) -> bool {
    let Some(g) = group_of(t) else { return true };
    group_lead(g, tasks, settings, now).is_some_and(|lead| lead.id == t.id)
}

/// 同组有人中了：把其余还没结束的成员收摊。返回收掉的行数。
fn close_group(conn: &Connection, winner: &GrabTask) -> Result<usize> {
    let Some(g) = group_of(winner) else { return Ok(0) };
    let who = winner
        .course_name
        .clone()
        .or_else(|| winner.lesson_name.clone())
        .unwrap_or_else(|| "同组课程".into());
    let msg = format!("已被第 {} 志愿「{}」抢先", winner.priority, who);
    let n = conn.execute(
        "UPDATE campus_grab_tasks SET status = ?3, phase = ?4, finished_at = ?5, last_message = ?6 \
         WHERE group_key = ?1 AND id <> ?2 \
           AND status NOT IN ('success','failed','conflict','cancelled')",
        rusqlite::params![g, winner.id, GRAB_CANCELLED, PHASE_IDLE, now_ms(), msg],
    )?;
    Ok(n)
}

/* ─────────────────────── 计划（意向） ───────────────────────
 *
 * 计划回答「我想抢什么」，任务回答「正在抢哪个教学班」。中间那次翻译就是
 * [`resolve_intent`]：拿**当时**的教学班名单做模糊匹配 → 命中的班按抢课语义排序 →
 * 排成志愿组任务。
 *
 * 三条不肯让步的性质：
 *
 * 1. **可以还没有批次**。提前一晚写下「高数 张」时，教务可能连批次都没公布。
 *    计划照样落库，等名单拉得到的那一刻自己解析（每分钟试一次）。
 * 2. **解析看的是当时的名单**。哪个班还有空位是开窗那一刻才知道的事；
 *    预先抄下来的 `lessonAssoc` 赌的是「名单没变过」，那是拿抢课去赌。
 * 3. **生成的仍是普通任务**。解析不是另一条提交链路，它只写 `campus_grab_tasks`——
 *    后面怎么抢、怎么退避、怎么换令牌，全归已有的任务引擎管。
 */

/// 把命中按「志愿组」分堆。
///
/// - `spread = false`（默认）：所有命中合成一堆，只中一个。「任意一个班都行」就该是这个
///   语义 —— 多抢到一门时间冲突的课，比没抢到更麻烦。
/// - `spread = true`：按课程分堆 —— 每门课各抢一个班（同一门课的多个班仍互斥），
///   课程之间互不影响。适合「查询写得很宽、但我确实每门都要」。
///
/// 已选过的班一律排除：引擎不该再对已经在名下的课动手。
pub fn plan_groups(hits: &[LessonHit], spread: bool) -> Vec<Vec<LessonHit>> {
    let grabbable: Vec<LessonHit> = hits
        .iter()
        .filter(|h| h.lesson.selected_lesson.is_none())
        .cloned()
        .collect();
    if !spread {
        return if grabbable.is_empty() { Vec::new() } else { vec![grabbable] };
    }
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<LessonHit>> = HashMap::new();
    for h in grabbable {
        let key = course_key(&h.lesson);
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(h);
    }
    order.into_iter().filter_map(|k| buckets.remove(&k)).collect()
}

/// 分堆用的课程身份：课程代码优先，退化到课程名，再退化到教学班 id。
///
/// **不能拿教学班 id 当第一选择** —— 那是「班」的身份，用它分堆等于每班一堆，
/// 而 spread 的全部意义正是「同一门课的多个班只中一个」。
fn course_key(l: &CourseSelectLesson) -> String {
    let course = l.course.as_ref();
    course
        .and_then(|c| c.code.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            course
                .and_then(|c| c.name_zh.clone())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| matcher::id_text(&l.id))
}

/// 上课小组：教务只给**一个**可选组时直接指定它（与抢课抽屉里的默认一致），
/// 多组时交给教务的默认值 —— 「抢哪个组」这件事我们没有比它更靠谱的判据。
fn schedule_group_of(l: &CourseSelectLesson) -> Option<Value> {
    match l.schedule_groups.as_slice() {
        [only] => Some(only.id.clone()).filter(|v| !v.is_null()),
        _ => None,
    }
}

/// 计划的目标批次：计划指定的优先；没指定就用教务当前开放的那个。
///
/// 指定的那个不在列表里就返回 None，**绝不自动换一个批次** ——
/// 「我排的是 A 轮，引擎跑去 B 轮抢」比抢不到更难查。
fn pick_turn(want: Option<&str>, briefs: &[GrabTurnBrief]) -> Option<GrabTurnBrief> {
    match want.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => briefs.iter().find(|b| b.id == id).cloned(),
        None => briefs
            .iter()
            .find(|b| b.allow_enter)
            .or_else(|| briefs.first())
            .cloned(),
    }
}

/// 目标批次（缓存优先）。计划解析与界面上的「预览」都从这一步起步 ——
/// 两边必须挑到同一个批次，否则预览里看到的班和真抢的班不是一回事。
pub(crate) fn resolve_turn(
    state: &tauri::State<'_, AppState>,
    ctx: &super::commands::SelectContext,
    want: Option<&str>,
) -> Result<Option<GrabTurnBrief>> {
    Ok(pick_turn(want, &turn_briefs(state, ctx)?))
}

/// 解析一条计划。引擎每轮心跳最多做一条（见 [`step`]），所以这里可以放心是一次完整流程。
///
/// 任何「现在做不了」都走 [`park_intent`]：记一句能看懂的话 + 定个重试时刻，**绝不删计划**。
fn resolve_intent(
    state: &tauri::State<'_, AppState>,
    hub: &GrabHub,
    ctx: &super::commands::SelectContext,
    intent: &mut GrabIntent,
) -> Result<()> {
    intent.attempts += 1;

    let briefs = turn_briefs(state, ctx)?;
    let Some(brief) = pick_turn(intent.turn_id.as_deref(), &briefs) else {
        return park_intent(
            state,
            intent,
            INTENT_PENDING,
            "还没看到这个选课批次，教务公布后会自动继续".into(),
            INTENT_RETRY_MS,
        );
    };
    intent.turn_id = Some(brief.id.clone());
    intent.turn_name = brief.name.clone();

    // 窗口已经过去的批次不再解析：解析出来也只会立刻落进「窗口已关闭」的终态。
    // 关门判断不校时钟偏差 —— 差几秒对「今天还抢不抢」没有影响。
    if let Some(end) = brief.window_end.as_deref().and_then(wall_to_ms) {
        if now_ms() >= end {
            let who = brief.name.clone().unwrap_or_else(|| brief.id.clone());
            return park_intent(
                state,
                intent,
                INTENT_PENDING,
                format!("批次「{who}」的选课窗口已经结束"),
                INTENT_RETRY_MS * 10,
            );
        }
    }

    let (lessons, assoc) = hub.lessons_cached(ctx, &brief.id)?;
    let hits = matcher::match_lessons(&intent.query, &lessons);
    // 打全了老师名字 → 那是指定，只抢他的班；只打姓 / 打错字 → 模糊匹配照旧（见 `preferred`）
    let pool = matcher::preferred(&hits);
    let picked_off = hits.len().saturating_sub(pool.len());
    let groups = plan_groups(&pool, intent.spread);
    if groups.is_empty() {
        let why = if hits.is_empty() {
            format!(
                "没匹配到「{}」—— 课名 / 课程代码 / 教师名都可以，空格分词",
                intent.query
            )
        } else {
            "匹配到的教学班都已经在你名下了".to_string()
        };
        return park_intent(state, intent, INTENT_EMPTY, why, INTENT_RETRY_MS);
    }

    // 窗口与开火判据与 `probe_windows` 保持一致：有精确区间就用区间；
    // 没有区间但「允许进入」就是窗口正开着（立刻出手）；都没有就等窗口公布。
    let (window, window_end, await_window) = match brief.window_start.as_deref() {
        Some(start) if !start.trim().is_empty() => {
            (Some(start.trim().to_string()), brief.window_end.clone(), false)
        }
        _ if brief.allow_enter => (None, None, false),
        _ => (None, None, true),
    };

    // 建任务。**短锁里只做写**：名单与匹配都在锁外算完了。
    let (created, keys) = {
        let conn = state.db.lock().unwrap();
        let mut created = 0usize;
        let mut keys: Vec<String> = Vec::new();
        for (gi, group) in groups.iter().enumerate() {
            // 一条计划生成的组用 `intent-{id}` 起头：界面靠它把任务归到计划名下
            let key = if groups.len() == 1 {
                format!("intent-{}", intent.id)
            } else {
                format!("intent-{}-{}", intent.id, gi + 1)
            };
            let name = if intent.spread {
                group.first().and_then(|h| matcher::course_name_of(&h.lesson))
            } else {
                None
            }
            .unwrap_or_else(|| intent.query.clone());

            let mut made = false;
            for (i, h) in group.iter().enumerate() {
                // 同一门课已经在抢了就别再来一条 —— 与投递口用的是同一套幂等判据
                let lid = json_to_col(&h.lesson.id);
                if active_task_exists(&conn, ctx.account_id, &brief.id, &lid) {
                    continue;
                }
                let input = GrabTargetInput {
                    lesson_id: h.lesson.id.clone(),
                    lesson_name: None,
                    course_name: matcher::course_name_of(&h.lesson),
                    course_code: h.lesson.course.as_ref().and_then(|c| c.code.clone()),
                    teacher: matcher::teacher_text(&h.lesson),
                    credits: h.lesson.course.as_ref().and_then(|c| c.credits),
                    virtual_cost: None,
                    schedule_group_id: schedule_group_of(&h.lesson),
                    group_key: Some(key.clone()),
                    group_name: Some(name.clone()),
                    priority: (i + 1) as i64,
                };
                let id = insert_task(
                    &conn,
                    ctx.account_id,
                    &brief.id,
                    brief.name.as_deref(),
                    &input,
                    &intent.mode,
                    window.as_deref(),
                    window_end.as_deref(),
                )?;
                if let Some(a) = assoc.as_deref() {
                    let _ = set_turn_assoc(&conn, id, a);
                }
                if await_window {
                    let _ = conn.execute(
                        "UPDATE campus_grab_tasks SET await_window = 1, last_message = ?2 WHERE id = ?1",
                        rusqlite::params![id, "等待教务公布选课窗口"],
                    );
                }
                made = true;
                created += 1;
            }
            if made {
                keys.push(key);
            }
        }
        (created, keys)
    };

    intent.status = INTENT_READY.into();
    intent.group_keys = keys;
    // 候选清单只列**真会抢的**那些班：被「指定老师」筛掉的不列出来，
    // 否则用户会问「为什么预览里有它、任务单里没有」。
    intent.candidates = pool
        .iter()
        .take(INTENT_CANDIDATE_CAP)
        .map(matcher::to_match)
        .collect();
    intent.resolved_at = Some(now_ms());
    intent.next_at = now_ms();
    let hidden = pool.len().saturating_sub(INTENT_CANDIDATE_CAP);
    let tail = if hidden > 0 {
        format!("（另有 {hidden} 个匹配未列出）")
    } else {
        String::new()
    };
    // 指定了老师就明说一句 —— 用户下次看到这条计划时，「只抢张伟的班」是解释而不是意外
    let by_teacher = if picked_off > 0 {
        format!("，只抢指定教师的班（另有 {picked_off} 个匹配被滤掉）")
    } else {
        String::new()
    };
    intent.last_message = Some(if created == 0 {
        "这些教学班都已经在抢了".to_string()
    } else if groups.len() > 1 {
        format!(
            "已为 {} 门课各排一组，共 {created} 个志愿{by_teacher}{tail}",
            groups.len()
        )
    } else {
        format!("已排入 {created} 个志愿，按序出手{by_teacher}{tail}")
    });

    let conn = state.db.lock().unwrap();
    save_intent(&conn, intent)
}

/// 把一条计划挂起：说清为什么、定好下次什么时候再试。**不删计划** ——
/// 用户排的是明天早上的事，「现在看不到批次」根本不算失败。
fn park_intent(
    state: &tauri::State<'_, AppState>,
    intent: &mut GrabIntent,
    status: &str,
    message: String,
    delay_ms: i64,
) -> Result<()> {
    intent.status = status.to_string();
    intent.last_message = Some(message);
    intent.next_at = now_ms() + delay_ms;
    let conn = state.db.lock().unwrap();
    save_intent(&conn, intent)
}

/// 把一次错误吸收进任务状态：分级 → 定下一次动作 → 必要时判死。
fn absorb_error(task: &mut GrabTask, settings: &GrabSettings, message: String) {
    let verdict = verdict_of(&message);
    task.last_message = Some(message);
    task.request_id = None;
    task.phase = PHASE_IDLE.into();

    if verdict.resets_strikes() {
        task.strikes = 0;
        task.strike_kind = None;
    } else if task.strike_kind.as_deref() == Some(verdict.kind()) {
        // 同类连败才累加；换了种类说明局面变了，重新给耐心
        task.strikes += 1;
    } else {
        task.strikes = 1;
        task.strike_kind = Some(verdict.kind().into());
    }

    // 「连续满员了多久」——只有让贤期限读它。满员是**持续**状态（要等别人退课），
    // 所以记下起点；换成别的失败种类就清零：一直满员和一直未知错误是两种耐心。
    if verdict == Verdict::Full {
        task.stuck_since.get_or_insert_with(now_ms);
    } else {
        task.stuck_since = None;
    }

    match verdict {
        // 换令牌是一次**引擎内务**，不是这个任务的失败 —— 下一轮令牌就换好了
        Verdict::TokenRefresh | Verdict::SessionLost => {
            task.status = GRAB_WAITING.into();
            task.next_at = now_ms() + 1500;
        }
        Verdict::Full => {
            task.status = GRAB_WAITING.into();
            task.next_at = now_ms() + settings.full_retry_ms;
        }
        Verdict::Conflict => finish(task, GRAB_CONFLICT, &task.last_message.clone().unwrap_or_default()),
        Verdict::Fatal => finish(task, GRAB_FAILED, &task.last_message.clone().unwrap_or_default()),
        Verdict::Retry => {
            // 未知错误不能无限撞：连败到上限就交给用户看原始文案
            if task.strikes >= UNKNOWN_STRIKE_LIMIT {
                let m = task.last_message.clone().unwrap_or_default();
                finish(
                    task,
                    GRAB_FAILED,
                    &format!("连续 {UNKNOWN_STRIKE_LIMIT} 次未成功：{m}"),
                );
                return;
            }
            let backoff = settings
                .backoff_ms
                .saturating_mul(1i64 << task.strikes.min(6))
                .min(settings.max_backoff_ms);
            task.status = GRAB_WAITING.into();
            task.next_at = now_ms() + backoff;
        }
    }

    if settings.max_attempts > 0 && task.attempts >= settings.max_attempts {
        let m = task.last_message.clone().unwrap_or_default();
        finish(task, GRAB_FAILED, &format!("已达提交上限 {} 次：{m}", settings.max_attempts));
    }
}

/// 采样「教务墙上时间 − 本机时钟」，返回 `(偏差毫秒, 服务器时间文本)`。
///
/// 偏差缓变，所以 30 秒才问一次；问不到就沿用上次的值（首次问不到则为 0，
/// 退化成「按本机时钟开火」——不理想，但比不开火强）。
///
/// **不返回 Result**：时钟采样失败绝不该让整轮心跳失败。
fn sample_clock(
    _app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    campus: &tauri::State<'_, CampusHub>,
) -> (i64, Option<String>) {
    let cached: Option<(i64, String)> = {
        let conn = state.db.lock().unwrap();
        read_meta(&conn, CLOCK_KEY).and_then(|s| serde_json::from_str(&s).ok())
    };
    if let Some((at, text)) = cached.as_ref() {
        if let Some(skew) = compute_skew(text, *at) {
            if now_ms() - at < TIME_RESAMPLE_MS {
                return (skew, Some(text.clone()));
            }
            // 过期了：重采一次，失败也还能用这个旧值兜底
            return match resample(state, campus) {
                Some((fresh, fresh_text)) => (fresh, Some(fresh_text)),
                None => (skew, Some(text.clone())),
            };
        }
    }
    match resample(state, campus) {
        Some((fresh, text)) => (fresh, Some(text)),
        None => (0, None),
    }
}

/// 偏差 = 把服务器时间文本当成**本机墙上时间**，与本机此刻的差。
/// 这样两边在同一个参照系里做差，时区差被自动吸收。
fn compute_skew(server_text: &str, sampled_at_ms: i64) -> Option<i64> {
    wall_to_ms(server_text).map(|wall| wall - sampled_at_ms)
}

fn resample(
    state: &tauri::State<'_, AppState>,
    campus: &tauri::State<'_, CampusHub>,
) -> Option<(i64, String)> {
    let at = now_ms();
    // `select_context` 自己安排锁的边界：换令牌 / 必要时重登的网络全在锁外
    let ctx = super::commands::select_context(&state.db, campus).ok()?;
    let text = ctx.client.server_time().ok()?;
    let skew = compute_skew(&text, at).unwrap_or(0);
    if let Ok(conn) = state.db.lock() {
        let _ = write_meta(
            &conn,
            CLOCK_KEY,
            &serde_json::to_string(&(at, &text)).unwrap_or_default(),
        );
    }
    Some((skew, text))
}

/* ─────────────────────────── 持久化 ─────────────────────────── */

const CLOCK_KEY: &str = "campus_grab_clock";
const SETTINGS_KEY: &str = "campus_grab_settings";
/// 窗口监听的最近结果（批次摘要），供界面显示「窗口开没开」。
const TURNS_KEY: &str = "campus_grab_turns";
/// 最近一次窗口探测的时刻（本机 ms）
const PROBED_KEY: &str = "campus_grab_probed_at";

const TASK_COLS: &str = "id, turn_id, turn_name, lesson_id, lesson_name, course_name, course_code, \
     teacher, credits, mode, virtual_cost, schedule_group_id, window_wall, window_end_wall, \
     await_window, predicate_done, status, phase, attempts, polls, strikes, strike_kind, request_id, \
     last_message, next_at, queued_at, finished_at, turn_assoc, \
     group_key, group_name, priority, stuck_since";

fn json_to_col(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

/// 库里存的是 JSON 文本，但**教学班 id 是数字时要还原成数字**：
/// 教务回 `317844` 而我们发 `"317844"` 是两种东西，`lessonAssoc` 类型不对会被拒。
fn col_to_json(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!(s))
}

fn task_row(r: &Row<'_>) -> rusqlite::Result<GrabTask> {
    let lesson_raw: String = r.get(3)?;
    let group_raw: Option<String> = r.get(11)?;
    Ok(GrabTask {
        id: r.get(0)?,
        turn_id: r.get(1)?,
        turn_name: r.get(2)?,
        lesson_id: col_to_json(&lesson_raw),
        lesson_name: r.get(4)?,
        course_name: r.get(5)?,
        course_code: r.get(6)?,
        teacher: r.get(7)?,
        credits: r.get(8)?,
        mode: r.get(9)?,
        virtual_cost: r.get(10)?,
        schedule_group_id: group_raw.map(|s| col_to_json(&s)),
        window_wall: r.get(12)?,
        window_end_wall: r.get(13)?,
        await_window: r.get::<_, i64>(14)? != 0,
        predicate_done: r.get::<_, i64>(15)? != 0,
        status: r.get(16)?,
        phase: r.get(17)?,
        attempts: r.get(18)?,
        polls: r.get(19)?,
        strikes: r.get(20)?,
        strike_kind: r.get(21)?,
        request_id: r.get(22)?,
        last_message: r.get(23)?,
        next_at: r.get(24)?,
        // 派生值，不落库 —— 由 `snapshot` 按时钟偏差算好后填上
        fire_at: None,
        queued_at: r.get(25)?,
        finished_at: r.get(26)?,
        turn_assoc: r.get(27)?,
        group_key: r.get(28)?,
        group_name: r.get(29)?,
        priority: r.get(30)?,
        stuck_since: r.get(31)?,
        // 派生值，不落库 —— 由 `snapshot` 按同组的志愿序算出来后填上
        held_by: None,
    })
}

fn load_task(conn: &Connection, id: i64) -> Result<Option<GrabTask>> {
    let sql = format!("SELECT {TASK_COLS} FROM campus_grab_tasks WHERE id = ?1");
    match conn.query_row(&sql, [id], task_row) {
        Ok(t) => Ok(Some(t)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReinError::from(e)),
    }
}

/// 全部任务：未结束的排在前面，再按入队时间倒序（界面上「正在抢的」永远在最上面）。
pub fn load_tasks(conn: &Connection, account_id: i64) -> Result<Vec<GrabTask>> {
    let sql = format!(
        "SELECT {TASK_COLS} FROM campus_grab_tasks WHERE account_id = ?1 \
         ORDER BY CASE WHEN status IN ('success','failed','conflict','cancelled') THEN 1 ELSE 0 END, \
         id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id], task_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 引擎关心的任务：非终态、非暂停。
fn load_active_tasks(conn: &Connection, account_id: i64) -> Result<Vec<GrabTask>> {
    let sql = format!(
        "SELECT {TASK_COLS} FROM campus_grab_tasks \
         WHERE account_id = ?1 AND status IN ('waiting','running') ORDER BY next_at ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id], task_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn active_account_id(conn: &Connection) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM campus_accounts WHERE active = 1 ORDER BY updated_at DESC LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .ok())
}

pub fn save_task(conn: &Connection, t: &GrabTask) -> Result<()> {
    conn.execute(
        "UPDATE campus_grab_tasks SET turn_name = ?2, lesson_name = ?3, course_name = ?4, \
         course_code = ?5, teacher = ?6, credits = ?7, mode = ?8, virtual_cost = ?9, \
         schedule_group_id = ?10, window_wall = ?11, window_end_wall = ?12, await_window = ?13, \
         predicate_done = ?14, status = ?15, phase = ?16, attempts = ?17, polls = ?18, \
         strikes = ?19, strike_kind = ?20, request_id = ?21, last_message = ?22, next_at = ?23, \
         queued_at = ?24, finished_at = ?25, turn_assoc = ?26, group_key = ?27, group_name = ?28, \
         priority = ?29, stuck_since = ?30 WHERE id = ?1",
        rusqlite::params![
            t.id,
            t.turn_name,
            t.lesson_name,
            t.course_name,
            t.course_code,
            t.teacher,
            t.credits,
            t.mode,
            t.virtual_cost,
            t.schedule_group_id.as_ref().map(json_to_col),
            t.window_wall,
            t.window_end_wall,
            t.await_window as i64,
            t.predicate_done as i64,
            t.status,
            t.phase,
            t.attempts,
            t.polls,
            t.strikes,
            t.strike_kind,
            t.request_id,
            t.last_message,
            t.next_at,
            t.queued_at,
            t.finished_at,
            t.turn_assoc,
            t.group_key,
            t.group_name,
            t.priority,
            t.stuck_since,
        ],
    )?;
    Ok(())
}

/// 「稍后再试」：定下次时刻、记原因，并顺手维护连败计数（同类才累加）。
fn park(
    conn: &Connection,
    task: &GrabTask,
    next_at: i64,
    message: &str,
    kind: Verdict,
) -> Result<()> {
    let same = task.strike_kind.as_deref() == Some(kind.kind());
    let strikes = if kind.resets_strikes() {
        0
    } else if same {
        task.strikes + 1
    } else {
        1
    };
    conn.execute(
        "UPDATE campus_grab_tasks SET status = ?2, phase = ?3, next_at = ?4, last_message = ?5, \
         strike_kind = ?6, strikes = ?7 WHERE id = ?1",
        rusqlite::params![
            task.id,
            GRAB_WAITING,
            PHASE_IDLE,
            next_at,
            message,
            kind.kind(),
            strikes
        ],
    )?;
    Ok(())
}

/// 入队。
///
/// `window_wall` 为 `None` 即「还不知道窗口什么时候开」—— 这种任务会被标成
/// `await_window`，由引擎每分钟去问一次，**而不是立刻开火**（理由见 [`fire_at_ms`]）。
#[allow(clippy::too_many_arguments)]
pub fn insert_task(
    conn: &Connection,
    account_id: i64,
    turn_id: &str,
    turn_name: Option<&str>,
    input: &GrabTargetInput,
    mode: &str,
    window_wall: Option<&str>,
    window_end_wall: Option<&str>,
) -> Result<i64> {
    let now = now_ms();
    let await_window = i64::from(window_wall.is_none());
    conn.execute(
        "INSERT INTO campus_grab_tasks (account_id, turn_id, turn_name, lesson_id, lesson_name, \
         course_name, course_code, teacher, credits, mode, virtual_cost, schedule_group_id, \
         window_wall, window_end_wall, await_window, predicate_done, status, phase, next_at, queued_at, \
         group_key, group_name, priority) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16, ?17, ?18, ?18, \
         ?19, ?20, ?21)",
        rusqlite::params![
            account_id,
            turn_id,
            turn_name,
            json_to_col(&input.lesson_id),
            input.lesson_name,
            input.course_name,
            input.course_code,
            input.teacher,
            input.credits,
            mode,
            input.virtual_cost,
            input.schedule_group_id.as_ref().map(json_to_col),
            window_wall,
            window_end_wall,
            await_window,
            GRAB_WAITING,
            PHASE_IDLE,
            now,
            input.group_key,
            input.group_name,
            input.priority,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/* ─────────────────────────── 投递口 ───────────────────────────
 *
 * 外部（开机监控脚本、或人）把「想抢什么」写成 JSON 放在 App 数据目录下的
 * `campus_intake.json`，引擎每轮心跳开头把它落库。
 *
 * 为什么要一个文件，而不是让脚本直接写 SQLite：任务表的列会继续长
 * （0022 → 0023 → 0027…），在 JS 里抄一份列名就是等着腐烂。**App 是唯一写者**，
 * 脚本只投递意图 —— 它也就不必知道 `next_at` / `phase` / `await_window` 这些内务。
 */

const INTAKE_FILE: &str = "campus_intake.json";
const INTAKE_DONE: &str = "campus_intake.done.json";

/// 投递的一批：一门课的若干教学班（互为志愿）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntakeBatch {
    turn_id: String,
    #[serde(default)]
    turn_name: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    window_wall: Option<String>,
    #[serde(default)]
    window_end_wall: Option<String>,
    #[serde(default)]
    targets: Vec<GrabTargetInput>,
}

/// 同一 (批次, 教学班) 是否已经有一条还没结束的任务。
///
/// 投递口是个文件，同一份内容被投两次太容易了（脚本重跑、人手动再投一遍），
/// 而重复任务的代价是真实的：同一门课被抢两次。
fn active_task_exists(conn: &Connection, account_id: i64, turn_id: &str, lesson_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM campus_grab_tasks WHERE account_id = ?1 AND turn_id = ?2 AND lesson_id = ?3 \
         AND status NOT IN ('success','failed','conflict','cancelled') LIMIT 1",
        rusqlite::params![account_id, turn_id, lesson_id],
        |_| Ok(()),
    )
    .is_ok()
}

/// 落库投递口里排队的意图，然后把它改名成 `.done`（幂等 + 可追溯）。
///
/// 返回 `Some(错误)` 时调用方把它挂到 `hub.last_error` 让人看见 ——
/// 「投递了半天没反应」是最难查的一种故障，不能让它在静默里发生。
/// 解析不了的文件会被挪成 `.bad.json`：不重试、不瘫痪引擎，原件还在，能查。
fn drain_intake(app: &AppHandle, account_id: i64) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    let path = dir.join(INTAKE_FILE);
    if !path.exists() {
        return None;
    }

    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return Some(format!("投递口读取失败：{e}")),
    };
    // 记事本存出来的 JSON 常带 BOM，serde 不认
    let text = text.trim_start_matches('\u{feff}').trim().to_string();

    let batches: Vec<IntakeBatch> = match serde_json::from_str(&text) {
        Ok(b) => b,
        Err(e) => {
            let bad = dir.join("campus_intake.bad.json");
            let _ = std::fs::remove_file(&bad);
            let _ = std::fs::rename(&path, &bad);
            return Some(format!("投递口不是合法 JSON，已挪到 campus_intake.bad.json：{e}"));
        }
    };

    let mut added = 0usize;
    let outcome = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        let mut r = Ok(());
        for b in batches.iter() {
            for t in b.targets.iter() {
                let lid = json_to_col(&t.lesson_id);
                if active_task_exists(&conn, account_id, &b.turn_id, &lid) {
                    continue; // 已经在抢了，投递口不该造出第二条
                }
                // 只认两种模式，其余一律当占位优先（拼错一个词不该变成「直接提交」）
                let mode = match b.mode.as_deref() {
                    Some("direct") => "direct",
                    _ => "predicate",
                };
                match insert_task(
                    &conn,
                    account_id,
                    &b.turn_id,
                    b.turn_name.as_deref(),
                    t,
                    mode,
                    b.window_wall.as_deref(),
                    b.window_end_wall.as_deref(),
                ) {
                    Ok(_) => added += 1,
                    Err(e) => {
                        r = Err(e);
                        break;
                    }
                }
            }
        }
        r
    };

    match outcome {
        Ok(()) => {
            let done = dir.join(INTAKE_DONE);
            let _ = std::fs::remove_file(&done);
            let _ = std::fs::rename(&path, &done);
            None
        }
        Err(e) => Some(format!("投递口落库失败（已落 {added} 条）：{e}")),
    }
}

/// 记下「进批次」拿到的批次 id（`courseSelectTurnAssoc`）。
///
/// 单独一个函数而不是塞进 [`insert_task`] 的参数里：入队时它是网络调用的结果，
/// 拿不到是常态（窗口没开、接口失败），此时留空即可 —— 提交时会退回列表 id。
pub fn set_turn_assoc(conn: &Connection, id: i64, turn_assoc: &str) -> Result<()> {
    if turn_assoc.trim().is_empty() {
        return Ok(());
    }
    conn.execute(
        "UPDATE campus_grab_tasks SET turn_assoc = ?2 WHERE id = ?1",
        rusqlite::params![id, turn_assoc],
    )?;
    Ok(())
}

pub fn delete_task(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM campus_grab_tasks WHERE id = ?1", [id])?;
    Ok(())
}

/// 清掉已结束的任务（成功/失败/冲突/已取消）。
pub fn clear_finished(conn: &Connection, account_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM campus_grab_tasks WHERE account_id = ?1 \
         AND status IN ('success','failed','conflict','cancelled')",
        [account_id],
    )?)
}

pub fn set_status(conn: &Connection, id: i64, status: &str) -> Result<()> {
    let finished = grab_is_terminal(status).then(now_ms);
    conn.execute(
        "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle', next_at = ?3, finished_at = ?4 \
         WHERE id = ?1",
        rusqlite::params![id, status, now_ms(), finished],
    )?;
    Ok(())
}

/* ─────────────────────── 计划（意向）：读写 ─────────────────────── */

const INTENT_COLS: &str = "id, turn_id, turn_name, query, mode, spread, status, group_keys, \
     candidates, last_message, attempts, next_at, created_at, resolved_at";

fn intent_row(r: &Row<'_>) -> rusqlite::Result<GrabIntent> {
    let keys: String = r.get(7)?;
    let candidates: String = r.get(8)?;
    Ok(GrabIntent {
        id: r.get(0)?,
        turn_id: r.get(1)?,
        turn_name: r.get(2)?,
        query: r.get(3)?,
        mode: r.get(4)?,
        spread: r.get::<_, i64>(5)? != 0,
        status: r.get(6)?,
        // 坏 JSON 按空数组处理：一条计划的候选清单不该拖垮整份快照
        group_keys: serde_json::from_str(&keys).unwrap_or_default(),
        candidates: serde_json::from_str(&candidates).unwrap_or_default(),
        last_message: r.get(9)?,
        attempts: r.get(10)?,
        next_at: r.get(11)?,
        created_at: r.get(12)?,
        resolved_at: r.get(13)?,
    })
}

/// 全部计划（界面用），按写下顺序。
pub fn load_intents(conn: &Connection, account_id: i64) -> Result<Vec<GrabIntent>> {
    let sql = format!(
        "SELECT {INTENT_COLS} FROM campus_grab_intents WHERE account_id = ?1 ORDER BY id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id], intent_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn load_intent(conn: &Connection, id: i64) -> Result<Option<GrabIntent>> {
    let sql = format!("SELECT {INTENT_COLS} FROM campus_grab_intents WHERE id = ?1");
    match conn.query_row(&sql, [id], intent_row) {
        Ok(i) => Ok(Some(i)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReinError::from(e)),
    }
}

/// 到点该解析的那条计划。
///
/// **只有 `pending` / `empty` 会被选中** —— `ready` 的计划不自动重解析：
/// 它已经排出了任务，再解析一遍只会对着同一批班重排（用户真要重来会按「重新解析」）。
fn load_due_intent(conn: &Connection, account_id: i64, now: i64) -> Result<Option<GrabIntent>> {
    let sql = format!(
        "SELECT {INTENT_COLS} FROM campus_grab_intents \
         WHERE account_id = ?1 AND status IN ('{INTENT_PENDING}','{INTENT_EMPTY}') AND next_at <= ?2 \
         ORDER BY next_at ASC, id ASC LIMIT 1"
    );
    match conn.query_row(&sql, rusqlite::params![account_id, now], intent_row) {
        Ok(i) => Ok(Some(i)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReinError::from(e)),
    }
}

/// 记下一条计划。`next_at = 0` 意味着「马上解析」。
pub fn insert_intent(
    conn: &Connection,
    account_id: i64,
    turn_id: Option<&str>,
    turn_name: Option<&str>,
    query: &str,
    mode: &str,
    spread: bool,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO campus_grab_intents \
         (account_id, turn_id, turn_name, query, mode, spread, status, next_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
        rusqlite::params![
            account_id,
            turn_id,
            turn_name,
            query,
            mode,
            spread as i64,
            INTENT_PENDING,
            now_ms(),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 写回一条计划的可变部分（解析结果与重试安排）。
pub fn save_intent(conn: &Connection, i: &GrabIntent) -> Result<()> {
    conn.execute(
        "UPDATE campus_grab_intents SET turn_id = ?2, turn_name = ?3, query = ?4, mode = ?5, \
         spread = ?6, status = ?7, group_keys = ?8, candidates = ?9, last_message = ?10, \
         attempts = ?11, next_at = ?12, resolved_at = ?13 WHERE id = ?1",
        rusqlite::params![
            i.id,
            i.turn_id,
            i.turn_name,
            i.query,
            i.mode,
            i.spread as i64,
            i.status,
            serde_json::to_string(&i.group_keys)?,
            serde_json::to_string(&i.candidates)?,
            i.last_message,
            i.attempts,
            i.next_at,
            i.resolved_at,
        ],
    )?;
    Ok(())
}

/// 删一条计划，同时**收掉它派出去的任务**。
///
/// 只删计划不收任务会留下一个说不通的局面：界面上的计划没了，抢课却还在跑。
/// 终态任务留着（那是历史记录），非终态的取消 —— 与「取消」这个动作的语义一致。
pub fn delete_intent(conn: &Connection, id: i64) -> Result<()> {
    if let Some(i) = load_intent(conn, id)? {
        for key in &i.group_keys {
            conn.execute(
                "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle', next_at = ?3, \
                 finished_at = ?3, last_message = '计划已移除' \
                 WHERE group_key = ?1 AND status NOT IN ('success','failed','conflict','cancelled')",
                rusqlite::params![key, GRAB_CANCELLED, now_ms()],
            )?;
        }
    }
    conn.execute("DELETE FROM campus_grab_intents WHERE id = ?1", [id])?;
    Ok(())
}

/// 让一条计划立刻重新解析（用户按「重新解析」）。
///
/// **不清候选**：解析要等一次名单查询，界面在这期间仍显示上一次的结果比显示空白强。
pub fn reset_intent(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE campus_grab_intents SET status = ?2, next_at = 0, \
         last_message = '正在重新解析教学班…' WHERE id = ?1",
        rusqlite::params![id, INTENT_PENDING],
    )?;
    Ok(())
}

fn read_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

fn write_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// 读节奏参数。库里存的是 JSON；解析不出来就用默认值
/// （**绝不因为设置坏了而停下引擎** —— 抢课期间「因为配置有问题所以不抢了」不可接受）。
pub fn load_settings(conn: &Connection) -> Result<GrabSettings> {
    Ok(read_meta(conn, SETTINGS_KEY)
        .and_then(|s| serde_json::from_str::<GrabSettings>(&s).ok())
        .unwrap_or_default()
        .sanitized())
}

pub fn save_settings(conn: &Connection, s: &GrabSettings) -> Result<()> {
    write_meta(
        conn,
        SETTINGS_KEY,
        &serde_json::to_string(&s.clone().sanitized())?,
    )?;
    Ok(())
}

/* ─────────────────────────── 快照 ─────────────────────────── */

/// 批次 → 界面用的轻量摘要。
///
/// 窗口时刻走 `opens_at_text` / `closes_at_text` 那一套优先级（结构化区间优先，
/// 退化才抠 `selectDateTimeText`）—— **界面显示的开窗时间与引擎实际开火的时刻必须同源**，
/// 否则用户看到的倒计时和它真正出手的那一刻对不上。
fn turn_brief(t: &CourseSelectTurn) -> GrabTurnBrief {
    GrabTurnBrief {
        id: matcher::id_text(&t.id),
        name: t.name.clone(),
        allow_enter: t.allow_enter,
        select_text: t.select_date_time_text.clone(),
        window_start: t.opens_at_text(),
        window_end: t.closes_at_text(),
    }
}

/// 读回窗口监听的批次摘要。
///
/// 坏数据按「还没探测过」处理：界面宁可显示「等待探测」，
/// 也不该因为一段坏 JSON 让整份快照失败（那会让整个抢课面板空掉）。
fn read_turns(conn: &Connection) -> Vec<GrabTurnBrief> {
    read_meta(conn, TURNS_KEY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 组装给界面看的快照。命令与事件共用它，保证「拉一次」与「推一次」永远同形。
pub fn snapshot(conn: &Connection, hub: &GrabHub) -> Result<GrabState> {
    let account_id = active_account_id(conn)?;
    let mut tasks = match account_id {
        Some(id) => load_tasks(conn, id)?,
        None => Vec::new(),
    };
    let intents = match account_id {
        Some(id) => load_intents(conn, id)?,
        None => Vec::new(),
    };
    let settings = load_settings(conn)?;
    let clock: Option<(i64, String)> =
        read_meta(conn, CLOCK_KEY).and_then(|s| serde_json::from_str(&s).ok());
    let skew_ms = clock
        .as_ref()
        .and_then(|(at, text)| compute_skew(text, *at));

    // 开火时刻是**派生值**，只有这里算得对（它要用实测偏差与提前量），
    // 所以在这一层填给界面，而不是让前端自己再实现一遍墙上时间换算。
    for t in tasks.iter_mut() {
        t.fire_at = fire_at_ms(t, skew_ms.unwrap_or(0), settings.lead_ms);
    }

    // 志愿组同理：谁在压着谁，只有 `group_lead` 说了算。在这里把结论喂给界面，
    // 前端就不必（也不该）自己再实现一遍「组内按志愿序取最小」的规则。
    let now = now_ms();
    let groups: BTreeSet<String> = tasks
        .iter()
        .filter_map(|t| group_of(t).map(str::to_string))
        .collect();
    let leads: HashMap<String, i64> = groups
        .iter()
        .filter_map(|g| group_lead(g, &tasks, &settings, now).map(|l| (g.clone(), l.id)))
        .collect();
    for t in tasks.iter_mut() {
        // 只有**还在场上**的才谈得上被谁压着。终态/暂停的任务不在等任何人 ——
        // 给它们也标上「等第 N 志愿」，界面就会说着「它还在排队」而实际上它已经出局了。
        let in_play = !grab_is_terminal(&t.status) && t.status != GRAB_PAUSED;
        let held = if in_play {
            group_of(t)
                .and_then(|g| leads.get(g).copied())
                .filter(|id| *id != t.id)
        } else {
            None
        };
        t.held_by = held;
    }

    let active = tasks
        .iter()
        .any(|t| !grab_is_terminal(&t.status) && t.status != GRAB_PAUSED);
    let next_at = tasks
        .iter()
        .filter(|t| t.status == GRAB_WAITING || t.status == GRAB_RUNNING)
        .map(|t| t.next_at)
        .min();
    // 还没到点的任务里，最早的那次开火就是用户要等的那个时刻
    let next_fire_at = tasks
        .iter()
        .filter(|t| t.status == GRAB_WAITING || t.status == GRAB_RUNNING)
        .filter_map(|t| t.fire_at)
        .filter(|at| *at != GATE_UNKNOWN)
        .min();

    Ok(GrabState {
        alive: true,
        active,
        // 界面上的「教务时间」此刻该显示什么：把最近一次采样按偏差推到现在
        server_time: skew_ms
            .map(|skew| format_now(now_ms() + skew))
            .or_else(|| clock.map(|(_, text)| text)),
        skew_sec: skew_ms.map(skew_secs),
        next_at,
        next_fire_at,
        last_error: hub.last_error(),
        turns: read_turns(conn),
        probed_at: read_meta(conn, PROBED_KEY).and_then(|s| s.parse::<i64>().ok()),
        intents,
        tasks,
    })
}

/// 本机 unix 毫秒 → `2026-09-17 07:07:57`
pub fn format_now(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

/// 偏差毫秒 → 展示用的秒数。**四舍五入，不是截断**：采样与读取之间总会过去几毫秒，
/// 截断会让 11.999 秒显示成 11 秒 —— 一个用来对时的数字不该系统性偏小。
pub fn skew_secs(skew_ms: i64) -> i64 {
    (skew_ms + 500).div_euclid(1000)
}

fn emit(app: &AppHandle, hub: &GrabHub) {
    let payload = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        match snapshot(&conn, hub) {
            Ok(s) => serde_json::to_string(&s).unwrap_or_default(),
            Err(_) => return,
        }
    };
    // 内容没变就不推。引擎每秒醒若干次，没有这道闸门事件总线会被刷爆。
    {
        let Ok(mut last) = hub.last_emit.lock() else {
            return;
        };
        if *last == payload {
            return;
        }
        *last = payload.clone();
    }
    let _ = app.emit(GRAB_EVENT, payload);
}

/* ─────────────────────────── 测试 ─────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn account(conn: &Connection) -> i64 {
        conn.execute(
            "INSERT INTO campus_accounts (system_kind, base_url, login_name, created_at, updated_at) \
             VALUES ('k', 'https://x', 'n', 't', 't')",
            [],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn input(id: Value) -> GrabTargetInput {
        GrabTargetInput {
            lesson_id: id,
            lesson_name: None,
            course_name: Some("高等数学（上）".into()),
            course_code: Some("000001".into()),
            teacher: None,
            credits: Some(5.0),
            virtual_cost: Some(30),
            schedule_group_id: Some(serde_json::json!(9)),
            group_key: None,
            group_name: None,
            priority: 0,
        }
    }

    /// 造一条「志愿组里的任务」并**真落库** —— `close_group` 是 SQL，不落库就测不到。
    fn grouped(conn: &Connection, account_id: i64, group: &str, priority: i64) -> GrabTask {
        let mut inp = input(serde_json::json!(priority));
        inp.group_key = Some(group.into());
        inp.group_name = Some("体育组".into());
        inp.priority = priority;
        let id = insert_task(conn, account_id, "77", None, &inp, "predicate", None, None).unwrap();
        load_task(conn, id).unwrap().unwrap()
    }

    /// 满员的文案里带「已选」二字 —— 先判「已选过」会把满员误判成终态，
    /// 那是抢课里最贵的 bug：你以为在守着，其实早就放弃了。
    #[test]
    fn full_is_not_mistaken_for_already_picked() {
        assert_eq!(verdict_of("已选人数已达上限"), Verdict::Full);
        assert_eq!(verdict_of("教学班人数已满"), Verdict::Full);
        assert_eq!(verdict_of("剩余名额不足"), Verdict::Full);
        assert_eq!(verdict_of("该教学班已满员"), Verdict::Full);
        // 真的已经选过，才判终态
        assert_eq!(verdict_of("你已经选过这门课"), Verdict::Fatal);
        assert_eq!(verdict_of("请不要重复提交"), Verdict::Fatal);
    }

    #[test]
    fn verdict_covers_the_real_failure_families() {
        assert_eq!(
            verdict_of("选课令牌已失效，请重新打开选课页重试"),
            Verdict::TokenRefresh
        );
        assert_eq!(verdict_of("教务会话已过期，请先重新登录"), Verdict::SessionLost);
        assert_eq!(verdict_of("与已选课程时间冲突，请办理免听"), Verdict::Conflict);
        assert_eq!(verdict_of("不在选课时间内"), Verdict::Fatal);
        assert_eq!(verdict_of("选课接口失败：HTTP 503"), Verdict::Retry);
        assert_eq!(verdict_of("网络请求失败：timed out"), Verdict::Retry);
        // 认不出来的一律可重试，由连败上限兜底
        assert_eq!(verdict_of("教务返回了一段没人见过的话"), Verdict::Retry);
        assert_eq!(verdict_of(""), Verdict::Retry);
    }

    #[test]
    fn wall_time_parses_the_shapes_the_school_actually_emits() {
        let base = wall_to_ms("2026-09-17 08:00:00").unwrap();
        assert_eq!(wall_to_ms("2026-09-17 08:00").unwrap(), base);
        assert_eq!(wall_to_ms("2026-09-17T08:00:00").unwrap(), base);
        assert_eq!(wall_to_ms("2026/09/17 08:00:00").unwrap(), base);
        assert_eq!(wall_to_ms(" 2026-09-17 08:00:00 ").unwrap(), base);
        assert_eq!(wall_to_ms("2026年9月17日 08:00:00").unwrap(), base);
        // 只给日期 → 当天零点
        assert_eq!(
            wall_to_ms("2026-09-17").unwrap(),
            wall_to_ms("2026-09-17 00:00:00").unwrap()
        );
        assert_eq!(wall_to_ms("待定"), None);
        assert_eq!(wall_to_ms(""), None);
    }

    fn task(window: Option<&str>, attempts: i64) -> GrabTask {
        GrabTask {
            id: 1,
            turn_id: "77".into(),
            turn_name: None,
            turn_assoc: None,
            lesson_id: serde_json::json!(1),
            lesson_name: None,
            course_name: None,
            course_code: None,
            teacher: None,
            credits: None,
            mode: "predicate".into(),
            virtual_cost: None,
            schedule_group_id: None,
            window_wall: window.map(str::to_string),
            window_end_wall: None,
            await_window: false,
            predicate_done: false,
            status: GRAB_WAITING.into(),
            phase: PHASE_IDLE.into(),
            attempts,
            polls: 0,
            strikes: 0,
            strike_kind: None,
            request_id: None,
            last_message: None,
            next_at: 0,
            fire_at: None,
            queued_at: None,
            finished_at: None,
            group_key: None,
            group_name: None,
            priority: 0,
            stuck_since: None,
            held_by: None,
        }
    }

    /// 占位只交一次。**这是真出过的 bug**：原先用 `attempts == 0` 反推「还没占位」，
    /// 而占位落定到正式提交之间 `attempts` 恰好是 0，于是任务在
    /// 「占位 → 轮询 → 占位」里转圈，正式请求永远发不出去。
    /// 逮到它的是 `scripts/e2e-auto-grab.mjs` —— 单测看不见这种跨状态序列的问题。
    #[test]
    fn predicate_is_placed_exactly_once() {
        let mut t = task(Some("2026-09-17 08:00:00"), 0);
        assert!(needs_predicate(&t), "第一次出手应当先占位");

        // 占位已交、正式提交尚未发生 —— 这正是那个 bug 的窗口期
        t.predicate_done = true;
        assert!(!needs_predicate(&t), "占位交过之后必须直接投正式请求");
        assert_eq!(t.attempts, 0, "此时 attempts 仍是 0，所以它不能拿来当判据");

        // 交过占位之后，即使重试了很多次也不再补占位
        t.attempts = 5;
        t.phase = PHASE_IDLE.into();
        assert!(!needs_predicate(&t));

        // 直接模式从不占位
        let mut d = task(None, 0);
        d.mode = "direct".into();
        assert!(!needs_predicate(&d));
    }

    /// 「重新排队」是一轮全新的抢课：占位标记必须跟着复位，否则重试的任务会直接跳过占位。
    #[test]
    fn predicate_flag_round_trips_and_resets() {
        let conn = db();
        let acct = account(&conn);
        let id = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "predicate",
            Some("2026-09-17 08:00:00"),
            None,
        )
        .unwrap();
        let mut t = load_task(&conn, id).unwrap().unwrap();
        assert!(!t.predicate_done, "入队时还没占位");

        t.predicate_done = true;
        t.phase = PHASE_POLL.into();
        save_task(&conn, &t).unwrap();
        let back = load_task(&conn, id).unwrap().unwrap();
        assert!(back.predicate_done, "占位标记必须落库");

        // 用户点「重试」走的是 commands 里的 SQL，语义必须一致
        conn.execute(
            "UPDATE campus_grab_tasks SET predicate_done = 0, attempts = 0 WHERE id = ?1",
            [id],
        )
        .unwrap();
        assert!(!load_task(&conn, id).unwrap().unwrap().predicate_done);
    }

    /// 「提交体该用哪个批次 id」是这套代码里最容易悄悄错的地方。
    ///
    /// SPA 提交时发的是「进批次」返回的 `options.turn.id`，不是列表里的 turnId。
    /// 我们拿不到真机样本确认两者是否相等，所以策略是：**有就用，没有就退回列表 id**。
    /// 这条测试钉的就是这个退回行为 —— 少了它，一次「顺手把 unwrap_or 去掉」的改动
    /// 就会让所有提交带着空 id 发出去，而且只在窗口开放时才暴露。
    #[test]
    fn turn_assoc_prefers_the_entered_turn_and_falls_back() {
        let mut t = task(None, 0);
        t.turn_id = "77".into();
        // 没进过批次 → 用列表 id（这是当前唯一有把握的行为）
        assert_eq!(t.turn_assoc(), "77");

        // 进过批次且拿到了别的 id → 用它
        t.turn_assoc = Some("991".into());
        assert_eq!(t.turn_assoc(), "991");

        // 空白值不算数（接口回了个空串时不能把提交搞坏）
        for blank in ["", "   "] {
            t.turn_assoc = Some(blank.into());
            assert_eq!(t.turn_assoc(), "77", "空白 assoc 必须退回 turn_id");
        }
        t.turn_assoc = None;
        assert_eq!(t.turn_assoc(), "77");
    }

    /// assoc 要真的落库：引擎重启后还得知道该用哪个 id。
    #[test]
    fn turn_assoc_round_trips_through_sqlite() {
        let conn = db();
        let acct = account(&conn);
        let id = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "direct",
            None,
            None,
        )
        .unwrap();
        assert_eq!(load_task(&conn, id).unwrap().unwrap().turn_assoc(), "77");

        set_turn_assoc(&conn, id, "991").unwrap();
        assert_eq!(load_task(&conn, id).unwrap().unwrap().turn_assoc(), "991");

        // 空串不该覆盖掉已有值，也不该写进去
        set_turn_assoc(&conn, id, "  ").unwrap();
        assert_eq!(load_task(&conn, id).unwrap().unwrap().turn_assoc(), "991");
    }

    /// 开火时刻必须走「教务墙上时间 − 实测偏差」这条换算，
    /// 而不是把教务的文本直接当本机时间 —— 学生电脑的时间经常偏。
    #[test]
    fn fire_time_is_skew_corrected_and_leads_the_gate() {
        let t = task(Some("2026-09-17 08:00:00"), 0);
        let wall = wall_to_ms("2026-09-17 08:00:00").unwrap();

        // 偏差 0：提前量 800ms 意味着 07:59:59.200 就该出手
        assert_eq!(fire_at_ms(&t, 0, 800), Some(wall - 800));
        // 服务器比本机快 5 秒：本机要更早出手
        assert_eq!(fire_at_ms(&t, 5_000, 800), Some(wall - 5_800));
        // 服务器比本机慢 3 秒：本机可以晚一点
        assert_eq!(fire_at_ms(&t, -3_000, 800), Some(wall + 2_200));

        // 已经开过火的任务不再受窗口约束，全由重试节奏支配 ——
        // 交过占位也算「出过手」：闸门只管第一枪，打出去之后不该再拿它挡路
        assert_eq!(fire_at_ms(&task(Some("2026-09-17 08:00:00"), 3), 0, 800), None);
        let mut placed = task(Some("2026-09-17 08:00:00"), 0);
        placed.predicate_done = true;
        assert_eq!(fire_at_ms(&placed, 0, 800), None);
        // 没有窗口信息 → 不设闸门
        assert_eq!(fire_at_ms(&task(None, 0), 0, 800), None);
    }

    /// 「提前一晚预设、但教务还没公布窗口」是**核心场景**：
    /// 这种任务绝不能立刻开火 —— 撞出来的「不在选课时间」会被判终态，预设就白费了。
    #[test]
    fn unknown_window_holds_the_task_instead_of_firing_blind() {
        let mut t = task(None, 0);
        // 没有 await 标记（调用方明确说「就是现在抢」）→ 不设闸门
        assert_eq!(fire_at_ms(&t, 0, 800), None);

        // 有 await 标记 → 挡住
        t.await_window = true;
        assert_eq!(fire_at_ms(&t, 0, 800), Some(GATE_UNKNOWN));
        assert!(GATE_UNKNOWN > now_ms(), "闸门未知必须落在遥远的未来，不能立刻到点");

        // 拿到窗口之后闸门就正常了
        t.window_wall = Some("2026-09-17 08:00:00".into());
        assert_eq!(
            fire_at_ms(&t, 0, 800),
            Some(wall_to_ms("2026-09-17 08:00:00").unwrap() - 800)
        );
    }

    /// 入队时给不出窗口 → 自动进入「等窗口」状态，而不是当成「立刻开抢」。
    #[test]
    fn enqueue_without_a_window_marks_it_as_awaiting() {
        let conn = db();
        let acct = account(&conn);
        let known = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "direct",
            Some("2026-09-17 08:00:00"),
            Some("2026-09-17 23:59:59"),
        )
        .unwrap();
        let unknown = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(2)),
            "direct",
            None,
            None,
        )
        .unwrap();

        assert!(!load_task(&conn, known).unwrap().unwrap().await_window);
        let waiting = load_task(&conn, unknown).unwrap().unwrap();
        assert!(waiting.await_window);
        assert_eq!(fire_at_ms(&waiting, 0, 800), Some(GATE_UNKNOWN));
    }

    #[test]
    fn window_close_stops_the_chase() {
        let past = Local::now() - chrono::Duration::minutes(5);
        let future = Local::now() + chrono::Duration::minutes(5);
        let mut t = task(None, 0);
        t.window_end_wall = Some(past.format("%Y-%m-%d %H:%M:%S").to_string());
        assert!(window_closed(&t, 0));
        t.window_end_wall = Some(future.format("%Y-%m-%d %H:%M:%S").to_string());
        assert!(!window_closed(&t, 0));
        // 没有结束时刻就不设这道闸门（由错误分级去兜）
        t.window_end_wall = None;
        assert!(!window_closed(&t, 0));
    }

    #[test]
    fn error_absorption_backs_off_and_gives_up_on_unknowns() {
        let s = GrabSettings::default();

        // 满员：一直守着，但节奏放慢
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, "教学班人数已满".into());
        assert_eq!(t.status, GRAB_WAITING);
        assert_eq!(t.strike_kind.as_deref(), Some("full"));
        assert!(t.next_at > now_ms());

        // 未知错误：退避重试，连败到上限才停
        let mut t = task(None, 1);
        for _ in 0..UNKNOWN_STRIKE_LIMIT - 1 {
            absorb_error(&mut t, &s, "没人见过的话".into());
            assert_eq!(t.status, GRAB_WAITING);
        }
        absorb_error(&mut t, &s, "没人见过的话".into());
        assert_eq!(t.status, GRAB_FAILED);
        assert!(t.last_message.unwrap().contains("连续"));

        // 换令牌不算这个任务的失败：连败清零、重新排队
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, format!("{TOKEN_EXPIRED}，请重新打开选课页重试"));
        assert_eq!(t.status, GRAB_WAITING);
        assert_eq!(t.strikes, 0);

        // 终态错误 / 冲突：立即停，不再浪费对方带宽
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, "不在选课时间内".into());
        assert_eq!(t.status, GRAB_FAILED);
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, "请办理免听".into());
        assert_eq!(t.status, GRAB_CONFLICT);
    }

    #[test]
    fn strikes_reset_when_the_failure_changes_family() {
        let s = GrabSettings::default();
        let mut t = task(None, 1);
        for _ in 0..5 {
            absorb_error(&mut t, &s, "没人见过的话".into());
        }
        assert_eq!(t.strikes, 5);
        // 局面变了：重新给耐心，否则「先未知几次、再满员」会被误判成耗尽
        absorb_error(&mut t, &s, "教学班人数已满".into());
        assert_eq!(t.strikes, 1);
        assert_eq!(t.strike_kind.as_deref(), Some("full"));
    }

    #[test]
    fn max_attempts_is_a_ceiling_when_set() {
        let s = GrabSettings {
            max_attempts: 3,
            ..Default::default()
        };
        let mut t = task(None, 3);
        absorb_error(&mut t, &s, "教学班人数已满".into());
        assert_eq!(t.status, GRAB_FAILED);
        assert!(t.last_message.unwrap().contains("已达提交上限"));
    }

    #[test]
    fn settings_are_clamped_to_sane_limits() {
        let s = GrabSettings {
            min_interval_ms: 0,
            poll_interval_ms: 0,
            full_retry_ms: 0,
            backoff_ms: 0,
            lead_ms: 999_999,
            max_polls: 0,
            ..Default::default()
        }
        .sanitized();
        // 下限压得很低（压测过 80 次/秒无异常），但**不能是 0 或负数** ——
        // 那会让闸门失效，变成不留间隙地连打
        assert_eq!(s.min_interval_ms, 10);
        assert_eq!(s.poll_interval_ms, 50);
        assert_eq!(s.full_retry_ms, 100);
        assert_eq!(s.backoff_ms, 50);
        assert_eq!(s.lead_ms, 5_000);
        assert_eq!(s.max_polls, 1);
        // 退避上限不得低于基数，否则退避会越退越快
        let s = GrabSettings {
            backoff_ms: 9000,
            max_backoff_ms: 100,
            ..Default::default()
        }
        .sanitized();
        assert!(s.max_backoff_ms >= s.backoff_ms);
    }

    /// 「快」是用户能调的，但**默认值不许偷偷变快** ——
    /// 放开钳位只回答「能调到多少」，不回答「默认多快」。
    #[test]
    fn loosening_the_floor_does_not_speed_up_the_default() {
        let d = GrabSettings::default();
        let s = d.clone().sanitized();
        assert_eq!(s.min_interval_ms, d.min_interval_ms, "默认值本身就落在钳位区间内");
        assert_eq!(s.poll_interval_ms, d.poll_interval_ms);
        assert_eq!(s.full_retry_ms, d.full_retry_ms);
        // 默认仍然是「一个学生抢几门课」的节奏，不是压测出来的那档
        assert_eq!(d.min_interval_ms, 700);
        assert_eq!(d.poll_interval_ms, 2000);
        assert_eq!(d.full_retry_ms, 5000);
    }

    /// 教学班 id 的类型必须原样往返：教务回 `317844` 而我们发 `"317844"` 是两种东西。
    #[test]
    fn lesson_id_json_roundtrip_keeps_the_scalar_type() {
        let conn = db();
        let acct = account(&conn);
        for id in [serde_json::json!(317844), serde_json::json!("65535")] {
            let tid = insert_task(
                &conn,
                acct,
                "77",
                Some("正选"),
                &input(id.clone()),
                "predicate",
                Some("2026-09-17 08:00:00"),
                Some("2026-09-17 23:59:59"),
            )
            .unwrap();
            let t = load_task(&conn, tid).unwrap().unwrap();
            assert_eq!(t.lesson_id, id, "教学班 id 的类型必须原样保留");
            assert_eq!(t.schedule_group_id, Some(serde_json::json!(9)));
            assert_eq!(t.virtual_cost, Some(30));
            assert_eq!(t.course_name.as_deref(), Some("高等数学（上）"));
            assert_eq!(t.status, GRAB_WAITING);
            assert_eq!(t.window_wall.as_deref(), Some("2026-09-17 08:00:00"));
            assert_eq!(t.window_end_wall.as_deref(), Some("2026-09-17 23:59:59"));
            // 入队即「已到点」：窗口闸门由 window_wall 单独把守，next_at 不该也跟着往后推
            assert!(t.next_at > 0);
        }
    }

    #[test]
    fn active_tasks_exclude_paused_and_finished() {
        let conn = db();
        let acct = account(&conn);
        let a = insert_task(&conn, acct, "77", None, &input(serde_json::json!(1)), "direct", None, None).unwrap();
        let b = insert_task(&conn, acct, "77", None, &input(serde_json::json!(2)), "direct", None, None).unwrap();
        set_status(&conn, b, GRAB_SUCCESS).unwrap();
        let paused = insert_task(&conn, acct, "77", None, &input(serde_json::json!(3)), "direct", None, None).unwrap();
        set_status(&conn, paused, GRAB_PAUSED).unwrap();

        let active = load_active_tasks(&conn, acct).unwrap();
        assert_eq!(active.len(), 1, "只有真正在抢的任务才该被引擎推进");
        assert_eq!(active[0].id, a);
        // 但界面上三行都要看得到，且未结束的排在前面
        let all = load_tasks(&conn, acct).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].id, paused);
    }

    #[test]
    fn clear_finished_keeps_the_running_ones() {
        let conn = db();
        let acct = account(&conn);
        insert_task(&conn, acct, "77", None, &input(serde_json::json!(1)), "direct", None, None).unwrap();
        let done = insert_task(&conn, acct, "77", None, &input(serde_json::json!(2)), "direct", None, None).unwrap();
        set_status(&conn, done, GRAB_FAILED).unwrap();

        assert_eq!(clear_finished(&conn, acct).unwrap(), 1);
        assert_eq!(load_tasks(&conn, acct).unwrap().len(), 1);
    }

    /// 暂停/取消必须真的让引擎停手 —— 用户在抢课途中反悔是常事。
    #[test]
    fn park_keeps_a_paused_family_intact() {
        let conn = db();
        let acct = account(&conn);
        let id = insert_task(&conn, acct, "77", None, &input(serde_json::json!(1)), "direct", None, None).unwrap();
        let mut t = load_task(&conn, id).unwrap().unwrap();
        t.status = GRAB_RUNNING.into();
        save_task(&conn, &t).unwrap();

        park(&conn, &t, now_ms() + 5000, "教务会话已过期", Verdict::SessionLost).unwrap();
        let parked = load_task(&conn, id).unwrap().unwrap();
        assert_eq!(parked.status, GRAB_WAITING);
        assert_eq!(parked.strike_kind.as_deref(), Some("session"));
        assert_eq!(parked.strikes, 1);
        // 同类再停一次 → 累加
        park(&conn, &parked, now_ms() + 5000, "教务会话已过期", Verdict::SessionLost).unwrap();
        assert_eq!(load_task(&conn, id).unwrap().unwrap().strikes, 2);
        // 换种类 → 重新计数
        park(&conn, &parked, now_ms(), "人数已满", Verdict::Full).unwrap();
        let after = load_task(&conn, id).unwrap().unwrap();
        assert_eq!(after.strikes, 1);
        assert_eq!(after.strike_kind.as_deref(), Some("full"));
    }

    /// 设置坏掉不该让引擎停下 —— 抢课期间任何「因为配置有问题所以不抢了」都是不可接受的。
    #[test]
    fn broken_settings_fall_back_to_defaults() {
        let conn = db();
        write_meta(&conn, SETTINGS_KEY, "{ 这不是 json").unwrap();
        let s = load_settings(&conn).unwrap();
        assert_eq!(s.poll_interval_ms, GrabSettings::default().poll_interval_ms);

        // 存进去的必须是收口后的值（下限 10ms —— 见 `GrabSettings::sanitized`）
        save_settings(
            &conn,
            &GrabSettings {
                min_interval_ms: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(load_settings(&conn).unwrap().min_interval_ms, 10);
        // 0 或负数会让节流闸门失效（不留间隙地连打），必须被夹上来
        save_settings(
            &conn,
            &GrabSettings {
                min_interval_ms: -5,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(load_settings(&conn).unwrap().min_interval_ms, 10);
    }

    #[test]
    fn skew_is_computed_in_one_reference_frame() {
        // 服务器说 08:00:00，而我本机此刻也正好是 08:00:00 → 偏差 0
        let at = wall_to_ms("2026-09-17 08:00:00").unwrap();
        assert_eq!(compute_skew("2026-09-17 08:00:00", at), Some(0));
        // 服务器说 08:00:05，我本机是 08:00:00 → 服务器快 5 秒
        assert_eq!(compute_skew("2026-09-17 08:00:05", at), Some(5_000));
        assert_eq!(compute_skew("待定", at), None);
    }

    /// 偏差要**四舍五入**到秒：采样与读取之间总会过去几毫秒，
    /// 截断会让 11.999 秒显示成 11 秒 —— 对时用的数字不该系统性偏小。
    #[test]
    fn skew_seconds_round_instead_of_truncating() {
        assert_eq!(skew_secs(11_999), 12);
        assert_eq!(skew_secs(11_400), 11);
        assert_eq!(skew_secs(0), 0);
        assert_eq!(skew_secs(-11_999), -12);
        assert_eq!(skew_secs(-11_400), -11);
    }

    /// 全局节流闸门：两次请求之间必须真的隔开，这是防封的主要旋钮。
    #[test]
    fn pacer_enforces_a_global_minimum_interval() {
        let hub = GrabHub::new();
        // 从未发过请求 → 立刻可发
        assert_eq!(hub.pace_gap_ms(700), 0);
        hub.mark_request();
        let gap = hub.pace_gap_ms(700);
        assert!(gap > 0 && gap <= 700, "刚发完必须等一会，实际 {gap}");
        assert_eq!(hub.pace_gap_ms(0), 0);
    }

    /// 空任务表时引擎必须安静待命，不该报错也不该空转。
    #[test]
    fn snapshot_is_empty_and_calm_without_tasks() {
        let conn = db();
        let hub = GrabHub::new();
        let s = snapshot(&conn, &hub).unwrap();
        assert!(!s.active);
        assert!(s.tasks.is_empty());
        assert!(s.last_error.is_none());
        assert!(s.server_time.is_none());
    }

    #[test]
    fn snapshot_reports_activity_and_skew() {
        let conn = db();
        let acct = account(&conn);
        let hub = GrabHub::new();
        // 采样发生在 10 秒前（对齐到整秒，让偏差是精确的 12 秒），服务器比本机快 12 秒
        let at = (now_ms() / 1000) * 1000 - 10_000;
        let server_text = format_now(at + 12_000);
        write_meta(&conn, CLOCK_KEY, &serde_json::to_string(&(at, &server_text)).unwrap()).unwrap();
        insert_task(&conn, acct, "77", None, &input(serde_json::json!(1)), "direct", None, None).unwrap();

        let s = snapshot(&conn, &hub).unwrap();
        assert!(s.active);
        assert_eq!(s.skew_sec, Some(12));
        assert_eq!(s.tasks.len(), 1);
        assert!(s.next_at.is_some());
        // 采样已过去 10 秒，推出来的「教务时间」必须跟着往前走 ——
        // 否则界面上的教务时钟会在两次采样之间停住不动
        assert!(
            s.server_time.as_deref().unwrap() > server_text.as_str(),
            "教务时间应当随真实时间推进，而不是停在采样那一刻"
        );
    }

    /* ─────────────────── 志愿组（互斥备选） ─────────────────── */

    /// 组内只有「当前志愿」能出手。分散出手在这里是负收益：全局节流本来一轮
    /// 只发一个请求，铺开只会让最想要的那门出手变慢。
    #[test]
    fn only_the_top_choice_of_a_group_fires() {
        let conn = db();
        let acc = account(&conn);
        // 故意乱序插入：判定必须靠 priority，而不是入库顺序
        let third = grouped(&conn, acc, "g1", 3);
        let first = grouped(&conn, acc, "g1", 1);
        let second = grouped(&conn, acc, "g1", 2);

        let mut lone = task(None, 0);
        lone.id = 9999;

        let s = GrabSettings::default();
        let now = now_ms();
        let all = vec![first.clone(), second.clone(), third.clone(), lone.clone()];

        assert!(armed(&first, &all, &s, now), "第 1 志愿该出手");
        assert!(!armed(&second, &all, &s, now), "第 2 志愿必须等");
        assert!(!armed(&third, &all, &s, now), "第 3 志愿必须等");
        assert!(armed(&lone, &all, &s, now), "不在组里的不受任何影响");
    }

    /// 中选即收组 —— 这是「不会同时抢到两门冲突课」的唯一保证。
    #[test]
    fn winning_a_group_cancels_its_siblings() {
        let conn = db();
        let acc = account(&conn);
        let first = grouped(&conn, acc, "g1", 1);
        let second = grouped(&conn, acc, "g1", 2);
        let other = grouped(&conn, acc, "g2", 1);

        let mut winner = second.clone();
        winner.status = GRAB_SUCCESS.into();
        save_task(&conn, &winner).unwrap();

        let n = close_group(&conn, &winner).unwrap();
        assert_eq!(n, 1, "只该收掉同组那一条，别的组不受牵连");

        let after = load_tasks(&conn, acc).unwrap();
        let by = |id: i64| after.iter().find(|t| t.id == id).unwrap().clone();
        assert_eq!(by(second.id).status, GRAB_SUCCESS, "中的那条不动");
        assert_eq!(by(first.id).status, GRAB_CANCELLED, "同组备选要被收掉");
        let msg = by(first.id).last_message.unwrap_or_default();
        assert!(msg.contains("第 2 志愿"), "要讲清是被谁抢先的：{msg}");
        assert_eq!(by(other.id).status, GRAB_WAITING, "别的组不该被牵连");
    }

    /// 第 1 志愿进终态后，第 2 志愿**下一轮自动**成为当前志愿 ——
    /// 这是算出来的，不是迁出来的，所以没有需要同步的中间状态。
    #[test]
    fn a_finished_choice_promotes_the_next() {
        let conn = db();
        let acc = account(&conn);
        let mut first = grouped(&conn, acc, "g1", 1);
        let second = grouped(&conn, acc, "g1", 2);
        let s = GrabSettings::default();
        let now = now_ms();

        assert!(!armed(&second, &[first.clone(), second.clone()], &s, now));

        // 冲突是终态（要去教务办免听，本地重试一万次也没用）→ 该轮到第 2 志愿
        finish(&mut first, GRAB_CONFLICT, "与已选课程时间冲突，请办理免听");
        let all = vec![first.clone(), second.clone()];
        assert!(!armed(&first, &all, &s, now), "终态的不再出手");
        assert!(armed(&second, &all, &s, now), "第 1 志愿没了，第 2 志愿该接手");
    }

    /// 默认**死守**：满员再久也不让位。「让贤期限」是唯一能改变这件事的数，
    /// 而且让位是**可逆**的 —— 后面志愿也没戏时，前面的要能回来。
    #[test]
    fn cede_deadline_is_off_by_default() {
        let conn = db();
        let acc = account(&conn);
        let mut first = grouped(&conn, acc, "g1", 1);
        let second = grouped(&conn, acc, "g1", 2);
        // 已经在满员上卡了一整天
        first.stuck_since = Some(now_ms() - 86_400_000);

        let s = GrabSettings::default();
        assert_eq!(s.cede_after_ms, 0, "默认必须是死守");
        let all = vec![first.clone(), second.clone()];
        assert!(armed(&first, &all, &s, now_ms()), "死守：不许因为满员让位");
        assert!(!armed(&second, &all, &s, now_ms()));

        // 把期限调出来才让位
        let ceded = GrabSettings { cede_after_ms: 180_000, ..s };
        assert!(!armed(&first, &all, &ceded, now_ms()), "过了期限该让位");
        assert!(armed(&second, &all, &ceded, now_ms()), "让位后第 2 志愿接手");

        // 后面也没成 → 前面那位回到出手位（它一直是非终态，没被写死）
        let mut second_done = second.clone();
        second_done.status = GRAB_FAILED.into();
        let all = vec![first.clone(), second_done];
        assert!(armed(&first, &all, &ceded, now_ms()), "后面没戏了，前面的该回来");
    }

    /// 没有 group_key（或空串）= 独立任务，行为与加志愿组之前**完全一致**。
    #[test]
    fn independent_tasks_are_unaffected() {
        let conn = db();
        let acc = account(&conn);
        let a = grouped(&conn, acc, "", 0);
        let b = grouped(&conn, acc, "", 0);
        assert!(group_of(&a).is_none(), "空组名按「不在组里」处理");

        let s = GrabSettings::default();
        let now = now_ms();
        let all = vec![a.clone(), b.clone()];
        assert!(armed(&a, &all, &s, now));
        assert!(armed(&b, &all, &s, now), "两个独立任务互不压制");

        // 中选也不该去收谁
        let mut winner = a.clone();
        winner.status = GRAB_SUCCESS.into();
        save_task(&conn, &winner).unwrap();
        assert_eq!(close_group(&conn, &winner).unwrap(), 0);
        let after = load_tasks(&conn, acc).unwrap();
        assert_eq!(
            after.iter().find(|t| t.id == b.id).unwrap().status,
            GRAB_WAITING
        );
    }

    /// 志愿组字段是**落库**的（不像 fire_at / held_by 那样是派生值）。
    #[test]
    fn group_fields_round_trip_through_sqlite() {
        let conn = db();
        let acc = account(&conn);
        let t = grouped(&conn, acc, "g1", 2);
        let back = load_task(&conn, t.id).unwrap().unwrap();
        assert_eq!(back.group_key.as_deref(), Some("g1"));
        assert_eq!(back.group_name.as_deref(), Some("体育组"));
        assert_eq!(back.priority, 2);
        assert!(back.held_by.is_none(), "held_by 是派生值，不落库");
    }

    /// 快照里的 `held_by` 只标给**还在场上**的成员。
    ///
    /// 这条是真在浏览器里看出来的：终态的第 1 志愿也挂着「等第 2 志愿」，
    /// 于是界面上一条已经出局的任务看起来还在排队。派生的意思是「现在谁压着你」，
    /// 出局的人没有被谁压着。
    #[test]
    fn held_by_skips_tasks_that_are_out_of_play() {
        let conn = db();
        let acc = account(&conn);
        let hub = GrabHub::new();
        let mut loser = grouped(&conn, acc, "g1", 1);
        let winner = grouped(&conn, acc, "g1", 2);
        // 第 1 志愿已经出局（时间冲突），第 2 志愿接手
        finish(&mut loser, GRAB_CONFLICT, "与已选课程时间冲突");
        save_task(&conn, &loser).unwrap();

        let s = snapshot(&conn, &hub).unwrap();
        let by = |id: i64| s.tasks.iter().find(|t| t.id == id).unwrap().clone();
        assert!(by(loser.id).held_by.is_none(), "出局的不该被标成在等谁");
        assert!(by(winner.id).held_by.is_none(), "接手的那个是当前志愿，也不被谁压着");
    }

    /// 「连续满员了多久」只由满员维护：同一状态要保住起点，换了失败种类就清零。
    /// 让贤期限读的就是它 —— 起点被反复重置的话，期限永远不会到。
    #[test]
    fn stuck_since_tracks_continuous_fullness() {
        let s = GrabSettings::default();
        let mut t = task(None, 0);
        assert!(t.stuck_since.is_none());

        absorb_error(&mut t, &s, "教学班人数已满".into());
        let started = t.stuck_since.expect("满员要记下起点");

        absorb_error(&mut t, &s, "剩余名额不足".into());
        assert_eq!(t.stuck_since, Some(started), "持续满员不许把起点往后挪");

        absorb_error(&mut t, &s, "选课接口失败：HTTP 503".into());
        assert!(t.stuck_since.is_none(), "换了失败种类就不再是「一直满员」");
    }

    /// 字符串型的 id 不许被加上 JSON 引号 —— 前端 `idOf()` 用的是 `String(v)`，
    /// 两边必须在同一个表示上，否则 `probe_windows` 永远匹配不到自己的批次。
    #[test]
    fn opaque_ids_lose_their_json_quotes() {
        assert_eq!(matcher::id_text(&serde_json::json!(317844)), "317844");
        assert_eq!(matcher::id_text(&serde_json::json!("317844")), "317844");
        assert_eq!(matcher::id_text(&serde_json::json!(null)), "null");
    }

    /* ─────────────────── 计划（意向） ─────────────────── */

    fn lesson(id: i64, code: &str, name: &str) -> CourseSelectLesson {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "course": { "id": id * 10, "code": code, "nameZh": name },
            "stdCount": 10,
            "limitCount": 20,
        }))
        .unwrap()
    }

    fn intent(query: &str) -> GrabIntent {
        GrabIntent {
            id: 1,
            turn_id: None,
            turn_name: None,
            query: query.into(),
            mode: "predicate".into(),
            spread: false,
            status: INTENT_PENDING.into(),
            group_keys: Vec::new(),
            candidates: Vec::new(),
            last_message: None,
            attempts: 0,
            next_at: 0,
            created_at: 0,
            resolved_at: None,
        }
    }

    fn brief(id: &str, allow_enter: bool) -> GrabTurnBrief {
        GrabTurnBrief {
            id: id.into(),
            name: Some(format!("批次{id}")),
            allow_enter,
            select_text: None,
            window_start: None,
            window_end: None,
        }
    }

    /// 分堆是这套解析的语义核心：
    /// 默认「任意一个班都行」（全合成一组，只中一个），`spread` 才是「每门课各来一个」。
    /// 已选过的班必须排除 —— 引擎不该再对已经在名下的课动手。
    #[test]
    fn plan_groups_splits_by_course_only_when_asked() {
        let ls = vec![
            lesson(1, "000001", "高等数学（上）"),
            lesson(2, "000001", "高等数学（上）"),
            lesson(3, "000002", "大学英语（一）"),
        ];
        let hits = matcher::match_lessons("学", &ls);
        assert_eq!(hits.len(), 3, "三个班都该被这句查询命中");

        // 默认：合成一组，它们互为备选
        let g = plan_groups(&hits, false);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].len(), 3);

        // spread：按课程分堆；同一门课的两个班仍在一堆里（只中一个）
        let g = plan_groups(&hits, true);
        assert_eq!(g.len(), 2, "命中的是两门课，就该两堆");
        let math = g
            .iter()
            .find(|grp| grp.iter().any(|h| h.lesson.id == serde_json::json!(1)))
            .expect("高数那一堆要在");
        assert_eq!(math.len(), 2, "同一门课的多个班必须留在同一组里");
        assert!(math[0].score >= math[1].score, "组内按「谁先值得出手」排好序");

        // 已经选上的班不再排进任务
        let mut picked = ls.clone();
        picked[0].selected_lesson =
            Some(serde_json::from_value(serde_json::json!({ "status": "已选中" })).unwrap());
        let hits = matcher::match_lessons("学", &picked);
        let g = plan_groups(&hits, false);
        assert_eq!(g[0].len(), 2, "已选过的教学班必须排除");
    }

    /// 计划的批次选择：指定的优先，**指定了但没出现就什么都别做**。
    /// 「我排的是 A 轮，引擎跑去 B 轮抢」比抢不到更难查，所以绝不自动换批次。
    #[test]
    fn intent_picks_its_turn_and_never_switches_silently() {
        let briefs = vec![brief("9", false), brief("77", true)];

        let mut i = intent("高数");
        assert_eq!(pick_turn(i.turn_id.as_deref(), &briefs).unwrap().id, "77", "没指定就用当前可进入的那个");

        i.turn_id = Some("77".into());
        assert_eq!(pick_turn(i.turn_id.as_deref(), &briefs).unwrap().id, "77");
        i.turn_id = Some("404".into());
        assert!(pick_turn(i.turn_id.as_deref(), &briefs).is_none(), "指定的批次没出现就只能等");

        // 都不允许进入时退到第一个：至少能把名字与窗口显示出来
        let none_enter = vec![brief("9", false), brief("77", false)];
        let j = intent("高数");
        assert_eq!(pick_turn(j.turn_id.as_deref(), &none_enter).unwrap().id, "9");
    }

    /// 计划是**落库**的：进程重启后它还认得自己排了什么，而「还没解析」的计划
    /// 必须每分钟被引擎捞起来重试 —— 用户排的是明天早上十点的事。
    #[test]
    fn intents_round_trip_and_only_pending_ones_are_due() {
        let conn = db();
        let acc = account(&conn);
        let id = insert_intent(
            &conn,
            acc,
            Some("77"),
            Some("正选"),
            "高数 张",
            "predicate",
            false,
        )
        .unwrap();
        let mut i = load_intent(&conn, id).unwrap().unwrap();
        assert_eq!(i.query, "高数 张");
        assert_eq!(i.status, INTENT_PENDING);
        assert_eq!(i.next_at, 0, "新计划必须立刻可解析");
        assert!(load_due_intent(&conn, acc, now_ms()).unwrap().is_some());

        // 解析完成 → 不再自动重解析（要重来是用户按「重新解析」）
        i.status = INTENT_READY.into();
        i.group_keys = vec!["intent-1".into()];
        i.candidates = vec![GrabMatch {
            lesson_id: serde_json::json!(7),
            course_name: Some("高等数学（上）".into()),
            course_code: Some("000001".into()),
            teacher: Some("张伟".into()),
            std_count: Some(10),
            limit_count: Some(20),
            picked: false,
            fields: vec!["course".into()],
        }];
        i.resolved_at = Some(now_ms());
        save_intent(&conn, &i).unwrap();
        assert!(load_due_intent(&conn, acc, now_ms()).unwrap().is_none());

        let back = load_intent(&conn, id).unwrap().unwrap();
        assert_eq!(back.group_keys, vec!["intent-1".to_string()]);
        assert_eq!(back.candidates[0].course_name.as_deref(), Some("高等数学（上）"));
        assert!(back.candidates[0].teacher.is_some());

        reset_intent(&conn, id).unwrap();
        assert!(load_due_intent(&conn, acc, now_ms()).unwrap().is_some());

        // 移除计划要**连它派出去的任务一起收**：只删计划会留下「计划没了、课还在抢」
        let t = grouped(&conn, acc, "intent-1", 1);
        delete_intent(&conn, id).unwrap();
        assert!(load_intent(&conn, id).unwrap().is_none());
        assert_eq!(
            load_task(&conn, t.id).unwrap().unwrap().status,
            GRAB_CANCELLED
        );
    }

    /// 坏 JSON 不该让整份快照失败：一条计划的候选清单烂掉，界面宁可少显示，
    /// 也不能整个抢课面板空掉。
    #[test]
    fn broken_intent_json_degrades_to_empty_lists() {
        let conn = db();
        let acc = account(&conn);
        let id = insert_intent(&conn, acc, None, None, "体育", "direct", true).unwrap();
        conn.execute(
            "UPDATE campus_grab_intents SET candidates = '不是 JSON', group_keys = '{' WHERE id = ?1",
            [id],
        )
        .unwrap();
        let hub = GrabHub::new();
        let s = snapshot(&conn, &hub).unwrap();
        assert_eq!(s.intents.len(), 1);
        assert!(s.intents[0].candidates.is_empty());
        assert!(s.intents[0].group_keys.is_empty());
    }
}
