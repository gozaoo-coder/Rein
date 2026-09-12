//! 知识库与认知层。
//!
//! 一个库装下多种来源：日程/附件、运动、饮食体测、方案/语音/历史聊天，以及 AI 从对话中提炼的
//! 长期记忆（source_type='memory'）。设计要点与取舍见各子文件头部注释，总览：
//!
//! - `source.rs`  源表 → 可检索文档的派生（只读源表，派生结果作为缓存）
//! - `chunk.rs`   文本切块与规范化
//! - `index.rs`   脏队列消费、文档/分块落库、向量存取
//! - `search.rs`  结构化过滤 + FTS5(trigram) + 向量召回 → RRF 融合
//! - `settings.rs` 三档检索模式与逐类开关
//! - `memory.rs`  长期记忆的增删改与 prompt 注入块
//! - `embed.rs`   三种 embedding 后端（本地 ORT / 云端 / 纯关键词）
//! - `worker.rs`  后台索引线程（消费脏队列、补算向量、上报进度）

pub mod chunk;
pub mod commands;
pub mod embed;
pub mod files;
pub mod index;
pub mod memory;
pub mod models;
pub mod search;
pub mod settings;
pub mod source;
pub mod worker;
