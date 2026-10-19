# 工作单 · README 优化（S-A）

你是 **S-A README 作者**。只允许写 `README.md` 一个文件，不许动任何其它文件。

先读这两份（唯一真源）：
- `docs/PROJECT-2026-10/PROJECT-PLAN.md`
- `docs/PROJECT-2026-10/DESIGN-BRIEF.md`

再读现有 `README.md`、`RELEASE_NOTES.md`（最近几版）、`docs/ARCHITECTURE.md` 的目录与分层章节。

## 目标

把 README 从「一份写得不错的项目说明」升级成「3 秒讲清是什么、30 秒看懂凭什么」的首页。
内容 90% 沿用现有事实，**不许编造功能**。

## 必须做到

1. **首屏**：标题 + 一句话定位 + 一排信息徽章（Tauri 2 / Vue 3 / Rust / SQLite / Windows+Android / 本地优先）。
   徽章用 shields.io 静态徽章（`img.shields.io/badge/...`，只写死文字与颜色，不依赖外部服务数据）。
2. **「为什么叫助理而不是工具箱」** 保留并写得更利落 —— 这是这个项目最独特的一段。
3. **功能地图**：现有表格保留，但按「AI / 记录 / 身体 / 时间 / 钱 / 系统」重新分组，别一张大表糊到底。
4. **AI 系统**那节保留（自带模型 / 对话即操作 / 卡片产物 / 知识库 / 长期记忆 / 语音）。
5. **快速开始**：命令要能一眼抄走；分成「桌面端」与「纯浏览器 UI 开发」两块。
6. **多平台 / 画质与动效**：保留，但把最长的说明压到 3 行以内，细节指向 `docs/`。
7. 新增 **「文档索引」**：把 `docs/` 下的文档列全（ARCHITECTURE / STANDARDS / SYNC / UPDATES /
   SERVER-SECURITY / ai-workspace / EXTERNAL-API / MOTION-MODE-EXPERIENCE / PROJECT-2026-10/）。
8. 新增 **「官网与宣传片」** 一小节：指向 `site/`（官网源码，产物 `site/dist`）与
   `promo/`（宣传片源码，成片 `promo/out/rein-promo.mp4`）。
9. 语言与语气：与 `DESIGN-BRIEF.md` §5 一致 —— 讲人话、不写文件名/函数名/e2e 这类工程词（目录结构那节除外）。

## 硬约束

- **所有相对链接必须真实可达**（`docs/*.md`、`server/README.md`、图片路径都要存在）。改完自己核对一遍。
- 图片引用沿用 `docs/screens/*.png`（已存在），不要引用 `docs/shots/`（那是本地产物、不入库）。
- 保持中文为主。允许英文术语（Tauri / Rust / SQLite / MIT 等）。
- 表格列宽别超过 4 列，中文表格尽量短。
- 不写「本文档由 AI 生成」这类元信息。

完成后，用一句话汇报：改了哪几块、新增了什么。
