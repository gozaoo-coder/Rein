//! 学期口径的换算与命名：周次 ↔ 公历日期、节次 ↔ 时刻、学期显示名。
//!
//! 这些是**学期语义**，不属于任何一家厂商 —— 树维与正方的差异在登录握手与数据形状，
//! 而「第 9 教学周的星期三是几号」两边是同一个算法。所以从 `guet.rs` 里提出来共用，
//! 免得正方适配器要去 import 桂电的模块取一个纯函数。

use chrono::{Datelike, NaiveDate};

/// `"16:30"` → 990（距 00:00 的分钟数），与 `todos.start_min` 同口径。
pub fn hhmm_to_min(s: &str) -> Option<i64> {
    let (h, m) = s.trim().split_once(':')?;
    let h: i64 = h.trim().parse().ok()?;
    let m: i64 = m.trim().parse().ok()?;
    if !(0..24).contains(&h) || !(0..60).contains(&m) {
        return None;
    }
    Some(h * 60 + m)
}

/// `"2026-09-14"` → NaiveDate
pub fn parse_ymd(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

/// 学期总周数：起止日（含端点）除以 7 向上取整。
/// 实测桂电 2026-09-14 ~ 2027-01-24 → 133 天 → 19 周，与教务的 `weekIndices: [1..19]` 一致。
pub fn total_weeks(start: NaiveDate, end: NaiveDate) -> i64 {
    let days = (end - start).num_days() + 1;
    if days <= 0 {
        return 0;
    }
    (days + 6) / 7
}

/// 今天是第几教学周（1 起）；不在学期内返回 None。
pub fn current_week(start: NaiveDate, end: NaiveDate, today: NaiveDate) -> Option<i64> {
    if today < start || today > end {
        return None;
    }
    Some((today - start).num_days() / 7 + 1)
}

/// 学期起始日所在周的周一（`week_start_on_sunday=false` 时即起始日本身）。
pub fn week_anchor(start: NaiveDate, week_start_on_sunday: bool) -> NaiveDate {
    let from_sunday = start.weekday().num_days_from_sunday() as i64;
    if week_start_on_sunday {
        start - chrono::Duration::days(from_sunday)
    } else {
        let from_monday = start.weekday().num_days_from_monday() as i64;
        start - chrono::Duration::days(from_monday)
    }
}

/// `AUTUMN` → `第一学期`。教务的 `nameEn`（`2026-2027 1st Term`）不友好，自己拼中文名。
pub fn season_cn(season: Option<&str>) -> &'static str {
    match season.unwrap_or("") {
        "AUTUMN" => "第一学期",
        "SPRING" => "第二学期",
        "SUMMER" => "小学期",
        _ => "学期",
    }
}

/// 学期显示名：`2026-2027` + `第一学期`；学年缺失时退到调用方给的兜底名。
pub fn semester_display_name(
    school_year: Option<&str>,
    season: Option<&str>,
    fallback: &str,
) -> String {
    match school_year {
        Some(y) if !y.is_empty() => format!("{y} {}", season_cn(season)),
        _ => fallback.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_and_date_helpers() {
        assert_eq!(hhmm_to_min("16:30"), Some(990));
        assert_eq!(hhmm_to_min("18:05"), Some(1085));
        assert_eq!(hhmm_to_min("24:00"), None);
        assert_eq!(hhmm_to_min("bad"), None);

        let start = parse_ymd("2026-09-14").unwrap();
        let end = parse_ymd("2027-01-24").unwrap();
        assert_eq!(total_weeks(start, end), 19);
        assert_eq!(current_week(start, end, start), Some(1));
        assert_eq!(
            current_week(start, end, parse_ymd("2026-09-21").unwrap()),
            Some(2)
        );
        assert_eq!(
            current_week(start, end, parse_ymd("2026-09-13").unwrap()),
            None
        );
    }

    #[test]
    fn week_anchor_snaps_to_monday() {
        // 2026-09-14 本身就是周一
        let d = parse_ymd("2026-09-14").unwrap();
        assert_eq!(week_anchor(d, false), d);
        // 2026-09-16 是周三 → 锚点仍是 09-14
        assert_eq!(week_anchor(parse_ymd("2026-09-16").unwrap(), false), d);
    }

    #[test]
    fn season_labels() {
        assert_eq!(season_cn(Some("AUTUMN")), "第一学期");
        assert_eq!(season_cn(Some("SPRING")), "第二学期");
        assert_eq!(
            semester_display_name(Some("2026-2027"), Some("AUTUMN"), "x"),
            "2026-2027 第一学期"
        );
        assert_eq!(semester_display_name(None, None, "回退名"), "回退名");
    }
}
