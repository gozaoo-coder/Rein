//! 训练课会话域：全程快照落盘与异常中断恢复。
//!
//! 不变量：`status='active'` 的行 = 存在被打断/进行中的训练。
//! 只有用户经「结束键 + 二级确认」调用 `session_finish` 或 `session_abort`
//! 才会离开 active；否则应用重启后一律按「异常中断」恢复。

pub mod commands;
pub mod models;
