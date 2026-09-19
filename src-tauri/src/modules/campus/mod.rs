//! 校园教务域：把学校教务系统的课表接进 Rein。
//!
//! 分层（自下而上）：
//! - [`provider`] —— **学校系统选择器**。哪所学校、用哪套登录握手、打哪些接口，全是声明式数据。
//!   新增一所学校 = 在 `REGISTRY` 里加一条，前端选择器自动出现。
//! - [`http`] —— 带 Cookie 会话的 HTTP 层（项目其它域都是一次性请求，没有会话概念）。
//! - [`guet`] —— 桂电（树维 Supwisdom EAMS5）适配器：登录握手、课表页面变量解析、课表归一化。
//! - [`course_select`] —— 选课/抢课子系统（`/course-selection-api`）客户端，鉴权走门户发的 SSO 令牌。
//! - [`models`] —— 远端 JSON 映射 + 本地落库形状 + IPC 契约。
//! - [`grab`] —— **自动抢课引擎**：后台线程按服务器时钟开火、按错误分级重试，任务落库可重启续跑。
//! - [`commands`] —— Tauri 命令 + SQL，以及**周次 → 公历日期**这条全链路唯一的换算。
//!
//! 课表与时间线的关系：`campus_sessions` 是真源，`todos` 里 `course_session_id` 非空的行
//! 是它的**派生只读投影**；切换学期 / 刷新 / 注销时的生命周期见 `commands::materialize_todos`
//! 的文档与 `docs/ARCHITECTURE.md`。

pub mod commands;
pub mod course_select;
pub mod grab;
pub mod guet;
pub mod http;
pub mod models;
pub mod provider;
