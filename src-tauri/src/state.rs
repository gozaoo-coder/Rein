//! 全局应用状态：单个 SQLite 连接（桌面单窗口场景足够；并发瓶颈出现时再引入连接池）。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tokio::sync::mpsc::UnboundedSender;

use crate::modules::voice::protocol::AsrCmd;

/// 语音识别会话注册表：sessionId → 命令通道（音频包/结束/取消）。
/// 识别任务由 `voice_asr_start` spawn，命令经通道送进 WS 任务。
pub struct VoiceHub {
    pub sessions: Mutex<HashMap<String, UnboundedSender<AsrCmd>>>,
}

impl VoiceHub {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// 全局唯一的那条 SQLite 连接，外加一条纪律：**锁中毒不该让整个数据层瘫掉**。
///
/// 原先全仓写的是 `state.db.lock()`（`STANDARDS.md` §1 唯一放行 unwrap 的场景）。
/// 问题在于 unwrap 把「持有锁时 panic」从**一次性故障**升级成**永久故障**：Mutex 一旦被标记
/// 中毒，之后每一条命令的 `lock().unwrap()` 都会继续 panic —— 整个应用的数据层在重启前不可用，
/// 而这条 panic 路径在库里上千处 `unwrap`（抓到的 HTML、解析出的 JSON、按列取值）之间并不罕见。
///
/// 所以把连接包一层，换取三件事：
/// 1. `lock()` 直接返回 `MutexGuard`，调用点因此**不需要也不允许** unwrap ——
///    漏改的地方是**编译错误**，不是又一个静默的 panic 点；
/// 2. 中毒时取回连接（SQLite 连接本身没有中毒这个概念，数据仍然可用）并补一次 `ROLLBACK`；
/// 3. 恢复正常使用。丢掉的只是「那条命令里还没提交的改动」，而这正是崩溃本来就该丢的东西。
///
/// 注意这不是「吞掉 panic」：panic 照旧发生、照旧由 Tauri 报给前端；变的只是**它不再带走整个应用**。
pub struct Db(Mutex<Connection>);

impl Db {
    pub fn new(conn: Connection) -> Self {
        Self(Mutex::new(conn))
    }

    /// 取连接。中毒时自愈（见类型注释），所以调用点不该、也不必再 unwrap。
    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        match self.0.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let guard = poisoned.into_inner();
                // panic 可能落在 BEGIN 之后：把这半截事务收掉，否则后续写入会一直撞
                // "cannot start a transaction within a transaction"。
                // 没有活动事务时 ROLLBACK 会报错，忽略即可。
                let _ = guard.execute_batch("ROLLBACK");
                guard
            }
        }
    }
}

pub struct AppState {
    pub db: Db,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self { db: Db::new(db) }
    }
}

/// 一次尚未完成的登录握手。
///
/// 树维把验证码答案绑在**会话**上，所以「取验证码图片」与「提交登录」必须共用同一个
/// Cookie 会话。这里只暂存那份 Cookie：salt 由适配器在提交时现取（同会话内取，
/// 既新鲜又不必在这里维护第二份状态）。用户重新取图时覆盖。
pub struct PendingLogin {
    /// `base_url|login_name` —— 参数变了就作废，避免拿着 A 学校的会话去登 B 学校
    pub key: String,
    pub cookies: crate::modules::campus::http::CookieJar,
}

/// 选课子系统的 SSO 令牌缓存。
///
/// 令牌是拿 EAMS 会话去门户换来的（见 `modules/campus/course_select.rs`）。
/// 抢课要 2 秒一轮地轮询结果，每次都去换一张既慢又会把门户打疼，所以缓存在进程内；
/// 换账号或令牌临近过期时作废。
pub struct CourseSelectToken {
    pub account_id: i64,
    pub token: String,
    /// JWT 的 exp；解不出来时为 None，由服务端 401 兜底
    pub expires_at: Option<i64>,
}

/// 「两个域都发」的计划缓存。
///
/// 探测一个域名要打两次网络请求，而抢课引擎每 2 秒就走一步 —— 绝不能每步都去探。
/// 域名会不会提供 EAMS5 是**很少变的事实**，缓存十分钟足够，
/// 又能在「学校把系统挪了域名」时自己纠正回来。
pub struct DualFireCache {
    pub account_id: i64,
    pub at_ms: i64,
    pub plan: crate::modules::campus::lesson_search::DualFirePlan,
}

/// 校园教务域：进行中的登录握手 + 选课令牌缓存 + 双发计划缓存。
#[derive(Default)]
pub struct CampusHub {
    pub pending: Mutex<Option<PendingLogin>>,
    pub select_token: Mutex<Option<CourseSelectToken>>,
    pub dual_fire: Mutex<Option<DualFireCache>>,
}

/// 双发计划的缓存有效期：十分钟。
pub const DUAL_FIRE_TTL_MS: i64 = 10 * 60 * 1000;

impl CampusHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 令牌还能用吗：账号对得上，且离过期还有 5 分钟以上。
    pub fn cached_select_token(&self, account_id: i64) -> Option<String> {
        let guard = self.select_token.lock().unwrap();
        let t = guard.as_ref()?;
        if t.account_id != account_id {
            return None;
        }
        let fresh = match t.expires_at {
            Some(exp) => exp - chrono::Utc::now().timestamp() > 300,
            None => true,
        };
        fresh.then(|| t.token.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// 中毒自愈：持锁线程 panic 之后，连接仍然可用 —— 而不是之后每一条命令都跟着 panic。
    ///
    /// 这条测试守的是「一次崩溃 vs 永久瘫痪」的区别，而它没有任何功能测试能覆盖到：
    /// 没有它的话，把 `Db::lock` 改回 `self.0.lock().unwrap()` 也不会让任何用例变红。
    #[test]
    fn poisoned_lock_recovers_with_rollback() {
        let db = Arc::new(Db::new(Connection::open_in_memory().unwrap()));
        db.lock().execute_batch("CREATE TABLE t (n INTEGER)").unwrap();

        let bomber = Arc::clone(&db);
        let died = std::thread::spawn(move || {
            let guard = bomber.lock();
            // 事务中途 panic：留下一个已 BEGIN 未提交的连接 + 一把中毒的锁
            guard
                .execute_batch("BEGIN; INSERT INTO t (n) VALUES (99)")
                .unwrap();
            panic!("模拟持锁时的 panic");
        })
        .join();
        assert!(died.is_err(), "前置条件：那个线程确实 panic 了");

        // 关键断言：中毒之后照常拿锁、照常写库，且半截事务已被回滚
        let guard = db.lock();
        guard
            .execute_batch("INSERT INTO t (n) VALUES (1)")
            .expect("中毒恢复后应能重新开事务写入（否则说明 ROLLBACK 没做）");
        let n: i64 = guard
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "只应留下恢复后写的那一行：99 属于崩溃时未提交的事务");
    }
}
