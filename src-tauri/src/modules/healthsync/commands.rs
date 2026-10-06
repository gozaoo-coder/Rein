//! Health Connect 双向同步命令。
//!
//! ## 一次同步的四步
//!
//! 1. `health_sync_start`：查授权，清掉上一轮的桥文件，让 Kotlin 去读 HC；
//! 2. 前端每隔几百毫秒调 `health_sync_step`，直到 `phase` 不再是 `pending`；
//! 3. step 里：HC 的记录文件一落地就交给 [`super::adapter`] 翻译，然后落库
//!    （新记录插入、变了的覆盖、HC 里没了的删掉）；
//! 4. 开了「回写 HC」的话，接着把本地记录写出去（新建 / 重写 / 收起已删除的副本），
//!    再等 Kotlin 把 `clientRecordId → recordId` 的结果写回来。
//!
//! 为什么拆成 start + step 而不是一个命令里跑完：HC 的读取是**协程异步**的，
//! 结果只会出现在文件里（见 `super` 的模块说明）。Rust 侧拿不到回调，
//! 只能「轮询文件是否落地」——同步是发后不管的，轮询动作交给前端驱动，
//! 与 `modules/tracking` 的 `tracking_status` 轮询同一个形状。
//!
//! ## 谁能改哪一侧
//!
//! - 导入记录（`source = 'health_connect'`）：**Health Connect 是权威**。
//!   每次同步以 HC 为准覆盖；HC 里没了就跟着删。想在 Rein 里改一条导入记录
//!   而不被下次同步改回去，本期做不到（那需要「转为本地记录」这个动作，见待办）。
//! - 本地记录（`source = 'local'`）：**本机是权威**。只有开了回写开关才会流向 HC，
//!   而且只流一次（靠指纹判断本地改没改过）。
//! - 用户在 Rein 里删掉一条导入记录：本地删 + 记墓碑，**不动 HC 侧那份** ——
//!   那可能是别家 App 写进去的数据，删它等于替用户改了别的 App 的账。
//!   墓碑保证下次同步不会又把它拉回来。

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{meta_get, meta_set};
use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::adapter;
use super::models::{
    Change, HcMetricRow, HcReadPayload, HcWritePayload, HealthMetricPoint, HealthMetricSeries,
    LocalWorkout, SyncReport, SyncStatus, WorkoutDraft,
};
use super::{
    read_json, remove_file, write_json, Pending, Stage, PENDING, PULL_FILE, PUSH_FILE, STATE_FILE,
    WRITE_FILE,
};

/// 「把本地记录也写进 HC」的开关（默认关：那是往外写用户系统健康数据的事，得用户点头）
const PUSH_KEY: &str = "health_sync.push_enabled";
const LAST_SYNC_KEY: &str = "health_sync.last_sync_at";

/// 单步等待上限：Kotlin 侧异常时文件不会落地，靠它收场而不是无限轮询
const STEP_TIMEOUT: Duration = Duration::from_secs(45);

/* ---------------- 桥文件形状 ---------------- */

/// Kotlin 写的 `state.json`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeState {
    /// `available` / `unavailable` / `update_required`
    availability: String,
    read_granted: bool,
    write_granted: bool,
    /// 四组读权限各自是否齐全（exercise/activity/body/vitals）。
    /// 旧桥没有这份 → 空表，前端按「未授权」引导。
    #[serde(default)]
    granted_categories: HashMap<String, bool>,
    /// 上一轮操作的失败原因（Kotlin 每次开新操作会清掉）
    #[serde(default)]
    error: Option<String>,
}

/// Kotlin 写的 `push-result.json`
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushResult {
    #[serde(default)]
    results: Vec<PushLink>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushLink {
    client_record_id: String,
    record_id: String,
}

/* ---------------- 回执 ---------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep {
    /// `unsupported` / `unavailable` / `needs_auth` / `pending` / `done` / `error`
    pub phase: &'static str,
    pub report: Option<SyncReport>,
    pub message: Option<String>,
}

impl SyncStep {
    fn phase(phase: &'static str) -> Self {
        Self {
            phase,
            report: None,
            message: None,
        }
    }
}

/* ---------------- 命令 ---------------- */

/// 平台/授权/开关/计数的一次性快照。
///
/// 会顺手让 Kotlin 重算一遍授权（用户在系统里撤销授权时 Rein 不会收到通知），
/// 所以第一次调用可能读到稍旧的值 —— 前端轮询一次就收敛了。
#[tauri::command]
pub fn health_sync_status(
    app: tauri::AppHandle,
    webview: tauri::Webview<tauri::Wry>,
    state: State<AppState>,
) -> Result<SyncStatus> {
    if supported() {
        super::dispatch(&webview, "refresh", None);
    }
    let bridge: Option<BridgeState> = read_json(&app, STATE_FILE);
    let conn = state.db.lock();
    let imported_count = count(&conn, "source = 'health_connect'")?;
    let exported_count = count(&conn, "external_id IS NOT NULL AND source = 'local'")?;
    Ok(SyncStatus {
        supported: supported(),
        // 读取授权要走 HC 的 binder，只能在协程里算，所以 state.json 是**异步**写出来的。
        // 页面刚进来时它可能还不存在 —— 那时报 `unknown` 而不是 `unavailable`：
        // 把「还没检测」说成「不可用」等于对用户撒谎（实测过，首次进入会误报不可用，
        // 退出再进就正常了）。前端对 `unknown` 轮询几次收敛到真值。
        availability: bridge
            .as_ref()
            .map(|b| b.availability.clone())
            .unwrap_or_else(|| "unknown".into()),
        read_granted: bridge.as_ref().map(|b| b.read_granted).unwrap_or(false),
        write_granted: bridge.as_ref().map(|b| b.write_granted).unwrap_or(false),
        granted_categories: bridge
            .as_ref()
            .map(|b| b.granted_categories.clone())
            .unwrap_or_default(),
        push_enabled: push_enabled(&conn),
        last_sync_at: meta_get(&conn, LAST_SYNC_KEY),
        imported_count,
        exported_count,
    })
}

/// 拉起 Health Connect 自己的授权页。
///
/// `mode` = `read` 只要读权限，`write` 要读 + 写。
/// **这里不能用系统运行时权限弹窗**：HC 的权限没有 `requestPermissions` 那条路，
/// 只能在 HC 的界面上授予（这也是「引导用户去授权」这件事在本域必须存在的原因）。
#[tauri::command]
pub fn health_sync_authorize(
    webview: tauri::Webview<tauri::Wry>,
    mode: String,
) -> Result<()> {
    if !supported() {
        return Err(ReinError::coded("health_unsupported", "桌面端没有 Health Connect"));
    }
    super::dispatch(&webview, "requestPermissions", Some(mode));
    Ok(())
}

/// 开关「把本地记录回写进 Health Connect」
#[tauri::command]
pub fn health_sync_set_push(
    webview: tauri::Webview<tauri::Wry>,
    state: State<AppState>,
    enabled: bool,
) -> Result<()> {
    let conn = state.db.lock();
    meta_set(&conn, PUSH_KEY, if enabled { "1" } else { "0" })?;
    drop(conn);
    // 打开开关时立刻刷一次状态：前端要马上知道还要不要去申请写权限
    if supported() {
        super::dispatch(&webview, "refresh", None);
    }
    Ok(())
}

/// 起一轮同步（不阻塞）。返回 `pending` 就表示已经让 Kotlin 去读了。
#[tauri::command]
pub fn health_sync_start(
    app: tauri::AppHandle,
    webview: tauri::Webview<tauri::Wry>,
    state: State<AppState>,
    push: bool,
    max_hr: Option<f64>,
    utc_offset_seconds: i64,
) -> Result<SyncStep> {
    if !supported() {
        return Ok(SyncStep::phase("unsupported"));
    }
    // 上一轮没走完就被再点一次：直接丢弃旧态，重新开始
    *PENDING.lock().unwrap() = None;

    let bridge: Option<BridgeState> = read_json(&app, STATE_FILE);
    let Some(bridge) = bridge else {
        return Ok(SyncStep::phase("unavailable"));
    };
    if bridge.availability != "available" {
        return Ok(SyncStep::phase("unavailable"));
    }
    if !bridge.read_granted {
        return Ok(SyncStep::phase("needs_auth"));
    }
    let push = push && bridge.write_granted;
    if push {
        let conn = state.db.lock();
        meta_set(&conn, PUSH_KEY, "1")?;
    }

    // 文件即信号：清掉旧的，等 Kotlin 写新的那份（见模块说明）
    remove_file(&app, PULL_FILE);
    remove_file(&app, PUSH_FILE);
    *PENDING.lock().unwrap() = Some(Pending {
        stage: Stage::PollPull,
        report: SyncReport {
            pushed: push,
            ..Default::default()
        },
        push,
        max_hr,
        utc_offset_seconds,
        started: Instant::now(),
    });
    super::dispatch(&webview, "startRead", None);
    Ok(SyncStep::phase("pending"))
}

/// 推进一轮同步。前端按几百毫秒的间隔轮询，直到 `phase` 不是 `pending`。
#[tauri::command]
pub fn health_sync_step(
    app: tauri::AppHandle,
    webview: tauri::Webview<tauri::Wry>,
    state: State<AppState>,
) -> Result<SyncStep> {
    let mut dispatches: Vec<(&'static str, Option<String>)> = Vec::new();
    let outcome;
    {
        let mut guard = PENDING.lock().unwrap();
        let Some(pending) = guard.as_mut() else {
            return Ok(SyncStep::phase("idle"));
        };

        let bridge: Option<BridgeState> = read_json(&app, STATE_FILE);
        if let Some(err) = bridge.as_ref().and_then(|b| b.error.clone()) {
            *guard = None;
            return Ok(SyncStep {
                phase: "error",
                report: None,
                message: Some(err),
            });
        }

        match pending.stage {
            Stage::PollPull => {
                let Some(payload) = read_json::<HcReadPayload>(&app, PULL_FILE) else {
                    if pending.started.elapsed() > STEP_TIMEOUT {
                        *guard = None;
                        return Ok(SyncStep {
                            phase: "error",
                            report: None,
                            message: Some(超时文案()),
                        });
                    }
                    return Ok(SyncStep::phase("pending"));
                };
                remove_file(&app, PULL_FILE);
                // 这一步之后 report 里已经有 imported/updated/removed/scanned
                let (counts, metrics_imported) = {
                    let conn = state.db.lock();
                    let counts = apply_pull(&conn, &payload, pending.max_hr)?;
                    let metrics = apply_metrics(&conn, &payload.metrics)?;
                    (counts, metrics)
                };
                pending.report.imported = counts.imported;
                pending.report.updated = counts.updated;
                pending.report.removed = counts.removed;
                pending.report.scanned = payload.records.len() as i64;
                pending.report.metrics_imported = metrics_imported;

                if pending.push {
                    let (payload, exported, re_exported, skipped) = {
                        let conn = state.db.lock();
                        build_push(&conn, pending.utc_offset_seconds)?
                    };
                    pending.report.exported = exported;
                    pending.report.re_exported = re_exported;
                    pending.report.skipped = skipped;
                    if payload.records.is_empty() {
                        pending.stage = Stage::Done;
                    } else {
                        write_json(&app, WRITE_FILE, &payload)?;
                        remove_file(&app, PUSH_FILE);
                        pending.started = Instant::now();
                        pending.stage = Stage::PollPush;
                        dispatches.push(("startWrite", None));
                    }
                } else {
                    pending.stage = Stage::Done;
                }
            }
            Stage::PollPush => {
                let Some(result) = read_json::<PushResult>(&app, PUSH_FILE) else {
                    if pending.started.elapsed() > STEP_TIMEOUT {
                        *guard = None;
                        return Ok(SyncStep {
                            phase: "error",
                            report: None,
                            message: Some(超时文案()),
                        });
                    }
                    return Ok(SyncStep::phase("pending"));
                };
                remove_file(&app, PUSH_FILE);
                if let Some(err) = result.error {
                    *guard = None;
                    return Ok(SyncStep {
                        phase: "error",
                        report: None,
                        message: Some(err),
                    });
                }
                {
                    let conn = state.db.lock();
                    apply_push_links(&conn, &result.results)?;
                }
                pending.stage = Stage::Done;
            }
            Stage::Done => {}
        }

        if matches!(pending.stage, Stage::Done) {
            let done = guard.take().unwrap();
            let conn = state.db.lock();
            meta_set(&conn, LAST_SYNC_KEY, &chrono::Utc::now().to_rfc3339())?;
            drop(conn);
            outcome = SyncStep {
                phase: "done",
                report: Some(done.report),
                message: None,
            };
        } else {
            outcome = SyncStep::phase("pending");
        }
    }
    // JNI 一律在锁外发：dispatch 会切到 WebView 主线程，持有 PENDING 锁时切线程
    // 万一撞上重入就是死锁（同 modules/tracking 的取舍）
    for (method, arg) in dispatches {
        super::dispatch(&webview, method, arg);
    }
    Ok(outcome)
}

/// 健康数据查询：每个指标的**全量**镜像序列（近 90 天窗口、含空天）。
///
/// 预览卡与指标详情抽屉共用这一份：前者自己切最近 14 天的窗口画条形，
/// 后者把全部行当 raw 数据列表展示。行数 = 指标数 × 有值的天数（≤ 16×90），
/// 量级很小，不分页。
#[tauri::command]
pub fn health_metrics_all(state: State<AppState>) -> Result<Vec<HealthMetricSeries>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT metric, day, value FROM health_metrics ORDER BY metric, day",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // ORDER BY metric, day → 同一指标必然连续出现，按「相邻同 metric」分桶；
    // latest 取最晚一天（ISO 日期串排序即时间序）
    let mut series: Vec<HealthMetricSeries> = Vec::new();
    for (metric, day, value) in rows {
        match series.last_mut() {
            Some(s) if s.metric == metric => {
                s.latest_day = day.clone();
                s.latest_value = value;
                s.points.push(HealthMetricPoint { day, value });
            }
            _ => series.push(HealthMetricSeries {
                metric,
                latest_day: day.clone(),
                latest_value: value,
                points: vec![HealthMetricPoint { day, value }],
            }),
        }
    }
    Ok(series)
}

/// 移除传播：删掉某条导出记录的 HC 副本（由 `delete_workout` 调用）
pub(crate) fn propagate_delete(webview: &tauri::Webview<tauri::Wry>, record_id: &str) {
    super::dispatch(webview, "deleteRecord", Some(record_id.to_string()));
}

/// 打开回写开关了吗
pub(crate) fn is_push_enabled(conn: &rusqlite::Connection) -> bool {
    push_enabled(conn)
}

/// 记一条墓碑：用户在本机删掉的导入记录，下次同步别再拉回来
pub(crate) fn add_tombstone(conn: &rusqlite::Connection, external_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO health_sync_tombstones (external_id, deleted_at) VALUES (?1, ?2) \
         ON CONFLICT(external_id) DO UPDATE SET deleted_at = excluded.deleted_at",
        rusqlite::params![external_id, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/* ---------------- 算法 ---------------- */

/// 体征镜像整表替换：表的内容 = 本次 pull 里按天聚合的行。
///
/// 为什么不做增量合并：Kotlin 每轮都全窗口（90 天）重读，收到的集合就是
/// HC 侧「现在该有什么」的完整答案 —— 直接替换，撤销授权的那组、用户在
/// HC 里删掉的某天数据，下一次同步自然消失，不必另立一套墓碑。
/// 表里也可能有 `metric`/`day` 相同的重复行（Kotlin 聚合的兜底），upsert 收口。
fn apply_metrics(conn: &rusqlite::Connection, rows: &[HcMetricRow]) -> Result<i64> {
    conn.execute("DELETE FROM health_metrics", [])?;
    let now = chrono::Utc::now().to_rfc3339();
    for row in rows {
        conn.execute(
            "INSERT INTO health_metrics (metric, day, value, updated_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(metric, day) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![row.metric, row.day, row.value, now],
        )?;
    }
    Ok(rows.len() as i64)
}


fn supported() -> bool {
    cfg!(target_os = "android")
}

fn 超时文案() -> String {
    "Health Connect 没有在预期时间内返回结果，请重试".to_string()
}

fn push_enabled(conn: &rusqlite::Connection) -> bool {
    meta_get(conn, PUSH_KEY).as_deref() == Some("1")
}

fn count(conn: &rusqlite::Connection, filter: &str) -> Result<i64> {
    let sql = format!("SELECT COUNT(*) FROM workouts WHERE {filter}");
    Ok(conn.query_row(&sql, [], |r| r.get(0))?)
}

/// 只在导入方向动的三个计数
#[derive(Debug, Default)]
struct PullCounts {
    imported: i64,
    updated: i64,
    removed: i64,
}

/// 读出来的 HC 记录怎么落到 `workouts`。
///
/// 三条规则，对应三种「变化」：
/// - 本地没有 → 插入（`imported`）
/// - 本地有、内容变了 → 覆盖（`updated`）
/// - HC 里没有了、本地却还有镜像 → 删掉（`removed`）
///
/// 最后一条是**基于「本次读全了」的前提**：Kotlin 是「从有记录以来」读的，
/// 所以 `seen` 就是 HC 侧的完整集合。读失败时不会走到这里（文件不会落地）。
fn apply_pull(
    conn: &rusqlite::Connection,
    payload: &HcReadPayload,
    max_hr: Option<f64>,
) -> Result<PullCounts> {
    let mut counts = PullCounts::default();
    let local = load_by_external_id(conn)?;
    let tombstones = load_tombstones(conn)?;
    let mut seen: HashSet<String> = HashSet::new();

    for rec in &payload.records {
        // 自己写进去的那份不算第三方数据（否则导出方向会变成回环）
        if adapter::is_own_export(rec) {
            continue;
        }
        if tombstones.contains(&rec.id) {
            continue;
        }
        seen.insert(rec.id.clone());

        let draft = adapter::to_draft(rec, max_hr);
        match adapter::classify(local.get(&rec.id), &draft, rec.last_modified_epoch_ms) {
            Change::Insert => {
                insert_imported(conn, &rec.id, rec.last_modified_epoch_ms, &draft)?;
                counts.imported += 1;
            }
            Change::Update => {
                let existing = local.get(&rec.id).expect("classify 说 Update，本地必然有");
                update_workout(conn, existing.id, &draft)?;
                conn.execute(
                    "UPDATE workouts SET external_updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![rec.last_modified_epoch_ms, existing.id],
                )?;
                counts.updated += 1;
            }
            Change::Unchanged => {}
        }
    }

    // 镜像回收：HC 侧已经删掉的记录，本地这份也收掉
    for id in seen_superset(&local, &seen) {
        conn.execute("DELETE FROM workouts WHERE id = ?1", [id])?;
        counts.removed += 1;
    }

    // 断链：本地记录（已导出过）在 HC 侧的那份被删了 —— 用户在小米运动健康里删掉、
    // 或换了健康 App —— 把外键清掉，让它下一轮重新导出去，
    // 而不是永远指着一个不存在的 id（那条记录此后既更新不了也删不掉）。
    // 这里要用**未过滤**的全集：自己写出去的那份也在里面（它排在 seen 之外）。
    let all_hc_ids: HashSet<&str> = payload.records.iter().map(|r| r.id.as_str()).collect();
    for lw in local.values() {
        if lw.source != "local" {
            continue;
        }
        let dangling = lw
            .external_id
            .as_deref()
            .map(|ext| !all_hc_ids.contains(ext))
            .unwrap_or(false);
        if dangling {
            conn.execute(
                "UPDATE workouts SET external_id = NULL, external_updated_at = NULL, \
                 external_fingerprint = NULL WHERE id = ?1",
                [lw.id],
            )?;
        }
    }
    Ok(counts)
}

/// 需要回收的本地镜像 id 列表（只碰 `source = 'health_connect'` 的行）
fn seen_superset(local: &HashMap<String, LocalWorkout>, seen: &HashSet<String>) -> Vec<i64> {
    local
        .values()
        .filter(|lw| {
            lw.source == "health_connect"
                && lw
                    .external_id
                    .as_deref()
                    .map(|ext| !seen.contains(ext))
                    .unwrap_or(false)
        })
        .map(|lw| lw.id)
        .collect()
}

/// 本地要往 HC 写哪些记录：没导出过的（新建）+ 指纹变了的（重写）。
///
/// 返回 `(载荷, 新建数, 重写数, 跳过数)`。跳过的是没有开始时间的记录 ——
/// HC 必须有起止时刻，而 Rein 的手动补录允许不填时间；与其编一个假时刻，
/// 不如不写并如实告诉用户跳了几条。
fn build_push(
    conn: &rusqlite::Connection,
    utc_offset_seconds: i64,
) -> Result<(HcWritePayload, i64, i64, i64)> {
    let locals = load_local_only(conn)?;
    let mut records = Vec::new();
    let mut exported = 0;
    let mut re_exported = 0;
    let mut skipped = 0;
    for lw in &locals {
        let fingerprint = adapter::fingerprint_of(&lw.draft);
        let is_new = lw.external_id.is_none();
        if !is_new && lw.external_fingerprint.as_deref() == Some(fingerprint.as_str()) {
            continue; // 本地没动过，HC 侧那份也就不用重写
        }
        match adapter::to_write_draft(lw, utc_offset_seconds) {
            Some(draft) => {
                records.push(draft);
                if is_new {
                    exported += 1;
                } else {
                    re_exported += 1;
                }
            }
            None => skipped += 1,
        }
    }
    Ok((HcWritePayload { records }, exported, re_exported, skipped))
}

/// 把 Kotlin 写回来的 recordId 记到本地记录上（连同内容指纹）
fn apply_push_links(conn: &rusqlite::Connection, links: &[PushLink]) -> Result<()> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    for link in links {
        // `rein-workout-<id>` → id
        let Some(id) = link
            .client_record_id
            .strip_prefix("rein-workout-")
            .and_then(|s| s.parse::<i64>().ok())
        else {
            continue;
        };
        let fingerprint: Option<String> = conn
            .query_row(
                &format!("SELECT {LOCAL_COLS} FROM workouts WHERE id = ?1"),
                [id],
                |row| row_to_local(row).map(|lw| adapter::fingerprint_of(&lw.draft)),
            )
            .ok();
        let Some(fingerprint) = fingerprint else {
            continue;
        };
        conn.execute(
            "UPDATE workouts SET external_id = ?1, external_updated_at = ?2, external_fingerprint = ?3 \
             WHERE id = ?4",
            rusqlite::params![link.record_id, now_ms, fingerprint, id],
        )?;
    }
    Ok(())
}

/* ---------------- 落库 ---------------- */

/// `LocalWorkout` 的 SELECT 列清单（顺序必须与 [`row_to_local`] 一致）
const LOCAL_COLS: &str = "name, type, date, start_min, duration_min, kcal, intensity, note, \
                          source, external_id, external_updated_at, external_fingerprint, id";

fn row_to_local(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalWorkout> {
    // `external_updated_at` 在表上是 TEXT 列（见 db.rs MIGRATION_0036），而本模块
    // 写入的是毫秒数 —— SQLite 的 TEXT 亲和性会把整数转成文本存进去。所以读它
    // **必须**按 String 读再自己 parse：直接按 Option<i64> 读，第二次同步就会
    // 抛 InvalidColumnType(Text)（第一次同步这些列还是 NULL，所以第一次永远
    // 是好的，坏在第二次 —— 实测过一次，极难当场想到往类型亲和性上想）。
    let external_updated_at: Option<i64> = row
        .get::<_, Option<String>>(10)?
        .and_then(|s| s.parse::<i64>().ok());
    Ok(LocalWorkout {
        draft: WorkoutDraft {
            name: row.get(0)?,
            workout_type: row.get(1)?,
            date: row.get(2)?,
            start_min: row.get(3)?,
            duration_min: row.get(4)?,
            kcal: row.get(5)?,
            intensity: row.get(6)?,
            note: row.get(7)?,
        },
        source: row.get(8)?,
        external_id: row.get(9)?,
        external_updated_at,
        external_fingerprint: row.get(11)?,
        id: row.get(12)?,
    })
}

fn load_by_external_id(conn: &rusqlite::Connection) -> Result<HashMap<String, LocalWorkout>> {
    let sql = format!("SELECT {LOCAL_COLS} FROM workouts WHERE external_id IS NOT NULL");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_to_local)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|lw| lw.external_id.clone().map(|ext| (ext, lw)))
        .collect())
}

fn load_local_only(conn: &rusqlite::Connection) -> Result<Vec<LocalWorkout>> {
    let sql = format!("SELECT {LOCAL_COLS} FROM workouts WHERE source = 'local'");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_to_local)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn load_tombstones(conn: &rusqlite::Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT external_id FROM health_sync_tombstones")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().collect())
}

/// 插入一条导入记录。
///
/// `effort` 留空：那是「用户自己说的累不累」，第三方数据里没有这一项，
/// 而 `intensity` 是适配层从心率/配速算出来的客观档位 —— 两者不混。
fn insert_imported(
    conn: &rusqlite::Connection,
    external_id: &str,
    last_modified_epoch_ms: Option<i64>,
    draft: &WorkoutDraft,
) -> Result<()> {
    conn.execute(
        "INSERT INTO workouts \
         (name, type, date, start_min, duration_min, kcal, intensity, effort, note, \
          source, external_id, external_updated_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, 'health_connect', ?9, ?10, ?11)",
        rusqlite::params![
            draft.name,
            draft.workout_type,
            draft.date,
            draft.start_min,
            draft.duration_min,
            draft.kcal,
            draft.intensity,
            draft.note,
            external_id,
            last_modified_epoch_ms,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn update_workout(conn: &rusqlite::Connection, id: i64, draft: &WorkoutDraft) -> Result<()> {
    conn.execute(
        "UPDATE workouts SET name = ?1, type = ?2, date = ?3, start_min = ?4, duration_min = ?5, \
         kcal = ?6, intensity = ?7, note = ?8 WHERE id = ?9",
        rusqlite::params![
            draft.name,
            draft.workout_type,
            draft.date,
            draft.start_min,
            draft.duration_min,
            draft.kcal,
            draft.intensity,
            draft.note,
            id,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn draft() -> WorkoutDraft {
        WorkoutDraft {
            name: "跑步".into(),
            workout_type: "run".into(),
            date: "2026-10-03".into(),
            start_min: Some(12 * 60 + 24),
            duration_min: 30.0,
            kcal: 422.0,
            intensity: "moderate".into(),
            note: None,
        }
    }

    /// 回归：`external_updated_at` 列亲和性是 TEXT，而本模块写入的是整数毫秒
    /// —— SQLite 会把它转成文本存。按 i64 读，第二次同步必抛
    /// InvalidColumnType(Text)（第一次这些列还是 NULL，所以第一次永远没事，
    /// 坏在第二次）。正确读法是按 String 读再 parse。
    #[test]
    fn external_updated_at_survives_the_text_column() {
        let conn = db();
        // 一条本地补录记录（source 走默认 'local'，与 create_workout 同形）
        conn.execute(
            "INSERT INTO workouts (name, type, date, start_min, duration_min, kcal, \
             intensity, effort, note, created_at) \
             VALUES ('跑步', 'run', '2026-10-03', 744, 30, 422, 'moderate', NULL, NULL, ?1)",
            rusqlite::params![chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();

        // 导出回填（apply_push_links 写入的是 i64 毫秒）
        apply_push_links(
            &conn,
            &[PushLink {
                client_record_id: "rein-workout-1".into(),
                record_id: "rec-1".into(),
            }],
        )
        .unwrap();

        // **下一次**同步的读取必须成功，且毫秒数原样取回
        let local = load_local_only(&conn).unwrap();
        assert_eq!(local.len(), 1, "本地记录应仍可读");
        // apply_push_links 写的是「当前时刻」，断言它被取回且是合理的毫秒数
        let ms = local[0].external_updated_at.expect("应写入了回填时刻");
        assert!(ms > 1_700_000_000_000, "毫秒数不合理：{ms}");
        assert_eq!(local[0].draft.start_min, Some(12 * 60 + 24));

        let by_ext = load_by_external_id(&conn).unwrap();
        let lw = by_ext.get("rec-1").expect("应按 external_id 找到记录");
        assert_eq!(lw.external_updated_at, Some(ms));
    }

    /// 导入记录同样走 TEXT 列：插入（带整数 lastModified）→ 再读必须成功
    #[test]
    fn imported_rows_survive_the_text_column() {
        let conn = db();
        insert_imported(&conn, "hc-1", Some(1_790_900_000_000_i64), &draft()).unwrap();
        let by_ext = load_by_external_id(&conn).unwrap();
        let lw = by_ext.get("hc-1").expect("应按 external_id 找到导入记录");
        assert_eq!(lw.external_updated_at, Some(1_790_900_000_000));
        assert_eq!(lw.source, "health_connect");
    }

    /// 墓碑 + 幂等键的落库往返
    #[test]
    fn tombstones_round_trip() {
        let conn = db();
        add_tombstone(&conn, "hc-9").unwrap();
        let set = load_tombstones(&conn).unwrap();
        assert!(set.contains("hc-9"));
    }

    /// 体征镜像是整表替换：上一轮的行不能混进下一轮
    /// （撤销授权的组、HC 侧删掉的某天，靠替换自然收敛）
    #[test]
    fn metrics_mirror_fully_replaces_each_sync() {
        let conn = db();
        let round1 = vec![
            HcMetricRow { metric: "steps".into(), day: "2026-10-05".into(), value: 8421.0 },
            HcMetricRow { metric: "sleep_min".into(), day: "2026-10-05".into(), value: 432.0 },
        ];
        apply_metrics(&conn, &round1).unwrap();
        // 第二轮只读到体重（其余被撤销/删除）
        let round2 = vec![
            HcMetricRow { metric: "weight_kg".into(), day: "2026-10-05".into(), value: 72.5 },
        ];
        apply_metrics(&conn, &round2).unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM health_metrics", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "上一轮的两行不该留下来");

        let (metric, value): (String, f64) = conn
            .query_row(
                "SELECT metric, value FROM health_metrics WHERE day = '2026-10-05'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(metric, "weight_kg");
        assert!((value - 72.5).abs() < f64::EPSILON);
    }

    /// 旧桥的 pull.json 没有 metrics 字段，serde default 必须兜住
    #[test]
    fn pull_payload_metrics_are_optional() {
        let payload: HcReadPayload = serde_json::from_str(r#"{"records":[]}"#).unwrap();
        assert!(payload.records.is_empty());
        assert!(payload.metrics.is_empty());

        let with: HcReadPayload = serde_json::from_str(
            r#"{"records":[],"metrics":[{"metric":"steps","day":"2026-10-05","value":100.0}]}"#,
        )
        .unwrap();
        assert_eq!(with.metrics.len(), 1);
        assert_eq!(with.metrics[0].metric, "steps");
    }
}
