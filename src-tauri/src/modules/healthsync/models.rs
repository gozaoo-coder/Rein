//! 第三方健康数据域的数据结构。
//!
//! 三层形状，别混：
//! - [`HcExerciseRecord`] / [`HcWriteDraft`]：**与 Kotlin 桥之间的 JSON**。
//!   时间是 epoch 毫秒 + 偏移秒数（不是字符串）—— 时区换算留在本侧做，
//!   见 [`super::adapter`]；Kotlin 只负责把 `java.time` 摊平成数字。
//! - [`WorkoutDraft`]：**翻译适配层的产物**，已经是 Rein 的字段语义
//!   （本地日期、当日分钟、中文名、MET 档位），但还没有 id。
//! - [`SyncReport`] / [`SyncStatus`]：给前端的回执。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/* ---------------- Kotlin → Rust：读到的 HC 记录 ---------------- */

/// Health Connect 的一条 `ExerciseSessionRecord`，外加同时间窗配到的消耗/距离/步数。
///
/// 为什么把 kcal/距离/步数挂在会话上：HC 里它们是**各自独立的记录类型**
/// （`TotalCaloriesBurnedRecord` / `DistanceRecord` / `StepsRecord`），
/// 与运动会话之间没有外键，只能按时间重叠配对。配对在 Kotlin 侧做（那边才有
/// 全部记录），本侧只管收结果 —— `None` 表示没配到，不是 0。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HcExerciseRecord {
    /// `metadata.id`：HC 侧的记录 UUID，就是导入记录的 `external_id`
    pub id: String,
    /// `ExerciseSessionRecord.EXERCISE_TYPE_*` 整数
    pub exercise_type: i64,
    pub title: Option<String>,
    pub notes: Option<String>,
    pub start_epoch_ms: i64,
    pub end_epoch_ms: i64,
    /// 记录写入时的 UTC 偏移（秒）。用它把 epoch 摊成「用户当时看到的墙上时间」
    pub utc_offset_seconds: i64,
    /// `metadata.lastModifiedTime`：变化判定用
    pub last_modified_epoch_ms: Option<i64>,
    /// `metadata.dataOrigin.packageName`（如 com.mi.health）：来源可追溯
    pub data_origin: Option<String>,
    pub kcal: Option<f64>,
    pub distance_m: Option<f64>,
    pub avg_heart_rate: Option<f64>,
}

/// Kotlin 侧一次读取的返回体
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HcReadPayload {
    pub records: Vec<HcExerciseRecord>,
    /// 按天聚合的体征指标行（Kotlin 侧逐项按授权放行读取后聚合）。
    /// 旧桥只写 records，`default` 让旧文件照样能解析。
    #[serde(default)]
    pub metrics: Vec<HcMetricRow>,
}

/// Health Connect 按天聚合好的一条体征值（Kotlin 产出，见 Kotlin `readMetrics`）。
///
/// `metric` id 与 Kotlin 桥、前端 `src/config/healthMetrics.ts` 三方同名——
/// 改一处就得改三处；`day` 是**记录自己时区**的本地日期（睡眠归「醒来那天」）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HcMetricRow {
    pub metric: String,
    pub day: String,
    pub value: f64,
}

/* ---------------- Rust → Kotlin：要写进 HC 的记录 ---------------- */

/// 要写进 Health Connect 的一条运动会话。
///
/// `client_record_id` 是幂等的关键：Rein 用自己的本地 id 生成（`rein-workout-<id>`），
/// HC 侧按它去重；改一条已导出的记录时先按它删、再插（见 Kotlin 侧的 deleteRecords 用法），
/// 而不是指望「同 id 高版本覆盖」那种不确定的语义。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HcWriteDraft {
    pub client_record_id: String,
    pub exercise_type: i64,
    pub title: String,
    pub notes: Option<String>,
    pub start_epoch_ms: i64,
    pub end_epoch_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HcWritePayload {
    pub records: Vec<HcWriteDraft>,
}

/* ---------------- 适配层产物 ---------------- */

/// 翻译后的 Rein 侧运动记录（无 id，尚未落库）
#[derive(Debug, Clone, PartialEq)]
pub struct WorkoutDraft {
    pub name: String,
    pub workout_type: String,
    /// 本地日期 `YYYY-MM-DD`（按记录自己的偏移折算，不是本机当前时区）
    pub date: String,
    /// 当日零点起的分钟数（与 `workouts.start_min` 同口径）
    pub start_min: Option<i64>,
    pub duration_min: f64,
    pub kcal: f64,
    pub intensity: String,
    pub note: Option<String>,
}

/// 落库现状（变化判定的输入）
#[derive(Debug, Clone)]
pub struct LocalWorkout {
    pub id: i64,
    pub source: String,
    pub external_id: Option<String>,
    /// 导入记录：HC 侧 lastModified；导出记录：本机写入 HC 的时刻
    pub external_updated_at: Option<i64>,
    /// 导出记录：上次写进 HC 的内容指纹（见 db.rs MIGRATION_0036）
    pub external_fingerprint: Option<String>,
    pub draft: WorkoutDraft,
}

/// 变化判定
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// 本地没有 → 插入
    Insert,
    /// 本地有但内容变了 → 覆盖（HC 是导入记录的权威源）
    Update,
    /// 完全一致 → 不动
    Unchanged,
}

/* ---------------- 回执 ---------------- */

/// 一次同步做了什么。前端用它做「已同步 N 条 / 更新 N 条 / 移除 N 条」的反馈。
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// HC → Rein：新导入
    pub imported: i64,
    /// HC → Rein：按 HC 侧变更覆盖
    pub updated: i64,
    /// HC → Rein：HC 里已删除，本地镜像跟着收掉
    pub removed: i64,
    /// Rein → HC：本地记录导出（新建）
    pub exported: i64,
    /// Rein → HC：导出过的记录内容变了，重写
    pub re_exported: i64,
    /// Rein → HC：删除本地记录时收掉的 HC 副本
    pub unexported: i64,
    /// Rein → HC：没有开始时间、在 HC 里无处安放的本地记录（逐条计数，不静默吞掉）
    pub skipped: i64,
    /// 读到的 HC 记录总数（含未变化的），用于区分「没数据」和「没授权」
    pub scanned: i64,
    /// 本次落库的体征指标行数（按天聚合后的行，不是 HC 原始记录数）
    #[serde(default)]
    pub metrics_imported: i64,
    /// 本次同步是否跑了导出方向（开关关着就是 false）
    pub pushed: bool,
}

/// 设备/授权状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// 当前平台是否可能支持（Android 之外一律 false）
    pub supported: bool,
    /// Health Connect 可用性：unavailable / update_required / available
    pub availability: String,
    /// Rein 是否已拿到读授权
    pub read_granted: bool,
    /// Rein 是否已拿到写授权
    pub write_granted: bool,
    /// 四组读权限各自是否齐全（exercise / activity / body / vitals）。
    /// 键由 Kotlin 桥定（`grantedCategories`），旧桥没有这份时是空表 ——
    /// 前端对「缺键」按未授权处理，引导用户去补。
    pub granted_categories: HashMap<String, bool>,
    /// 是否把本地记录回写进 HC（用户在管理页开的开关）
    pub push_enabled: bool,
    pub last_sync_at: Option<String>,
    /// 已导入的镜像记录数
    pub imported_count: i64,
    /// 已导出到 HC 的本地记录数
    pub exported_count: i64,
}

/* ---------------- 预览查询（health_metrics_recent） ---------------- */

/// 一个指标在回看窗口里某一天的值
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthMetricPoint {
    pub day: String,
    pub value: f64,
}

/// 一个指标的预览序列：窗口内全部有值的天 + 由它们推出的最新值。
/// `latest` 取窗口内**最晚一天**的值（ISO 日期串排序即时间序）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthMetricSeries {
    pub metric: String,
    pub latest_day: String,
    pub latest_value: f64,
    pub points: Vec<HealthMetricPoint>,
}
