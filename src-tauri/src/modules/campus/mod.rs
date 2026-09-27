//! 校园教务域：把学校教务系统的课表接进 Rein。
//!
//! 分层（自下而上）：
//! - [`provider`] —— **学校系统选择器**。哪所学校、用哪套登录握手、打哪些接口，全是声明式数据。
//!   新增一所学校 = 在 `REGISTRY` 里加一条，前端选择器自动出现。
//! - [`http`] —— 带 Cookie 会话的 HTTP 层（项目其它域都是一次性请求，没有会话概念）。
//! - [`dates`] —— 学期口径的换算与命名（周次 ↔ 公历日期、节次 ↔ 时刻、学期显示名）。厂商无关。
//! - [`adapter`] —— **适配器分派**：按 [`provider::LoginStrategy`] 把调用转给对应的厂商适配器。
//! - [`guet`] / [`zfsoft`] —— 两家厂商的适配器：登录握手、页面变量解析、课表归一化。
//!   前者是桂电（树维 Supwisdom EAMS5），后者是广西科技大学（正方 ZFSoft zftal）。
//! - [`course_select`] —— 选课/抢课子系统（`/course-selection-api`）客户端，鉴权走门户发的 SSO 令牌。
//! - [`models`] —— 远端 JSON 映射 + 本地落库形状 + IPC 契约。
//! - [`lesson_search`] —— **全校开课查询**（与选课批次无关）+ 两个域名分别探测。
//!   批次没开的时候靠它看清开课时间地点，再去排志愿。仅树维那套系统有这条路。
//! - [`grab`] —— **自动抢课引擎**（课表的子模块，默认关闭，见 `plugins/builtin/campusGrab.ts`）
//! - [`rescue`] —— **救援面**：把一次任意请求渲染成可重放的 curl、写审计、导出脱机脚本。
//!   引擎管「一切照常」，它管「不照常」——教务改接口、会话被踢、批次规则变了的时候。
//! - [`commands`] —— Tauri 命令 + SQL，以及**周次 → 公历日期**这条全链路唯一的换算。
//!
//! 课表与时间线的关系：`campus_sessions` 是真源，`todos` 里 `course_session_id` 非空的行
//! 是它的**派生只读投影**；切换学期 / 刷新 / 注销时的生命周期见 `commands::materialize_todos`
//! 的文档与 `docs/ARCHITECTURE.md`。

pub mod adapter;
pub mod commands;
pub mod course_select;
pub mod dates;
pub mod grab;
pub mod guet;
pub mod http;
pub mod lesson_search;
pub mod matcher;
pub mod models;
pub mod provider;
pub mod rescue;
pub mod zfsoft;
