//! 分享收件箱域：无数据库、无模型。Android 端由 `ShareReceiver.kt` 把系统
//! 分享/打开的文件拷入 `cacheDir/share_inbox/`，本域提供前端拉取命令
//! （poll 列出 / read 取走即删）。契约见前端 `services/shareService.ts`。

pub mod commands;
