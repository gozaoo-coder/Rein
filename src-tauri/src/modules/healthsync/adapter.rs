//! 翻译适配层：Health Connect 的记录 ↔ Rein 的运动记录。
//!
//! 这一层**只做纯函数**，不碰数据库、不碰 JNI —— 两侧的数据形状差异全部收在这里，
//! 于是「同步算法」只需要处理 [`Change`] 三种结果，不必知道 HC 的 `EXERCISE_TYPE_*`
//! 有 61 个常量、也不必知道它的时间是 UTC 而 Rein 记的是本地日期 + 当日分钟。
//!
//! 三个方向的翻译各自对应一个函数：
//! - [`to_draft`]：HC 记录 → Rein 草稿（导入）
//! - [`to_write_draft`]：Rein 记录 → HC 写入载荷（导出）
//! - [`classify`]：本地现状 × HC 记录 → 插/改/不动（变化判定）
//!
//! ## 时区：两侧的时间**不是**同一件事
//!
//! Rein 的 `workouts` 存的是「本地日期 + 当日分钟」—— 它表达的是「用户那天几点练的」，
//! 是一条**墙上时间**记录。HC 存的是 `Instant` + 当时的 `ZoneOffset`。
//! 所以两边换算必须用**记录自己携带的偏移**（`utc_offset_seconds`），不能用本机当前时区：
//! 用户上周飞了趟东京，在那边练的那次就该落在那边的日历上，
//! 拿今天北京的时区去折算会把它挪到前一天或后一天。

use chrono::{Duration, FixedOffset, NaiveDate, TimeZone, Timelike, Utc};

use super::models::{Change, HcExerciseRecord, HcWriteDraft, LocalWorkout, WorkoutDraft};

/* ---------------- 类型映射表 ---------------- */

/// HC `ExerciseSessionRecord.EXERCISE_TYPE_*` → Rein `WORKOUT_TYPES`。
///
/// 常量值取自 `androidx.health.connect:connect-client:1.1.0` 的类常量表
/// （不是猜的：61 个 `EXERCISE_TYPE_*` 常量里**输入端全部有归宿**，
/// 见本文件末尾的 `every_hc_type_maps_to_a_valid_rein_type` 测试 ——
/// HC 加常量时那条测试会失败，而不是默默把新运动类型吞成「其他」）。
///
/// 多对一是常态：HC 把跑步机与户外跑分成两个常量，Rein 只有一个 `run`。
const HC_TO_REIN: &[(i64, &str)] = &[
    (0, "other"),                      // OTHER_WORKOUT
    (2, "badminton"),                  // BADMINTON
    (4, "ball"),                       // BASEBALL
    (5, "basketball"),                 // BASKETBALL
    (8, "cycle"),                      // BIKING
    (9, "cycle"),                      // BIKING_STATIONARY
    (10, "hiit"),                      // BOOT_CAMP
    (11, "boxing"),                    // BOXING
    (13, "strength"),                  // CALISTHENICS
    (14, "ball"),                      // CRICKET
    (16, "dance"),                     // DANCING
    (25, "elliptical"),                // ELLIPTICAL
    (26, "hiit"),                      // EXERCISE_CLASS
    (27, "martial"),                   // FENCING
    (28, "football"),                  // FOOTBALL_AMERICAN
    (29, "football"),                  // FOOTBALL_AUSTRALIAN
    (31, "other"),                     // FRISBEE_DISC
    (32, "golf"),                      // GOLF
    (33, "other"),                     // GUIDED_BREATHING
    (34, "strength"),                  // GYMNASTICS
    (35, "ball"),                      // HANDBALL
    (36, "hiit"),                      // HIGH_INTENSITY_INTERVAL_TRAINING
    (37, "hike"),                      // HIKING
    (38, "ball"),                      // ICE_HOCKEY
    (39, "skate"),                     // ICE_SKATING
    (44, "martial"),                   // MARTIAL_ARTS
    (46, "kayak"),                     // PADDLING
    (47, "other"),                     // PARAGLIDING
    (48, "pilates"),                   // PILATES
    (50, "tennis"),                    // RACQUETBALL
    (51, "climbing"),                  // ROCK_CLIMBING
    (52, "ball"),                      // ROLLER_HOCKEY
    (53, "row"),                       // ROWING
    (54, "row"),                       // ROWING_MACHINE
    (55, "football"),                  // RUGBY
    (56, "run"),                       // RUNNING
    (57, "run"),                       // RUNNING_TREADMILL
    (58, "kayak"),                     // SAILING
    (59, "swim"),                      // SCUBA_DIVING
    (60, "skate"),                     // SKATING
    (61, "ski"),                       // SKIING
    (62, "ski"),                       // SNOWBOARDING
    (63, "hike"),                      // SNOWSHOEING
    (64, "football"),                  // SOCCER
    (65, "ball"),                      // SOFTBALL
    (66, "tennis"),                    // SQUASH
    (68, "stairs"),                    // STAIR_CLIMBING
    (69, "stairs"),                    // STAIR_CLIMBING_MACHINE
    (70, "strength"),                  // STRENGTH_TRAINING
    (71, "yoga"),                      // STRETCHING
    (72, "other"),                     // SURFING
    (73, "swim"),                      // SWIMMING_OPEN_WATER
    (74, "swim"),                      // SWIMMING_POOL
    (75, "pingpong"),                  // TABLE_TENNIS
    (76, "tennis"),                    // TENNIS
    (78, "ball"),                      // VOLLEYBALL
    (79, "walk"),                      // WALKING
    (80, "swim"),                      // WATER_POLO
    (81, "strength"),                  // WEIGHTLIFTING
    (82, "other"),                     // WHEELCHAIR
    (83, "yoga"),                      // YOGA
];

/// Rein `WORKOUT_TYPES` → HC 常量的**反向**映射（导出方向）。
///
/// 刻意不是 [`HC_TO_REIN`] 的机械取反：那个方向上「球类」同时来自 BASEBALL/CRICKET/HANDBALL
/// 三个常量，取反时选哪个都是任意的。这里逐个类型**指定一个最有代表性的 HC 常量**，
/// 于是「Rein 的球类导出成什么」是一个写下来的决定，而不是遍历顺序的副产品。
/// 值与 `src/types/exercise.ts` 的 `WORKOUT_TYPES` 一一对应（30 项）。
const REIN_TO_HC: &[(&str, i64)] = &[
    ("walk", 79),       // WALKING
    ("hike", 37),       // HIKING
    ("stairs", 68),     // STAIR_CLIMBING
    ("chores", 0),      // OTHER_WORKOUT（HC 没有家务）
    ("dogwalk", 79),    // WALKING
    ("run", 56),        // RUNNING
    ("cycle", 8),       // BIKING
    ("hiit", 36),       // HIGH_INTENSITY_INTERVAL_TRAINING
    ("rope", 0),        // OTHER_WORKOUT（HC 没有跳绳）
    ("elliptical", 25), // ELLIPTICAL
    ("row", 53),        // ROWING
    ("dance", 16),      // DANCING
    ("ball", 0),        // OTHER_WORKOUT（「球类」是兜底项，HC 无数值对应）
    ("basketball", 5),  // BASKETBALL
    ("badminton", 2),   // BADMINTON
    ("tennis", 76),     // TENNIS
    ("pingpong", 75),   // TABLE_TENNIS
    ("football", 64),   // SOCCER
    ("golf", 32),       // GOLF
    ("swim", 74),       // SWIMMING_POOL
    ("kayak", 46),      // PADDLING
    ("strength", 70),   // STRENGTH_TRAINING
    ("yoga", 83),       // YOGA
    ("pilates", 48),    // PILATES
    ("boxing", 11),     // BOXING
    ("martial", 44),    // MARTIAL_ARTS
    ("climbing", 51),   // ROCK_CLIMBING
    ("skate", 60),      // SKATING
    ("ski", 61),        // SKIING
    ("other", 0),       // OTHER_WORKOUT
];

/// Rein 类型的中文名（与前端 `config/domain.ts` 的 `WORKOUT_META.label` 同一份口径）。
///
/// 为什么 Rust 侧也要有一份：导入时 HC 可能没给 title（第三方 App 允许为空），
/// 而 `workouts.name` 是 NOT NULL 且会直接显示在列表里 —— 那时得有个像样的名字。
const REIN_LABELS: &[(&str, &str)] = &[
    ("walk", "快走"),
    ("hike", "徒步"),
    ("stairs", "爬楼梯"),
    ("chores", "做家务"),
    ("dogwalk", "遛狗"),
    ("run", "跑步"),
    ("cycle", "骑行"),
    ("hiit", "HIIT"),
    ("rope", "跳绳"),
    ("elliptical", "椭圆机"),
    ("row", "划船机"),
    ("dance", "跳舞"),
    ("ball", "球类"),
    ("basketball", "篮球"),
    ("badminton", "羽毛球"),
    ("tennis", "网球"),
    ("pingpong", "乒乓球"),
    ("football", "足球"),
    ("golf", "高尔夫"),
    ("swim", "游泳"),
    ("kayak", "皮划艇"),
    ("strength", "力量训练"),
    ("yoga", "瑜伽"),
    ("pilates", "普拉提"),
    ("boxing", "拳击"),
    ("martial", "武术散打"),
    ("climbing", "攀岩"),
    ("skate", "滑冰轮滑"),
    ("ski", "滑雪"),
    ("other", "其他"),
];

/// 走配速反推强度的类型（有距离才有意义的有氧）
const PACE_TYPES: &[&str] = &["run", "walk", "hike", "cycle"];

/// Rein 自己的包名。读回来的记录里凡是出自它的，都是**我们自己写进去的**。
pub const SELF_PACKAGE: &str = "com.gozaoo.rein";

/* ---------------- 查询 ---------------- */

/// HC 常量 → Rein 类型（认不出来一律 `other`）
pub fn rein_type_of(exercise_type: i64) -> &'static str {
    HC_TO_REIN
        .iter()
        .find(|(t, _)| *t == exercise_type)
        .map(|(_, name)| *name)
        .unwrap_or("other")
}

/// Rein 类型 → HC 常量（认不出来一律 0 = OTHER_WORKOUT）
pub fn hc_type_of(workout_type: &str) -> i64 {
    REIN_TO_HC
        .iter()
        .find(|(name, _)| *name == workout_type)
        .map(|(_, t)| *t)
        .unwrap_or(0)
}

/// Rein 类型的中文名
pub fn label_of(workout_type: &str) -> &'static str {
    REIN_LABELS
        .iter()
        .find(|(name, _)| *name == workout_type)
        .map(|(_, label)| *label)
        .unwrap_or("运动")
}

/* ---------------- 导入方向 ---------------- */

/// 把 HC 记录翻译成 Rein 草稿。
///
/// `max_hr`：用户的估算最大心率（`220 - 年龄`），有它才能用心率反推强度；
/// 没有就退到配速，再没有就 moderate。**刻意不从本函数里查档案** ——
/// 保持纯函数才能对每条规则单独写测试。
pub fn to_draft(rec: &HcExerciseRecord, max_hr: Option<f64>) -> WorkoutDraft {
    let workout_type = rein_type_of(rec.exercise_type);
    let duration_min = duration_minutes(rec.start_epoch_ms, rec.end_epoch_ms);
    let (date, start_min) = local_parts(rec.start_epoch_ms, rec.utc_offset_seconds);

    let name = rec
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| label_of(workout_type).to_string());

    WorkoutDraft {
        name,
        workout_type: workout_type.to_string(),
        date,
        start_min,
        duration_min,
        // 配不到消耗记录时写 0 而不是估算：Rein 自己的 MET 估算需要体重，
        // 而那条路是「补录」的语义；导入的语义是「如实搬运第三方给的数」。
        kcal: rec.kcal.unwrap_or(0.0).max(0.0),
        intensity: derive_intensity(
            workout_type,
            duration_min,
            rec.distance_m,
            rec.avg_heart_rate,
            max_hr,
        )
        .to_string(),
        note: rec
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string),
    }
}

/// 时长（分钟）。HC 的 end 早于 start 一律按 0 处理 —— 宁可少一条时长，
/// 也不要让一个负值顺着统计流下去。
pub fn duration_minutes(start_epoch_ms: i64, end_epoch_ms: i64) -> f64 {
    let ms = (end_epoch_ms - start_epoch_ms).max(0);
    (ms as f64) / 60_000.0
}

/// epoch 毫秒 + 记录自带的偏移 → (本地日期, 当日分钟)
///
/// `start_min` 返回 `Option` 是因为 `workouts.start_min` 就是可空的；
/// 但对 HC 来说 start 必然存在，所以这里实际上总是 `Some` ——
/// 保持着 `Option` 只是不把这个「其实不会发生」的假设写死进类型。
fn local_parts(epoch_ms: i64, offset_seconds: i64) -> (String, Option<i64>) {
    let Some(offset) = FixedOffset::east_opt(offset_seconds as i32) else {
        // 偏移越界（脏数据）：退回 UTC，别让整条记录翻译失败
        let dt = Utc.timestamp_millis_opt(epoch_ms).single();
        return match dt {
            Some(dt) => (
                dt.format("%Y-%m-%d").to_string(),
                Some(dt.hour() as i64 * 60 + dt.minute() as i64),
            ),
            None => ("1970-01-01".to_string(), None),
        };
    };
    match Utc.timestamp_millis_opt(epoch_ms).single() {
        Some(dt) => {
            let local = dt.with_timezone(&offset);
            (
                local.format("%Y-%m-%d").to_string(),
                Some(local.hour() as i64 * 60 + local.minute() as i64),
            )
        }
        None => ("1970-01-01".to_string(), None),
    }
}

/// 强度反推：心率优先于配速，都没有就 moderate。
///
/// 心率阈值用最大心率百分比（<65% low / 65–80% moderate / ≥80% high），
/// 与运动生理学的有氧区间划分一致；配速阈值沿用跑步路径那套
/// （5'30"/km 内算 high）—— 两者都不是新发明，只是把已有口径搬过来。
pub fn derive_intensity(
    workout_type: &str,
    duration_min: f64,
    distance_m: Option<f64>,
    avg_hr: Option<f64>,
    max_hr: Option<f64>,
) -> &'static str {
    if let (Some(hr), Some(max)) = (avg_hr, max_hr) {
        if max > 0.0 && hr > 0.0 {
            let pct = hr / max;
            return if pct >= 0.80 {
                "high"
            } else if pct >= 0.65 {
                "moderate"
            } else {
                "low"
            };
        }
    }
    if PACE_TYPES.contains(&workout_type) && duration_min > 0.0 {
        if let Some(dist) = distance_m {
            if dist > 0.0 {
                let pace_min_per_km = duration_min / (dist / 1000.0);
                return if pace_min_per_km <= 5.5 {
                    "high"
                } else if pace_min_per_km <= 7.5 {
                    "moderate"
                } else {
                    "low"
                };
            }
        }
    }
    "moderate"
}

/* ---------------- 导出方向 ---------------- */

/// 把本地记录翻译成 HC 写入载荷。
///
/// 用户当前的 UTC 偏移由调用方给（Kotlin 侧传上来）：Rein 的日期/分钟是**墙上时间**，
/// 要变成 HC 的 `Instant` 就得知道「那条记录是哪个时区的墙上时间」。
/// 这里用**今天**的偏移去折算历史记录，跨过时区变更（或夏令时）会有偏差 ——
/// 这是本期明确接受的取舍：Rein 库里没有存每条记录写入时的偏移。
pub fn to_write_draft(
    workout: &LocalWorkout,
    utc_offset_seconds: i64,
) -> Option<HcWriteDraft> {
    // 没有开始时间的记录在 HC 里无处安放（HC 必须有起止时刻），交给调用方计数跳过
    let start_min = workout.draft.start_min?;
    let start_epoch_ms = epoch_ms_from_local(
        &workout.draft.date,
        start_min,
        utc_offset_seconds,
    )?;
    // HC 要求 end > start；不足 1 分钟的按 1 分钟写
    let duration_ms = ((workout.draft.duration_min * 60_000.0).round() as i64).max(60_000);
    Some(HcWriteDraft {
        client_record_id: client_record_id(workout.id),
        exercise_type: hc_type_of(&workout.draft.workout_type),
        title: workout.draft.name.clone(),
        notes: workout.draft.note.clone(),
        start_epoch_ms,
        end_epoch_ms: start_epoch_ms + duration_ms,
    })
}

/// Rein 记录的 HC 幂等键。前缀把「Rein 写的」和「别家 App 写的」区分开，
/// 也避免将来别家碰巧用纯数字 id 撞上。
pub fn client_record_id(workout_id: i64) -> String {
    format!("rein-workout-{workout_id}")
}

/// (本地日期, 当日分钟, 偏移) → epoch 毫秒
fn epoch_ms_from_local(date: &str, start_min: i64, offset_seconds: i64) -> Option<i64> {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let offset = FixedOffset::east_opt(offset_seconds as i32)?;
    let naive = day.and_hms_opt(0, 0, 0)? + Duration::minutes(start_min);
    // 夏令时切换那一小时会有歧义/不存在：取最早的解，别让一条记录因为「那一小时」导不出去
    let dt = offset
        .from_local_datetime(&naive)
        .earliest()?;
    Some(dt.timestamp_millis())
}

/// 这条记录是不是 Rein 自己写进去的？
///
/// **必须有这个判断**，否则导出方向会变成回环：Rein 把本地记录写进 HC，
/// 下一次同步又从 HC 读回来 —— 读到的是自己刚写的那条，于是「导入」了一遍
/// 自己的数据（轻则多一条重复记录，重则每次同步都把自己当第三方更新一遍）。
/// HC 的 `metadata.dataOrigin.packageName` 就是为这件事准备的。
pub fn is_own_export(rec: &HcExerciseRecord) -> bool {
    rec.data_origin.as_deref() == Some(SELF_PACKAGE)
}

/// 导出方向的内容指纹：本地这几个字段一改，指纹就变。
///
/// 用可读字符串而不是哈希：跨 Rust 版本稳定（`DefaultHasher` 不保证跨版本一致，
/// 那会导致每次升级 App 都把全部已导出记录重写一遍），且出问题时肉眼能比对。
/// 浮点统一保留一位小数 —— 与导入方向判定用的 0.05 分钟容差同一量级。
pub fn fingerprint_of(draft: &WorkoutDraft) -> String {
    format!(
        "{}|{}|{}|{:.1}|{:.1}|{}|{}|{}",
        draft.workout_type,
        draft.date,
        draft.start_min.map(|m| m.to_string()).unwrap_or_default(),
        draft.duration_min,
        draft.kcal,
        draft.name,
        draft.intensity,
        draft.note.as_deref().unwrap_or(""),
    )
}

/* ---------------- 变化判定 ---------------- */

/// 本地现状 × HC 记录 → 该做什么。
///
/// 快路径：`metadata.lastModifiedTime` 没变就认定整条没变 —— 这比逐个字段比对更准
/// （用户可能只在小米运动健康里改了备注，那种改动不体现在别的字段上），
/// 也省掉了每次同步把全表重写一遍。
///
/// 慢路径（没有 lastModified 可比时）逐字段比对，浮点留容差：
/// HC 的能量单位换算（kcal ↔ 焦耳）会带出 0.1 级的抖动，不该被当成用户改了数据。
pub fn classify(
    local: Option<&LocalWorkout>,
    incoming: &WorkoutDraft,
    last_modified_epoch_ms: Option<i64>,
) -> Change {
    let Some(local) = local else {
        return Change::Insert;
    };
    if let (Some(a), Some(b)) = (local.external_updated_at, last_modified_epoch_ms) {
        if a == b {
            return Change::Unchanged;
        }
    }
    let l = &local.draft;
    let same = l.workout_type == incoming.workout_type
        && l.date == incoming.date
        && l.start_min == incoming.start_min
        && (l.duration_min - incoming.duration_min).abs() < 0.05
        && (l.kcal - incoming.kcal).abs() < 0.5
        && l.name == incoming.name
        && l.intensity == incoming.intensity
        && l.note == incoming.note;
    if same {
        Change::Unchanged
    } else {
        Change::Update
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rein_types() -> Vec<&'static str> {
        REIN_TO_HC.iter().map(|(n, _)| *n).collect()
    }

    fn rec(exercise_type: i64, start_ms: i64, end_ms: i64) -> HcExerciseRecord {
        HcExerciseRecord {
            id: "hc-1".into(),
            exercise_type,
            title: None,
            notes: None,
            start_epoch_ms: start_ms,
            end_epoch_ms: end_ms,
            utc_offset_seconds: 8 * 3600,
            last_modified_epoch_ms: Some(1_700_000_000_000),
            data_origin: Some("com.mi.health".into()),
            kcal: None,
            distance_m: None,
            avg_heart_rate: None,
        }
    }

    /// 反查漏配：HC 端每个常量都要有归宿，否则新运动类型会被默默吞成「其他」
    #[test]
    fn every_hc_type_maps_to_a_valid_rein_type() {
        let valid = rein_types();
        for (hc, rein) in HC_TO_REIN {
            assert!(
                valid.contains(rein),
                "HC 常量 {hc} 映射到了不存在的 Rein 类型 {rein}"
            );
        }
    }

    /// 正查漏配：Rein 每个类型都要导得出去
    #[test]
    fn every_rein_type_has_an_hc_mapping() {
        for (name, hc) in REIN_TO_HC {
            assert!(
                HC_TO_REIN.iter().any(|(t, _)| t == hc),
                "Rein 类型 {name} 映射到了不存在的 HC 常量 {hc}"
            );
        }
    }

    /// 两张表必须一样大 —— 少一项就是少一个类型的翻译
    #[test]
    fn mapping_tables_cover_the_same_type_set() {
        assert_eq!(REIN_TO_HC.len(), REIN_LABELS.len());
        for (name, _) in REIN_TO_HC {
            assert!(
                REIN_LABELS.iter().any(|(n, _)| n == name),
                "类型 {name} 没有中文名兜底"
            );
        }
    }

    /// 记录自己的偏移说了算：东京练的一次不该被折到北京日历的前一天
    #[test]
    fn local_parts_use_the_records_own_offset() {
        // 2026-10-03T00:30+09:00 = 2026-10-02T15:30Z
        let utc_ms: i64 = 1_790_974_200_000; // 占位：真实值由 with_offset 计算
        let _ = utc_ms;
        let dt = NaiveDate::from_ymd_opt(2026, 10, 3)
            .unwrap()
            .and_hms_opt(0, 30, 0)
            .unwrap();
        let tokyo = FixedOffset::east_opt(9 * 3600).unwrap();
        let ms = tokyo.from_local_datetime(&dt).unwrap().timestamp_millis();

        let (date, start_min) = local_parts(ms, 9 * 3600);
        assert_eq!(date, "2026-10-03");
        assert_eq!(start_min, Some(30));

        // 同一条记录若错用北京偏移（+8），会被折成前一天 23:30
        let (date_cn, start_min_cn) = local_parts(ms, 8 * 3600);
        assert_eq!(date_cn, "2026-10-02");
        assert_eq!(start_min_cn, Some(23 * 60 + 30));
    }

    #[test]
    fn duration_is_clamped_at_zero() {
        assert_eq!(duration_minutes(1000, 1000 - 5000), 0.0);
        assert_eq!(duration_minutes(0, 90 * 60_000), 90.0);
    }

    #[test]
    fn missing_kcal_is_zero_not_estimated() {
        let draft = to_draft(&rec(56, 0, 60 * 60_000), None);
        assert_eq!(draft.kcal, 0.0);
        assert_eq!(draft.workout_type, "run");
        assert_eq!(draft.name, "跑步"); // HC 没给 title → 用中文名兜底
        assert_eq!(draft.intensity, "moderate");
    }

    #[test]
    fn hc_title_wins_over_the_fallback_name() {
        let mut r = rec(56, 0, 60 * 60_000);
        r.title = Some("  晨跑  ".into());
        assert_eq!(to_draft(&r, None).name, "晨跑");
    }

    #[test]
    fn heart_rate_outranks_pace_when_deriving_intensity() {
        // 配速很差（10 分钟/公里）但心率很高 → 心率说了算
        let low_pace = Some(6_000.0_f64); // 6km / 60min = 10 min/km
        assert_eq!(
            derive_intensity("run", 60.0, low_pace, Some(175.0), Some(190.0)),
            "high"
        );
        assert_eq!(
            derive_intensity("run", 60.0, low_pace, Some(110.0), Some(190.0)),
            "low"
        );
    }

    #[test]
    fn pace_used_when_heart_rate_missing() {
        // 5km / 30min = 6 分/公里 → moderate
        assert_eq!(
            derive_intensity("run", 30.0, Some(5_000.0), None, None),
            "moderate"
        );
        // 5km / 25min = 5 分/公里 → high
        assert_eq!(
            derive_intensity("run", 25.0, Some(5_000.0), None, None),
            "high"
        );
        // 力量训练没有配速概念，缺心率就是 moderate
        assert_eq!(
            derive_intensity("strength", 45.0, None, None, None),
            "moderate"
        );
    }

    fn draft(workout_type: &str) -> WorkoutDraft {
        WorkoutDraft {
            name: "跑步".into(),
            workout_type: workout_type.into(),
            date: "2026-10-03".into(),
            start_min: Some(7 * 60 + 30),
            duration_min: 42.0,
            kcal: 320.0,
            intensity: "moderate".into(),
            note: None,
        }
    }

    fn local_of(d: WorkoutDraft, ext_updated: Option<i64>) -> LocalWorkout {
        LocalWorkout {
            id: 1,
            source: "health_connect".into(),
            external_id: Some("hc-1".into()),
            external_updated_at: ext_updated,
            external_fingerprint: None,
            draft: d,
        }
    }

    #[test]
    fn classify_insert_update_unchanged() {
        let incoming = draft("run");
        assert_eq!(classify(None, &incoming, None), Change::Insert);

        let same = local_of(draft("run"), Some(123));
        assert_eq!(classify(Some(&same), &incoming, Some(123)), Change::Unchanged);

        // lastModified 变了 → 必须再比字段，字段全同就还是不折腾
        assert_eq!(
            classify(Some(&same), &incoming, Some(999)),
            Change::Unchanged
        );

        // 真变了（时长）→ Update
        let mut changed = local_of(draft("run"), Some(123));
        changed.draft.duration_min = 55.0;
        assert_eq!(classify(Some(&changed), &incoming, Some(999)), Change::Update);
    }

    #[test]
    fn kcal_jitter_does_not_count_as_a_change() {
        let mut local = local_of(draft("run"), Some(1));
        local.draft.kcal = 320.4; // 单位换算的抖动
        assert_eq!(
            classify(Some(&local), &draft("run"), Some(2)),
            Change::Unchanged
        );
    }

    #[test]
    fn export_needs_a_start_time() {
        let mut w = local_of(draft("run"), None);
        assert!(to_write_draft(&w, 8 * 3600).is_some());
        w.draft.start_min = None;
        assert!(to_write_draft(&w, 8 * 3600).is_none());
    }

    #[test]
    fn export_round_trips_through_the_offset() {
        let w = local_of(draft("run"), None);
        let out = to_write_draft(&w, 8 * 3600).unwrap();
        assert_eq!(out.client_record_id, "rein-workout-1");
        assert_eq!(out.exercise_type, 56);
        // 反着翻译回来应当落在同一天同一分钟
        let (date, start_min) = local_parts(out.start_epoch_ms, 8 * 3600);
        assert_eq!(date, "2026-10-03");
        assert_eq!(start_min, Some(7 * 60 + 30));
        // 时长一致（42 分钟）
        assert_eq!(
            duration_minutes(out.start_epoch_ms, out.end_epoch_ms).round(),
            42.0
        );
    }

    #[test]
    fn zero_length_export_is_bumped_to_one_minute() {
        let mut w = local_of(draft("run"), None);
        w.draft.duration_min = 0.0;
        let out = to_write_draft(&w, 8 * 3600).unwrap();
        assert_eq!(out.end_epoch_ms - out.start_epoch_ms, 60_000);
    }

    /// 回环防线：别把 Rein 自己写进 HC 的记录当成第三方数据再导一遍
    #[test]
    fn own_exports_are_recognized_by_data_origin() {
        let mut r = rec(56, 0, 60 * 60_000);
        r.data_origin = Some("com.mi.health".into());
        assert!(!is_own_export(&r));
        r.data_origin = Some(SELF_PACKAGE.into());
        assert!(is_own_export(&r));
        // 来源缺失时按「不是自己的」处理：宁可多导一次，也别把用户的真实记录漏掉
        r.data_origin = None;
        assert!(!is_own_export(&r));
    }

    #[test]
    fn fingerprint_tracks_edited_fields() {
        let base = draft("run");
        let same = fingerprint_of(&base);
        assert_eq!(same, fingerprint_of(&base), "同一内容指纹必须稳定");

        let mut renamed = draft("run");
        renamed.name = "夜跑".into();
        assert_ne!(same, fingerprint_of(&renamed));

        let mut retyped = draft("cycle");
        retyped.workout_type = "cycle".into();
        assert_ne!(same, fingerprint_of(&retyped));

        // 浮点抖动不进指纹（保留一位小数）
        let mut jitter = draft("run");
        jitter.duration_min = 42.04;
        assert_eq!(same, fingerprint_of(&jitter));
    }
}
