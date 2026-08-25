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
| `src/system/*` | 应用级运行时单例（当前仅运动系统 `workoutRuntime`：启动接管 + 沉浸页/悬浮运动条统一数据源） | 组件渲染逻辑、IPC 直连 |
| `src/services/*` | 命令名 → 类型化函数 | 业务逻辑 |
| `src/mock/server.ts` | 与 Rust 相同的命令契约 | 生产分支逻辑 |
| `src/ai/*` | AI 推理层（pi-ai / pi-agent-core）：`runtime.ts` 模型装配、`probe.ts` max_tokens=1 能力探测、`vision.ts` 照片食物识别。模型请求由 WebView 直连 provider，不经 Rust | 直接 import '@tauri-apps/api'；同步 import 进主包（store 侧动态 import） |
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
- **待办智能解析 `todoGen.ts`**：与聊天同款前端 pi-ai 单轮 Agent（粘贴文本 / 图片 → 提示词约束 JSON 数组 → `TodoDraft[]`），草稿必须先经用户确认/编辑（现由 `SmartAddSheet` 承载）才落库；头像/文本共用 `src/ai/json.ts` 的 JSON 提取工具。`SmartAddSheet` 右上角提供「管理模型 ›」入口（`components/ai/ManageModelsButton.vue`，经 SheetModal `#action` 插槽放入）。`list_all_todos` 返回全部待办（含收件箱 date IS NULL），供主页紧急列表、全部待办页与虚拟时间线（`VirtualTimeline`，虚拟化渲染 + 双指/Ctrl+滚轮缩放）使用，排序：未完成 → 日期 → 时间 → 优先级。
- **聊天历史**：多会话（`ai_chats`，前端 `chatId` 指向当前会话，启动打开最近会话，历史抽屉 `HistoryDrawer` 切换/新建）；消息按 id 幂等 upsert（commit 状态变更不产生新行、不改变原 seq）；food-parse 的 items/source/committedAt 与 text 的 thinking/quote 序列化在 `payload`；图片存 1600px 压缩图（识别与追问复用同一张）。**照片静默入会话**（不自动识别、不输出内容，识别由用户提问触发，模型经历史图片块看图）。撤回 = `ai_chat_cut`（按消息 id 删该条及其后全部，级联）；清空上下文 = `ai_chat_clear` + 重写欢迎语；会话首条用户消息后自动把标题"AI 对话"改为前 16 字（`ai_chat_rename`）。
- **AI 工具与消息操作**：`chat.ts` 给 Agent 注入 `search_context` 工具（TypeBox schema，后端 `ai_chat_search` 跨会话 LIKE 搜索、命中含会话标题），模型可自主调用回忆历史。长按消息（450ms，移动 8px 取消）或右键 → ActionSheet：复制 / 引用 / 撤回（仅用户消息，级联）；引用以 payload 持久化、气泡内引用块渲染、发给模型时作为消息前缀上下文。

### 数据不变量

1. `meal_logs.grams` 恒为换算后的克重（unit 模式由前端换算后传入）；`units/unit_name` 仅展示。聚合只信 grams。
2. 日期一律本地时区 `YYYY-MM-DD` 字符串；时间戳一律 ISO-8601（UTC）。
3. 时间用「距 00:00 的分钟数」（`start_min`），不用 `HH:mm` 字符串存储。
4. `profile` 恒有一行（id=1），迁移里插入；目标字段以它为准。
5. **训练课会话**：`workout_sessions` 存在 `status='active'` 行 = 有未正常结束的训练。只有用户经「结束键 → 二级确认」调用 `session_finish/session_abort` 才会离开 active；其余一切（切页/收起/关机/崩溃）都视为**异常中断**，启动时由运动系统运行时（`system/workoutRuntime`）自动接管续跑，悬浮运动条（`ActiveWorkoutBar`）提示接续。前端每个训练事件调用 `session_snapshot` 落盘（`elapsed_sec` 由服务端按快照间隔累加）。
6. **训练课程**：课程是用户数据，存 `workout_plans` 表；内置课程种子来自根目录 `resources/workout_plans.json`（与前端 mock 共用的单一来源），启动时**按 id 幂等补齐缺失项**（Rust `seed_builtin_plans` 用 `INSERT OR IGNORE`，mock 用种子版本标记 `PLAN_SEED_VERSION`），已有行永不覆盖；代价是被用户删除的内置课会在下次启动补回。`last_used_at` 在每次开始训练时由 `touch_workout_plan` 更新，「最近使用的三个课程」按它倒序取前三。
7. **跑步会话**：复用 `workout_sessions`，约定 `plan_id='__run__'`（常量 `RUN_PLAN_ID`）；跑步专属状态（目标/累计时长/GPS 距离）全部放在 `state_json`，恢复时强制进入暂停态由用户手动继续。

## 4. 数据库

迁移规则：`db.rs::MIGRATIONS` 数组下标即版本号，**只追加不改历史**。新迁移 = 末尾加一条 SQL。

表：`foods` / `food_units` / `meal_logs` / `profile` / `todos` / `workouts` / `pomodoro_sessions`（MIGRATION_0001）、`workout_sessions`（0002）、`workout_plans`（0003）、`ledger_entries` / `ledger_settings`（0004）、`calc_params` / `body_metrics`（0005）、`ai_models` / `ai_chats` / `ai_chat_messages`（0006）。营养值单位约定：宏量与纤维/糖为 g，钠钾钙等为 mg，维生素 A/D/B12/叶酸为 μg，C/E 为 mg。记账金额一律整数分（`amount_cents`）、恒为正，正负由 `kind`（expense/income）表达；`ledger_settings` 单行（id=1）存月度总预算。`calc_params` 单行快照方案计算器的身体参数（含手输年龄；改动静默自动落库）；`body_metrics` 体重身高按天一条、同日补录 COALESCE 合并，非空值同步写回 `profile` 保持计算器与「我」页同源。AI：`ai_models` 含能力探测三态（vision/thinking/effort 可空）、部分唯一索引保证至多一个默认；`ai_chat_messages` 的 `(chat_id, seq)` 唯一，`ai_chat_append` 按消息 id 幂等 upsert。

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
| `/me` | me | 我 |
| `/focus` | focus | 专注（二级内容页：番茄钟 + 待办 + 日程时间线预览；完整时间线、超量待办收抽屉） |
| `/todos` | todos | 全部待办（二级内容页：紧急程度排序 + 按日期分组；主页「待办」卡入口） |
| `/nutrition` | nutrition | 营养全览（二级内容页：能量/宏量/微量元素详解 + 记饮食、改目标快捷入口） |
| `/nutrition/adjust` | nutrition-adjust | 饮食调整（二级内容页：目标计算器（参数快照持久化） · 体重身高追踪 · AI 目标建议 · 手动微调） |
| `/nutrition/foods` | nutrition-foods | 饮食库（二级内容页：全部食物浏览，搜索 + 分类筛选，点行弹详情抽屉；右下角「记录」悬浮按钮直接记一笔） |
| `/ledger` | ledger | 记账（二级内容页：月度统计 + 预算跟踪 + 流水列表 + 记一笔） |
| `/sports/plans` | sports-plans | 全部课程（二级内容页：课程列表 + 新建入口） |
| `/sports/plans/:id` | sports-plan-detail | 课程详情（二级内容页：动作明细 + 开始训练 + 删除） |
| `/sports/plans/:id/edit` | sports-plan-edit | 课程编辑（二级内容页；`:id='new'` 表示新建） |
| `/sports/records` | sports-records | 全部运动记录（二级内容页：日/周/年三视图，概览卡=周期导航+分钟柱状图+统计行，列表按日/月分组；入口为本周运动卡「详情」角标） |
| `/session` | session | 运动模式·训练课（沉浸二级页，`meta.fullscreen=true` 隐藏 TabBar） |
| `/session/run` | session-run | 运动模式·跑步（沉浸二级页：目标设置 → GPS/计时 → 暂停/继续 → 总结保存） |

页面分级约定：一级页 `meta.tab`（TabBar 四个页签）；二级内容页 `meta.title`（保留 TabBar，`PageHeader back` 提供返回键）；沉浸页 `meta.fullscreen`。每日目标的编辑入口收敛在「饮食调整」二级页，「我」页只展示摘要。训练课程的全部管理动作收敛在「全部课程」及其详情/编辑二级页，运动主页只放跑步/手动记快速入口与最近使用的三个课程。

**桌面工作台（2026-08-24）**：视口 ≥ `config/domain.ts::DESKTOP_MIN`（1100px）时 `App.vue` 切换到三窗格壳——左侧导航轨 `layout/DesktopRail.vue`（替代底部 TabBar）、主人区 `RouterView`、右侧信息栏 `layout/DesktopInspector.vue`（**全部页面常驻**，保证构图平衡：三环小结 + 今日待办快切 + AI 问句）。主页本身提供两个可切换视图（页头分段控件，选择持久化 `localStorage:'rein.homeView.v1'`）：`workbench/BentoOverview.vue`（便当总览：能量磁贴 + 待办 + 番茄/AI + 快捷入口 + 记账/运动概览）与 `workbench/DaySpine.vue`（一日脊柱：体重/饮食/运动/番茄/收支/待办按分钟聚合的纵向时间线，未来安排虚线 + 「现在」呼吸点）。移动端（< DESKTOP_MIN）保持原底部导航四页结构，桌面端其他页面内容以 560px 窄栏居中（`App.vue` `.desk-main:not(.wide)` 约束）。断点检测用 `composables/useMediaQuery.ts`（matchMedia 响应式），不依赖窗口 resize 监听。沉浸页（`meta.fullscreen`）在两形态下都隐藏导航。

## 9. 训练课会话与跑步（stores/session.ts · stores/run.ts · system/workoutRuntime.ts）

- 纯前端状态机 + 后端会话持久化：状态事件 → `session_snapshot`（fire-and-forget，失败显示页顶警示不阻塞训练）。两台状态机都是 Pinia 应用级单例，**组件卸载不影响计时/GPS/落盘**。
- 中断恢复：`hydrateFromServer()` 读 `session_active`，恢复 doneSets/重量/阶段；**休息倒计时按快照间隔的真实流逝补时**，计时动作被打断则整组重做。
- **运动系统运行时**（`system/workoutRuntime.ts`，main.ts 装载）：应用启动即接管 active 会话（原各页「检测到未完成的训练」恢复卡逻辑收敛于此）；沉浸页挂载先 `whenReady()` 防竞态。导航栏上方的悬浮运动条（`components/exercise/ActiveWorkoutBar.vue`，fullscreen 路由隐藏）与沉浸页共用运行时的数据与动作：跑步 = 配速/里程/暂停（**必须暂停再结束**），课程 = 动作名/当前组数/完成本组；两者都提供「恢复沉浸」。开始前发现 active 会话 → 提示「前往继续」（`run.courseConflict` / `session.foreignRoute` 区分训练课 `/session` 与跑步 `/session/run`）防止覆盖。
- **课程数据不再来自静态配置**：`stores/plan.ts` 从 `workout_plans` 表加载；会话恢复按 `planId` 查库，查不到（已删除）则作废该会话。开始训练时调用 `touch_workout_plan` 维护「最近使用」。
- **跑步**（`stores/run.ts`）：`plan_id='__run__'` 复用会话落盘；GPS 用 `navigator.geolocation.watchPosition` 累加距离（精度过滤），不可用时总结页手动填距离（跑步机场景）；卡路里按配速分档取 run 的 MET；恢复时强制暂停态。
- **跑步保活**（2026-08-24）：安卓锁屏后 WebView 的 GPS/计时随进程冻结停摆（用户感知「定位丢失后崩溃」）。开跑（`begin`）/续跑前经 `trackingService.setKeepalive(true)` 拉起 Android `RunTrackingService`（location 类型前台服务 + WakeLock），首次未授权先弹系统授权框（轮询 `tracking_status` 收敛，拒绝或超时则降级为无 GPS）；总结/重置时停服务。命令：`tracking_keepalive` / `tracking_status`（JNI 经 `Webview::jni_handle().exec` 发后不管，状态走 Kotlin snapshot 静态缓存）。桌面端空操作。

## 10. 已知边界（框架阶段的有意取舍）

- 单窗口单连接（Mutex<Connection>）：桌面场景足够，出现并发瓶颈再引入连接池/rusqlite pool。
- 目标按天覆盖（daily_targets）未启用：`get_targets/set_targets` 的 date 参数已预留。
- 待办无重复规则、无子任务；饮食自定义食物目前仅经 AI `create_food` / 智能添加自动补录落库（手动新建 UI 未做，表结构与命令已就绪）。
- 记账为轻量单账本模型：支出/收入两类（无转账/多账户/多币种）、预设分类（自定义分类与层级未启用）、单一月度总预算（无分类预算/结转/提醒）、无周期账与 CSV 导出；流水搜备注 + 分类筛选。
- 跑步 GPS 依赖系统定位服务：桌面端常不可用或漂移大，此时自动退化为纯计时模式，距离在总结页手动补填（跑步机场景同理）。
- AI：`ai_models.api_key` 目前明文存 SQLite（单机单用户应用可接受，未上系统钥匙串）。
