//! 脚本化假后端：单测 / 离线开发用（确定性、可重放）。
//!
//! 逐次弹出预设响应；脚本耗尽后返回空响应（`stop`），便于「循环自然收敛」
//! 的用例。记录每次请求供断言（wire 形态验证）。

use std::collections::VecDeque;
use std::sync::Mutex;

use crate::error::{ReinError, Result};

use super::{DeltaTx, LlmBackend, LlmRequest, LlmResponse, StreamDelta};

/// 一次脚本项：Ok(响应) 或 Err(错误文本)
pub type MockStep = Result<LlmResponse>;

pub struct MockBackend {
    model: String,
    script: Mutex<VecDeque<MockStep>>,
    requests: Mutex<Vec<LlmRequest>>,
    /// stream_complete 是否把 content / reasoning 作为增量外发（默认 true）
    emit_deltas: bool,
}

impl MockBackend {
    pub fn new(model: impl Into<String>, script: Vec<MockStep>) -> Self {
        Self {
            model: model.into(),
            script: Mutex::new(script.into()),
            requests: Mutex::new(Vec::new()),
            emit_deltas: true,
        }
    }

    /// 只回一次文本（无工具）的最简脚本
    pub fn text(model: impl Into<String>, content: impl Into<String>) -> Self {
        Self::new(
            model,
            vec![Ok(LlmResponse {
                content: content.into(),
                ..Default::default()
            })],
        )
    }

    pub fn without_deltas(mut self) -> Self {
        self.emit_deltas = false;
        self
    }

    /// 已收到的请求快照
    pub fn requests(&self) -> Vec<LlmRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn next(&self, req: &LlmRequest) -> Result<LlmResponse> {
        self.requests.lock().unwrap().push(req.clone());
        let step = self.script.lock().unwrap().pop_front();
        match step {
            Some(Ok(resp)) => Ok(resp),
            Some(Err(e)) => Err(e),
            None => Ok(LlmResponse::default()),
        }
    }
}

#[async_trait::async_trait]
impl LlmBackend for MockBackend {
    fn model(&self) -> &str {
        &self.model
    }

    async fn complete(&self, req: &LlmRequest) -> Result<LlmResponse> {
        self.next(req)
    }

    async fn stream_complete(&self, req: &LlmRequest, tx: DeltaTx) -> Result<LlmResponse> {
        let resp = self.next(req)?;
        if self.emit_deltas {
            if let Some(r) = &resp.reasoning {
                if !r.is_empty() {
                    let _ = tx.send(StreamDelta::Reasoning(r.clone()));
                }
            }
            if !resp.content.is_empty() {
                let _ = tx.send(StreamDelta::Text(resp.content.clone()));
            }
        }
        Ok(resp)
    }
}

/// 便捷构造：一步工具调用响应
pub fn tool_call_response(
    id: impl Into<String>,
    name: impl Into<String>,
    args: serde_json::Value,
) -> LlmResponse {
    LlmResponse {
        tool_calls: vec![super::LlmToolCall { id: id.into(), name: name.into(), arguments: args }],
        ..Default::default()
    }
}

/// 便捷构造：一步错误脚本项
pub fn err_step(msg: impl Into<String>) -> MockStep {
    Err(ReinError::Message(msg.into()))
}
