//! 全局应用状态：单个 SQLite 连接（桌面单窗口场景足够；并发瓶颈出现时再引入连接池）。

use std::collections::HashMap;
use std::sync::Mutex;

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

pub struct AppState {
    pub db: Mutex<Connection>,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self { db: Mutex::new(db) }
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
