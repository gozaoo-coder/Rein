//! 统一错误类型：跨 IPC 序列化为字符串，前端 toast 展示。

use serde::ser::Serializer;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum ReinError {
    #[error("数据库错误：{0}")]
    Db(#[from] rusqlite::Error),

    #[error("IO 错误：{0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 错误：{0}")]
    Json(#[from] serde_json::Error),

    #[error("{0}")]
    Message(String),
}

impl Serialize for ReinError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, ReinError>;
