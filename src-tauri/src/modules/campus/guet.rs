//! 桂林电子科技大学（树维 Supwisdom EAMS5 学生端）适配器。
//!
//! 这里的每个函数都对应一次实测验证过的真实请求，注释里记的字节数/字段名都来自线上响应，
//! 改接口时先对照注释确认，别凭直觉猜。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Datelike, NaiveDate};

use crate::error::{ReinError, Result};

use super::http::{rsa_encrypt_password, HttpResponse, Session};
use super::models::{LoginOutcome, PageVars, RemoteSemester, TimetableResponse};
use super::provider::SchoolSystemSpec;

/// 课表页面里学期列表的入口。真实形状（2026-09 实测）：
///
/// ```text
/// var semesters = JSON.parse(
///         '[{\"nameZh\":\"2026-2027\u4E0A\u5B66\u671F\",\"nameEn\":\"2026-2027 1st Term\",\"id\":321,...}]'
/// );
/// ```
///
/// 注意三点，任何一处想当然都会解析失败：
/// 1. 字面量是**单引号**的（不是双引号），里面的 `\"` 是 JS 转义，解码后才是 JSON 的引号；
/// 2. `JSON.parse(` 与引号之间有换行和缩进；
/// 3. 内容里的中文用 `\uXXXX` 转义。
const SEMESTERS_MARKER: &str = "JSON.parse(";

/// 在 `s` 中从 `start`（指向开引号）开始扫一个 JS 字符串字面量，
/// 返回**不含引号**的内容切片。识别 `\` 转义，避免被内容里的 `\'` 提前截断。
fn scan_js_literal(s: &str, start: usize, quote: char) -> Option<&str> {
    let mut escaped = false;
    let mut chars = s[start..].char_indices();
    chars.next()?; // 跳过开引号
    for (off, ch) in chars {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
        } else if ch == quote {
            let body_start = start + quote.len_utf8();
            return Some(&s[body_start..start + off]);
        }
    }
    None
}

/// 解码 JS 字符串字面量的转义。
///
/// 必须自己做而不能直接喂给 `serde_json`：JS 允许 `\'`、`\x41`、`\` + 换行这些
/// JSON 不认的写法，而 JSON 又要求外层是双引号。解一遍转义后，内层就是干净的 JSON 文本。
fn decode_js_string(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('\'') => out.push('\''),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('v') => out.push('\u{b}'),
            Some('0') => out.push('\0'),
            // 行继续：`\` 后紧跟换行，两者一起丢掉
            Some('\n') => {}
            Some('\r') => {
                if chars.clone().next() == Some('\n') {
                    chars.next();
                }
            }
            Some('u') => {
                let hex: String = chars.clone().take(4).collect();
                if hex.len() == 4 {
                    if let Ok(v) = u32::from_str_radix(&hex, 16) {
                        if let Some(c) = char::from_u32(v) {
                            out.push(c);
                            for _ in 0..4 {
                                chars.next();
                            }
                            continue;
                        }
                    }
                }
                // 解不出来就原样保留，交给后面的 JSON 解析去报错
                out.push('u');
            }
            Some('x') => {
                let hex: String = chars.clone().take(2).collect();
                if hex.len() == 2 {
                    if let Ok(v) = u32::from_str_radix(&hex, 16) {
                        if let Some(c) = char::from_u32(v) {
                            out.push(c);
                            for _ in 0..2 {
                                chars.next();
                            }
                            continue;
                        }
                    }
                }
                out.push('x');
            }
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// 抽出 `var semesters = JSON.parse('…')` 里的学期数组。
///
/// 公开是因为**开课查询页用的是同一份字面量**（见 `lesson_search`）：
/// 两个页面的学期列表同源，解析器就该只有一份，否则哪天教务改了格式
/// 会出现「课表能读、开课查询读不出来」这种半坏状态。
pub fn parse_semesters(html: &str) -> Result<Vec<RemoteSemester>> {
    let at = html
        .find(SEMESTERS_MARKER)
        .ok_or_else(|| ReinError::Message("课表页面结构变化：找不到 semesters 定义".into()))?;
    let rest = &html[at + SEMESTERS_MARKER.len()..];

    let (offset, quote) = rest
        .char_indices()
        .find_map(|(i, c)| (c == '\'' || c == '"').then_some((i, c)))
        .ok_or_else(|| {
            ReinError::Message("课表页面结构变化：semesters 实参不是字符串字面量".into())
        })?;

    let raw = scan_js_literal(rest, offset, quote)
        .ok_or_else(|| ReinError::Message("课表页面结构变化：semesters 字面量未闭合".into()))?;
    let inner = decode_js_string(raw);

    serde_json::from_str(&inner).map_err(|e| ReinError::Message(format!("学期列表解析失败：{e}")))
}

fn ok_resp(resp: &HttpResponse, what: &str) -> Result<()> {
    if resp.is_redirect() {
        return Err(ReinError::coded(
            "session_lost",
            format!("{what} 需要登录：会话已过期，请重新登录教务系统"),
        ));
    }
    if !resp.is_ok() {
        return Err(ReinError::Message(format!(
            "{what} 失败：HTTP {}",
            resp.status
        )));
    }
    Ok(())
}

/// `AUTUMN` → `第一学期`。教务的 `nameEn`（`2026-2027 1st Term`）不友好，自己拼中文名。
fn season_cn(season: Option<&str>) -> &'static str {
    match season.unwrap_or("") {
        "AUTUMN" => "第一学期",
        "SPRING" => "第二学期",
        "SUMMER" => "小学期",
        _ => "学期",
    }
}

/// 登录被拒时的文案。
///
/// 教务对「账号密码不对」并不总给 `message`（实测有时是空串 / null）。
/// 空手而归会让用户完全不知道下一步该干什么，所以这里必须给出可执行的兜底：
/// 要验证码却没说原因 → 就是缺验证码；给了验证码还是被拒 → 多半是验证码错了；
/// 连提示都没有 → 至少把「去核对学号密码」这句话说清楚。
fn login_failure(raw: &str, need_captcha: bool, captcha: &str) -> (String, Option<String>) {
    match raw {
        // 这两种是「口令策略」类错误，在 App 里重试没意义，必须去网页端改密
        "login_first" => (
            "首次登录需要先在教务系统网页端修改密码".to_string(),
            Some("change_password".to_string()),
        ),
        "weak_password" => (
            "教务系统判定密码过弱，需要先在网页端重置".to_string(),
            Some("reset_password".to_string()),
        ),
        "" if need_captcha && captcha.trim().is_empty() => ("需要输入验证码".to_string(), None),
        "" if need_captcha => ("验证码不正确，请重新输入".to_string(), None),
        "" => (
            "登录被拒绝：请核对学号与密码（教务系统没有返回具体原因）".to_string(),
            None,
        ),
        other => (other.to_string(), None),
    }
}

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

/// 归一化后的课表快照（落库前的中间形态）。
pub struct TimetableSnapshot {
    pub student_id: Option<String>,
    pub student_code: Option<String>,
    pub student_name: Option<String>,
    pub department: Option<String>,
    pub major: Option<String>,
    pub adminclass: Option<String>,
    pub grade: Option<String>,
    pub total_credits: Option<f64>,
    pub activities: Vec<super::models::TimetableActivity>,
}

pub struct GuetAdapter<'a> {
    pub spec: &'static SchoolSystemSpec,
    pub session: &'a mut Session,
}

impl<'a> GuetAdapter<'a> {
    pub fn new(spec: &'static SchoolSystemSpec, session: &'a mut Session) -> Self {
        Self { spec, session }
    }

    /// 会话探针：`GET /student/home`。200 = 仍有效，302 = 被踢回登录页。
    pub fn probe_session(&mut self) -> Result<bool> {
        let path = self.spec.login.probe_path();
        let resp = self.session.get(path)?;
        Ok(resp.is_ok())
    }

    /// 拉取图形验证码（原始 JPEG 字节的 base64，前端自行拼 `data:` URL）。
    ///
    /// 必须在**同一个会话**里做：教务把验证码答案绑在会话上，
    /// 换个会话拿图再提交必然对不上。
    pub fn fetch_captcha(&mut self) -> Result<String> {
        let path = format!(
            "{}?d={}",
            self.spec.login.captcha_path(),
            chrono::Utc::now().timestamp_millis()
        );
        let referer = self.spec.login.login_path();
        let resp = self.session.get_with_referer(&path, referer)?;
        ok_resp(&resp, "获取验证码")?;
        Ok(STANDARD.encode(&resp.body))
    }

    /// 完整登录握手。步骤与登录页 `submit()` 逐行对应。
    pub fn login(
        &mut self,
        login_name: &str,
        password: &str,
        captcha: &str,
    ) -> Result<LoginOutcome> {
        // ① 取 salt —— 注意这一步同时替我们建立了携带 SESSION 的 Cookie
        let salt_path = self.spec.login.salt_path();
        let salt_resp = self.session.get(salt_path)?;
        ok_resp(&salt_resp, "获取登录盐值")?;
        let salt = salt_resp.text().trim().to_string();
        if salt.is_empty() {
            return Err(ReinError::Message(
                "登录盐值为空，教务系统可能已改版".into(),
            ));
        }

        // ② RSA_PKCS1_v1_5(salt + "-" + password) —— 与 JSEncrypt.encrypt 等价
        let encrypted = rsa_encrypt_password(self.spec.login.public_key(), &salt, password)?;

        // ③ 提交
        let login_path = self.spec.login.login_path();
        let payload = serde_json::json!({
            "username": login_name,
            "password": encrypted,
            "captcha": captcha,
        });
        let resp = self.session.post_json(login_path, login_path, &payload)?;
        if resp.is_redirect() {
            return Err(ReinError::Message(
                "登录被重定向：教务系统拒绝了本次请求，请稍后重试".into(),
            ));
        }
        let body = resp.json()?;
        let ok = body
            .get("result")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let need_captcha = body
            .get("needCaptcha")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if ok {
            return Ok(LoginOutcome {
                ok: true,
                message: None,
                need_captcha: false,
                action_required: None,
                account: None,
            });
        }

        // `login_first` / `weak_password` 是「口令策略」类错误，在 App 里重试没意义，
        // 必须去网页端改密。单独透出给前端做专门文案。
        let raw = body.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let (message, action_required) = login_failure(raw, need_captcha, captcha);

        Ok(LoginOutcome {
            ok: false,
            message: Some(message),
            need_captcha,
            action_required,
            account: None,
        })
    }

    /// 刮课表页面上的变量：学期列表（唯一来源）+ bizTypeId。
    ///
    /// 树维没有独立的 `semester-list` 接口（实测 404），学期列表只内嵌在这个页面里。
    pub fn fetch_page_vars(&mut self) -> Result<PageVars> {
        let path = self
            .spec
            .endpoints
            .course_table_page_for(self.spec.term.biz_type_id);
        let resp = self.session.get(&path)?;
        ok_resp(&resp, "获取课表页面")?;
        let html = resp.text();

        let semesters = parse_semesters(&html)?;
        if semesters.is_empty() {
            return Err(ReinError::Message("课表页面未返回任何学期".into()));
        }
        Ok(PageVars { semesters })
    }

    /// 课表数据（主数据源）。路径里只有 semesterId，不需要额外的 dataId，最稳。
    pub fn fetch_timetable(&mut self, semester_id: i64) -> Result<TimetableSnapshot> {
        let path = self.spec.endpoints.course_table_print_for(semester_id);
        let resp = self.session.get(&path)?;
        ok_resp(&resp, "获取课表数据")?;
        let raw = resp
            .json()
            .map_err(|e| ReinError::Message(format!("课表数据解析失败：{e}")))?;
        let parsed: TimetableResponse = serde_json::from_value(raw)
            .map_err(|e| ReinError::Message(format!("课表数据解析失败：{e}")))?;

        let vm = parsed
            .student_table_vms
            .into_iter()
            .next()
            .ok_or_else(|| ReinError::Message("课表数据为空：该学期可能没有排课".into()))?;

        Ok(TimetableSnapshot {
            student_id: vm.id.map(|v| v.to_string()),
            student_code: vm.code,
            student_name: vm.name,
            department: vm.department,
            major: vm.major,
            adminclass: vm.adminclass,
            grade: vm.grade,
            total_credits: vm.credits,
            activities: vm.activities,
        })
    }

    /// 培养方案。响应可达 900KB+，调用方负责缓存。
    pub fn fetch_program_info(&mut self, student_id: &str) -> Result<serde_json::Value> {
        let path = self.spec.endpoints.program_info_for(student_id);
        let resp = self.session.get(&path)?;
        ok_resp(&resp, "获取培养方案")?;
        resp.json()
    }
}

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
/// 实测 2026-09-14 ~ 2027-01-24 → 133 天 → 19 周，与教务的 `weekIndices: [1..19]` 一致。
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 页面的真实形状：**单引号**字面量 + `\"` 转义 + `\uXXXX` 中文 + `JSON.parse(` 后换行。
    /// 这里逐字照抄线上片段，任何一处放宽都会让真机联调重新失败。
    #[test]
    fn parses_real_world_semesters_literal() {
        let html = r#"<script>
    var semesters = JSON.parse(
        '[{\"nameZh\":\"2026-2027\u4E0A\u5B66\u671F\",\"nameEn\":\"2026-2027 1st Term\",\"id\":321,\"code\":\"2026-2027_1\",\"schoolYear\":\"2026-2027\",\"startDate\":\"2026-09-14\",\"endDate\":\"2027-01-24\",\"weekStartOnSunday\":false,\"season\":\"AUTUMN\"}]'
    );
</script>"#;
        let list = parse_semesters(html).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, 321);
        assert_eq!(list[0].start_date.as_deref(), Some("2026-09-14"));
        assert_eq!(list[0].end_date.as_deref(), Some("2027-01-24"));
        assert_eq!(list[0].week_start_on_sunday, Some(false));
        assert_eq!(list[0].name_en.as_deref(), Some("2026-2027 1st Term"));
    }

    /// 双引号字面量（另一种可能的写法）也要能认
    #[test]
    fn parses_double_quoted_literal_too() {
        let html = r#"var semesters = JSON.parse("[{\"id\":7,\"startDate\":\"2027-02-22\",\"endDate\":\"2027-07-04\"}]");"#;
        let list = parse_semesters(html).unwrap();
        assert_eq!(list[0].id, 7);
        assert_eq!(list[0].start_date.as_deref(), Some("2027-02-22"));
    }

    #[test]
    fn decodes_js_escapes() {
        assert_eq!(decode_js_string(r#"a\"b"#), r#"a"b"#);
        assert_eq!(decode_js_string(r"a\'b"), "a'b");
        assert_eq!(decode_js_string(r"a\\b"), r"a\b");
        assert_eq!(decode_js_string(r"\u4E0A"), "上");
        assert_eq!(decode_js_string("a\\\nb"), "ab"); // 行继续
    }

    #[test]
    fn parses_semesters_and_rejects_missing_marker() {
        assert!(parse_semesters("<html>no marker</html>").is_err());
        assert!(parse_semesters("JSON.parse(   ").is_err());
    }

    /// 登录失败也必须**有话说** —— 这是「密码错了却没有任何前端反馈」那条反馈的根因：
    /// 教务不给 `message` 时，以前会吐出「登录失败，教务系统未返回原因」，用户无从下手。
    #[test]
    fn login_failures_always_say_something_actionable() {
        let (msg, act) = login_failure("login_first", false, "");
        assert!(msg.contains("网页端"), "{msg}");
        assert_eq!(act.as_deref(), Some("change_password"));

        let (msg, act) = login_failure("weak_password", false, "");
        assert!(msg.contains("过弱"), "{msg}");
        assert_eq!(act.as_deref(), Some("reset_password"));

        // 要验证码却没说原因：这不是「原因未知」，而是「还差一步」
        assert_eq!(login_failure("", true, "").0, "需要输入验证码");
        // 填了验证码还是被拒：多半就是验证码错了
        assert_eq!(
            login_failure("", true, "8f3d").0,
            "验证码不正确，请重新输入"
        );
        // 什么都没有：至少把「去核对学号密码」讲清楚
        assert!(login_failure("", false, "").0.contains("学号与密码"));

        // 教务给了原话就原样透传，不替它改写（`null` 也算没给）
        let (msg, act) = login_failure("用户名或密码错误", false, "");
        assert_eq!(msg, "用户名或密码错误");
        assert!(act.is_none());
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

    /// 真机联调（默认忽略）。带上凭据手动跑一次，确认「登录握手 → 课表页面解析 → 课表归一化」
    /// 这三段在真实教务系统上仍然成立 —— 教务改版通常就是这三处先坏。
    ///
    /// ```text
    /// $env:REIN_GUET_USER='2600xxxxxx'; $env:REIN_GUET_PASS='...'
    /// cargo test --lib campus::guet::tests::live -- --ignored --nocapture
    /// ```
    ///
    /// 凭据只从环境变量读，不进仓库。与 `scripts/voice-*-probe.mjs` 同类：真实站点的探针。
    #[test]
    #[ignore = "打真实教务系统，需要 REIN_GUET_USER / REIN_GUET_PASS"]
    fn live_guet_roundtrip() {
        let (Ok(user), Ok(pass)) = (
            std::env::var("REIN_GUET_USER"),
            std::env::var("REIN_GUET_PASS"),
        ) else {
            println!("缺少 REIN_GUET_USER / REIN_GUET_PASS，跳过");
            return;
        };
        let spec = super::super::provider::spec("guet-supwisdom-eams5").expect("桂电 spec");
        let mut session =
            crate::modules::campus::http::Session::new(spec.default_base_url, Default::default());
        let mut adapter = GuetAdapter::new(spec, &mut session);

        let login = adapter
            .login(&user, &pass, "")
            .expect("登录请求本身要能发出");
        assert!(login.ok, "登录被拒绝：{:?}", login.message);
        println!("✓ 登录通过");

        assert!(adapter.probe_session().expect("会话探针"), "会话探针未通过");
        println!("✓ 会话有效");

        let vars = adapter.fetch_page_vars().expect("课表页面解析");
        println!("✓ 解析到 {} 个学期", vars.semesters.len());
        let first = &vars.semesters[0];
        println!(
            "  学期样本：id={} startDate={:?} endDate={:?}",
            first.id, first.start_date, first.end_date
        );
        assert!(
            first.start_date.is_some(),
            "学期缺起始日 —— 周次无法映射成日期"
        );

        let snap = adapter
            .fetch_timetable(first.id)
            .expect("课表数据解析（跳过暑假等空学期时属正常）");
        println!(
            "✓ 课表：{} 门课 / {} 条上课时段（学生 {}）",
            snap.activities
                .iter()
                .filter_map(|a| a.lesson_id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            snap.activities.len(),
            snap.student_name.as_deref().unwrap_or("?")
        );

        let with_time = snap
            .activities
            .iter()
            .filter(|a| a.start_time.is_some() && a.end_time.is_some())
            .count();
        println!("  其中 {} 条带真实上课时间", with_time);
        assert!(with_time > 0, "没有任何一条带 startTime/endTime");

        // 培养方案：900KB+ 的单体响应，页面完全依赖它的结构，所以这里顺带核实
        // 「拿得到 + 顶层键在」。数据量太大不适合断言具体条目，改钉结构与规模。
        let student_id = snap.student_id.as_deref().expect("课表数据里没有学生标识");
        let program = adapter
            .fetch_program_info(student_id)
            .expect("培养方案拉取");
        let text = serde_json::to_string(&program)
            .map(|s| s.len())
            .unwrap_or(0);
        let has_distr = program
            .get("programInfos")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().any(|p| p.get("creditDistrTable").is_some()))
            .unwrap_or(false);
        println!("✓ 培养方案 {} KB", text / 1024);
        assert!(
            text > 100_000,
            "培养方案只有 {text} 字节，太小，疑似解析或端点不对"
        );
        assert!(
            has_distr,
            "培养方案里没有 creditDistrTable —— 页面画不出学分分布"
        );
        println!("✓ 联调通过");
    }
}
