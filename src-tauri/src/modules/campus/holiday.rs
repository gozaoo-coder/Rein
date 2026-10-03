//! 官方节假日数据（`holiday-cn`）与**调休补课映射**。
//!
//! 数据源（免密钥、可直接抓）：
//! `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json`
//! 它**只列非常规日**：法定放假日（`isOffDay:true`）与调休补班日（`isOffDay:false`），
//! 普通周末不在表里 —— 所以「今天是不是周末」不该问它，只有「今天是不是被调过」才问。
//!
//! 用户可见的两条语义：
//! - **假**：放假日仍在课表上（课不会因为放假就凭空消失），只是打一枚「假」标；
//! - **调**：补班日额外挂上「被补的那一天是星期几」的课，并打一枚「调」标。
//!
//! 「补的是星期几」由 [`infer_makeups`] 推断：同一节日下的补班日与「假期内被吃掉的工作日」
//! 都按日期降序一一配对。实测 2026 国庆 → 10/10 补 10/7（周三），与桂电教务口径一致；
//! 但推断天生不可靠（各校口径会变），所以 [`HolidayConfig::overrides`] 允许按日期手动覆盖。
//!
//! 本模块**不碰 DB 锁**：抓取（[`fetch_raw`]）与缓存读写（[`cached_raw`]/[`cache_raw`]）分开，
//! 由调用方按「短锁读 → 无锁联网 → 短锁写」三段式编排（见 `commands.rs` 文件头铁律）。

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use chrono::Datelike;
use serde::{Deserialize, Serialize};

use crate::error::{ReinError, Result};
use rusqlite::Connection;

use super::dates;
use super::http;
use super::models::HolidayKind;

/// `app_meta`：总开关。只有显式写过 `"0"` 才算关闭 —— **缺省即开启**（需求：默认打开）。
pub const ENABLED_KEY: &str = "campus_holiday_enabled";
/// `app_meta`：按日期的手动覆盖，JSON `{ "2026-10-10": 3 }`（值 `0` = 取消该日补课）。
pub const OVERRIDES_KEY: &str = "campus_holiday_overrides";
/// `app_meta`：按年缓存的前缀，完整键 `campus_holiday_cache_2026`。
const CACHE_PREFIX: &str = "campus_holiday_cache_";

/// 数据源：只取路径部分，域名单独给（[`Session`] 需要一个 base）。
const SOURCE_BASE: &str = "https://fastly.jsdelivr.net";
const SOURCE_PATH: &str = "/gh/NateScarlet/holiday-cn@master/{year}.json";

/// 抓取的超时。这是一次几百 KB 的 CDN 静态文件，20 秒足够；它不该继承教务那条 60 秒的宽限。
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/* ─────────────────────────── 数据源形状 ─────────────────────────── */

/// `holiday-cn` 里的一天。字段一律 `default`：数据源换版式时宁可少一天，也不该整年解析失败。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HolidayDay {
    #[serde(default)]
    pub name: String,
    /// `YYYY-MM-DD`
    pub date: String,
    /// true = 法定放假日；false = 调休补班日。
    #[serde(default, rename = "isOffDay")]
    pub is_off_day: bool,
}

/// `holiday-cn` 的一年。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HolidayYear {
    #[serde(default)]
    pub year: i64,
    #[serde(default)]
    pub days: Vec<HolidayDay>,
}

/* ─────────────────────────── 配置 ─────────────────────────── */

fn default_enabled() -> bool {
    true
}

/// 用户可写的那部分（`campus_holiday_config_set` 的入参）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayConfig {
    /// 总开关，**默认开**。
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 按日期的手动覆盖：日期 → 补星期几（1=周一 … 7=周日）；值 `0` 表示该日**不补课**。
    #[serde(default)]
    pub overrides: BTreeMap<String, i64>,
}

impl Default for HolidayConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            overrides: BTreeMap::new(),
        }
    }
}

impl HolidayConfig {
    /// 读配置。**缺省即开启**。
    pub fn load(conn: &Connection) -> Self {
        let enabled = crate::db::meta_get(conn, ENABLED_KEY).as_deref() != Some("0");
        let overrides = crate::db::meta_get(conn, OVERRIDES_KEY)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { enabled, overrides }
    }

    pub fn save(&self, conn: &Connection) -> Result<()> {
        crate::db::meta_set(conn, ENABLED_KEY, if self.enabled { "1" } else { "0" })?;
        crate::db::meta_set(conn, OVERRIDES_KEY, &serde_json::to_string(&self.overrides)?)?;
        Ok(())
    }
}

/// 设置页要看的全貌（`campus_holiday_config_get` 的出参）：配置 + 推断出来的映射。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayConfigView {
    pub enabled: bool,
    pub overrides: BTreeMap<String, i64>,
    /// 生效的补班映射：日期 → 补星期几。**含被覆盖为 `0`（不补）的日期**，
    /// 这样用户在设置页把某天改成「不补课」之后，那一行仍留在列表里，能再改回来。
    pub makeups: BTreeMap<String, i64>,
    /// 已具备数据的年份（可用于「数据已就绪 / 还没取到」的提示）。
    pub years: Vec<i64>,
}

/* ─────────────────────────── 缓存读写（不碰锁，调用方持锁调用） ─────────────────────────── */

fn cache_key(year: i64) -> String {
    format!("{CACHE_PREFIX}{year}")
}

/// 读某年的原始 JSON；没缓存过返回 None。
pub fn cached_raw(conn: &Connection, year: i64) -> Option<String> {
    crate::db::meta_get(conn, &cache_key(year))
}

/// 写某年的原始 JSON 进缓存。
pub fn cache_raw(conn: &Connection, year: i64, raw: &str) -> Result<()> {
    crate::db::meta_set(conn, &cache_key(year), raw)
}

/// 解析原始 JSON。
pub fn parse(raw: &str) -> Result<HolidayYear> {
    serde_json::from_str(raw).map_err(ReinError::from)
}

/* ─────────────────────────── 联网抓取 ─────────────────────────── */

/// 联网抓取某一年的官方调休 JSON。
///
/// **调用方必须保证此刻没有持有 `AppState.db` 的锁**（见 `commands.rs` 文件头铁律）。
/// 这里刻意不走 [`Session`]：那是教务会话（会带门户的 Origin/Referer 与 Cookie），
/// 而这是个公开 CDN，只要一个裸请求；但「响应怎么读」仍复用 [`http::read_response`]。
pub fn fetch_raw(year: i64) -> Result<String> {
    let url = format!("{SOURCE_BASE}{}", SOURCE_PATH.replace("{year}", &year.to_string()));
    let agent = ureq::AgentBuilder::new().timeout(FETCH_TIMEOUT).build();
    let outcome = agent
        .get(&url)
        .set("User-Agent", http::USER_AGENT)
        .set("Accept", "application/json")
        .call();
    let resp = match outcome {
        Ok(r) => r,
        // ureq 把非 2xx 也当 Err 抛出；要的是状态码，所以两种情况都收
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(ReinError::Message(format!("调休数据请求失败：{e}"))),
    };
    let normalized = http::read_response(resp)?;
    if !normalized.is_ok() {
        return Err(ReinError::Message(format!(
            "调休数据源返回 {}（{year} 年）",
            normalized.status
        )));
    }
    Ok(normalized.text())
}

/* ─────────────────────────── 年份 / 推断 / 计划 ─────────────────────────── */

/// 学期覆盖到的年份（含端点）。一个学年通常跨两年 → 至多两次抓取。
pub fn years_of(start: &str, end: &str) -> Vec<i64> {
    let (Some(s), Some(e)) = (dates::parse_ymd(start), dates::parse_ymd(end)) else {
        return Vec::new();
    };
    (s.year() as i64..=e.year() as i64).collect()
}

/// `"2026-10-07"` → 3（周三）。教务口径：1=周一 … 7=周日。
fn weekday_of(date: &str) -> Option<i64> {
    Some(dates::parse_ymd(date)?.weekday().num_days_from_monday() as i64 + 1)
}

/// 推断「补班日 → 被补的星期几」。
///
/// 规则：把**同一节日**下的补班日、与「假期内被吃掉的工作日（周一~周五）」都按日期降序排列，
/// 一一配对。例：2026 国庆被吃掉的工作日（降序）= 10/7(三)、10/6(二)、10/5(一)、10/2(五)、10/1(四)，
/// 补班日（降序）= 10/10(六)、9/20(日)，配对后 10/10 补周三、9/20 补周二 —— 与桂电口径一致。
///
/// 配对不上的补班日**不做映射**：宁可少显示，也不要张冠李戴（用户可在设置页手动补上）。
pub fn infer_makeups(tables: &[HolidayYear]) -> BTreeMap<String, i64> {
    // name → (假期内被吃掉的工作日, 补班日)
    let mut groups: BTreeMap<&str, (Vec<&HolidayDay>, Vec<&HolidayDay>)> = BTreeMap::new();
    for t in tables {
        for d in &t.days {
            let g = groups.entry(d.name.as_str()).or_default();
            if d.is_off_day {
                // 只有工作日被吃掉才有「被补」的意义（周末本来就是休息日）
                if matches!(weekday_of(&d.date), Some(1..=5)) {
                    g.0.push(d);
                }
            } else {
                g.1.push(d);
            }
        }
    }

    let mut out = BTreeMap::new();
    for (_, (mut offs, mut makeups)) in groups {
        offs.sort_by(|a, b| b.date.cmp(&a.date));
        makeups.sort_by(|a, b| b.date.cmp(&a.date));
        for (m, o) in makeups.iter().zip(offs.iter()) {
            if let Some(wd) = weekday_of(&o.date) {
                out.insert(m.date.clone(), wd);
            }
        }
    }
    out
}

/// 调休计划：把「某天放假」与「某天补星期几的课」预先摊平，供课表展开直接用。零 IO。
#[derive(Debug, Clone, Default)]
pub struct HolidayPlan {
    /// 放假日（打「假」标）
    off: BTreeSet<String>,
    /// 补班日 → 被补的星期几（1..=7）
    makeup: BTreeMap<String, i64>,
}

impl HolidayPlan {
    /// 这一天的调休性质；普通日返回 None。
    ///
    /// 注意：补班日**自身的课不打标**（那天上的还是被补那天的课，标在额外挂上的那些上），
    /// 所以这里对 `makeup` 只用于「要不要额外挂课」，标签由展开逻辑自己给。
    pub fn kind(&self, date: &str) -> Option<HolidayKind> {
        if self.off.contains(date) {
            Some(HolidayKind::Off)
        } else if self.makeup.contains_key(date) {
            Some(HolidayKind::Makeup)
        } else {
            None
        }
    }

    /// 全部生效的补班映射（日期 → 星期几）。
    pub fn makeups(&self) -> &BTreeMap<String, i64> {
        &self.makeup
    }
}

/// 由若干年的调休表 + 用户覆盖组装计划。
///
/// 覆盖优先级最高：写 `1..=7` 就改成补那天，写 `0` 就取消该日补课。
pub fn build_plan(tables: &[HolidayYear], overrides: &BTreeMap<String, i64>) -> HolidayPlan {
    let mut plan = HolidayPlan::default();
    for t in tables {
        for d in &t.days {
            if d.is_off_day {
                plan.off.insert(d.date.clone());
            }
        }
    }
    for (date, wd) in infer_makeups(tables) {
        plan.makeup.insert(date, wd);
    }
    for (date, wd) in overrides {
        if *wd == 0 {
            plan.makeup.remove(date);
        } else if (1..=7).contains(wd) {
            plan.makeup.insert(date.clone(), *wd);
        }
    }
    plan
}

/// 从缓存组装计划 —— **绝不联网**：打开课表这条路上不该出现网络请求。
///
/// 开关关闭、或某年还没缓存过，就退化为「无调休」，课表本身照常渲染。
pub fn plan_from_cache(conn: &Connection, years: &[i64], cfg: &HolidayConfig) -> HolidayPlan {
    if !cfg.enabled {
        return HolidayPlan::default();
    }
    let tables: Vec<HolidayYear> = years
        .iter()
        .filter_map(|y| cached_raw(conn, *y))
        .filter_map(|raw| parse(&raw).ok())
        .collect();
    build_plan(&tables, &cfg.overrides)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(name: &str, date: &str, off: bool) -> HolidayDay {
        HolidayDay {
            name: name.into(),
            date: date.into(),
            is_off_day: off,
        }
    }

    /// 2026 国庆：放 10/1~10/7，补班 9/20（周日）、10/10（周六）。
    fn national_day_2026() -> HolidayYear {
        HolidayYear {
            year: 2026,
            days: vec![
                day("国庆节", "2026-10-01", true),
                day("国庆节", "2026-10-02", true),
                day("国庆节", "2026-10-03", true),
                day("国庆节", "2026-10-04", true),
                day("国庆节", "2026-10-05", true),
                day("国庆节", "2026-10-06", true),
                day("国庆节", "2026-10-07", true),
                day("国庆节", "2026-09-20", false),
                day("国庆节", "2026-10-10", false),
            ],
        }
    }

    #[test]
    fn infers_national_day_makeups() {
        let m = infer_makeups(&[national_day_2026()]);
        assert_eq!(m.get("2026-10-10"), Some(&3), "10/10 补周三");
        assert_eq!(m.get("2026-09-20"), Some(&2), "9/20 补周二");
    }

    #[test]
    fn overrides_win_and_zero_cancels() {
        let mut ov = BTreeMap::new();
        ov.insert("2026-10-10".to_string(), 5);
        ov.insert("2026-09-20".to_string(), 0);
        let plan = build_plan(&[national_day_2026()], &ov);

        assert_eq!(plan.makeups().get("2026-10-10").copied(), Some(5), "覆盖成周五");
        assert_eq!(plan.makeups().get("2026-09-20").copied(), None, "0 = 取消该日补课");
        assert_eq!(plan.kind("2026-10-05"), Some(HolidayKind::Off));
        assert_eq!(plan.kind("2026-10-10"), Some(HolidayKind::Makeup));
        assert_eq!(plan.kind("2026-10-08"), None, "普通日无值");
    }

    #[test]
    fn weekend_off_days_are_not_paired() {
        // 放假日若落在周末，它不是「被吃掉的工作日」，不该占配位
        let t = HolidayYear {
            year: 2026,
            days: vec![
                day("测试节", "2026-03-07", true), // 周六
                day("测试节", "2026-03-09", true), // 周一（工作日）
                day("测试节", "2026-03-14", false), // 周六补班
            ],
        };
        let m = infer_makeups(&[t]);
        assert_eq!(m.get("2026-03-14"), Some(&1), "应配到周一而不是周六");
    }

    #[test]
    fn year_span_covers_cross_year_semester() {
        assert_eq!(years_of("2026-09-14", "2027-01-24"), vec![2026, 2027]);
        assert_eq!(years_of("2026-09-14", "2026-12-31"), vec![2026]);
        assert!(years_of("", "2027-01-24").is_empty());
    }

    #[test]
    fn config_is_enabled_by_default() {
        assert!(HolidayConfig::default().enabled);
        let parsed: HolidayConfig = serde_json::from_str("{}").unwrap();
        assert!(parsed.enabled, "缺字段时默认开");
        let off: HolidayConfig = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!off.enabled);
    }

    #[test]
    fn parses_source_shape_with_field_drift() {
        // 多一个未知键、少一个 name，都不该让整年失败
        let raw = r#"{"year":2026,"papers":[],"days":[
            {"date":"2026-10-01","isOffDay":true,"extra":"x"},
            {"date":"2026-10-10","isOffDay":false}
        ]}"#;
        let t = parse(raw).unwrap();
        assert_eq!(t.year, 2026);
        assert_eq!(t.days.len(), 2);
        assert_eq!(t.days[0].name, "");
        assert!(t.days[0].is_off_day);
    }
}
