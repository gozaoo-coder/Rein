//! 对外服务网关的数据模型与权限枚举。
//!
//! 这里放的是**跨层共享的形状**：scope 枚举、客户端凭据行、审计行、变更事件。
//! 序列化一律 camelCase —— 前端（`src/types/externalAccess.ts`）与外部客户端消费的是同一批名字。

use serde::{Deserialize, Serialize};

/// 一个可授权的权限。**唯一定义处**（contract §5.3）：前端与 mock 只消费同名字符串。
///
/// 解析一律**精确匹配**（[`Scope::parse`] 逐个 `match` 字面量），绝不用前缀 / 通配 ——
/// 否则 `schedule.read` 会命中未来的 `schedule.read_secret`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Scope {
    ScheduleRead,
    ScheduleCreate,
    ScheduleWrite,
    ScheduleDelete,
    WorkoutRead,
    WorkoutWrite,
    WorkoutDelete,
    PomodoroRead,
    PomodoroWrite,
    PomodoroControl,
}

impl Scope {
    /// 全部权限，供管理面「逐项勾选」与「列出全部」用。顺序即界面展示顺序
    /// （与 contract §5.3 的 10 条字符串同序）。
    ///
    /// 当前只有单测在用（管理面 UI 还没接出来）—— 挂 `#[cfg(test)]` 而不是 `allow(dead_code)`，
    /// 免得这一整块「先写好的公有面」在别处悄悄烂着。
    #[cfg(test)]
    pub const ALL: [Scope; 10] = [
        Scope::ScheduleRead,
        Scope::ScheduleCreate,
        Scope::ScheduleWrite,
        Scope::ScheduleDelete,
        Scope::WorkoutRead,
        Scope::WorkoutWrite,
        Scope::WorkoutDelete,
        Scope::PomodoroRead,
        Scope::PomodoroWrite,
        Scope::PomodoroControl,
    ];

    /// 线上字符串（也是库里 `ext_clients.scopes` 的元素）。
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::ScheduleRead => "schedule.read",
            Scope::ScheduleCreate => "schedule.create",
            Scope::ScheduleWrite => "schedule.write",
            Scope::ScheduleDelete => "schedule.delete",
            Scope::WorkoutRead => "workout.read",
            Scope::WorkoutWrite => "workout.write",
            Scope::WorkoutDelete => "workout.delete",
            Scope::PomodoroRead => "pomodoro.read",
            Scope::PomodoroWrite => "pomodoro.write",
            Scope::PomodoroControl => "pomodoro.control",
        }
    }

    /// 精确匹配解析；未知字符串返回 `None`（调用方决定是丢弃还是报 `bad_request`）。
    pub fn parse(s: &str) -> Option<Scope> {
        match s {
            "schedule.read" => Some(Scope::ScheduleRead),
            "schedule.create" => Some(Scope::ScheduleCreate),
            "schedule.write" => Some(Scope::ScheduleWrite),
            "schedule.delete" => Some(Scope::ScheduleDelete),
            "workout.read" => Some(Scope::WorkoutRead),
            "workout.write" => Some(Scope::WorkoutWrite),
            "workout.delete" => Some(Scope::WorkoutDelete),
            "pomodoro.read" => Some(Scope::PomodoroRead),
            "pomodoro.write" => Some(Scope::PomodoroWrite),
            "pomodoro.control" => Some(Scope::PomodoroControl),
            _ => None,
        }
    }
}

impl std::fmt::Display for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for Scope {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Scope {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Scope::parse(&raw).ok_or_else(|| serde::de::Error::custom(format!("未知权限：{raw}")))
    }
}

/// 一组权限（去重、保序）。库里以 JSON 字符串数组存（`ext_clients.scopes`）。
///
/// 「是否包含某权限」是授权校验的核心原语：入站每一次调用都要过一遍
/// `set.contains(need)`，**不缓存**（缓存即撤销延迟生效），所以这里只是一个朴素的线性查找 ——
/// 最多 10 个元素，任何索引结构都是过度设计。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeSet(Vec<Scope>);

impl ScopeSet {
    pub fn new() -> Self {
        ScopeSet(Vec::new())
    }

    /// 解析字符串集合：**未知串直接丢弃**（不报错、不 panic）。
    /// 老版本库或未来客户端塞进来的新 scope 不该让当前版本炸掉；放不进去的权限自然等于没授。
    pub fn parse(list: &[String]) -> Self {
        let mut out: Vec<Scope> = Vec::new();
        for raw in list {
            if let Some(sc) = Scope::parse(raw) {
                if !out.contains(&sc) {
                    out.push(sc);
                }
            }
        }
        ScopeSet(out)
    }

    /// 默认最小集 = 仅 `schedule.read`（对应「小组件显示今天日程」）。
    /// 任何写入 scope 默认**不勾**，必须用户在配对时逐项显式勾选。
    pub fn minimal_default() -> Self {
        ScopeSet(vec![Scope::ScheduleRead])
    }

    /// 从库里存的 JSON 文本读；解析失败一律当空集（宁可少授权，不可多授权）。
    pub fn from_json(raw: &str) -> Self {
        let list: Vec<String> = serde_json::from_str(raw).unwrap_or_default();
        ScopeSet::parse(&list)
    }

    /// 写库用的 JSON 文本。序列化不可能失败（元素都是字符串），失败也退化成空数组。
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.to_strings()).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn to_strings(&self) -> Vec<String> {
        self.0.iter().map(|s| s.as_str().to_string()).collect()
    }

    // 以下 3 个门面（计数 / 判空 / 多权限判据）目前只有单测在用（管理面还没接线），
    // 一律挂 `#[cfg(test)]`，等真正有调用方时再放开 —— 不做「先摆着」的死代码。
    // （原先还有 `as_slice` / `iter` 两个，全仓没人用，已删。）
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// 加一项（已在集合里则不重复），返回是否真的新增。
    pub fn insert(&mut self, scope: Scope) -> bool {
        if self.0.contains(&scope) {
            return false;
        }
        self.0.push(scope);
        true
    }

    /// 是否包含指定权限 —— 入站调用的授权判据。
    pub fn contains(&self, need: Scope) -> bool {
        self.0.contains(&need)
    }

    /// 是否包含全部指定权限（多 scope 方法用）。当前只有单测在用，理由同 [`Self::len`]。
    #[cfg(test)]
    pub fn contains_all(&self, needs: &[Scope]) -> bool {
        needs.iter().all(|n| self.contains(*n))
    }
}

impl FromIterator<Scope> for ScopeSet {
    fn from_iter<T: IntoIterator<Item = Scope>>(iter: T) -> Self {
        let mut set = ScopeSet::new();
        for sc in iter {
            set.insert(sc);
        }
        set
    }
}

impl Serialize for ScopeSet {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = s.serialize_seq(Some(self.0.len()))?;
        for sc in &self.0 {
            seq.serialize_element(sc.as_str())?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for ScopeSet {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let raw = Vec::<String>::deserialize(d)?;
        Ok(ScopeSet::parse(&raw))
    }
}

/// 网关的绑定模式（contract §4.1）。`local` = 只绑回环；`lan` = 绑 `0.0.0.0` 且强制 `pairToken`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindMode {
    Local,
    Lan,
}

impl BindMode {
    pub fn as_str(self) -> &'static str {
        match self {
            BindMode::Local => "local",
            BindMode::Lan => "lan",
        }
    }

    pub fn parse(s: &str) -> Option<BindMode> {
        match s {
            "local" => Some(BindMode::Local),
            "lan" => Some(BindMode::Lan),
            _ => None,
        }
    }

    pub const DEFAULT: BindMode = BindMode::Local;
}

impl Serialize for BindMode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for BindMode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        BindMode::parse(&raw).ok_or_else(|| serde::de::Error::custom(format!("未知绑定模式：{raw}")))
    }
}

/// `ext_clients.decision` 的三种取值。
///
/// **只有 `Allow` 能放行**；`Deny` 与 `Ignore` 都视为「无有效授权」。
/// `Ignore` 这一档只为「用户点过忽略」的限频记录（`last_prompt_at` / `prompt_count`）而存在 ——
/// 它不含 `token_hash`、`scopes` 为空，读授权时与不存在等价。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientDecision {
    Allow,
    Deny,
    Ignore,
}

impl ClientDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            ClientDecision::Allow => "allow",
            ClientDecision::Deny => "deny",
            ClientDecision::Ignore => "ignore",
        }
    }

    pub fn parse(s: &str) -> Option<ClientDecision> {
        match s {
            "allow" => Some(ClientDecision::Allow),
            "deny" => Some(ClientDecision::Deny),
            "ignore" => Some(ClientDecision::Ignore),
            _ => None,
        }
    }
}

impl Serialize for ClientDecision {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// `ext_audit.decision`：这次调用最后是什么结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditDecision {
    Allowed,
    Denied,
    Error,
}

impl AuditDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            AuditDecision::Allowed => "allowed",
            AuditDecision::Denied => "denied",
            AuditDecision::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Option<AuditDecision> {
        match s {
            "allowed" => Some(AuditDecision::Allowed),
            "denied" => Some(AuditDecision::Denied),
            "error" => Some(AuditDecision::Error),
            _ => None,
        }
    }
}

impl Serialize for AuditDecision {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// 一行外部客户端凭据（`ext_clients`）。字段顺序与表列一一对应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtClient {
    pub id: i64,
    pub client_id: String,
    pub name: String,
    /// `sha256(token)` 的 hex；无「始终允许」时为 `None`。明文令牌从不出现。
    pub token_hash: Option<String>,
    pub scopes: ScopeSet,
    pub decision: ClientDecision,
    pub last_ip: Option<String>,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub updated_at: String,
    pub revoked_at: Option<String>,
    pub last_prompt_at: Option<String>,
    pub prompt_count: i64,
}

impl ExtClient {
    /// 这一行当前能否放行（决策为 allow 且未被撤销）。
    pub fn is_authorized(&self) -> bool {
        self.decision == ClientDecision::Allow && self.revoked_at.is_none()
    }
}

/// 写审计用（无 id）。字段名对齐 `ext_audit` 列（contract §5.4）。
#[derive(Debug, Clone)]
pub struct AuditRecord {
    /// ISO-8601
    pub at: String,
    pub client_id: Option<String>,
    pub method: String,
    pub scope: String,
    pub decision: AuditDecision,
    pub detail: Option<String>,
    pub ip: Option<String>,
    pub duration_ms: i64,
}

/// 读审计用（带 id）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub at: String,
    pub client_id: Option<String>,
    pub method: String,
    pub scope: String,
    pub decision: AuditDecision,
    pub detail: Option<String>,
    pub ip: Option<String>,
    pub duration_ms: i64,
}

impl AuditEntry {
    pub const COLS: &'static str = "id, at, client_id, method, scope, decision, detail, ip, duration_ms";

    /// 从 `ext_audit` 的一行读出来。列顺序必须与 [`AuditEntry::COLS`] 一致。
    pub fn from_row(r: &rusqlite::Row) -> rusqlite::Result<AuditEntry> {
        let decision: String = r.get(5)?;
        Ok(AuditEntry {
            id: r.get(0)?,
            at: r.get(1)?,
            client_id: r.get(2)?,
            method: r.get(3)?,
            scope: r.get(4)?,
            decision: AuditDecision::parse(&decision).unwrap_or(AuditDecision::Error),
            detail: r.get(6)?,
            ip: r.get(7)?,
            duration_ms: r.get(8)?,
        })
    }
}

/// 同步变更事件 —— 网关向外部订阅者推送的最小载荷（contract §6.2）。
/// `seq` 是 `sync_log.seq`，订阅者据此判断有没有丢事件（遇 `Lagged` 一律全量重查）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub seq: i64,
    pub kind: String,
    pub uuid: String,
    pub deleted: bool,
    pub at: i64,
}

/// 「要不要弹授权窗」的判定结果（contract §5.1 忽略那行的 30s 静默 + 连续 3 次静默挂起）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptGate {
    /// 正常弹窗。
    Show,
    /// 距上次忽略不足静默窗口：本次请求静默挂起，不弹窗。
    Suppress,
    /// 已连续忽略到上限：静默挂起（维持 pending），不再打扰用户。
    Silent,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_parse_is_exact_not_prefix() {
        assert_eq!(Scope::parse("schedule.read"), Some(Scope::ScheduleRead));
        // 前缀 / 后缀 / 大小写都不该命中
        assert_eq!(Scope::parse("schedule.read_secret"), None);
        assert_eq!(Scope::parse("schedule"), None);
        assert_eq!(Scope::parse("Schedule.Read"), None);
        assert_eq!(Scope::parse("schedule.read "), None);
    }

    /// 第二轮新增的三条 scope（删除 / 控制）：字符串、精确匹配、`ALL` 覆盖全 10 条。
    #[test]
    fn scope_table_covers_ten_including_delete_and_control() {
        assert_eq!(Scope::ALL.len(), 10);
        for sc in Scope::ALL {
            assert_eq!(Scope::parse(sc.as_str()), Some(sc), "{} 必须能反查", sc.as_str());
        }
        assert_eq!(Scope::parse("schedule.delete"), Some(Scope::ScheduleDelete));
        assert_eq!(Scope::parse("workout.delete"), Some(Scope::WorkoutDelete));
        assert_eq!(Scope::parse("pomodoro.control"), Some(Scope::PomodoroControl));
        // 删除 / 控制**不从写权限派生**：精确匹配下 write 不蕴含 delete
        let set: ScopeSet = [Scope::ScheduleWrite, Scope::WorkoutWrite].into_iter().collect();
        assert!(!set.contains(Scope::ScheduleDelete));
        assert!(!set.contains(Scope::WorkoutDelete));
        assert!(!set.contains(Scope::PomodoroControl));
    }

    #[test]
    fn scope_set_dedups_and_answers_membership() {
        let set = ScopeSet::parse(&[
            "schedule.read".into(),
            "schedule.read".into(),
            "nonsense.scope".into(),
            "workout.read".into(),
        ]);
        assert_eq!(set.len(), 2, "未知串丢弃、重复项去重");
        assert!(set.contains(Scope::ScheduleRead));
        assert!(set.contains(Scope::WorkoutRead));
        assert!(!set.contains(Scope::ScheduleWrite));
        assert!(set.contains_all(&[Scope::ScheduleRead, Scope::WorkoutRead]));
        assert!(!set.contains_all(&[Scope::ScheduleRead, Scope::WorkoutWrite]));
    }

    #[test]
    fn scope_set_json_roundtrip() {
        let set: ScopeSet = [Scope::PomodoroWrite, Scope::ScheduleRead].into_iter().collect();
        let json = set.to_json();
        assert_eq!(json, r#"["pomodoro.write","schedule.read"]"#);
        assert_eq!(ScopeSet::from_json(&json), set);
        // 坏 JSON / 未知串都退化成能用的集合，绝不 panic
        assert_eq!(ScopeSet::from_json("not json"), ScopeSet::new());
        assert_eq!(ScopeSet::from_json(r#"["nope"]"#), ScopeSet::new());
    }

    #[test]
    fn minimal_default_is_read_only_schedule() {
        let set = ScopeSet::minimal_default();
        assert!(set.contains(Scope::ScheduleRead));
        assert!(!set.contains(Scope::ScheduleWrite), "写入项默认不勾");
        assert!(!set.contains(Scope::ScheduleCreate));
    }

    #[test]
    fn scope_serde_uses_wire_strings() {
        let set: ScopeSet = [Scope::WorkoutWrite].into_iter().collect();
        assert_eq!(serde_json::to_string(&set).unwrap(), r#"["workout.write"]"#);
        let back: ScopeSet = serde_json::from_str(r#"["workout.write"]"#).unwrap();
        assert_eq!(back, set);
        assert!(serde_json::from_str::<Scope>(r#""bogus""#).is_err(), "未知权限反序列化要报错");
    }
}
