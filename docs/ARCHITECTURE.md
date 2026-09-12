# Rein 架构

> 修改本文档是改动架构的前置条件：代码与文档不一致 = bug。

## 1. 技术栈与分层

```
┌────────────────────────── Vue 3 + TypeScript（src/）──────────────────────────┐
│ pages/      一级页面，只做装配与数据加载                                        │
│ components/ 按领域分目录；通用件在 common/、layout/                              │
│ stores/     Pinia 按领域一店；写操作后联动刷新关联 store                          │
│ system/     应用级运行时单例（运动系统 workoutRuntime，main.ts 装载）             │
│ services/   IPC 封装层 —— 组件/store 禁止直接 import '@tauri-apps/api'          │
│ types/      领域类型（Rust models 的 TS 镜像，camelCase）                        │
│ config/     展示元数据（标签/颜色/MET 表/DRI）                                   │
│ mock/       内存后端，实现同一套命令契约（仅浏览器开发模式）                       │
└───────────────────────────────────┬───────────────────────────────────────────┘
                          invoke(cmd, args)  ← 唯一通道：services/transport.ts
┌───────────────────────────────────▼───────────────────────────────────────────┐
│ modules/<域>/commands.rs   #[tauri::command]，参数校验 + SQL                    │
│ modules/<域>/models.rs     serde camelCase 结构体（= types/ 的镜像）             │
│ modules/<域>/mod.rs        列常量 / 行映射等模块内共享辅助                       │
│ db.rs  迁移（只追加）   state.rs  Mutex<Connection>   seed.rs  首启种子         │
└──────────────────────────────── SQLite（应用数据目录/rein.db）─────────────────┘
```

## 2. 目录职责速查

| 路径 | 职责 | 不该出现的东西 |
| --- | --- | --- |
| `src/styles/tokens.css` | 全部设计令牌（颜色/圆角/阴影/动效/字号） | 业务选择器 |
| `src/components/common` | 与领域无关的通用组件 | 领域 store 依赖 |
| `src/system/*` | 应用级运行时单例（`workoutRuntime` 运动接管、`recorderRuntime` 录音、`voiceRuntime` 语音会话、`micBus` 麦克风互斥仲裁、`sessionImmersive` 沉浸层显隐） | 组件渲染逻辑、IPC 直连 |
| `src/services/*` | 命令名 → 类型化函数 | 业务逻辑 |
| `src/mock/server.ts` | 与 Rust 相同的命令契约 | 生产分支逻辑 |
| `src/ai/*` | AI 推理层（pi-ai / pi-agent-core）：`runtime.ts` 模型装配、`probe.ts` max_tokens=1 能力探测、`vision.ts` 照片食物识别。模型请求由 WebView 直连 provider，不经 Rust | 直接 import '@tauri-apps/api'；同步 import 进主包（store 侧动态 import） |
| `src/components/program/*` | 健康方案的十块 UI：`ProgramDashboard`（今日驾驶舱）、`ProgramCycleMap`（全周期网格）、`ProgramEvidenceSheet`（三条研究曲线）、`ProgramCompare`（三档对比矩阵 + 4 周强度预览双视图）、`ProgramConstraints`（内联约束向导，chips 写回 profile）、`ProgramNutritionCompass`（聚焦日宏量环 + 餐次分布）、`ProgramEvolutionChart`（参数演进双泳道图 + 节点 diff + 摇摆检测）、`ProgramWeightChannel`（体重航道：档位速率走廊 ±0.3kg）、`ProgramReviewSheet`（AI 复盘：数据先行 + 建议逐条采纳 + 实时汇总） | 直连 IPC；方案参数的写入 |
| `src/utils/programCurves.ts` | 档位科学依据的**纯数据 + 纯函数**：训练频次 / 睡眠时长 / 社交时差三条曲线、线性插值 `sampleCurve`、档位耐受度判定、SVG 坐标映射。不落库、不参与方案计算 | 任何 IPC / store 依赖；把它当作方案参数来源（唯一事实仍是 `TIER_SPECS`） |
| `src/utils/programProgress.ts` | 周期地图的格子状态计算：`buildDayCells`（`blob.days` × 方案日程待办左连接，六态判定）+ `cycleStats` + `groupByWeek` + `phaseLabel`。统计口径与 `programReport.ts` 保持一致 | 写操作 |
| `src/utils/programSetup.ts` | setup 阶段纯函数：约束快照对比（`constraintSnapshotOf`/`sameConstraint`）、三档矩阵行 `matrixRows`、月度预期 `monthlyDeltaKg`、档位差异解说、4 周强度预览 `weekPreview`、约束即时预览 `constraintSummary` | 写操作 |
| `src/utils/programWrapup.ts` | 结营成绩单聚合：`buildWrapup`（复用 buildProgramReport 口径，补起点对照/最长连续打卡/徽章判定/下一期档位建议，纯前端规则） | 新增持久化 |
| `resources/foods.json` | 种子数据单一来源 | 运行时可变数据 |
| `src-tauri/gen/android/.../RunTrackingService.kt` · `TrackingBridge.kt` | 跑步前台保活（Android 原生侧，与 MainActivity 同为手工维护；`tauri android init` 重新生成会丢） | 业务逻辑、SQL |

## 3. IPC 契约

- **命令命名**：动词开头 snake_case（`list_foods` / `log_meal` / `get_daily_summary`）。前端 service 函数同名 camelCase。
- **参数**：Rust 参数 snake_case ⇄ JS 键 camelCase（Tauri 自动转换）。结构体一律 `#[serde(rename_all = "camelCase")]`。
- **例外**：运动类型参数统一叫 `workoutType`，不用 `type`（避免原始标识符转换坑）。
- **错误**：后端 `ReinError` 序列化为字符串；前端在 service 层不吞错，store 决定提示方式。
- **新增命令三同步**：`modules/x/commands.rs` ↔ `lib.rs generate_handler!` ↔ `src/services/xService.ts`。缺一不可。

### AI 域说明（2026-08 起）

- **AI 域的职责边界**：Rust 只持久化**模型配置**（`ai_models`）与**聊天历史**（`ai_chats` / `ai_chat_messages`）；所有模型请求（照片识别、能力探测）在前端 WebView 内由 `@earendil-works/pi-ai` / `pi-agent-core` 直连 provider（DeepSeek 等 CORS 回显任意 Origin，已验证）。
- **模型装配**：pi 内置目录无视觉模型（deepseek-v4-flash-vision-exp 不在其中），`src/ai/runtime.ts` 用 `createProvider` 为每条配置自建单模型 provider（`openai-completions` 线路），thinking 的 deepseek 写法与 `max_tokens` 字段按 baseUrl 自动探测（URL 含 deepseek.com 即命中）。
- **能力探测 `probe.ts`**：六发 max_tokens=1（文本 / 文本+1×1 图 / thinking on / off / effort low / high）；200=支持，错误消息关键词分类（不支持→false、token 预算抱怨=参数已接受→true、鉴权错误→中止、其余→未知 null），原始错误落 `ai_models.last_error` 供复核。
- **照片识别 `vision.ts`**：已下线（识别统一走聊天流：附件图片随消息发模型，模型带工具看图出 food 卡）。
- **食物匹配与自动补录（2026-08-25）**：foodId 一律由模型自己调 `search_food`（Rust `search_foods_fuzzy` 按字包含/顺序相似度打分排序）选定；`ai/foodMatch.ts::toParsedItems` 对幻觉/缺省 foodId **直接自动补录**（create_food 同名幂等，营养取模型输出的 `nutrition` 字段，缺省回退 kcalEstimate）——解析卡不再出现"未匹配不可写入"。无模型时的本地关键词解析兜底保持只读不写入。
- **智能添加统一抽屉 `SmartAddSheet`（2026-08-25）**：替代原 `TodoAddSheet` 与 `QuickLogSheet`（均已删除）。`mode: 'todo'|'food'` 决定标题与手动入口（待办表单 / 食物库选择器），智能添加与 AI 聊天同款交互——选图先进草稿区（附件芯片可移除），可同时粘贴文字，点「生成」由 `ai/smartGen.ts` 单轮 Agent（挂 search_food/create_food/get_food 最小工具集）后台解析，任务类内容→待办草稿、吃吃喝喝→食物卡（估算重量），分区出卡供确认编辑后添加。
- **AI 联网工具（2026-08-25）**：Rust `modules/web`（ureq + html2text）提供 `web_search`（默认必应）/ `web_fetch`（任意 URL→纯文本，SSRF 私网防护、15s 超时、6000 字符截断）；前端 `ai/tools/web.ts` 注册进统一工具层，聊天提示词已纳入。WebView 内 JS fetch 会被 CORS 拦，抓取必须走 Rust。
- **语音对话（2026-09-10）**：会议纪要式语音会话——持续说话，豆包流式 ASR（`bigmodel_async` + enable_nonstream 二遍识别，utterances/definite 驱动逐句落库）实时转写；停止后 `ai/memoGen.ts` 整理为纪要（AI 自动起标题 + 总结条目带引用角标 refs + 待办/饮食提取可写入），纪要可重放（音频增量落盘 app_data/voice_sessions/*.wav，asset 协议回放）与 TTS 朗读（seed-tts-2.0 HTTP）。**ASR 适配器层（2026-09-10）**：`modules/voice/asr.rs` 定义 `AsrAdapter` trait（connect/next_frame/send_audio/finish_input/on_frame → NormEvent）+ 枚举分发，豆包与 Qwen/DashScope（run-task/continue-task/finish-task JSON 控制消息 + Bearer 头，`sentence.end_time` 判句终，官方 SDK 1.27.4 核对）各一实现，两家协议互不通用；配置 `asr_adapter = auto|doubao|qwen`（+ `asr_adapter_user_picked` 区分程序替选/用户手选），auto 由 baseURL/模型名关键词识别（词表 Rust `AsrAdapterKind::detect` 与前端 `VoiceConfigSheet.detectAdapter` 一致）。前端双层选择：未手选 → 程序自动替选并跟随关键词换向/撤回；已手选 → 仅弹推荐气泡不强改。豆包 WS 需 `X-Api-*` 自定义鉴权头 → 连接在 Rust `modules/voice`（tokio-tungstenite + gzip 二进制协议，协议结论见 memory rein-voice-memo-asr）；前端 `system/voiceRuntime`（状态机 + AudioWorklet 16k PCM 200ms 包 + 3 分钟自动结算窗口）经 `voice_asr_*` 命令与 `voice://asr` 事件对接。纪要存 `voice_memos`（0016），语音轮是 kind='voice' 的普通聊天消息（与文字同会话）；AI 页输入 `@` 可引用纪要（memoRefs 注入消息文本）。麦克风经 `micBus` 与录音系统互斥；会话视图/浮条挂 App 根部不走路由。聊天与纪要总结的 AI 输出统一 Markdown 渲染（`utils/markdown.ts` 白名单 + `MdText` 流式按块增量）。
- **待办智能解析 `todoGen.ts`**：与聊天同款前端 pi-ai 单轮 Agent（粘贴文本 / 图片 → 提示词约束 JSON 数组 → `TodoDraft[]`），草稿必须先经用户确认/编辑（现由 `SmartAddSheet` 承载）才落库；头像/文本共用 `src/ai/json.ts` 的 JSON 提取工具。`SmartAddSheet` 右上角提供「管理模型 ›」入口（`components/ai/ManageModelsButton.vue`，经 SheetModal `#action` 插槽放入）。`list_all_todos` 返回全部待办（含收件箱 date IS NULL），供主页紧急列表、待办页与虚拟时间线（`VirtualTimeline`，虚拟化渲染 + 双指/Ctrl+滚轮缩放）使用，排序：未完成 → 日期 → 时间 → 优先级。
- **今日画布（2026-08-28）**：`/todos` = 未安排池（date=今天且 start_min 为空）+ 单日时间轴（`CanvasTimeline`：重叠贪心分列、指针拖拽改位、现在线、过去块降透明）+ 桌面右栏详情（`DayDetailPanel`，子任务可勾选）；移动端点块直接进编辑抽屉。智能排程 `autoSchedule.ts`：AI（单轮 pi-agent）产出建议槽位 → 幽灵块预览 → 用户确认才落库（L2 契约），无模型回落启发式（优先级×时长装填最早空档）。每日规划仪式 `DailyRitual`（当天首次打开，localStorage 打标）。周段 = `WeekView` + `WeekSummary`（完成率环 + 按天分布 + 本地洞察）。清单段 = `AllTodoList`（原分组列表）。前端每次 `loadAll` 先调 `sync_recurrences` 物化重复实例（幂等，失败静默跳过）。
- **聊天历史**：多会话（`ai_chats`，前端 `chatId` 指向当前会话，启动打开最近会话，历史抽屉 `HistoryDrawer` 切换/新建）；消息按 id 幂等 upsert（commit 状态变更不产生新行、不改变原 seq）；food-parse 的 items/source/committedAt 与 text 的 thinking/quote 序列化在 `payload`；图片存 1600px 压缩图（识别与追问复用同一张）。**照片静默入会话**（不自动识别、不输出内容，识别由用户提问触发，模型经历史图片块看图）。撤回 = `ai_chat_cut`（按消息 id 删该条及其后全部，级联）；清空上下文 = `ai_chat_clear` + 重写欢迎语；会话首条用户消息后自动把标题"AI 对话"改为前 16 字（`ai_chat_rename`）。
- **AI 工具与消息操作**：`chat.ts` 给 Agent 注入 `search_context` 工具（TypeBox schema，后端 `ai_chat_search` 跨会话 LIKE 搜索、命中含会话标题），模型可自主调用回忆历史。长按消息（450ms，移动 8px 取消）或右键 → ActionSheet：复制 / 引用 / 撤回（仅用户消息，级联）；引用以 payload 持久化、气泡内引用块渲染、发给模型时作为消息前缀上下文。
- **健康方案与 AI 调参（2026-08-26）**：方案基线由纯函数引擎 `src/utils/programEngine.ts` 确定性生成（三档参数表 × Mifflin-St Jeor 计算 × `resources/recipe_templates.json` 食谱模板装配 × 周计划模板组合），食谱模板营养值由 `scripts/gen-recipes.mjs` 从 foods.json 实算生成、禁止手填。**训练频率以用户设置的「每周可训练天数」为权威**（未设置时用档位默认；周模板覆盖 3~7 练，1~2 练从最低频模板裁剪）。AI 侧入口：聊天工具 `get_program`（只读）/ `generate_program`（生成并启用新方案，与页面同一引擎与激活链路，dangerous：会归档现有方案）/ `adjust_program`（调参，走 store.adjust 同一钳制链路）；周复盘在方案页发起（`src/ai/programReview.ts` 汇总近 7 天执行数据 → 无工具单轮分析 → 结构化建议 → 用户确认后应用），AI 不生成新计划结构。
- **AI 定制菜单（2026-08-27）**：`src/ai/recipeGen.ts` —— 模型只出「结构」（餐次 + 库内食物 + 克重，经 search_food 选 id），营养一律由前端用食物库每 100g 数据实算，再按目标热量整体缩放（钳制 0.6~1.5，越界提示）。两个入口共用核心 `generateDayMenu`：食谱库的一日菜单、方案页的**按天生成**（上下文含日期/训练日/近期已吃避免重复/忌口与偏好）。**每日菜单不再是模板写死**：方案启用时仍铺模板菜单作回落，聚焦日的菜单按需 AI 生成并落 `program_meals` 缓存（生成一次即稳定，可「换一批」重新生成；同步更新当天饮食锚点待办备注）；方案调整后从当天起清缓存按新参数重生成；无模型用户始终回落模板菜单。**食谱偏好闭环**：`recipe_prefs` 表存喜欢(1)/不喜欢(-1)，食谱库页标记 → 方案引擎选菜（喜欢优先、不喜欢排除）与 AI 生成提示词共用。
- **体重趋势自动提醒（2026-08-27）**：`src/utils/weightTrend.ts` 纯函数按目标分带判定（减脂掉秤过快/反向增重/停滞、增肌同理、保持期波动过大），主页出现可忽略的提醒卡，直达方案页复盘。
- **归档执行报告（2026-08-27）**：`src/utils/programReport.ts` 汇总归档方案的执行数据（日程/训练/饮食锚点完成率、有记录日均摄入、体重变化、运动消耗、调整次数），ProgramPage「历史方案」区点开弹层查看。

### 数据不变量

1. `meal_logs.grams` 恒为换算后的克重（unit 模式由前端换算后传入）；`units/unit_name` 仅展示。聚合只信 grams。
2. 日期一律本地时区 `YYYY-MM-DD` 字符串；时间戳一律 ISO-8601（UTC）。
3. 时间用「距 00:00 的分钟数」（`start_min`），不用 `HH:mm` 字符串存储。
4. `profile` 恒有一行（id=1），迁移里插入；目标字段以它为准。
5. **训练课会话**：`workout_sessions` 存在 `status='active'` 行 = 有未正常结束的训练。只有用户经「结束键 → 二级确认」调用 `session_finish/session_abort` 才会离开 active；其余一切（切页/收起/关机/崩溃）都视为**异常中断**，启动时由运动系统运行时（`system/workoutRuntime`）自动接管续跑，悬浮运动条（`ActiveWorkoutBar`）提示接续。前端每个训练事件调用 `session_snapshot` 落盘（`elapsed_sec` 由服务端按快照间隔累加）。
6. **训练课程**：课程是用户数据，存 `workout_plans` 表；内置课程种子来自根目录 `resources/workout_plans.json`（与前端 mock 共用的单一来源），启动时**按 id 幂等补齐缺失项**（Rust `seed_builtin_plans` 用 `INSERT OR IGNORE`，mock 用种子版本标记 `PLAN_SEED_VERSION`），已有行永不覆盖；代价是被用户删除的内置课会在下次启动补回。**种子内容版本**（Rust `app_meta` 三键 `plan_seed_applied` / `plan_seed_override` / `plan_seed_keep` = `PLAN_SEED_CONTENT_VERSION`，mock = `PLAN_SEED_VERSION`，当前 **5**）：种子里的课程内容（exercises/subtitle）变更时 +1，但**新版本不再自动覆盖存量内置课**——启动补种只做增量，版本落后时由课程库页横幅触发用户三选一：**兼容合并**（`plan_seed_migrate`，按动作 id 字段级合并，只补本地缺失字段、保留用户设置，推荐）/ **使用新版本**（`plan_seed_override`，整体覆盖）/ **保留我的**（`plan_seed_keep`，本版本不再刷新，下个版本再问）。前端在 `stores/plan.ts` 读 `seedStatus` 判断是否弹横幅。`last_used_at` 在每次开始训练时由 `touch_workout_plan` 更新，「最近使用的三个课程」按它倒序取前三。
7. **跑步会话**：复用 `workout_sessions`，约定 `plan_id='__run__'`（常量 `RUN_PLAN_ID`）；跑步专属状态（目标/累计时长/GPS 距离）全部放在 `state_json`，恢复时强制进入暂停态由用户手动继续。
8. **健康方案**：`programs` 同一时刻至多一行 `status='active'`（`program_create` 事务内自动归档旧方案）；方案内容由前端引擎确定性生成并整体存 `params_json`（Rust 不做计算），调整历史存 `adjustments_json`、每次调参版本自增。方案日程 = 带 `program_id` 的 todos：`program_schedule_replace` 在事务内「删 fromDate 起未完成 → 整批写入」，删除方案时未完成日程一并清除、已完成的保留为普通待办。AI 的角色被限制为参数复盘（缺口/蛋白配比/训练天数），任何建议必须经 `clampAdjustment` 钳制与用户确认，禁止生成新计划结构。

## 4. 数据库

迁移规则：`db.rs::MIGRATIONS` 数组下标即版本号，**只追加不改历史**。新迁移 = 末尾加一条 SQL。

表：`foods` / `food_units` / `meal_logs` / `profile` / `todos` / `workouts` / `pomodoro_sessions`（MIGRATION_0001）、`workout_sessions`（0002）、`workout_plans`（0003）、`ledger_entries` / `ledger_settings`（0004）、`calc_params` / `body_metrics`（0005）、`ai_models` / `ai_chats` / `ai_chat_messages`（0006）、`workouts.session_id`（0007）、profile 个性化约束五列 + `workout_plans.equipment/est_duration_min` + `programs` + `todos.program_id`（0008）、`recipe_prefs`（0009）、`program_meals`（0010，方案每日 AI 菜单缓存，PK(program_id,date)，随方案级联删除）、`todos.rec_rule/rec_key/subtasks`（0011，重复规则/实例键/子任务 JSON 列，rec_key 部分唯一索引保证物化幂等）、`shopping_checks`（0012，采购清单勾选）、`workout_sets` + `app_meta`（0013，逐组做组记录与通用键值元数据）、`todos.attachments`（0014）、`ai_models.image_max_edge`（0015）、`voice_memos`（0016，语音纪要：句子/总结存 JSON 文本列，音频为磁盘文件路径）。营养值单位约定：宏量与纤维/糖为 g，钠钾钙等为 mg，维生素 A/D/B12/叶酸为 μg，C/E 为 mg。记账金额一律整数分（`amount_cents`）、恒为正，正负由 `kind`（expense/income）表达；`ledger_settings` 单行（id=1）存月度总预算。`calc_params` 单行快照方案计算器的身体参数（含手输年龄；改动静默自动落库）；`body_metrics` 体重身高按天一条、同日补录 COALESCE 合并，非空值同步写回 `profile` 保持计算器与「我」页同源。AI：`ai_models` 含能力探测三态（vision/thinking/effort 可空）、部分唯一索引保证至多一个默认；`ai_chat_messages` 的 `(chat_id, seq)` 唯一，`ai_chat_append` 按消息 id 幂等 upsert。健康方案：`programs.params_json` 存前端引擎的完整内容快照 `{params, days}`；`profile` 新列中 `preferred_time_slots`/`diet_restrictions` 为 JSON 数组文本列（NULL=未设置）；`workout_plans.equipment/est_duration_min` 是内置课程 meta（用户编辑不感知，upsert COALESCE 保留原值）。逐组记录：`workout_sets` 在 `session_finish` 事务内由前端提交的做组明细展开落行（workout_id 外键随 workouts 级联删除；exercise_name 跨课程/编辑稳定，是重量曲线的聚合键；warmup=1 的行不计入正式组）；查询命令 `strength_history`（单动作全部做组行）/ `strength_exercises`（有记录的动作清单）/ `strength_last_weights`（批量取各动作最近一次做组重量，沉浸页预填「上次重量」）。

## 5. 设计系统

- 一切视觉值引用 `tokens.css` 令牌；暗色模式只改 tokens 的 dark 块。
- **页头图标按钮统一规范**：PageHeader 通过 `:slotted(.hdr-btn)` 提供标准样式（38px 圆钮、surface 底、卡片阴影；`.accent` 变体为主操作 CTA），各页 lead/action 插槽内的图标按钮一律挂 `hdr-btn` 类，不再各自写样式。
- 三环语义固定：红=摄入达标，绿=运动消耗（目标 `EXERCISE_KCAL_GOAL`=300kcal），青=营养均衡（三大宏量完成度均值）。
- 动效默认 `--ease-standard`；弹层用 `--ease-sheet`（Apple sheet 曲线）；进出必须同路径；遵守 `prefers-reduced-motion` / `prefers-reduced-transparency`。
- 反馈即时性：按压态在 `:active`（pointer-down）生效，不做延迟反馈。

## 6. Mock 模式

`transport.ts` 探测 `__TAURI_INTERNALS__`：非 Tauri 环境动态加载 `mock/server.ts`（内存数据 + 演示记录）。
约束：mock 必须与 Rust 实现同一套命令名与参数键（含 `workoutType` 这类例外）；演示数据只在 mock 中存在，真实库只种食物库与 profile。

## 7. 扩展指南

**新增一个页面**：`pages/X.vue` → `router.ts` 登记（meta.tab）→ 若属一级导航，改 `TabBar.vue` items → 本文件登记路由清单。

**新增一个领域模块（后端）**：
1. `src-tauri/src/modules/<域>/`：`mod.rs` + `models.rs` + `commands.rs`
2. `db.rs` 追加迁移 SQL
3. `lib.rs` 注册命令
4. 前端：`types/<域>.ts` → `services/<域>Service.ts` → `stores/<域>.ts` → 组件/页面
5. `mock/server.ts` 补齐同名命令
6. 更新本文档模块清单

**接入真实 LLM / 视觉模型**：AI 推理层已在前端 `src/ai/`（pi-ai / pi-agent-core），Rust 侧只存配置与聊天历史。新增 AI 能力（如文字走 LLM、目标调整走 LLM）沿用 `src/ai/` 的模式：`runtime.ts` 装配模型 → 调用方动态 import 对应模块；如需 Service Worker 式后台执行再考虑 Node sidecar（届时可换 pi 官方会话后端）。

## 8. 路由清单

| path | name | 页面 |
| --- | --- | --- |
| `/` | home | 主页（今天） |
| `/sports` | sports | 运动（训练主页：周概览 + 跑步/手动记快速入口 + 最近三个课程 + 运动待办 + 最近运动） |
| `/ai` | ai | AI（拍照 / 文字记饮食 · 会话消息流 SQLite 持久化；右上角「管理模型」入口） |
| `/ai/models` | ai-models | 管理模型（二级内容页：模型增删改 / 设默认 / max_tokens=1 能力探测徽章：视觉·思考·努力） |
| `/ai/knowledge` | ai-knowledge | 知识库（二级内容页：检索模式三档切换 / 索引概况与重建 / 索引范围逐类开关 / 检索试跑 / 长期记忆审阅删除；入口在「我 › 知识库」） |
| `/ai/knowledge/files` | ai-knowledge-files | 文件库（三级页：知识库虚拟文件树浏览界面——最近内容 + 命名空间网格 + 目录下钻面包屑 + 文件名搜索；阅读器 note 源直读 kb_files 真源、派生文档 L2 分块渐进加载，保证完整阅读；可编辑文件支持改/删；入口在「知识库 › 文件」卡） |
| `/me` | me | 我 |
| `/focus` | focus | 专注（二级内容页：番茄钟 + 待办 + 日程时间线预览；完整时间线、超量待办收抽屉） |
| `/todos` | todos | 待办 · 今日画布（二级内容页：未安排池 + 单日时间轴 + 详情联动 + 智能排程；周视图含周回顾；清单保留原分组列表；桌面端宽栏三窗格） |
| `/nutrition` | nutrition | 营养全览（二级内容页：能量/宏量/微量元素详解 + 记饮食、改目标快捷入口） |
| `/nutrition/adjust` | nutrition-adjust | 饮食调整（二级内容页：目标计算器（参数快照持久化） · 体重身高追踪 · AI 目标建议 · 手动微调） |
| `/nutrition/foods` | nutrition-foods | 饮食库（二级内容页：全部食物浏览，搜索 + 分类筛选，点行弹详情抽屉；右下角「记录」悬浮按钮直接记一笔） |
| `/nutrition/recipes` | nutrition-recipes | 食谱库（二级内容页：22 个内置食谱模板，餐次筛选 + 忌口灰标 + 喜欢/不喜欢标记，偏好实时影响方案选菜；AI 定制一日菜单，营养由食物库实算并整体缩放） |
| `/program` | program | 健康方案（二级内容页：内联约束向导 → 三档对比矩阵/强度预览双视图 → 日程级展开；生效后展示今日驾驶舱/营养罗盘/周期地图/体重航道/参数演进图，支持手动调参、AI 复盘逐条采纳与档位科学依据；入口在主页快捷行与「我 › 个人约束」） |
| `/program/wrapup/:id` | program-wrapup | 结营成绩单（二级内容页：完成度环 + 开始→结束对照 + 数据徽章 + 下一期档位建议 + 完整报告；`:id`=方案记录 id，生效中的方案查看时提供归档入口；入口为方案页「生成本期成绩单」与历史方案列表） |
| `/ledger` | ledger | 记账（二级内容页：月度统计 + 预算跟踪 + 流水列表 + 记一笔） |
| `/sports/plans` | sports-plans | 全部课程（二级内容页：课程列表 + 新建入口） |
| `/sports/plans/:id` | sports-plan-detail | 课程详情（二级内容页：动作明细 + 开始训练 + 删除） |
| `/sports/plans/:id/edit` | sports-plan-edit | 课程编辑（二级内容页；`:id='new'` 表示新建） |
| `/sports/records` | sports-records | 全部运动记录（二级内容页：日/周/年三视图，概览卡=周期导航+分钟柱状图+统计行，列表按日/月分组；入口为本周运动卡「详情」角标） |
| `/session/run` | session-run | 运动模式·跑步（沉浸二级页：目标设置 → GPS/计时 → 暂停/继续 → 总结保存） |
| `/record` | record | 录音（二级内容页：录音台 + 未归档 take 管理（回放 / 删除 / 附加到待办）；录音中由录音悬浮条跨页接管） |

页面分级约定：一级页 `meta.tab`（TabBar 四个页签）；二级内容页 `meta.title`（保留 TabBar，`PageHeader back` 提供返回键）；沉浸页 `meta.fullscreen`。**训练课沉浸层不再走路由**（2026-09-03）：`components/exercise/SessionOverlay.vue` 由 `App.vue` 常驻挂载，显隐与 container transform 形变动画由 `system/sessionImmersive.ts` 驱动——收起/恢复零重建，原 `/session` 路由已移除。每日目标的编辑入口收敛在「饮食调整」二级页，「我」页只展示摘要。训练课程的全部管理动作收敛在「全部课程」及其详情/编辑二级页，运动主页只放跑步/手动记快速入口与最近使用的三个课程。

**桌面工作台（2026-08-24）**：视口 ≥ `config/domain.ts::DESKTOP_MIN`（1100px）时 `App.vue` 切换到三窗格壳——左侧导航轨 `layout/DesktopRail.vue`（替代底部 TabBar）、主人区 `RouterView`、右侧信息栏 `layout/DesktopInspector.vue`（**全部页面常驻**，保证构图平衡：三环小结 + 今日待办快切 + AI 问句）。主页本身提供两个可切换视图（页头分段控件，选择持久化 `localStorage:'rein.homeView.v1'`）：`workbench/BentoOverview.vue`（便当总览：能量磁贴 + 待办 + 番茄/AI + 快捷入口 + 记账/运动概览）与 `workbench/DaySpine.vue`（一日脊柱：体重/饮食/运动/番茄/收支/待办按分钟聚合的纵向时间线，未来安排虚线 + 「现在」呼吸点）。移动端（< DESKTOP_MIN）保持底部导航四页结构，主页为「状态条 + 主页画布 + 常用工具栏」（2026-08-26 起：无壳能量状态条 → 2026-08-29 升级为 `home/HomeCanvas.vue` **主页画布**：未安排池 chips（点卡片进编辑抽屉快排）+ 紧凑版 `todo/CanvasTimeline.vue`（现在线/打勾/拖拽改位，与 /todos 画布同组件同数据，216px 视窗锚定「现在」）+ 餐次摘要 chips → 查阅文字链 → 移动便当风格 2 列工具格：图标章+标题+副标，覆盖记饮食/记运动/专注/AI/记账/健康方案六动作），桌面端其他页面内容以 560px 窄栏居中（`App.vue` `.desk-main:not(.wide)` 约束）。断点检测用 `composables/useMediaQuery.ts`（matchMedia 响应式），不依赖窗口 resize 监听。沉浸页（`meta.fullscreen`）在两形态下都隐藏导航。

## 9. 训练课会话与跑步（stores/session.ts · stores/run.ts · system/workoutRuntime.ts）

- 纯前端状态机 + 后端会话持久化：状态事件 → `session_snapshot`（fire-and-forget，失败显示页顶警示不阻塞训练）。两台状态机都是 Pinia 应用级单例，**组件卸载不影响计时/GPS/落盘**。
- 中断恢复：`hydrateFromServer()` 读 `session_active`，恢复 doneSets/重量/阶段；**休息倒计时按快照间隔的真实流逝补时**，计时动作被打断则整组重做。
- **录音系统运行时**（`system/recorderRuntime.ts`，模块级单例）：MediaRecorder 与计时在模块状态上，编辑抽屉「录音」、录音页、录音悬浮条（`components/record/RecordFloatBar.vue`，useDragDock 独立持久化 key `rein.rbar.dock.v1`）发起的是同一次录音，录音中可跨页；录完的 take 统一进内存 takes 列表，「附加到待办」写 `todos.attachments` 持久化，未附加的关应用即失。Android 需 Manifest 声明 `RECORD_AUDIO`（RustWebChromeClient 已把 web 的 AUDIO_CAPTURE 映射为运行时权限请求）。
- **运动系统运行时**（`system/workoutRuntime.ts`，main.ts 装载）：应用启动即接管 active 会话（原各页「检测到未完成的训练」恢复卡逻辑收敛于此）；沉浸页挂载先 `whenReady()` 防竞态。导航栏上方的悬浮运动条（`components/exercise/ActiveWorkoutBar.vue`，沉浸形态隐藏）与沉浸层共用运行时的数据与动作：跑步 = 配速/里程/暂停（**必须暂停再结束**），课程 = 动作名/当前组数/完成本组；两者都提供「恢复沉浸」（训练课经 `system/sessionImmersive` 从浮窗位置形变展开，不走路由；跑步推 `/session/run`）。开始前发现 active 会话 → 提示「前往继续」（`run.courseConflict` / `session.foreignRoute` 区分训练课沉浸层与跑步 `/session/run`）防止覆盖。
- **课程数据不再来自静态配置**：`stores/plan.ts` 从 `workout_plans` 表加载；会话恢复按 `planId` 查库，查不到（已删除）则作废该会话。开始训练时调用 `touch_workout_plan` 维护「最近使用」。
- **跑步**（`stores/run.ts`）：`plan_id='__run__'` 复用会话落盘；GPS 用 `navigator.geolocation.watchPosition` 累加距离（精度过滤），不可用时总结页手动填距离（跑步机场景）；卡路里按配速分档取 run 的 MET；恢复时强制暂停态。
- **跑步保活**（2026-08-24）：安卓锁屏后 WebView 的 GPS/计时随进程冻结停摆（用户感知「定位丢失后崩溃」）。开跑（`begin`）/续跑前经 `trackingService.setKeepalive(true)` 拉起 Android `RunTrackingService`（location 类型前台服务 + WakeLock），首次未授权先弹系统授权框（轮询 `tracking_status` 收敛，拒绝或超时则降级为无 GPS）；总结/重置时停服务。命令：`tracking_keepalive` / `tracking_status`（JNI 经 `Webview::jni_handle().exec` 发后不管，状态走 Kotlin snapshot 静态缓存）。桌面端空操作。

## 10. 知识库与认知层（src-tauri/src/modules/kb · stores/ai.ts · ai/tools/knowledge.ts）

一个库装下多种来源：日程与附件、运动记录与逐组明细、训练课程、饮食与体测、健康方案、语音纪要、历史聊天，以及 AI 从对话中提炼的长期记忆。**长期记忆不是独立系统**，它是 `kb_docs` 的一类来源（`source_type='memory'`），因此天然进入同一套检索；反过来，全部来源又都是 LLM 的检索目标。

- **检索三档**（`kb_settings.embedding_mode`，默认 `keyword`）：`keyword` 纯 FTS5 trigram + 结构化过滤，零依赖全平台可用；`local` 进程内 ONNX Runtime + 内置 int8 模型（bge-small-zh-v1.5），数据不出设备；`cloud` 走 OpenAI 兼容 `/v1/embeddings`（Rust 侧 ureq，不受 WebView CSP 约束）。三档共用同一个 `Embedder` trait 与同一套检索流程，`keyword` 即「无 embedder」。性能实测见 `docs/kb-embed-benchmark.md`。
- **召回阶梯**（`kb/search.rs`）：FTS5 bm25 → 整串 LIKE（trigram 不支持少于 3 字符的查询，中文两字词如「膝盖」必须走这层）→ 二字窗口模糊（中文无分词器时唯一能兜住「膝盖内扣」→「膝盖不要内扣」的手段）。各层结果用 RRF(k=60) 融合，再与向量召回并轨。向量是**暴力扫描**：万级块 × 512 维约 20 MB、单次 5–15 ms，因此不引入任何向量索引库。
- **分层读取**（对应 OpenViking 的 L0/L1/L2）：检索只回摘要级命中（L0），`kb_read` 默认给概览（L1），确需全文才用 `level:'l2'`。工具返回值的分层纪律直接修掉了 `list_all_workouts` 无分页、`get_plan` 全量返回这类上下文失控问题。
- **同步靠触发器而非命令层挂点**（迁移 0019）：`todos`/`workouts`/`workout_sets`/`workout_plans`/`meal_logs`/`body_metrics`/`foods`(仅 `is_custom=1`)/`programs`/`program_meals`/`voice_memos`/`ai_chat_messages` 的增改删都会写一行 `kb_dirty`。这样连 `program_schedule_replace` 这种批量直写 `todos` 的旁路也被覆盖，未来新增写入路径同样自动生效。`foods` 只在自建时登记——内置 2722 条种子每次启动都 `INSERT OR IGNORE`，无条件登记会拖垮首启。
- **索引线程**（`kb/worker.rs`，`std::thread` + `recv_timeout`）：三段落法——持锁取文本 → **放锁嵌入** → 持锁写回。全应用共用同一个 `Mutex<Connection>`，嵌入若在持锁期间执行会直接卡住界面。空闲约 60 秒后释放 embedder（重建仅 50–130 ms），因为进程峰值工作集实测 157 MB，安卓上会被低内存杀手盯上。
- **记忆抽取**（`ai/memoryExtract.ts` + `kb_memory_apply`）：会话结束（切会话/新建/清空）时后台跑一次，**不 await**。把「现有记忆清单」一并放进上下文，让模型一次调用同时完成抽取与去重合并，比原有的「抽取 + 向量预筛 + LLM 去重」两轮省一半成本。落库留 `kb_memory_diffs` 审计。编排在前端是因为模型请求由 WebView 里的 pi-ai 直连 provider。
- **认知注入**：`kb_cognition` 产出一段紧凑文本，由 `stores/ai.ts` 在每轮请求前取（60 秒 TTL 缓存）并经 `chatWithModel(cfg, …, { cognition })` 传进系统提示词的【用户认知】段。做成预注入而非又一个工具，是因为模型每轮都该直接知道自己面对的是谁。
- **两个必须守住的约束**：① 附件里 image/file/audio 的 `content` 是 base64 data URL，**绝不能进索引正文**，只索引文件名与体积（`source.rs::attachments_digest`，有单测硬断言）；② `kb_fts` 用 external content 指回 `kb_chunks`，一致性靠 `kb_chunks` 上的三触发器，而 SQLite 的外键级联删除**不触发**子表触发器，所以删除文档一律先显式删块（`fts_stays_consistent…` 单测用 FTS5 integrity-check 守着）。
- 命令：`kb_status` / `kb_search` / `kb_read` / `kb_reindex` / `kb_settings_get` / `kb_settings_set` / `kb_probe_embedder` / `kb_rebuild_vectors` / `kb_memories` / `kb_memory_apply` / `kb_memory_delete` / `kb_cognition` / `kb_memory_bump` / `kb_glob` / `kb_file_write` / `kb_file_rename` / `kb_file_delete` / `kb_file_get`。
- **虚拟文件系统**（规范见 `docs/kb-vfs.md`，同文档会播种为只读系统文件 `规范/知识库规范.md` 供 AI 自查）：迁移 0020 给每篇文档加 `path`，统一规则在 `source.rs::build_path`（日程/运动/课程/饮食/体测/食物/方案/菜单/纪要/对话/附件/记忆/笔记/文档/规范）。`editable`/`system`/`kind` 做成列；派生文档只读，可写的只有 `笔记/`、`文档/`（kb_files，内容即真源）与记忆（经记忆 API）。`kb_files` 的编辑/改名/删除走 files.rs，id 可传文档 id 或文件 id（`resolve_file_id`）。`read_knowledge` 按 L1/L2 分块分页（`offset`/`limit`/`hasMore`/`nextOffset`），`glob_knowledge` 用 git 语义 glob（`*` 不跨目录、`**` 跨、`a/**/b` 匹配零层目录）。**上传文档时前端把抽取全文自动归档进 `文档/`**（prompt 只带 6000 字截断版并注明归档路径，AI 靠分页读全文）——真机验证：docx 训练安排表 → AI 逐条 `create_todo` 67 条，60 秒完成。**阅读以真源为准（2026-09-12）**：`kb_read` 对 note 源直读 `kb_files.content` 即时切块——`kb_docs.body` 是带 8000 字上限的检索缓存，此前全文超限的 Word 归档会被截断，AI 分页到头也读不到剩余内容；用户侧完整浏览走「知识库 › 文件库」（`FileLibraryPage.vue`，目录下钻 + 直读原文/分块渐进加载）。
- **启动对账**（`worker.rs::reconcile`）：每次启动先播种规范文件，再把既有源记录全部入队并清孤儿（触发器只对之后的写入生效，老库升级必须靠它），内容未变的条目按 `content_hash` 跳过。
- **构建前置**：端侧模型与 ORT 运行库不入库，克隆后先跑 `node scripts/fetch-embed-model.mjs` 与 `node scripts/fetch-ort-runtime.mjs --target all`；`src-tauri/build.rs` 会校验并在缺失时给出提示。三端交叉编译不需要任何原生链接配置（`ort` 用 `load-dynamic`、`tokenizers` 用纯 Rust 的 `fancy-regex`，整棵依赖树零 C 代码）。

## 11. 已知边界（框架阶段的有意取舍）

- 单窗口单连接（Mutex<Connection>）：桌面场景足够，出现并发瓶颈再引入连接池/rusqlite pool。
- 目标按天覆盖（daily_targets）未启用：`get_targets/set_targets` 的 date 参数已预留。
- 重复任务为轻量规则（每天/每周几/间隔 N 天 + 结束日期），模板行持有规则、实例按 `rec_key="模板id:日期"` 物化到滚动窗口 [今天-1, 今天+7]，`sync_recurrences` 幂等（改规则后未来未完成实例自动重建）；仅支持改单条实例，无"整个系列"编辑。子任务为单层 checklist（JSON 列，无嵌套/指派）。饮食自定义食物目前仅经 AI `create_food` / 智能添加自动补录落库（手动新建 UI 未做，表结构与命令已就绪）。
- 记账为轻量单账本模型：支出/收入两类（无转账/多账户/多币种）、预设分类（自定义分类与层级未启用）、单一月度总预算（无分类预算/结转/提醒）、无周期账与 CSV 导出；流水搜备注 + 分类筛选。
- 跑步 GPS 依赖系统定位服务：桌面端常不可用或漂移大，此时自动退化为纯计时模式，距离在总结页手动补填（跑步机场景同理）。
- AI：`ai_models.api_key` 目前明文存 SQLite（单机单用户应用可接受，未上系统钥匙串）。
