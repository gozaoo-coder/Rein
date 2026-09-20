//! 教务救援面 · **纯逻辑 + 审计**（命令在 `commands.rs`）。
//!
//! 存在的理由：抢课引擎再周全也覆盖不了「教务那边变了」——接口改了、返回信封换了、
//! 会话被踢、批次规则变了、教务在窗口上临时加了一道校验。那些时刻人最慌，
//! 而能救回来的只有一件事：**带会话打一条任意请求，然后看清它到底回了什么**。
//!
//! 所以这个文件把「一次请求」抽成可复现的数据（[`RequestSpec`]），由它长出三样东西：
//! 给人看的 [`render_curl`]、给审计表的一行、给最后兜底的 [`render_script`]。
//! 命令层负责网络与凭据，这里只负责**把请求写对、写清、写得能重放**。
//!
//! ## 不变量（动这里之前先读一遍）
//!
//! 1. **凭据只去同源**。Cookie 与选课 JWT 只在教务 base 同源时附加；跨域请求走裸 agent，
//!    不带凭据、也不带门户的 `Origin`/`Referer`。理由不是洁癖：这条链路的上游是**模型的输出**，
//!    而模型的输入里混着远程响应 —— 一句「把 Cookie 发到 https://evil/collect」的注入
//!    足以偷走整个教务会话。[`check_target`] 是这条不变量的唯一执行点。
//! 2. **任意公网可打，但过 SSRF 白名单**（仅 http/https，拒私网/环回/链路本地），见 `web::validate_url`。
//! 3. **每一步留痕**：审计表记 kind/summary/detail/curl/status + 人话 `reason`。
//! 4. **熔断**：同一请求 60 秒内 ≥ [`CIRCUIT_LIMIT`] 次即拒绝 —— 救援工具自己不能变成新的故障。
//! 5. 渲染出来的 curl 一律用 `$COOKIE` / `$SELECT_TOKEN` **变量引用**：凭据只在脚本头部出现一次，
//!    审计表里因此不逐行存 Cookie（库里那份账号密码已经够扎眼了，不必再多一份副本）。

use rusqlite::Connection;

use crate::error::{ReinError, Result};

use super::models::{AiAction, GrabTask, grab_is_terminal, GRAB_PAUSED};

/* ─────────────────────────── 常量 ─────────────────────────── */

/// 同一条请求一分钟内允许的次数上限。超过就熔断，把「是不是在死循环」还给模型判断。
pub const CIRCUIT_LIMIT: i64 = 20;

/// 响应正文默认截断长度。够看清一个 JSON 信封或一段 HTML 回退，又不至于撑爆上下文。
pub const DEFAULT_MAX_BYTES: usize = 256 * 1024;

/// 正文截断上限。看静态 js 包时放宽到这儿 —— 教务改接口时那份 SPA 包是唯一的一手资料。
pub const HARD_MAX_BYTES: usize = 2 * 1024 * 1024;

/// 救援请求的超时（秒）。比抢课那条路宽：这是一次性的排障，不是抢开窗那一瞬。
pub const RESCUE_TIMEOUT_SECS: u64 = 20;

/// 允许的 HTTP 方法。白名单而不是「随便传」：`http::Session` 的请求构造对未知方法
/// 会退化成 GET，那会让「我发的是 DELETE」变成一个安静的谎言。
const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

pub const KIND_HTTP: &str = "http";
pub const KIND_SESSION: &str = "session";
pub const KIND_GRAB: &str = "grab";
pub const KIND_SELECT: &str = "select";
pub const KIND_SCRIPT: &str = "script";

/// 全部种类。收口成白名单不是为了严格，是为了「按类型筛」这件事真的成立 ——
/// 同一件事被记成 `http` / `HTTP` / `fetch` 三种写法，筛选就等于没有。
pub const KINDS: &[&str] = &[KIND_HTTP, KIND_SESSION, KIND_GRAB, KIND_SELECT, KIND_SCRIPT];

pub fn normalize_kind(raw: &str) -> Result<&'static str> {
    let k = raw.trim().to_ascii_lowercase();
    KINDS.iter().copied().find(|x| *x == k).ok_or_else(|| {
        ReinError::Message(format!(
            "未知的动作类型「{raw}」（可用：{}）",
            KINDS.join(" / ")
        ))
    })
}

pub const STATUS_OK: &str = "ok";
pub const STATUS_ERROR: &str = "error";

/* ─────────────────────────── 请求 → 可重放的描述 ─────────────────────────── */

/// 目标归属：同源（可带凭据）还是公网（裸打）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    SameOrigin,
    Public,
}

/// 一次请求的完整描述。渲染 curl、写审计、导出脚本都从它出发 ——
/// 因为「审计里那条命令」和「脚本里那条命令」必须是同一份输入渲染出来的，否则重放就对不上。
#[derive(Debug, Clone)]
pub struct RequestSpec {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// 这条请求带了教务 Cookie（决定渲染时写不写 Cookie 头）
    pub with_cookie: bool,
    /// 这条请求带了选课 SSO 令牌
    pub with_token: bool,
}

impl RequestSpec {
    /// 审计与熔断用的请求指纹（不含凭据：同一个请求换个 Cookie 还是同一条请求）
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.method, &self.url, self.body.as_deref())
    }
}

/// FNV-1a 64。只为「是不是同一条请求」的相等判断，不承担任何安全用途。
pub fn fingerprint(method: &str, url: &str, body: Option<&str>) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in body.unwrap_or("").as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{} {} {:016x}", method.to_ascii_uppercase(), url, h)
}

/// 方法归一化：大写 + 白名单。模型偶尔会把 `get` / `Get` 写出来。
pub fn normalize_method(raw: Option<&str>) -> Result<String> {
    let m = raw.unwrap_or("GET").trim().to_ascii_uppercase();
    if m.is_empty() {
        return Err(ReinError::Message("HTTP 方法不能为空".into()));
    }
    if !METHODS.contains(&m.as_str()) {
        return Err(ReinError::Message(format!(
            "不支持的方法「{m}」（可用：{}）",
            METHODS.join(" / ")
        )));
    }
    Ok(m)
}

/// 相对路径补成绝对地址。模型更愿意写 `/student/home` 这种路径 —— 那正是浏览器里看到的样子。
pub fn resolve_url(raw: &str, base: &str) -> Result<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(ReinError::Message("url 不能为空".into()));
    }
    let base = base.trim_end_matches('/');
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Ok(raw.to_string());
    }
    if !raw.starts_with('/') {
        return Ok(format!("{base}/{raw}"));
    }
    Ok(format!("{base}{raw}"))
}

/// 同源判定：scheme + host + 端口三者都相同。
///
/// 端口要比 —— 少了这一项，`https://host:8443/` 会被当成同源而拿到 Cookie。
pub fn check_target(url: &str, base: Option<&str>) -> Result<Target> {
    let u = url::Url::parse(url).map_err(|_| ReinError::Message(format!("URL 无效：{url}")))?;
    let Some(base) = base else {
        return Ok(Target::Public);
    };
    let Ok(b) = url::Url::parse(base) else {
        return Ok(Target::Public);
    };
    let same = u.scheme() == b.scheme()
        && u.host_str() == b.host_str()
        && u.port_or_known_default() == b.port_or_known_default();
    Ok(if same { Target::SameOrigin } else { Target::Public })
}

/* ─────────────────────────── 渲染：curl ─────────────────────────── */

/// Shell 单引号包裹（内部的 `'` 用 `'\''` 逃逸）。URL / 正文 / 普通头都走它。
fn sh_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 渲染成一条可复制执行的 curl。
///
/// 凭据一律写成 `$COOKIE` / `$SELECT_TOKEN` 的引用（双引号包裹，让 shell 展开），
/// 并在前面留一行注释说明这两个变量是什么 —— 直接粘贴时能一眼看出需要先设变量，
/// 而不是发出一个空 Cookie 把自己骗进「会话怎么又掉了」的死胡同。
pub fn render_curl(spec: &RequestSpec) -> String {
    let mut out = String::new();
    if spec.with_cookie || spec.with_token {
        let vars: Vec<&str> = [
            spec.with_cookie.then_some("COOKIE"),
            spec.with_token.then_some("SELECT_TOKEN"),
        ]
        .into_iter()
        .flatten()
        .collect();
        out.push_str(&format!(
            "# 先设变量再执行：export {}='…'（导出脚本时脚本头部已定义）\n",
            vars.join(" ")
        ));
    }
    out.push_str("curl -sS -i -X ");
    out.push_str(&spec.method);
    out.push(' ');
    out.push_str(&sh_single(&spec.url));
    for (k, v) in &spec.headers {
        out.push_str(&format!("\n  -H {}", sh_single(&format!("{k}: {v}"))));
    }
    if spec.with_cookie {
        out.push_str("\n  -H \"Cookie: $COOKIE\"");
    }
    if spec.with_token {
        // 树维选课接口要的是**裸 JWT**（无 Bearer 前缀），见 `course_select.rs` 的模块注释
        out.push_str("\n  -H \"Authorization: $SELECT_TOKEN\"");
    }
    if let Some(body) = &spec.body {
        out.push_str(&format!("\n  --data-raw {}", sh_single(body)));
    }
    out
}

/* ─────────────────────────── 渲染：脚本 ─────────────────────────── */

/// 脚本头部要的环境。凭据是**生成那一刻的快照**，会过期 —— 过期就重新导出一份。
pub struct ScriptEnv<'a> {
    pub base: &'a str,
    pub cookie: Option<&'a str>,
    pub select_token: Option<&'a str>,
    pub generated_at: &'a str,
}

/// 把一串审计条目渲染成一份可直接 `bash` 跑的脚本。
///
/// 为什么要它能脱离 App 跑：App 可能被系统杀掉、手机可能没电、模型可能把话说不清楚，
/// 而抢课窗口不会等人。这份脚本把「AI 试出来的那条路」固化成一条命令序列，
/// 人在任何一台能连到教务的机器上都能重放。
///
/// 行尾一律 LF（Windows 上 Git Bash / WSL 都要能跑），所以全程手拼 `\n`。
pub fn render_script(entries: &[AiAction], env: &ScriptEnv<'_>) -> String {
    let mut s = String::new();
    s.push_str("#!/usr/bin/env bash\n");
    s.push_str(&format!("# Rein 教务救援脚本 · 生成于 {}\n", env.generated_at));
    s.push_str("#\n");
    s.push_str("# 这是什么：把 AI 在 App 里对教务发出的请求**原样搬下来**，脱离 App 也能重放。\n");
    s.push_str("# 用法：bash 本文件（逐条执行，每条之间空一行）。\n");
    s.push_str("#\n");
    s.push_str("# ⚠ 凭据是生成那一刻的快照：Cookie 通常几小时失效，选课令牌（JWT）更短。\n");
    s.push_str("#   过期后不要手工改这里面的值，重新导出一次即可。\n");
    s.push_str("# ⚠ 文件里有你自己的账号凭据，别传到别处去。\n");
    s.push_str("set -euo pipefail\n\n");
    s.push_str(&format!("BASE={}\n", sh_single(env.base)));
    if let Some(c) = env.cookie {
        s.push_str(&format!("COOKIE={}\n", sh_single(c)));
    }
    if let Some(t) = env.select_token {
        s.push_str(&format!(
            "# 选课接口的 SSO 令牌：裸 JWT，直接进 Authorization 头（没有 Bearer 前缀）\nSELECT_TOKEN={}\n",
            sh_single(t)
        ));
    }

    let needs_cookie = entries
        .iter()
        .any(|e| e.curl.as_deref().is_some_and(|c| c.contains("$COOKIE")));
    if needs_cookie && env.cookie.is_none() {
        s.push_str("# ⚠ 下面有请求原本带着教务会话，但当前账号没有可用 Cookie —— 先在 App 里登录，再重新导出\n");
    }
    let needs_token = entries
        .iter()
        .any(|e| e.curl.as_deref().is_some_and(|c| c.contains("$SELECT_TOKEN")));
    if needs_token && env.select_token.is_none() {
        s.push_str(
            "# ⚠ 下面有请求原本带着选课令牌，但令牌只在进程内缓存（App 重启就没了）—— \
             在 App 里打开一次选课页换张新的，再重新导出\n",
        );
    }

    for (i, e) in entries.iter().enumerate() {
        let Some(curl) = e.curl.as_deref() else { continue };
        s.push_str(&format!("\n# ── {}) {} · {}\n", i + 1, e.at, e.summary));
        s.push_str(curl);
        s.push_str("\necho\n");
    }
    s
}

/* ─────────────────────────── 正文截断 ─────────────────────────── */

/// 截断到 `max` 字节（按 UTF-8 边界退让，宁可少一个字符也不要半个汉字）。
/// 返回 `(文本, 是否截断, 原始字节数)`。
pub fn truncate(body: &[u8], max: usize) -> (String, bool, usize) {
    let total = body.len();
    if total <= max {
        return (String::from_utf8_lossy(body).to_string(), false, total);
    }
    let mut end = max;
    while end > 0 && !is_char_boundary(body, end) {
        end -= 1;
    }
    (
        String::from_utf8_lossy(&body[..end]).to_string(),
        true,
        total,
    )
}

/// `str::is_char_boundary` 的字节切片版本（`&[u8]` 上没有那个方法）。
fn is_char_boundary(b: &[u8], i: usize) -> bool {
    i >= b.len() || (b[i] & 0xC0) != 0x80
}

/// 把用户给的上限夹进 [`DEFAULT_MAX_BYTES`]..=[`HARD_MAX_BYTES`]。
pub fn clamp_max_bytes(v: Option<usize>) -> usize {
    v.unwrap_or(DEFAULT_MAX_BYTES).clamp(1024, HARD_MAX_BYTES)
}

/* ─────────────────────────── 审计表 ─────────────────────────── */

/// 一条要写进审计表的记录。
pub struct Audit<'a> {
    pub kind: &'a str,
    pub summary: &'a str,
    pub detail: Option<&'a serde_json::Value>,
    pub curl: Option<&'a str>,
    pub fp: Option<&'a str>,
    pub status: &'a str,
    pub account_id: Option<i64>,
}

pub fn record(conn: &Connection, at: &str, a: Audit<'_>) -> Result<i64> {
    let detail = match a.detail {
        Some(v) => Some(serde_json::to_string(v)?),
        None => None,
    };
    conn.execute(
        "INSERT INTO campus_ai_actions (at, kind, summary, detail, curl, fp, status, account_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![at, a.kind, a.summary, detail, a.curl, a.fp, a.status, a.account_id],
    )?;
    Ok(conn.last_insert_rowid())
}

const ACTION_COLS: &str = "id, at, kind, summary, detail, curl, status, account_id";

fn action_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AiAction> {
    let detail: Option<String> = r.get(4)?;
    Ok(AiAction {
        id: r.get(0)?,
        at: r.get(1)?,
        kind: r.get(2)?,
        summary: r.get(3)?,
        // 坏 JSON 不该让整份快照失败：这条记录的价值在于「有过这件事」，不在于细节可读
        detail: detail.and_then(|d| serde_json::from_str(&d).ok()),
        curl: r.get(5)?,
        status: r.get(6)?,
        account_id: r.get(7)?,
    })
}

/// 最近的 N 条（新的在前）。模型靠它看「我上一步干了什么」，避免把同一件事再做一遍。
pub fn recent(conn: &Connection, limit: usize) -> Result<Vec<AiAction>> {
    let sql = format!("SELECT {ACTION_COLS} FROM campus_ai_actions ORDER BY id DESC LIMIT ?1");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([limit as i64], action_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 某个时刻之后**带 curl 的**记录（脚本导出用）。没有 curl 的条目导出出来也没有意义。
pub fn scriptable_since(conn: &Connection, since: &str, limit: usize) -> Result<Vec<AiAction>> {
    let sql = format!(
        "SELECT {ACTION_COLS} FROM campus_ai_actions \
         WHERE at >= ?1 AND curl IS NOT NULL AND curl <> '' ORDER BY id ASC LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![since, limit as i64], action_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 同一条请求在窗口里是不是已经打得太多了。
pub fn circuit_broken(conn: &Connection, fp: &str, since: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM campus_ai_actions WHERE fp = ?1 AND at >= ?2",
        rusqlite::params![fp, since],
        |r| r.get(0),
    )?;
    Ok(n >= CIRCUIT_LIMIT)
}

/// 审计表瘦身：只留最近 [`KEEP_ROWS`] 行。救援期间一次排障几十条很正常，
/// 但没人会想在一个健康检查表里翻三年前的东西。
pub const KEEP_ROWS: i64 = 500;

pub fn prune(conn: &Connection) -> Result<usize> {
    let n = conn.execute(
        "DELETE FROM campus_ai_actions WHERE id <= (SELECT MAX(id) - ?1 FROM campus_ai_actions)",
        [KEEP_ROWS],
    )?;
    Ok(n)
}

/* ─────────────────────────── 现场判读 ─────────────────────────── */

/// 「卡住」的任务：还在场上（非终态、没被暂停），但要么连败过，要么早该动了却没动。
///
/// 这只是**给模型的提示**，不是结论 —— 引擎里那些精心设计的等待（等窗口、让贤、满员节奏）
/// 都会让 `next_at` 落在未来，所以判据里必须带 `now`，且只挑「逾期」的那种。
pub fn stuck_tasks(tasks: &[GrabTask], now_ms: i64) -> Vec<i64> {
    tasks
        .iter()
        .filter(|t| !grab_is_terminal(&t.status) && t.status != GRAB_PAUSED)
        .filter(|t| t.strikes >= 3 || t.next_at <= now_ms)
        .map(|t| t.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_for_test;

    fn spec(method: &str, url: &str) -> RequestSpec {
        RequestSpec {
            method: method.into(),
            url: url.into(),
            headers: vec![],
            body: None,
            with_cookie: false,
            with_token: false,
        }
    }

    fn entry(at: &str, summary: &str, curl: &str) -> AiAction {
        AiAction {
            id: 1,
            at: at.into(),
            kind: KIND_HTTP.into(),
            summary: summary.into(),
            detail: None,
            curl: Some(curl.into()),
            status: STATUS_OK.into(),
            account_id: None,
        }
    }

    #[test]
    fn method_is_normalized_and_whitelisted() {
        assert_eq!(normalize_method(None).unwrap(), "GET");
        assert_eq!(normalize_method(Some(" post ")).unwrap(), "POST");
        // 未知方法必须报错：`Session::request` 对未识别的方法会退化成 GET，
        // 那会让「我发的是 DELETE」变成一句安静的谎
        assert!(normalize_method(Some("TRACE")).is_err());
        assert!(normalize_method(Some("")).is_err());
    }

    #[test]
    fn url_is_resolved_against_base() {
        let base = "https://bkjwtest.guet.edu.cn/";
        assert_eq!(
            resolve_url("/student/home", base).unwrap(),
            "https://bkjwtest.guet.edu.cn/student/home"
        );
        assert_eq!(
            resolve_url("student/home", base).unwrap(),
            "https://bkjwtest.guet.edu.cn/student/home"
        );
        assert_eq!(
            resolve_url("https://other.example/x", base).unwrap(),
            "https://other.example/x"
        );
        assert!(resolve_url("  ", base).is_err());
    }

    #[test]
    fn same_origin_needs_scheme_host_and_port() {
        let base = Some("https://bkjwtest.guet.edu.cn");
        assert_eq!(
            check_target("https://bkjwtest.guet.edu.cn/student/home", base).unwrap(),
            Target::SameOrigin
        );
        // 换主机、换 scheme、换端口，三者任一不同都不算同源
        assert_eq!(
            check_target("https://evil.example/collect", base).unwrap(),
            Target::Public
        );
        assert_eq!(
            check_target("http://bkjwtest.guet.edu.cn/student/home", base).unwrap(),
            Target::Public
        );
        assert_eq!(
            check_target("https://bkjwtest.guet.edu.cn:8443/x", base).unwrap(),
            Target::Public
        );
        // 没有账号时一切按公网处理
        assert_eq!(
            check_target("https://bkjwtest.guet.edu.cn/x", None).unwrap(),
            Target::Public
        );
    }

    #[test]
    fn curl_uses_variable_refs_and_escapes_body() {
        let mut s = spec("POST", "https://h/p");
        s.with_cookie = true;
        s.with_token = true;
        s.headers = vec![("Content-Type".into(), "application/json".into())];
        s.body = Some(r#"{"q":"it's ok"}"#.into());
        let out = render_curl(&s);

        // 凭据只以变量引用的形式出现（双引号包裹，shell 才会展开）
        assert!(out.contains("-H \"Cookie: $COOKIE\""));
        assert!(out.contains("-H \"Authorization: $SELECT_TOKEN\""));
        assert!(out.contains("export COOKIE SELECT_TOKEN"));
        // 正文里的单引号被正确逃逸，粘进 bash 不会截断字符串
        assert!(out.contains(r#"--data-raw '{"q":"it'\''s ok"}'"#), "{out}");
        assert!(out.starts_with("# 先设变量再执行"));
    }

    #[test]
    fn curl_off_campus_carries_nothing() {
        let out = render_curl(&spec("GET", "https://example.com/x"));
        assert!(!out.contains("COOKIE"));
        assert!(!out.contains("SELECT_TOKEN"));
        assert_eq!(out, "curl -sS -i -X GET 'https://example.com/x'");
    }

    #[test]
    fn script_has_skeleton_and_entries() {
        let script = render_script(
            &[
                entry("2026-09-20T07:00:00Z", "探会话", "curl -sS -i -X GET 'https://h/a' -H \"Cookie: $COOKIE\""),
                entry("2026-09-20T07:01:00Z", "看名单", "curl -sS -i -X GET 'https://h/b'"),
            ],
            &ScriptEnv {
                base: "https://h",
                cookie: Some("__pstsid__=abc; SESSION=xyz"),
                select_token: Some("eyJhbGciOiJIUzI1NiJ9.x.y"),
                generated_at: "2026-09-20T07:02:00Z",
            },
        );
        assert!(script.starts_with("#!/usr/bin/env bash\n"));
        assert!(script.contains("set -euo pipefail"));
        assert!(script.contains("COOKIE='__pstsid__=abc; SESSION=xyz'"));
        assert!(script.contains("SELECT_TOKEN='eyJhbGciOiJIUzI1NiJ9.x.y'"));
        assert!(script.contains("# ── 1) 2026-09-20T07:00:00Z · 探会话"));
        assert!(script.contains("# ── 2) 2026-09-20T07:01:00Z · 看名单"));
        assert_eq!(script.matches("curl -sS").count(), 2);
        // 行尾必须是 LF：Windows 上 CRLF 的 .sh 会让 bash 报 $'\r': command not found
        assert!(!script.contains('\r'), "脚本里不该出现 CR");
    }

    #[test]
    fn script_warns_when_cookie_is_gone() {
        let script = render_script(
            &[entry("2026-09-20T07:00:00Z", "探会话", "curl -sS -i -X GET 'https://h/a' -H \"Cookie: $COOKIE\"")],
            &ScriptEnv {
                base: "https://h",
                cookie: None,
                select_token: None,
                generated_at: "2026-09-20T07:02:00Z",
            },
        );
        assert!(script.contains("当前账号没有可用 Cookie"));
        assert!(!script.contains("COOKIE="));
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        let body = "会话已过期".as_bytes();
        let (text, cut, total) = truncate(body, 4);
        assert!(cut);
        assert_eq!(total, body.len());
        assert_eq!(text, "会"); // 4 字节处落在一个汉字的中间，退回到字符边界
        let (all, cut2, _) = truncate(body, 999);
        assert!(!cut2);
        assert_eq!(all, "会话已过期");
    }

    #[test]
    fn kind_is_normalized_against_the_whitelist() {
        assert_eq!(normalize_kind(" HTTP ").unwrap(), KIND_HTTP);
        assert_eq!(normalize_kind("session").unwrap(), KIND_SESSION);
        // 自造的 kind 会让「按类型筛」失效，宁可报错让它改
        assert!(normalize_kind("fetch").is_err());
        assert!(normalize_kind("").is_err());
    }

    #[test]
    fn fingerprint_tracks_method_url_body() {
        let a = fingerprint("GET", "https://h/a", None);
        let b = fingerprint("get", "https://h/a", None);
        let c = fingerprint("GET", "https://h/a", Some("{}"));
        assert_eq!(a, b, "方法与空正文都要归一化");
        assert_ne!(a, c);
    }

    #[test]
    fn audit_roundtrip_and_circuit_breaker() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();

        let fp = fingerprint("GET", "https://h/a", None);
        for i in 0..CIRCUIT_LIMIT {
            record(
                &conn,
                "2026-09-20T07:00:00Z",
                Audit {
                    kind: KIND_HTTP,
                    summary: &format!("第 {i} 次"),
                    detail: Some(&serde_json::json!({"status": 200})),
                    curl: Some("curl -sS -i -X GET 'https://h/a'"),
                    fp: Some(&fp),
                    status: STATUS_OK,
                    account_id: Some(7),
                },
            )
            .unwrap();
        }
        // 第 20 条之前不算熔断，第 20 条开始算（上限是「允许 20 次」）
        assert!(circuit_broken(&conn, &fp, "2026-09-20T00:00:00Z").unwrap());
        assert!(!circuit_broken(&conn, &fp, "2026-09-21T00:00:00Z").unwrap());
        assert!(!circuit_broken(&conn, "GET https://h/b 0", "2026-09-20T00:00:00Z").unwrap());

        let all = recent(&conn, 50).unwrap();
        assert_eq!(all.len(), CIRCUIT_LIMIT as usize);
        assert_eq!(all[0].summary, format!("第 {} 次", CIRCUIT_LIMIT - 1), "新的在前");
        assert_eq!(all[0].detail.as_ref().unwrap()["status"], 200);
        assert_eq!(all[0].account_id, Some(7));

        // 只有带 curl 的条目才进脚本
        record(
            &conn,
            "2026-09-20T07:05:00Z",
            Audit {
                kind: KIND_GRAB,
                summary: "重试了任务 3",
                detail: None,
                curl: None,
                fp: None,
                status: STATUS_OK,
                account_id: Some(7),
            },
        )
        .unwrap();
        let scriptable = scriptable_since(&conn, "2026-09-20T00:00:00Z", 100).unwrap();
        assert_eq!(scriptable.len(), CIRCUIT_LIMIT as usize);
        let later = scriptable_since(&conn, "2026-09-20T07:04:00Z", 100).unwrap();
        assert!(later.is_empty());

        // 瘦身：只留最近 KEEP_ROWS 条
        let removed = prune(&conn).unwrap();
        assert_eq!(removed, 0, "还没到上限就不该删东西");
    }

    #[test]
    fn stuck_picks_only_overdue_or_losing_tasks() {
        let mk = |id: i64, status: &str, strikes: i64, next_at: i64| GrabTask {
            id,
            status: status.into(),
            strikes,
            next_at,
            ..GrabTask::blank()
        };
        let now = 1_000_000;
        let tasks = vec![
            mk(1, super::super::models::GRAB_WAITING, 0, now + 5000), // 正常等在窗口前
            mk(2, super::super::models::GRAB_WAITING, 0, now - 1),    // 逾期没动
            mk(3, super::super::models::GRAB_RUNNING, 4, now + 5000), // 连败 4 次
            mk(4, super::super::models::GRAB_SUCCESS, 9, now - 1),    // 终态：不是「卡住」
            mk(5, super::super::models::GRAB_PAUSED, 9, now - 1),     // 用户自己停的：别去动它
        ];
        assert_eq!(stuck_tasks(&tasks, now), vec![2, 3]);
    }
}
