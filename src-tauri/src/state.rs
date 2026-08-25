//! 全局应用状态：单个 SQLite 连接（桌面单窗口场景足够；并发瓶颈出现时再引入连接池）。

use std::sync::Mutex;

use rusqlite::Connection;

pub struct AppState {
    pub db: Mutex<Connection>,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self { db: Mutex::new(db) }
    }
}
