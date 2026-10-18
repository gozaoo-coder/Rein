//! 对外服务网关的存储层：凭据（`ext_clients`）、审计（`ext_audit`）、设置（`app_meta` 键）
//! 与 token 原语。
//!
//! 三条纪律，全文照抄仓库既有先例：
//!
//! 1. **明文令牌永不落库**。生成 32 字节 `OsRng` → base64url → 只在用户点「始终允许」那一刻回写
//!    一次给客户端；库里只留 `sha256` 的 hex（先例：`ai_models.api_key`、同步 `identity` 私钥）。
//! 2. **比较是恒定时间**，XOR 折叠（照抄 `modules/sync/crypto.rs::hello_mac_ok`），
//!    绝不用 SQL 相等做密码学比较 —— SQL 查询本身不是恒定时间。
//! 3. **连接一律由调用方给**（`&Connection`），本模块不 `Connection::open`：
//!    同步的 `update_hook` 是**连接级**的，自开连接会绕过捕获（STANDARDS §1 单连接铁律）。
//!
//! 本模块不碰锁、不开事务 —— 短锁 / 三段式由上层 handler 编排（contract §6.3）。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::error::{ReinError, Result};
use crate::modules::gateway::models::{
    AuditEntry, AuditRecord, BindMode, ClientDecision, ExtClient, PromptGate, ScopeSet,
};
use crate::modules::gateway::protocol::Method;

// ---------------------------------------------------------------- token 原语

/// 令牌前缀。标识「这是 Rein 外部访问令牌」，便于用户与日志辨认。
pub const TOKEN_PREFIX: &str = "rein_ext_";

/// 忽略静默窗口（秒）：同一客户端 30 秒内的重复挂起不再弹窗（contract §16「忽略」那一行）。
pub const IGNORE_WINDOW_SECS: i64 = 30;

/// 连续忽略到这一次后转为静默挂起，不再打扰用户（contract §16「连续 3 次 → 静默挂起」）。
pub const MAX_SILENT_PROMPTS: i64 = 3;

/// 生成一枚外部客户端令牌：32 字节 `OsRng` → base64url（无填充）+ 前缀 `rein_ext_`。
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(buf))
}

/// 令牌是否长得像自己家的（前缀对）。只用于快速拒绝明显不合形状的输入，**不是**鉴权。
pub fn looks_like_token(s: &str) -> bool {
    s.starts_with(TOKEN_PREFIX) && s.len() > TOKEN_PREFIX.len()
}

/// `sha256(token)` 的十六进制 —— 库里**只存**这个。
pub fn hash_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    let digest = h.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 恒定时间字符串比较：长度不同直接 `false`；等长则逐字节 XOR 折叠后判零。
/// 不因「第几个字节不同」泄漏时间差（照抄 `sync/crypto.rs::hello_mac_ok`）。
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b)
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// 明文令牌与库里存的哈希做恒定时间比较。
///
/// 生产侧走 [`find_by_token`]（它自己逐行比哈希），这条目前只有单测在用。
#[cfg(test)]
pub fn token_matches(token: &str, stored_hash: &str) -> bool {
    constant_time_eq(&hash_token(token), stored_hash)
}

/// 统一的 ISO-8601 时间戳（UTC）。全库时间列都用它写，避免两套表示（STANDARDS §5）。
pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------- app_meta 键

/// 开关（"1"/"0"）。
pub const KEY_ENABLED: &str = "gateway.enabled";
/// 绑定模式（`BindMode::as_str`）。
pub const KEY_BIND_MODE: &str = "gateway.bindMode";
/// 实际端口（十进制文本；未运行时为空）。
pub const KEY_PORT: &str = "gateway.port";
/// 安装级配对令牌（LAN 模式必填）。
pub const KEY_PAIR_TOKEN: &str = "gateway.pairToken";

pub fn get_enabled(conn: &Connection) -> bool {
    crate::db::meta_get(conn, KEY_ENABLED).as_deref() == Some("1")
}

pub fn set_enabled(conn: &Connection, on: bool) -> Result<()> {
    crate::db::meta_set(conn, KEY_ENABLED, if on { "1" } else { "0" })
}

pub fn get_bind_mode(conn: &Connection) -> BindMode {
    crate::db::meta_get(conn, KEY_BIND_MODE)
        .and_then(|s| BindMode::parse(&s))
        .unwrap_or(BindMode::DEFAULT)
}

pub fn set_bind_mode(conn: &Connection, mode: BindMode) -> Result<()> {
    crate::db::meta_set(conn, KEY_BIND_MODE, mode.as_str())
}

pub fn get_port(conn: &Connection) -> Option<u16> {
    crate::db::meta_get(conn, KEY_PORT).and_then(|s| s.parse::<u16>().ok())
}

pub fn set_port(conn: &Connection, port: Option<u16>) -> Result<()> {
    match port {
        Some(p) => crate::db::meta_set(conn, KEY_PORT, &p.to_string()),
        None => crate::db::meta_del(conn, KEY_PORT),
    }
}

/// 读配对令牌（未生成过则 `None`）。
pub fn get_pair_token(conn: &Connection) -> Option<String> {
    crate::db::meta_get(conn, KEY_PAIR_TOKEN)
}

/// 确保配对令牌存在并返回它。生成时用同一套 32 字节随机（与客户端令牌同熵，只是没有前缀）。
pub fn ensure_pair_token(conn: &Connection) -> Result<String> {
    if let Some(t) = get_pair_token(conn) {
        return Ok(t);
    }
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    let token = URL_SAFE_NO_PAD.encode(buf);
    crate::db::meta_set(conn, KEY_PAIR_TOKEN, &token)?;
    Ok(token)
}

// ---------------------------------------------------------------- 功能模块开关快照（contract §4.7）

/// 已启用的功能模块 id 快照（JSON 字符串数组）。前端 `stores/features.ts` 是唯一作者：
/// 每次开/关（以及每次启动）把整份快照推过来，Rust 侧只读不写业务判断。
pub const KEY_ENABLED_MODULES: &str = "gateway.enabledModules";

/// 快照条数上限（当前只有 10 个可开关模块，留足余量；超限拒绝而不是静默截断）。
pub const MAX_ENABLED_MODULES: usize = 64;

/// 单个模块 id 的长度上限。
pub const MAX_MODULE_ID_LEN: usize = 64;

/// 清洗一份快照：去空白项、去重（保序）。超长 / 超量在写侧拒绝（与 Origin 白名单同一套纪律）。
fn normalize_modules_lossy(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in ids {
        let id = raw.trim();
        if !id.is_empty() && !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// 读快照；`None` = 从没推过（前端尚未启动到推快照那一步），与「空表 = 全关」区分开。
pub fn stored_modules(conn: &Connection) -> Option<Vec<String>> {
    crate::db::meta_get(conn, KEY_ENABLED_MODULES)
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .map(|list| normalize_modules_lossy(&list))
}

/// 写入快照（整表替换语义）。返回清洗后的列表。
pub fn set_enabled_modules(conn: &Connection, ids: &[String]) -> Result<Vec<String>> {
    let cleaned = normalize_modules_lossy(ids);
    if cleaned.len() > MAX_ENABLED_MODULES {
        return Err(ReinError::coded(
            "bad_request",
            format!("模块条数超限（上限 {MAX_ENABLED_MODULES} 条）"),
        ));
    }
    if cleaned.iter().any(|m| m.chars().count() > MAX_MODULE_ID_LEN) {
        return Err(ReinError::coded(
            "bad_request",
            format!("模块 id 过长（上限 {MAX_MODULE_ID_LEN} 字符）"),
        ));
    }
    let json = serde_json::to_string(&cleaned).unwrap_or_else(|_| "[]".to_string());
    crate::db::meta_set(conn, KEY_ENABLED_MODULES, &json)?;
    Ok(cleaned)
}

/// 某个功能模块此刻是否开着。
///
/// **缺快照 = 全部视为开着**（fail-open，刻意）：快照由前端启动时推，而网关只可能
/// 从前端设置页打开 —— 真机上不存在「服务在跑但快照没推」的稳态。反过来 fail-closed
/// 会把一次漏推放大成「对外接口整体不可用」，而这道门禁**不是安全边界**
/// （边界是首帧令牌 + 逐次 scope + 用户授权），它只是一致性闸门。
pub fn is_module_enabled(conn: &Connection, plugin: &str) -> bool {
    match stored_modules(conn) {
        None => true,
        Some(list) => list.iter().any(|m| m == plugin),
    }
}

/// 模块门禁：方法所属模块被用户关掉时拒绝（`server.rs::handle_request` 在短锁内调它）。
///
/// 顺序上**排在 scope 校验之前**：它是「这个功能此刻在不在」的事实，不是授权判定 ——
/// 客户端即便拿着全部 scope，界面上关掉的功能也不该可用。
pub fn module_gate(conn: &Connection, method: Method) -> Result<()> {
    let Some(plugin) = method.plugin() else {
        return Ok(());
    };
    if is_module_enabled(conn, plugin) {
        return Ok(());
    }
    Err(ReinError::coded(
        "module_disabled",
        format!(
            "功能「{plugin}」已关闭，「{}」暂不可用：请在设置 › 打开或关闭功能里开启它",
            method.name()
        ),
    ))
}

// ---------------------------------------------------------------- Origin 白名单（contract §15）

/// 用户批准过的网页来源（`Origin` 头）白名单，JSON 字符串数组。
pub const KEY_ALLOWED_ORIGINS: &str = "gateway.allowedOrigins";

/// 单个 Origin 的长度上限（写侧校验，contract §17.5「写字段长度校验」）。
pub const MAX_ORIGIN_LEN: usize = 512;

/// 白名单条数上限（超限拒绝，不静默截断）。
pub const MAX_ORIGINS: usize = 64;

/// 被拒握手的审计 `detail` 前缀 —— [`list_blocked_origins`] 靠它把 Origin 捞回来
/// （contract §15.2b：被 403 的 Origin 落审计，设置页据此列出「被拦下的来源」）。
pub const ORIGIN_BLOCKED_PREFIX: &str = "浏览器来源未在白名单：";

/// 读白名单。坏 JSON / 非字符串数组一律当空表（宁可拒绝，不可放行）。
pub fn get_allowed_origins(conn: &Connection) -> Vec<String> {
    crate::db::meta_get(conn, KEY_ALLOWED_ORIGINS)
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .map(|list| normalize_origins_lossy(&list))
        .unwrap_or_default()
}

/// 清洗一份白名单：去空白项、去重（保序）。
fn normalize_origins_lossy(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in list {
        let o = raw.trim();
        if !o.is_empty() && !out.iter().any(|x| x == o) {
            out.push(o.to_string());
        }
    }
    out
}

/// 写入白名单（整表替换语义）。空表写入 `"[]"`（键保留、读取解析为空表；无害的常驻键）。
/// 长度 / 条数超限回 `bad_request`（写侧校验，contract §17.5）——错误文案不回显来源串本身，
/// 避免把可疑内容带进 UI。
pub fn set_allowed_origins(conn: &Connection, origins: &[String]) -> Result<Vec<String>> {
    let cleaned = normalize_origins_lossy(origins);
    if cleaned.len() > MAX_ORIGINS {
        return Err(ReinError::coded(
            "bad_request",
            format!("来源条数超限（上限 {MAX_ORIGINS} 条）"),
        ));
    }
    if cleaned.iter().any(|o| o.chars().count() > MAX_ORIGIN_LEN) {
        return Err(ReinError::coded(
            "bad_request",
            format!("来源过长（上限 {MAX_ORIGIN_LEN} 字符）"),
        ));
    }
    // 序列化不会失败（元素都是字符串），失败也退化成空数组。
    let json = serde_json::to_string(&cleaned).unwrap_or_else(|_| "[]".to_string());
    crate::db::meta_set(conn, KEY_ALLOWED_ORIGINS, &json)?;
    Ok(cleaned)
}

/// 「被拦下的来源」：被 Origin 闸门拒过、且**尚未**加入白名单的 Origin（去重、最近优先）。
/// 设置页据此一键「加入白名单」（contract §15.2b）。
pub fn list_blocked_origins(conn: &Connection, limit: i64) -> Result<Vec<String>> {
    let take = clamp_limit(limit) as usize;
    let allowed = get_allowed_origins(conn);
    let mut stmt = conn.prepare(
        "SELECT detail FROM ext_audit \
         WHERE method = '' AND decision = 'denied' AND detail LIKE ?1 \
         ORDER BY at DESC, id DESC LIMIT ?2",
    )?;
    // 一个 Origin 可能被拒很多次：多扫一些行再在 Rust 侧去重（接不上就少列几个，不影响正确性）。
    let rows = stmt.query_map(
        params![format!("{ORIGIN_BLOCKED_PREFIX}%"), (take * 10) as i64],
        |r| r.get::<_, String>(0),
    )?;
    let mut out: Vec<String> = Vec::new();
    for row in rows {
        let detail = row?;
        let Some(origin) = detail.strip_prefix(ORIGIN_BLOCKED_PREFIX) else {
            continue;
        };
        let origin = origin.trim();
        if origin.is_empty()
            || allowed.iter().any(|a| a == origin)
            || out.iter().any(|o| o == origin)
        {
            continue;
        }
        out.push(origin.to_string());
        if out.len() >= take {
            break;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- 运行态快照（contract §14）

/// 番茄钟运行态快照的 `app_meta` 键（值 = 原样 JSON `FocusRuntime`）。
pub const KEY_FOCUS_RUNTIME: &str = "runtime.focus.v1";

/// 运行态陈旧阈值（毫秒）：前端 1 秒一次上报（`focus_publish`），超过 5 秒没有新值即视作已停。
/// 判定用**服务端**写入时刻，不信前端自报的 `reportedAt`（contract §14.1）。
pub const RUNTIME_TTL_MS: i64 = 5_000;

/// 写入时刻存在快照键的兄弟键上（`runtime.focus.v1.at`），值 = ISO-8601。
const RUNTIME_AT_SUFFIX: &str = ".at";

/// 一份运行态快照：原样载荷 + 服务端写入时刻。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSnapshot {
    /// `app_meta` 里那份原样 JSON 文本（上层自己解析成 `FocusRuntime`）。
    pub payload: String,
    /// ISO-8601（服务端时钟）。
    pub written_at: String,
}

/// 写入时刻的伴随键名。
pub fn runtime_at_key(key: &str) -> String {
    format!("{key}{RUNTIME_AT_SUFFIX}")
}

/// 写一份运行态快照（写入时刻 = 现在）。载荷原样落库，本层不解析其形状。
pub fn put_runtime_snapshot(conn: &Connection, key: &str, payload: &str) -> Result<()> {
    put_runtime_snapshot_at(conn, key, payload, &now_iso())
}

/// 指定写入时刻（测试 / 重启恢复用）。
pub fn put_runtime_snapshot_at(
    conn: &Connection,
    key: &str,
    payload: &str,
    at: &str,
) -> Result<()> {
    crate::db::meta_set(conn, key, payload)?;
    crate::db::meta_set(conn, &runtime_at_key(key), at)
}

/// 读一份运行态快照（不存在返回 `None`）。缺写入时刻的旧快照照样返回，陈旧判定自会判它陈旧。
pub fn get_runtime_snapshot(conn: &Connection, key: &str) -> Result<Option<RuntimeSnapshot>> {
    let Some(payload) = crate::db::meta_get(conn, key) else {
        return Ok(None);
    };
    Ok(Some(RuntimeSnapshot {
        payload,
        written_at: crate::db::meta_get(conn, &runtime_at_key(key)).unwrap_or_default(),
    }))
}

/// 清掉运行态快照（键 + 写入时刻键）。`focus_unpublish` / 恢复自检用它。
pub fn clear_runtime_snapshot(conn: &Connection, key: &str) -> Result<()> {
    crate::db::meta_del(conn, key)?;
    crate::db::meta_del(conn, &runtime_at_key(key))
}

/// 快照是否已陈旧：`now - writtenAt > ttlMs`。时间戳缺失 / 解不出来一律按陈旧处理
/// （宁可对外报「没有运行态」，也不报一个来历不明的旧值）。
pub fn is_runtime_stale(written_at: &str, now: DateTime<Utc>, ttl_ms: i64) -> bool {
    match DateTime::parse_from_rfc3339(written_at) {
        Ok(t) => now
            .signed_duration_since(t.with_timezone(&Utc))
            .num_milliseconds()
            > ttl_ms,
        Err(_) => true,
    }
}

/// 只在**未陈旧**时返回快照 —— `pomodoro.status` 用这一个就够（陈旧即 `null`，contract §14.1）。
pub fn fresh_runtime_snapshot(conn: &Connection, key: &str) -> Result<Option<RuntimeSnapshot>> {
    Ok(get_runtime_snapshot(conn, key)?
        .filter(|s| !is_runtime_stale(&s.written_at, Utc::now(), RUNTIME_TTL_MS)))
}

// ---------------------------------------------------------------- ext_clients 读写

/// `ext_clients` 的列清单，必须与 [`client_from_row`] 的下标一一对应。
const CLIENT_COLS: &str = "id, client_id, name, token_hash, scopes, decision, last_ip, \
     last_seen_at, created_at, decided_at, updated_at, revoked_at, last_prompt_at, prompt_count";

fn client_from_row(r: &rusqlite::Row) -> rusqlite::Result<ExtClient> {
    let scopes: String = r.get(4)?;
    let decision: String = r.get(5)?;
    Ok(ExtClient {
        id: r.get(0)?,
        client_id: r.get(1)?,
        name: r.get(2)?,
        token_hash: r.get(3)?,
        scopes: ScopeSet::from_json(&scopes),
        // 库里出现无法识别的决策（改了表 / 老版本写的）时按最保守的 `Ignore` 处理 —— 不放行。
        decision: ClientDecision::parse(&decision).unwrap_or(ClientDecision::Ignore),
        last_ip: r.get(6)?,
        last_seen_at: r.get(7)?,
        created_at: r.get(8)?,
        decided_at: r.get(9)?,
        updated_at: r.get(10)?,
        revoked_at: r.get(11)?,
        last_prompt_at: r.get(12)?,
        prompt_count: r.get(13)?,
    })
}

/// 按 `client_id` 取那一行（不存在返回 `None`）。
pub fn find_client(conn: &Connection, client_id: &str) -> Result<Option<ExtClient>> {
    let sql = format!("SELECT {CLIENT_COLS} FROM ext_clients WHERE client_id = ?1");
    Ok(conn
        .query_row(&sql, [client_id], client_from_row)
        .optional()?)
}

/// 全部客户端行（管理面列表用）。最新变动的排前面。
pub fn list_clients(conn: &Connection) -> Result<Vec<ExtClient>> {
    let sql = format!("SELECT {CLIENT_COLS} FROM ext_clients ORDER BY updated_at DESC, id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], client_from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 首帧带 `clientToken` 时的鉴权查找：只认 **decision='allow' 且未撤销** 的行。
///
/// **密码学比较只在 Rust 侧做**：SQL 只按 decision/revoked 取候选行（不看 `token_hash`），
/// 逐行用 [`constant_time_eq`] 做恒定时间比较 —— 绝不用 SQL 相等定夺令牌是否匹配
/// （SQLite 的字符串/索引查找不是恒定时间，contract §5.2）。
pub fn find_by_token(conn: &Connection, token: &str) -> Result<Option<ExtClient>> {
    let hash = hash_token(token);
    let sql = format!(
        "SELECT {CLIENT_COLS} FROM ext_clients \
         WHERE decision = 'allow' AND revoked_at IS NULL AND token_hash IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let client = client_from_row(row)?;
        if let Some(stored) = &client.token_hash {
            if constant_time_eq(stored, &hash) {
                return Ok(Some(client));
            }
        }
    }
    Ok(None)
}

/// 用户点「始终允许」：落一行 `allow` + scopes + token 哈希，清掉此前的撤销与忽略痕迹。
/// 已存在同 client_id 的行则就地升级（含 session→always 的升级）。
pub fn upsert_allow(
    conn: &Connection,
    client_id: &str,
    name: &str,
    scopes: &ScopeSet,
    token_hash: &str,
    ip: Option<&str>,
) -> Result<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO ext_clients \
           (client_id, name, token_hash, scopes, decision, last_ip, last_seen_at, \
            created_at, decided_at, updated_at, revoked_at, last_prompt_at, prompt_count) \
         VALUES (?1, ?2, ?3, ?4, 'allow', ?5, ?6, ?6, ?6, ?6, NULL, NULL, 0) \
         ON CONFLICT(client_id) DO UPDATE SET \
           name = excluded.name, token_hash = excluded.token_hash, scopes = excluded.scopes, \
           decision = 'allow', last_ip = excluded.last_ip, last_seen_at = excluded.last_seen_at, \
           decided_at = excluded.decided_at, updated_at = excluded.updated_at, \
           revoked_at = NULL, last_prompt_at = NULL, prompt_count = 0",
        params![
            client_id,
            name,
            token_hash,
            scopes.to_json(),
            ip,
            now.as_str()
        ],
    )?;
    Ok(())
}

/// 用户点「拒绝」：落一行 `deny`（无令牌、无 scope），清掉此前的撤销与忽略痕迹。
pub fn upsert_deny(conn: &Connection, client_id: &str, name: &str, ip: Option<&str>) -> Result<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO ext_clients \
           (client_id, name, token_hash, scopes, decision, last_ip, last_seen_at, \
            created_at, decided_at, updated_at, revoked_at, last_prompt_at, prompt_count) \
         VALUES (?1, ?2, NULL, '[]', 'deny', ?3, ?4, ?4, ?4, ?4, NULL, NULL, 0) \
         ON CONFLICT(client_id) DO UPDATE SET \
           name = excluded.name, token_hash = NULL, scopes = '[]', decision = 'deny', \
           last_ip = excluded.last_ip, last_seen_at = excluded.last_seen_at, \
           decided_at = excluded.decided_at, updated_at = excluded.updated_at, \
           revoked_at = NULL, last_prompt_at = NULL, prompt_count = 0",
        params![client_id, name, ip, now.as_str()],
    )?;
    Ok(())
}

/// 用户点「忽略」：只记限频（`last_prompt_at` + `prompt_count`），**不授予任何权限**。
///
/// 首次接触的客户端此前没有行，所以这里会落一行 `decision='ignore'` 专门承载限频记录；
/// 若该客户端已有 `allow`/`deny` 决策，`DO UPDATE ... WHERE` 使它不被污染（忽略不该改结论）。
pub fn record_ignore(conn: &Connection, client_id: &str, name: &str, ip: Option<&str>) -> Result<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO ext_clients \
           (client_id, name, token_hash, scopes, decision, last_ip, last_seen_at, \
            created_at, decided_at, updated_at, revoked_at, last_prompt_at, prompt_count) \
         VALUES (?1, ?2, NULL, '[]', 'ignore', ?3, ?4, ?4, NULL, ?4, NULL, ?4, 1) \
         ON CONFLICT(client_id) DO UPDATE SET \
           name = CASE WHEN excluded.name = '' THEN ext_clients.name ELSE excluded.name END, \
           last_ip = COALESCE(excluded.last_ip, ext_clients.last_ip), \
           last_seen_at = excluded.last_seen_at, \
           updated_at = excluded.updated_at, \
           last_prompt_at = excluded.last_prompt_at, \
           prompt_count = ext_clients.prompt_count + 1 \
         WHERE ext_clients.decision NOT IN ('allow', 'deny')",
        params![client_id, name, ip, now.as_str()],
    )?;
    Ok(())
}

/// 更新「最后活跃」：每次成功鉴权/握手后调用。
pub fn touch_seen(conn: &Connection, client_id: &str, ip: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE ext_clients SET last_seen_at = ?2, last_ip = COALESCE(?3, last_ip), updated_at = ?2 \
         WHERE client_id = ?1",
        params![client_id, now_iso(), ip],
    )?;
    Ok(())
}

/// 撤销：置 `revoked_at` 并清掉 token 哈希 —— 下次带旧令牌来即 `unauthorized`。
/// 保留行是为了审计与设置页能显示「已撤销」。
pub fn revoke_client(conn: &Connection, client_id: &str) -> Result<()> {
    let now = now_iso();
    conn.execute(
        "UPDATE ext_clients SET revoked_at = ?2, token_hash = NULL, updated_at = ?2 \
         WHERE client_id = ?1",
        params![client_id, now],
    )?;
    Ok(())
}

/// 从设置页彻底删掉一行（拒绝名单靠它解除，回到「无记录」）。
pub fn delete_client(conn: &Connection, client_id: &str) -> Result<()> {
    conn.execute("DELETE FROM ext_clients WHERE client_id = ?1", [client_id])?;
    Ok(())
}

/// 「要不要弹授权窗」的判定（见 [`PromptGate`]）。只对**没有有效决策**的客户端有意义。
pub fn prompt_gate(conn: &Connection, client_id: &str) -> Result<PromptGate> {
    let row: Option<(Option<String>, i64)> = conn
        .query_row(
            "SELECT last_prompt_at, prompt_count FROM ext_clients WHERE client_id = ?1",
            [client_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((last, count)) = row else {
        return Ok(PromptGate::Show);
    };
    if let Some(last) = last.as_deref() {
        if within_ignore_window(last, IGNORE_WINDOW_SECS) {
            return Ok(PromptGate::Suppress);
        }
    }
    if count >= MAX_SILENT_PROMPTS {
        return Ok(PromptGate::Silent);
    }
    Ok(PromptGate::Show)
}

/// `last_prompt_at` 距现在是否仍在静默窗口内。时间戳解不出来时按「不在窗口内」处理
/// （宁可多弹一次，也不把用户永久静默在一个坏时间戳上）。
pub fn within_ignore_window(last_prompt_at: &str, window_secs: i64) -> bool {
    match DateTime::parse_from_rfc3339(last_prompt_at) {
        Ok(t) => {
            let elapsed = Utc::now().signed_duration_since(t.with_timezone(&Utc));
            elapsed.num_seconds() < window_secs
        }
        Err(_) => false,
    }
}

// ---------------------------------------------------------------- ext_audit 读写

/// 审计单页上限 —— 与 contract §6.4 的列表上限一致。
pub const AUDIT_LIMIT_MAX: i64 = 500;

/// 写一条审计（`ext_audit`）。返回新行 id。
pub fn insert_audit(conn: &Connection, rec: &AuditRecord) -> Result<i64> {
    conn.execute(
        "INSERT INTO ext_audit (at, client_id, method, scope, decision, detail, ip, duration_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            rec.at,
            rec.client_id,
            rec.method,
            rec.scope,
            rec.decision.as_str(),
            rec.detail,
            rec.ip,
            rec.duration_ms
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 列表 / 审计的 `limit` 统一夹到 `[1, AUDIT_LIMIT_MAX]`：
/// `<= 0` 视为 1（至少回一行，而不是「不限」），超过上限视为上限。
fn clamp_limit(limit: i64) -> i64 {
    limit.clamp(1, AUDIT_LIMIT_MAX)
}

/// 最近的审计（管理/排障用）。按时间倒序。
pub fn list_audit(conn: &Connection, limit: i64) -> Result<Vec<AuditEntry>> {
    let sql = format!(
        "SELECT {} FROM ext_audit ORDER BY at DESC, id DESC LIMIT ?1",
        AuditEntry::COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([clamp_limit(limit)], AuditEntry::from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 某个客户端的历史审计。
pub fn list_audit_for_client(
    conn: &Connection,
    client_id: &str,
    limit: i64,
) -> Result<Vec<AuditEntry>> {
    let sql = format!(
        "SELECT {} FROM ext_audit WHERE client_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
        AuditEntry::COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![client_id, clamp_limit(limit)], AuditEntry::from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::gateway::models::{AuditDecision, Scope};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn token_shape_and_hash_are_stable() {
        let t = generate_token();
        assert!(t.starts_with("rein_ext_"));
        assert!(looks_like_token(&t));
        // 前缀 + 32 字节 base64url（无填充）= 43 字符
        assert_eq!(t.len(), TOKEN_PREFIX.len() + 43);
        assert_ne!(generate_token(), generate_token(), "每次生成都该是新的随机串");

        let h = hash_token(&t);
        assert_eq!(h.len(), 64, "sha256 hex");
        assert_eq!(h, hash_token(&t), "同输入同摘要");
        assert!(token_matches(&t, &h));
        assert!(!token_matches(&generate_token(), &h));
        assert!(!looks_like_token("schedule.read"));
    }

    #[test]
    fn constant_time_eq_matches_plain_eq() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn allow_row_authenticates_only_with_the_right_token() {
        let conn = db();
        let token = generate_token();
        let scopes = ScopeSet::minimal_default();
        upsert_allow(
            &conn,
            "c-1",
            "小组件",
            &scopes,
            &hash_token(&token),
            Some("127.0.0.1"),
        )
        .unwrap();

        let hit = find_by_token(&conn, &token).unwrap().expect("正确令牌应命中");
        assert_eq!(hit.client_id, "c-1");
        assert_eq!(hit.scopes, scopes);
        assert!(hit.is_authorized());
        assert!(find_by_token(&conn, &generate_token()).unwrap().is_none());

        // 撤销后旧令牌立刻失效
        revoke_client(&conn, "c-1").unwrap();
        assert!(find_by_token(&conn, &token).unwrap().is_none(), "撤销后必须 unauthorized");
        let row = find_client(&conn, "c-1").unwrap().unwrap();
        assert!(row.revoked_at.is_some());
        assert!(row.token_hash.is_none());
        assert!(!row.is_authorized());
    }

    #[test]
    fn deny_and_ignore_never_authenticate() {
        let conn = db();
        upsert_deny(&conn, "c-deny", "可疑程序", Some("10.0.0.9")).unwrap();
        record_ignore(&conn, "c-ign", "路过的小组件", Some("10.0.0.8")).unwrap();

        assert!(find_by_token(&conn, &generate_token()).unwrap().is_none());
        let deny = find_client(&conn, "c-deny").unwrap().unwrap();
        let ign = find_client(&conn, "c-ign").unwrap().unwrap();
        assert_eq!(deny.decision, ClientDecision::Deny);
        assert_eq!(ign.decision, ClientDecision::Ignore);
        assert!(!deny.is_authorized() && !ign.is_authorized());
        assert!(ign.scopes.is_empty(), "忽略不授予任何权限");
    }

    #[test]
    fn ignore_is_rate_limited_then_goes_silent() {
        let conn = db();
        assert_eq!(prompt_gate(&conn, "c-ign").unwrap(), PromptGate::Show, "首次应弹窗");
        record_ignore(&conn, "c-ign", "小组件", None).unwrap();
        assert_eq!(
            prompt_gate(&conn, "c-ign").unwrap(),
            PromptGate::Suppress,
            "30 秒内重复请求应静默"
        );
        for _ in 0..2 {
            record_ignore(&conn, "c-ign", "小组件", None).unwrap();
        }
        let row = find_client(&conn, "c-ign").unwrap().unwrap();
        assert_eq!(row.prompt_count, 3);
        // 把上次忽略时间推到窗口之外，计数已到上限 → 静默挂起
        conn.execute(
            "UPDATE ext_clients SET last_prompt_at = ?2 WHERE client_id = ?1",
            params!["c-ign", "2000-01-01T00:00:00+00:00"],
        )
        .unwrap();
        assert_eq!(prompt_gate(&conn, "c-ign").unwrap(), PromptGate::Silent);
    }

    #[test]
    fn ignore_does_not_overwrite_an_existing_decision() {
        let conn = db();
        let token = generate_token();
        upsert_allow(&conn, "c-1", "已批准", &ScopeSet::minimal_default(), &hash_token(&token), None)
            .unwrap();
        record_ignore(&conn, "c-1", "已批准", None).unwrap();
        let row = find_client(&conn, "c-1").unwrap().unwrap();
        assert_eq!(row.decision, ClientDecision::Allow, "忽略不该把 allow 改掉");
        assert_eq!(row.prompt_count, 0);
        assert!(find_by_token(&conn, &token).unwrap().is_some(), "批准仍然有效");
    }

    #[test]
    fn audit_rows_roundtrip_and_clamp() {
        let conn = db();
        let rec = AuditRecord {
            at: now_iso(),
            client_id: Some("c-1".into()),
            method: "schedule.list".into(),
            scope: Scope::ScheduleRead.as_str().into(),
            decision: AuditDecision::Allowed,
            detail: None,
            ip: Some("127.0.0.1".into()),
            duration_ms: 3,
        };
        insert_audit(&conn, &rec).unwrap();
        insert_audit(
            &conn,
            &AuditRecord {
                client_id: None,
                decision: AuditDecision::Denied,
                ..rec.clone()
            },
        )
        .unwrap();

        let all = list_audit(&conn, 100).unwrap();
        assert_eq!(all.len(), 2);
        let mine = list_audit_for_client(&conn, "c-1", 100).unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].method, "schedule.list");
        assert_eq!(mine[0].decision, AuditDecision::Allowed);

        // limit 统一夹到 [1, 500]：0 退化为 1，巨大值退化为上限
        assert_eq!(list_audit(&conn, 0).unwrap().len(), 1);
        assert_eq!(list_audit(&conn, i64::MAX).unwrap().len(), 2);
    }

    /// Origin 白名单：默认空、写入去重保序、超长/超量拒绝（写侧校验）。
    #[test]
    fn allowed_origins_are_normalized_and_bounded() {
        let conn = db();
        assert!(get_allowed_origins(&conn).is_empty(), "默认没有放行任何来源");

        let saved = set_allowed_origins(
            &conn,
            &[
                " null ".into(),
                "http://localhost:5173".into(),
                "null".into(),
                "".into(),
            ],
        )
        .unwrap();
        assert_eq!(saved, vec!["null", "http://localhost:5173"], "去空白 + 去重 + 保序");
        assert_eq!(get_allowed_origins(&conn), saved);

        // 超长单条 → bad_request，且不落库（旧值原样保留）
        let long = "x".repeat(MAX_ORIGIN_LEN + 1);
        assert_eq!(
            set_allowed_origins(&conn, &[long]).unwrap_err().code(),
            "bad_request"
        );
        assert_eq!(get_allowed_origins(&conn), saved);

        // 超量 → bad_request
        let many: Vec<String> = (0..(MAX_ORIGINS + 1)).map(|i| format!("http://h{i}")).collect();
        assert_eq!(
            set_allowed_origins(&conn, &many).unwrap_err().code(),
            "bad_request"
        );

        // 空表 = 清空（写入 "[]"，读取解析为空表；不删键）
        assert!(set_allowed_origins(&conn, &[]).unwrap().is_empty());
        assert!(get_allowed_origins(&conn).is_empty());
        // 坏 JSON 当空表（宁可拒绝，不可放行）
        crate::db::meta_set(&conn, KEY_ALLOWED_ORIGINS, "{ not json").unwrap();
        assert!(get_allowed_origins(&conn).is_empty());
    }

    /// 被 Origin 闸门拒过的来源进「被拦下的来源」；加入白名单后即从该清单消失。
    #[test]
    fn blocked_origins_come_from_audit_and_leave_once_allowed() {
        let conn = db();
        let audit = |origin: &str| AuditRecord {
            at: now_iso(),
            client_id: None,
            method: String::new(),
            scope: String::new(),
            decision: AuditDecision::Denied,
            detail: Some(format!("{ORIGIN_BLOCKED_PREFIX}{origin}")),
            ip: Some("127.0.0.1".into()),
            duration_ms: 0,
        };
        insert_audit(&conn, &audit("http://evil.example")).unwrap();
        insert_audit(&conn, &audit("http://evil.example")).unwrap(); // 重复拒绝只列一次
        insert_audit(&conn, &audit("null")).unwrap();
        // 别的审计行（不是 Origin 拒绝）不该被当成来源
        insert_audit(
            &conn,
            &AuditRecord {
                detail: Some("握手被拒".into()),
                ..audit("ignored")
            },
        )
        .unwrap();

        let blocked = list_blocked_origins(&conn, 10).unwrap();
        assert_eq!(blocked.len(), 2, "去重后两条：{blocked:?}");
        assert!(blocked.contains(&"http://evil.example".to_string()));
        assert!(blocked.contains(&"null".to_string()));

        // 用户点「允许」→ 写进白名单 → 从「被拦下的来源」消失
        set_allowed_origins(&conn, &["null".into()]).unwrap();
        let after = list_blocked_origins(&conn, 10).unwrap();
        assert_eq!(after, vec!["http://evil.example"], "已加白的来源不再列出");

        // limit 生效且夹到 [1, 500]
        assert_eq!(list_blocked_origins(&conn, 1).unwrap().len(), 1);
    }

    /// 运行态快照：原样读写 + 服务端写入时刻 + 陈旧判定（5 秒）。
    #[test]
    fn runtime_snapshot_roundtrip_and_staleness() {
        let conn = db();
        assert_eq!(get_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME).unwrap(), None);
        assert_eq!(fresh_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME).unwrap(), None);

        let payload = r#"{"phase":"focus","running":true,"remainingSec":1234}"#;
        put_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME, payload).unwrap();
        let snap = get_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME).unwrap().unwrap();
        assert_eq!(snap.payload, payload, "载荷原样落库");
        assert!(!snap.written_at.is_empty(), "写入时刻由服务端记");
        // 刚写完 → 未陈旧
        assert!(fresh_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME).unwrap().is_some());

        // 只写载荷、没有写入时刻（老版本 / 坏数据）→ 判陈旧
        crate::db::meta_del(&conn, &runtime_at_key(KEY_FOCUS_RUNTIME)).unwrap();
        assert!(fresh_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME).unwrap().is_none());
        assert!(is_runtime_stale("", Utc::now(), RUNTIME_TTL_MS));

        // 眨眼间的时间差：4.9s 未陈旧，5.1s 陈旧（阈值 5000ms，判定在后端）
        let now = Utc::now();
        let at = |ms: i64| (now - chrono::Duration::milliseconds(ms)).to_rfc3339();
        assert!(!is_runtime_stale(&at(4_900), now, RUNTIME_TTL_MS));
        assert!(is_runtime_stale(&at(5_100), now, RUNTIME_TTL_MS));

        // 清除 = 两个键一起没
        clear_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME).unwrap();
        assert_eq!(get_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME).unwrap(), None);
        assert_eq!(crate::db::meta_get(&conn, &runtime_at_key(KEY_FOCUS_RUNTIME)), None);
    }

    /// 运行态只落 `app_meta`，绝不碰业务表（写业务表会产生脏记录并被广播，contract §14.1）。
    #[test]
    fn runtime_snapshot_never_touches_business_tables() {
        let conn = db();
        put_runtime_snapshot(&conn, KEY_FOCUS_RUNTIME, r#"{"running":true}"#).unwrap();
        let pomodoro_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM pomodoro_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pomodoro_rows, 0, "运行态快照不进 pomodoro_sessions");
        let in_meta: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_meta WHERE key LIKE 'runtime.focus.v1%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(in_meta, 2, "载荷 + 写入时刻都在 app_meta");
    }

    /// 模块门禁：关掉的模块其对外方法一律 `module_disabled`，内核方法不受影响。
    ///
    /// 三条契约（contract §4.7）：① 从没推过快照 → 全部放行（fail-open，理由见 `is_module_enabled`）；
    /// ② 推了快照之后就按快照判（**空表 = 全关**）；③ 开关拨回来立刻恢复 —— 没有缓存中间态。
    #[test]
    fn module_gate_rejects_only_disabled_modules() {
        let conn = db();
        // ① 从没推过快照：全部放行（含运动/专注这些可开关方法）
        assert_eq!(stored_modules(&conn), None);
        assert!(module_gate(&conn, Method::PomodoroStart).is_ok());
        assert!(module_gate(&conn, Method::WorkoutList).is_ok());
        assert!(module_gate(&conn, Method::ScheduleCampus).is_ok());

        // ② 只开运动与待办（内核）：专注 / 课表 / 方案被拒
        let saved = set_enabled_modules(&conn, &["sports".into(), "nutrition".into()]).unwrap();
        assert_eq!(saved, vec!["sports", "nutrition"]);
        assert!(module_gate(&conn, Method::WorkoutList).is_ok());
        assert!(module_gate(&conn, Method::WorkoutSessionStart).is_ok(), "下行控制同组同命");
        assert!(module_gate(&conn, Method::ScheduleList).is_ok(), "待办是内核，不受开关管");
        for m in [
            Method::PomodoroList,
            Method::PomodoroStart,
            Method::PomodoroStatus,
            Method::ScheduleCampus,
            Method::SchedulePrograms,
        ] {
            let e = module_gate(&conn, m).unwrap_err();
            assert_eq!(e.code(), "module_disabled", "{} 应被门禁拒绝", m.name());
            assert!(
                e.to_string().contains(m.name()) && e.to_string().contains("打开或关闭功能"),
                "错误文案要指得出方法与去处：{e}"
            );
        }

        // ③ 空表 = 全关（不是 fail-open！）：只有内核方法活着
        set_enabled_modules(&conn, &[]).unwrap();
        assert!(module_gate(&conn, Method::WorkoutList).is_err());
        assert!(module_gate(&conn, Method::ScheduleDelete).is_ok());

        // 拨回来立刻恢复
        set_enabled_modules(&conn, &["focus".into()]).unwrap();
        assert!(module_gate(&conn, Method::PomodoroStart).is_ok());
        assert!(module_gate(&conn, Method::WorkoutList).is_err());
    }

    /// 快照的清洗与边界：去空白 / 去重 / 超长与超量在写侧拒绝（坏 JSON 当未推过 → 放行）。
    #[test]
    fn enabled_modules_snapshot_is_normalized_and_bounded() {
        let conn = db();
        let saved = set_enabled_modules(
            &conn,
            &[" sports ".into(), "".into(), "sports".into(), "focus".into()],
        )
        .unwrap();
        assert_eq!(saved, vec!["sports", "focus"], "去空白 + 去重 + 保序");
        assert_eq!(stored_modules(&conn).as_deref(), Some(&saved[..]));

        let long = "x".repeat(MAX_MODULE_ID_LEN + 1);
        assert_eq!(
            set_enabled_modules(&conn, &[long]).unwrap_err().code(),
            "bad_request"
        );
        assert_eq!(stored_modules(&conn).as_deref(), Some(&saved[..]), "被拒不落库");

        let many: Vec<String> = (0..(MAX_ENABLED_MODULES + 1)).map(|i| format!("m{i}")).collect();
        assert_eq!(
            set_enabled_modules(&conn, &many).unwrap_err().code(),
            "bad_request"
        );

        // 坏 JSON / 手改过的库：当「未推过」→ fail-open，而不是崩或全关
        crate::db::meta_set(&conn, KEY_ENABLED_MODULES, "{ not json").unwrap();
        assert_eq!(stored_modules(&conn), None);
        assert!(module_gate(&conn, Method::PomodoroStart).is_ok());
    }

    #[test]
    fn settings_live_in_app_meta_and_never_touch_business_tables() {
        let conn = db();
        assert!(!get_enabled(&conn));
        assert_eq!(get_bind_mode(&conn), BindMode::Local);
        assert_eq!(get_port(&conn), None);
        assert_eq!(get_pair_token(&conn), None);

        set_enabled(&conn, true).unwrap();
        set_bind_mode(&conn, BindMode::Lan).unwrap();
        set_port(&conn, Some(17650)).unwrap();
        let pair = ensure_pair_token(&conn).unwrap();
        assert_eq!(ensure_pair_token(&conn).unwrap(), pair, "配对令牌生成一次后固定");

        assert!(get_enabled(&conn));
        assert_eq!(get_bind_mode(&conn), BindMode::Lan);
        assert_eq!(get_port(&conn), Some(17650));
        assert_eq!(get_pair_token(&conn).as_deref(), Some(pair.as_str()));

        set_port(&conn, None).unwrap();
        assert_eq!(get_port(&conn), None);
    }
}
