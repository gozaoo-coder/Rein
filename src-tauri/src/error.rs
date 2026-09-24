//! 统一错误类型：跨 IPC 序列化为 `{ code, message }`；前端 `transport.ts` 归一为 `IpcError`。
//!
//! 契约：`code` 是机器可读判据（前端据此分派提示与动作，**不许解析文案**），
//! `message` 是给人看的中文文案。`session_lost` 是当前唯一的语义码：
//! 教务会话失效，前端必须把「去重新登录」这个动作直接递给用户。

use serde::ser::{SerializeStruct, Serializer};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum ReinError {
    #[error("数据库错误：{0}")]
    Db(#[from] rusqlite::Error),

    #[error("IO 错误：{0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 错误：{0}")]
    Json(#[from] serde_json::Error),

    /// 带判据的错误：`code` 供分派，`message` 给人看（文案仍是那一句中文）。
    #[error("{message}")]
    Coded { code: &'static str, message: String },

    #[error("{0}")]
    Message(String),
}

impl ReinError {
    /// 机器可读错误码。前端按它分派（`IpcError.code`），不解析文案。
    pub fn code(&self) -> &'static str {
        match self {
            ReinError::Db(_) => "db",
            ReinError::Io(_) => "io",
            ReinError::Json(_) => "json",
            ReinError::Coded { code, .. } => code,
            ReinError::Message(_) => "internal",
        }
    }

    /// 带判据的错误构造：文案与判据分开，判据走 `code`。
    pub fn coded(code: &'static str, message: impl Into<String>) -> Self {
        ReinError::Coded {
            code,
            message: message.into(),
        }
    }
}

impl Serialize for ReinError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut s = serializer.serialize_struct("ReinError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type Result<T> = std::result::Result<T, ReinError>;
