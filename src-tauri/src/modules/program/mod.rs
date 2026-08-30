//! 健康方案域：程序计算的周期方案（营养目标 + 训练安排 + 日程展开）。
//!
//! 职责边界：方案的「生成与调整」全部在前端确定性引擎 `src/utils/programEngine.ts`
//! （多套方案对比、食谱模板装配、参数钳制），本模块只负责持久化、单激活约束与
//! 方案日程（todos.program_id）的事务化重排，不做任何计算。

pub mod commands;
pub mod models;
