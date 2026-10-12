//! 对外服务网关（modules/gateway）：本机 / 局域网外部程序读写 Rein 数据的入口
//! （契约：`docs/EXTERNAL-API.md`）。模块划分（均已接线）：
//! - [`store`]：凭据表 / 审计表读写（`db.rs` MIGRATION_0042）、token 生成 / sha256 入库 /
//!   恒定时间比较、`app_meta` 设置键；
//! - [`models`]：`Scope` 枚举与 `ScopeSet`、凭据行 / 审计行 / 变更事件形状；
//! - [`protocol`]：消息信封、错误码、15 条方法注册表（`Method`）；
//! - [`auth`]：四态状态机、连接级会话表、待决队列、逐次 `require`、按 client/IP 限流；
//! - [`server`]：WS 监听与握手闸门、首帧令牌、请求分派、变更推送（`EVENT_CHANGE`）；
//! - [`methods`]：把 15 条方法接到各域 `*_on`（不注册成 tauri 命令）；
//! - [`commands`]：6 条管理面 tauri 命令（`gateway_*`）；
//! - [`ChangeFeed`]：变更广播 hub（容量 256），由 `sync/engine.rs` 的 `set_feed` 接上。
//!
//! 整模块挂 `allow(dead_code)` 的原因：`lib.rs` 里是私有 `mod modules;`，rustc 的死代码分析
//! 看不到「跨层调用」；且审计查询（`list_audit*`）等 pub 面暂无应用内调用方。
//! 这些面接出 UI / 命令后应删掉这一行（先例：`modules/ai/agent/llm/mod.rs:12`）。
#![allow(dead_code)]

pub mod auth;
pub mod commands;
pub mod methods;
pub mod models;
pub mod protocol;
pub mod server;
pub mod store;

// 便捷再导出（`gateway::Scope` 与 `gateway::models::Scope` 同一物）。
// `lib.rs` 里 `modules` 是私有模块，rustc 的可见性分析把跨层调用当成「没人用的 import」，
// 故仍挂 `allow(unused_imports)`；模块内部各层已直接按 `models::` 路径引用。
#[allow(unused_imports)]
pub use models::{
    AuditDecision, AuditEntry, AuditRecord, BindMode, ChangeEvent, ClientDecision, ExtClient,
    PromptGate, Scope, ScopeSet,
};

use tokio::sync::broadcast;

/// 变更广播 hub：把同步捕获到的改动转给外部订阅者。
///
/// 原语是 `tokio::sync::broadcast`（容量 256，contract §6.2）。三条约定：
///
/// 1. **发布必须在 DB 锁外**：`update_hook` 回调在 SQLite 语句执行中同步触发，
///    持锁时做任何分发都可能重入连接（`sync/engine.rs:9`）。所以调用方要在
///    「锁内收集事件 → 松锁 → `publish`」的三段式里用它。
/// 2. **没有订阅者不算错误**：`send` 在无接收者时返回 `Err`，这里静默丢弃 ——
///    网关没开、外部没人连的时候，同步捕获照旧要为其它消费者工作。
/// 3. **订阅者遇到 `Lagged(n)` 一律全量重查**，不试图补齐丢失的增量（contract §6.2）。
#[derive(Debug)]
pub struct ChangeFeed {
    tx: broadcast::Sender<ChangeEvent>,
}

impl ChangeFeed {
    /// 环形缓冲容量：够慢消费者追上，又不至于攒住无界内存。
    pub const CAPACITY: usize = 256;

    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(Self::CAPACITY);
        Self { tx }
    }

    /// 订阅一路变更流。返回的 receiver 断开（drop）即自动退订。
    pub fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.tx.subscribe()
    }

    /// 发布一条变更。无订阅者时静默丢弃（见类型注释第 2 条）。
    pub fn publish(&self, event: ChangeEvent) {
        let _ = self.tx.send(event);
    }

    /// 当前订阅者数（诊断/测试用）。
    pub fn subscribers(&self) -> usize {
        self.tx.receiver_count()
    }
}

impl Default for ChangeFeed {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(seq: i64) -> ChangeEvent {
        ChangeEvent {
            seq,
            kind: "todo".into(),
            uuid: format!("u-{seq}"),
            deleted: false,
            at: 1_700_000_000,
        }
    }

    /// 发布 → 订阅端收得到；无订阅者时发布不 panic。
    #[test]
    fn feed_delivers_to_subscribers() {
        let feed = ChangeFeed::new();
        feed.publish(ev(0)); // 还没有订阅者：静默丢弃，绝不该 panic

        let mut rx = feed.subscribe();
        assert_eq!(feed.subscribers(), 1);
        feed.publish(ev(7));
        assert_eq!(rx.try_recv().unwrap(), ev(7));

        // 第二个订阅者互不影响（广播语义）
        let mut rx2 = feed.subscribe();
        feed.publish(ev(8));
        assert_eq!(rx.try_recv().unwrap(), ev(8));
        assert_eq!(rx2.try_recv().unwrap(), ev(8));
    }

    /// 容量打满时返回 `Lagged` 而不是丢订阅 —— 上层据此全量重查。
    #[test]
    fn feed_reports_lag_instead_of_silently_dropping() {
        let feed = ChangeFeed::new();
        let mut rx = feed.subscribe();
        for i in 0..(ChangeFeed::CAPACITY as i64 + 5) {
            feed.publish(ev(i));
        }
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
    }
}
