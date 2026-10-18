# Rein 对外服务接口（External API）实现契约

> 本文是把六路只读调研合成的**唯一实现依据**。三层 Rust 实现与两名前端实现照此写。
> 文中每条事实带 `path:line`；凡无源码支撑的推断均显式标「推断」；调研报告之间冲突处
> 在本文给出唯一裁定，并注明被舍弃的一方。提到尚未创建的文件一律写「新建」。
> 本文件由合成者创建，未改动任何代码文件。
>
> 本次会话实测：`node scripts/check-ipc-contract.mjs` → `命令数：Rust 266 / services 266 / mock 266`、
> `IPC 契约一致 ✓`、退出码 0。落地新增 tauri 命令后必须重跑，数字应变大而三处仍相等。

---

## 1. 结论与边界

### 1.1 做什么（v1）

让外部程序（首个消费者：独立的 Windows 桌面三方 UI + 一个「显示今天日程」的小组件）
在**用户逐项授权**下，经本机或局域网 WebSocket 读写 Rein 三类数据：日程/待办（`todos`）、
番茄钟会话（`pomodoro_sessions`）、运动数据（`workouts` / `workout_plans` / `workout_sets`）。

四条硬性要求落点：

| 硬性要求 | 落点 |
| --- | --- |
| 授权四态（本次会话/始终允许/忽略/拒绝） | §5.1 状态机；「本次会话」只存内存，随连接消亡 |
| 覆盖日程查看/修改/新增、番茄钟、运动数据 | §4.4 方法表（15 条）+ §5.3 scope 模型 |
| 绑定模式：仅本机 / 局域网 | §4.1 `bindMode: "local"｜"lan"` |
| 开了端口≠拿到全部数据 | §5.3 每次调用逐次校验 scope + §7 三道门（Origin/Host/令牌） |

### 1.2 明确不做（v1 边界）

- **不做 HTTP/REST**：传输统一 WebSocket（握手闸门 + 首帧令牌），不引入 axum/hyper/warp。
- **不暴露原始 SQL**：只有类型化白名单方法，无「执行任意查询」入口。
- **不在 Android 启用**：整个服务 `#[cfg(desktop)]` 门控。
- **对外数据方法不注册成 `#[tauri::command]`**：由网关私有 router 分发；只有管理面是 tauri 命令（§4.5）。
- **v1 不提供训练课运行态控制**（开始/暂停/完成组/结束）：状态机唯一真源在前端，
  直写 `workout_sessions.state_json` 会被前端内存旧值静默覆盖（§10）。属 v2 下行通道。
- **v1 不提供 `delete_workout`**：它要 `tauri::Webview` 做 Health Connect 传播
  （`src-tauri/src/modules/exercise/commands.rs:95`，`delete_workout` 首参为 `webview`），网关无 Webview。
- **不做局域网端到端加密**：仅「绑 0.0.0.0 + 强制令牌 + 界面风险提示」（§11）。
- **番茄钟不做运行态上报**：只暴露已落盘的数据（§11）。
- **审计只落库**：查看界面留到后续（§11）。

---

## 2. 架构总览

### 2.1 为什么不架在同步通道上

多设备同步是**设备↔设备**、被动捕获、端到端加密的链路；本接口是**本机外部进程↔Rein**，
消费者与信任模型都不同。共用会同时污染两边的语义（同步对象要收敛、要跨设备传，
对外接口要即时、要按 scope 收口）。二者并列且互不替代。

### 2.2 写操作如何被同步自动捕获（关键）

全应用只有一条 SQLite 连接，包在 `Db(Mutex<Connection>)`（`src-tauri/src/state.rs:39`，取锁见 `:47`），
200+ 命令全走它。同步的捕获钩子 `update_hook` 是**连接级**的（`src-tauri/src/modules/sync/engine.rs:127-147`
的 `install_hook`），在 setup 里、`db::init` 之后装到那条唯一连接上（`src-tauri/src/lib.rs:23,26,27,28`）。
因此**只要对外 handler 用同一把 `state.db.lock()` 写库，写入就被现有钩子当成普通本地改动捕获**，
无需网关做任何额外的事（`engine.rs:5` 自述「一个 update_hook 就能看见所有写入」）。
捕获线程 `rein-sync` 也**无条件**在 setup 启动（`lib.rs:68-69`；`engine.rs:488` 初始即运行），
所以「没配置同步」时钩子照样在、广播照样工作（见 §6.2 的落点）。

### 2.3 一句话数据流

外部程序 WS 连接 → 握手闸门（Origin/Host）→ 首帧令牌 → 四态授权（scope 逐次校验）→
router 按方法名分发 → handler **短锁** `state.db.lock()` 内调各域 `*_on(&conn, …)` →
写入被 `update_hook` 自动捕获进同步队列；同时同步消费点在**锁外**把变更事件推给 `ChangeFeed` → 外部订阅。

---

## 3. 文件清单

| 路径 | 新建/改动 | 负责层 | 干什么 |
| --- | --- | --- | --- |
| `src-tauri/src/modules/gateway/mod.rs` | 新建 | 协议与域绑定 | 模块声明、`GatewayHub` 状态、`ChangeFeed`、对外 pub 入口 |
| `src-tauri/src/modules/gateway/server.rs` | 新建 | 协议与域绑定 | WS 监听/accept/握手闸门/首帧令牌/限流/生命周期/请求分派/变更推送 |
| `src-tauri/src/modules/gateway/protocol.rs` | 新建 | 协议与域绑定 | 消息信封（请求/响应/事件）+ 错误码 + **15 条方法注册表 `Method`**（原计划的 router.rs/dto.rs 合并于此） |
| `src-tauri/src/modules/gateway/methods.rs` | 新建 | 协议与域绑定 | 各域方法绑定：参数 → `*_on` → DTO（原计划的 handlers/ 合并于此） |
| `src-tauri/src/modules/gateway/models.rs` | 新建 | 协议与域绑定 | **`Scope` 枚举唯一定义处** + `ScopeSet` + 凭据/审计/变更事件形状（原计划的 scope.rs 并入此处） |
| `src-tauri/src/modules/gateway/auth.rs` | 新建 | 服务与授权 | 四态状态机、连接级会话表 conn_id→ConnGrant、待决队列、`require()` 强制点、按 client/IP 限流（原计划的 session.rs 并入此处） |
| `src-tauri/src/modules/gateway/store.rs` | 新建 | 服务与授权 | ext_clients / ext_audit 读写；token 生成 / sha256 入库 / 恒定时间比较；app_meta 键读写 |
| `src-tauri/src/modules/gateway/commands.rs` | 新建 | 服务与授权 | 仅管理面的 6 条 tauri command |
| `src-tauri/src/modules/todo/commands.rs` | 改动 | 存储层 | 5 条命令下沉为 `*_on(&Connection,…)`，命令退化为壳 |
| `src-tauri/src/modules/exercise/commands.rs` | 改动 | 存储层 | `list_workouts`/`create_workout` 下沉为 `*_on` |
| `src-tauri/src/modules/plan/commands.rs` | 改动 | 存储层 | `list_workout_plans`/`get_workout_plan` 拆锁（后者已委托 `plan_by_id`） |
| `src-tauri/src/modules/pomodoro/commands.rs` | 改动 | 存储层 | `save`/`list` 下沉为 `*_on` |
| `src-tauri/src/modules/session/commands.rs` | 改动 | 存储层 | 4 条 `strength_*` 读命令下沉为 `*_on` |
| `src-tauri/src/modules/sync/engine.rs` | 改动 | 存储层 | `capture` 三态化、`append_log` 返 seq、消费点广播（§6.2） |
| `src-tauri/src/db.rs` | 改动 | 存储层 | 追加 MIGRATION_0042（ext_clients/ext_audit/build SQL 见 §6.5） |
| `src-tauri/src/lib.rs` | 改动 | 服务与授权 | manage `GatewayHub`、启动 server、注册 6 条管理命令 |
| `src-tauri/src/modules/mod.rs` | 改动 | 服务与授权 | 追加 `pub mod gateway;` |
| `src-tauri/Cargo.toml` | 改动 | 协议与域绑定 | tokio features 追加 `"net"`（§6.1） |
| `src-tauri/capabilities/default.json` | 不改 | — | 自定义命令不受其约束（`:4`），不是安全边界 |
| `src/types/externalAccess.ts` | 新建 | 前端 | 四态/绑定模式/scope/请求/客户端/状态类型 |
| `src/types/index.ts` | 改动 | 前端 | barrel 追加一行 `export * from './externalAccess'` |
| `src/services/gatewayService.ts` | 新建 | 前端 | 6 条管理命令封装 + 两个事件的桥 |
| `src/system/externalAccessRuntime.ts` | 新建 | 前端 | 授权弹窗的单例状态机（显隐、待处理队列） |
| `src/components/settings/GatewayAuthSheet.vue` | 新建 | 前端 | 授权四态弹窗（SheetModal 壳） |
| `src/components/settings/ExternalAccessSection.vue` | 新建 | 前端 | 「外部访问」**内嵌设置页分区**：开关/绑定模式/配对令牌/已授权列表/被拦下列表与解除（原计划的独立页 `ExternalAccessPage.vue` 改为内嵌分区） |
| `src/pages/SettingsPage.vue` | 改动 | 前端 | 挂载 `<ExternalAccessSection />`（原计划的 `/settings/external` 独立路由取消） |
| `src/App.vue` | 改动 | 前端 | 模板末尾追加 `<GatewayAuthSheet />`（全局常驻层） |
| `src/main.ts` | 改动 | 前端 | 启动调用 `externalAccessRuntime.init()` |
| `src/mock/server.ts` | 改动 | 前端 | 6 条命令顶层 case + `mockGateway` 事件钩子 + e2e 触发入口 |
| `scripts/e2e-external-api.mjs` | 新建 | 前端 | e2e 骨架（原计划名 `e2e-external-access.mjs`，实际为 `e2e-external-api.mjs`） |

---

## 4. 接口契约（最要紧的一章）

### 4.1 连接方式与握手要求

- 传输：**WebSocket（文本帧）**。沿用 `tokio-tungstenite` 的服务器侧握手
  （Cargo.toml:50；仓库现只用了客户端 `connect_async`）。
- 绑定地址：`bindMode: "local"` → 同时绑 `127.0.0.1` 与 `::1`（Windows 上 `localhost` 常先解析到 `::1`）；
  `"lan"` → 只绑 IPv4 `0.0.0.0`（Windows `IPV6_V6ONLY=1` 时不覆盖 v4；此点为通识**推断**，未实测）。
- 默认端口 `17650`（避开同步 UDP 48990/48991）；被占则 17650..17659 顺延，全占退系统分配（port 0），
  把**实际**端口写回设置并显示，绝不静默换端口。**不要**手动设 `SO_REUSEADDR`（tokio 在 Windows 上不设，
  端口占用会干净地返回 `AddrInUse`）。
- 握手闸门（在 WS 握手回调里，顺序固定）：
  1. `Origin` 必须缺失或为空，否则 `403`（挡浏览器页面；HTML 组件形态需走白名单，见 §10 风险）；
  2. `Host` 必须等于「客户端敲到的本机地址」（取自已连接 socket 的 `local_addr()`），
     否则 `403`（挡 DNS rebinding——tungstenite **自己不校验 Host**）；
  3. 握手成功**不等于进网**：必须 5 秒内发出**首帧令牌**，否则 `1008` 关闭。
- WS 参数显式收紧（库默认 64MiB/16MiB/写缓冲无上限，对本地接口是内存 DoS 面）：
  `max_message_size = max_frame_size = max_write_buffer_size = 256KiB`、`write_buffer_size = 16KiB`；
  未鉴权并发 ≤ 8、已鉴权并发 ≤ 4（两者都用 `Semaphore` 在 accept 前**强占槽位**，非事后计数）、
  未鉴权失败 5 次/分钟/IP 封 10 分钟、同一来源 IP 弹窗 ≤ 3 次/分钟（防轮换 clientId 刷弹窗）、
  控制面单请求 ≤ 64KiB、每连接下行 mpsc 容量 64（满即断，用 `try_send`）、
  30s 一次 ping、两次无 pong（60s）判半开并关闭。

### 4.2 首帧（令牌）

首帧是**不带 `method`** 的 JSON 对象，字段：

```jsonc
{ "v": 1, "clientId": "<客户端稳定 uuid>", "clientName": "<展示名>",
  "clientToken": "<rein_ext_…，可选>", "pairToken": "<可选，LAN 模式必填>" }
```

- `clientId`：客户端生成、稳定的 uuid，跨重连不变；`ext_clients.client_id` 的唯一键。
- `clientToken`：此前「始终允许」时签发的凭证；命中未撤销的 allow 行 → 直接以该行 scopes 放行，跳过弹窗。
- `pairToken`：安装级配对令牌，存 `app_meta` 键 `gateway.pairToken`，设置页显示；
  **LAN 模式必填且必须匹配**（这就是「LAN 必须带 token」）；Local 模式可省。
- 首帧校验失败 → 回错误帧并以 `1008` 关闭（见 §4.6 错误码）。

### 4.3 消息信封（版本字段 `v` 必带）

请求（客户端→服务端）：
```jsonc
{ "v": 1, "id": "<请求 uuid 字符串>", "method": "schedule.list", "params": { /* 见 §4.4 */ } }
```
响应（服务端→客户端，`id` 回填）：
```jsonc
{ "v": 1, "id": "<同请求>", "ok": true,  "result": <任意 JSON> }
{ "v": 1, "id": "<同请求>", "ok": false, "error": { "code": "forbidden_scope", "message": "…中文…" } }
```
事件（服务端→客户端，非应答，无 `id`）：
```jsonc
{ "v": 1, "event": "gateway.auth.granted", "data": { … } }
```

### 4.4 方法清单（28 条 = v1 15 条 + 第二轮 13 条）

> 第二轮新增的 13 条在 §13 给出完整参数/返回与副作用；下表同步登记，方法与 scope 的注册处是
> `src-tauri/src/modules/gateway/protocol.rs`（`Method::ALL`）与 `models.rs`（`Scope::ALL`）。

参数/返回字段一律 **camelCase**（与 IPC 一致，STANDARDS §2）。「映射」列是必须调用的现有函数。

**schedule（日程/待办，默认 scope 前缀 `schedule.`）**

| 方法字符串 | 参数（名:类型） | 返回 | 需要的 scope | 映射现有 Rust 函数 |
| --- | --- | --- | --- | --- |
| `schedule.list` | `startDate:string`, `endDate:string`（YYYY-MM-DD） | `TodoDto[]` | `schedule.read` | `list_todos`（todo/commands.rs:119） |
| `schedule.listAll` | 无 | `TodoDto[]` | `schedule.read` | `list_all_todos`（todo/commands.rs:140） |
| `schedule.create` | `title:string`, `notes?:string`, `date?:string`, `startMin?:int`, `durationMin?:int`, `category?:string`, `priority?:int` | `TodoDto` | `schedule.create` | `create_todo`（todo/commands.rs:247，其余参数取默认） |
| `schedule.update` | `todo:TodoInput`（见下） | `TodoDto` | `schedule.write` | `update_todo`（todo/commands.rs:296） |
| `schedule.delete` | `id:int` | `{}` | **`schedule.delete`**（第二轮由 `schedule.write` 拆出） | `delete_todo_on`（todo/commands.rs:504；重复待办：实例 id = 跳过这一次，带重复规则的 id = 整条删除） |
| `schedule.campus` | `semesterId?:int`, `from?:string`, `to?:string` | `ScheduleView` | `schedule.read` | `campus_schedule`（campus/commands.rs:1392）→ §13 |
| `schedule.programs` | 无 | `ProgramRecord[]` | `schedule.read` | `program_list`（program/commands.rs:43）→ §13 |
| `schedule.programActive` | 无 | `ProgramRecord ｜ null` | `schedule.read` | `program_get_active`（program/commands.rs:55）→ §13 |

`TodoInput` = `{ id:int, title:string, notes?:string|null, date?:string|null, startMin?:int|null, durationMin?:int|null, category:string, priority:int, status:string, completedAt?:string|null }`。
**注意**：`update_todo` 是**全量覆盖**（todo/commands.rs:296-329 用 `?13` 覆盖 attachments），
外部不带 `recRule/subtasks/attachments` 时这三列会被清空——v1 必须在 handler 层拒绝更新带附件的待办（§10）。

**workout（运动数据）**

| 方法字符串 | 参数 | 返回 | scope | 映射 |
| --- | --- | --- | --- | --- |
| `workout.plans` | 无 | `PlanDto[]` | `workout.read` | `list_workout_plans`（plan/commands.rs:65） |
| `workout.plan` | `id:string` | `PlanDto` | `workout.read` | `get_workout_plan`（plan/commands.rs:79） |
| `workout.list` | `startDate:string`, `endDate:string` | `WorkoutDto[]` | `workout.read` | `list_workouts`（exercise/commands.rs:13） |
| `workout.create` | `name:string`, `workoutType:string`, `date:string`, `startMin?:int`, `durationMin:float`, `intensity?:string`, `effort?:int`, `kcal:float`, `note?:string` | `WorkoutDto` | `workout.write` | `create_workout`（exercise/commands.rs:51） |
| `workout.strengthHistory` | `exerciseId:string` | `StrengthSetRecord[]` | `workout.read` | `strength_history`（session/commands.rs:293） |
| `workout.strengthExercises` | 无 | `StrengthExerciseRef[]` | `workout.read` | `strength_exercises`（session/commands.rs:335） |
| `workout.lastWeights` | `exerciseIds:string[]` | `StrengthLastWeight[]` | `workout.read` | `strength_last_weights`（session/commands.rs:364） |
| `workout.recentSets` | `days?:int`（默认 42，clamp 1..365） | `StrengthSetRecord[]` | `workout.read` | `strength_recent_sets`（session/commands.rs:400） |
| `workout.sessionActive` | 无 | `SessionLive ｜ null` | `workout.read` | `session_active`（session/commands.rs:119）→ §13/§14 |
| `workout.sessionStart` | `planId:string`, `planName:string`, `startedAt:string`, `state?:object` | `{accepted:true}` | `workout.write` | 下行事件 → `session_start`（session/commands.rs:73）→ §14 |
| `workout.sessionSnapshot` | `id:int`, `exIndex:int`, `setIndex:int`, `weightKg:float`, `state:object` | `{accepted:true}` | `workout.write` | 下行事件 → `session_snapshot`（session/commands.rs:97）→ §14 |
| `workout.sessionFinish` | `sessionFinish:SessionFinishInput`（§13） | `{accepted:true}` | `workout.write` | 下行事件 → `session_finish`（session/commands.rs:151）→ §14 |
| `workout.sessionAbort` | `id:int` | `{accepted:true}` | `workout.write` | 下行事件 → `session_abort`（session/commands.rs:223）→ §14 |
| `workout.delete` | `id:int` | `{}` | **`workout.delete`**（第二轮新增） | `delete_workout`（exercise/commands.rs:118），HC 传播照旧 → §13 |

**pomodoro（番茄钟）**

| 方法字符串 | 参数 | 返回 | scope | 映射 |
| --- | --- | --- | --- | --- |
| `pomodoro.list` | `startDate:string`, `endDate:string` | `PomodoroDto[]` | `pomodoro.read` | `list_pomodoro_sessions`（pomodoro/commands.rs:49） |
| `pomodoro.save` | `session:PomodoroInput`=`{ todoId?:int|null, startedAt:string, endedAt:string, focusMin:float, breakMin:float, completed:bool }` | `PomodoroDto` | `pomodoro.write` | `save_pomodoro_session`（pomodoro/commands.rs:25） |
| `pomodoro.status` | 无 | `FocusRuntime ｜ null` | `pomodoro.read` | 新建 `runtime::focus_state_on`（读 `app_meta`，§14） |
| `pomodoro.start` | `focusMin?:int`, `breakMin?:int`, `todoId?:int｜null` | `{accepted:true}` | `pomodoro.control` | 下行事件 → `pomodoroStore.start()` → §14 |
| `pomodoro.pause` | 无 | `{accepted:true}` | `pomodoro.control` | 下行事件 → `pomodoroStore.pause()` → §14 |
| `pomodoro.stop` | 无 | `{accepted:true}` | `pomodoro.control` | 下行事件 → `pomodoroStore.reset()` → §14 |

**对外 DTO（剥离前端专属列，与现有 model 的差异必须照此实现）**

- `TodoDto`：`{ id, title, notes, date, startMin, durationMin, category, priority, status, completedAt, source }`。
  `source: "campus" | "user"`（由 `category=='class'` 派生；课表派生行见 campus 物化）。**剥离**：
  `attachments`（含 data URL，体积/内容泄漏）、`recRule/recKey`、`subtasks`、`courseSessionId`、`createdAt`。
- `WorkoutDto` = 直接复用 `Workout`（exercise/models.rs:7，字段干净）。
- `PlanDto` = 直接复用 `PlanRecord`（plan/models.rs:8）。
- `StrengthSetRecord` / `StrengthExerciseRef` / `StrengthLastWeight` = 直接复用（session/models.rs:65/87/99）。
- `PomodoroDto` = 直接复用 `PomodoroSession`（pomodoro/models.rs:7，扁平）。
- **不复用** `SessionRecord`（session/models.rs:8）：其 `state: Value`（:26）是前端状态机落盘快照，对外无意义。

### 4.5 Tauri 侧必须新增的命令名与前端要监听的字符串

**6 条 tauri command（管理面）**——必须三处同步：`lib.rs` 的 `generate_handler!`（`lib.rs:73`）、
`src/services/gatewayService.ts` 的 `invoke`、`src/mock/server.ts` 顶层 4 空格 `case`，否则
`scripts/check-ipc-contract.mjs`（:52-73）红着退出。

| 命令字符串 | 参数 | 返回 |
| --- | --- | --- |
| `gateway_status` | 无 | `GatewayStatus` |
| `gateway_set_enabled` | `enabled:bool` | `GatewayStatus` |
| `gateway_set_bind` | `bindMode:"local"｜"lan"`, `port:int｜null` | `GatewayStatus` |
| `gateway_set_enabled_modules` | `ids:string[]`（**整表替换**：已启用的功能模块 id） | `string[]`（清洗后的落库值，见 §4.7） |
| `gateway_authorization_pending` | 无 | `GatewayAuthRequest[]`（冷启动补漏） |
| `gateway_authorization_respond` | `requestId:string`, `decision:"allow-session"｜"allow-always"｜"ignore"｜"deny"`, `scopes:string[]` | `{}` |
| `gateway_revoke_client` | `clientId:string` | `GatewayStatus` |

**2 个 Tauri→前端事件（前端照抄字符串）**：

- `gateway://authorization-required`，负载 `GatewayAuthRequest`。
- `gateway://authorization-changed`，负载 `GatewayStatus`。

**3 个 WS→外部客户端事件**：`gateway.auth.pending`（`{requestId,timeoutMs}`）、
`gateway.auth.granted`（`{grant:"session"｜"always", clientToken?:string, scopes:string[]}`；
`clientToken` 仅在 `always` 时出现一次）、`gateway.auth.denied`（`{reason:string}`）。

**第 4 个 WS→外部客户端事件（变更推送，本层补齐的冻结面）**：`gateway.change`，
载荷 = `ChangeEvent = { seq:int, kind:string, uuid:string, deleted:bool, at:int }`
（`seq` 是 `sync_log.seq`）。**约定**：连接一旦鉴权成功即**自动订阅**全部变更（无 `subscribe` 方法）；
订阅者追不上（服务端广播 `Lagged`）时应自行**全量重查**，服务端不补齐。契约此前的 §4.4/§4.5 只冻结了
3 条 auth 事件，此处把这条实现补齐的约定正式写入。

**第二轮新增的 Tauri 命令与事件（前端照抄字符串，§14/§17）**：
命令 `focus_publish`、`focus_unpublish`（前端→后端运行态上报/清除，1 秒一次）、
`gateway_audit_recent`（设置页读最近审计）；
Tauri→前端事件 `gateway://pomodoro-command`（`{action, args}`）、`gateway://session-command`（`{action, args}`）——
外部控制经此落到前端 store 执行，对外方法只回 `{accepted:true}` 受理回执。
三条命令同样要三处同步（`lib.rs` / `gatewayService.ts` / `mock/server.ts`）。
**`Origin` 白名单变更不动本节的这三道门**：见 §15。

**前端类型（新建 `src/types/externalAccess.ts`）**：
`GatewayAuthRequest = { requestId, clientId, clientName, origin, ip:string|null, scopes:string[], createdAt, timeoutMs }`
（`ip` = 服务端从 socket 取的来源 IP，请求方无法伪造；`origin` = 握手时带的来源，无 `Origin` 的原生客户端为 null，带 `Origin` 的必须先命中 §15 的白名单才会走到待决流程）；
`GatewayClient = { clientId, name, grant:"session"｜"always", scopes:string[], lastSeen:string|null, online:bool, ip:string|null }`；
`GatewayBlocked = { clientId, name, reason:"deny"｜"revoked"｜"ignore", lastSeen:string|null, ip:string|null }`；
`GatewayStatus = { enabled:bool, bindMode:"local"｜"lan", port:number|null, pairToken:string|null, pendingCount:number, clients:GatewayClient[], blocked:GatewayBlocked[] }`
（`blocked` = 被拒绝 / 已撤销 / 连续忽略进入静默的客户端，设置页可**解除**——`gateway_revoke_client`
对 deny/ignore 行删行；对 allow 行首次置撤销位、**对已置撤销位的行再调一次则删行**，
好让「已撤销」不永远滞留在「被拦下」清单里）。
（`pairToken` = 安装级配对令牌，LAN 模式必填，仅本机设置页显示，用户可复制给外部客户端）。

### 4.6 错误码表（响应 `error.code`）

| code | WS 关闭/语义 | 触发 |
| --- | --- | --- |
| `unsupported_version` | 400 | `v != 1` |
| `bad_request` | — | 信封/参数字段缺失或类型错 |
| `unauthorized` | 1008 | 首帧缺失/令牌不符/LAN 缺 `pairToken` |
| `forbidden_scope` | — | 令牌有效但未授本次 `method` 所需 scope |
| `module_disabled` | — | 该方法所属的**功能模块**被用户在界面上关掉了（§4.7）—— 不是权限问题 |
| `pending_authorization` | — | 授权请求已发出、用户未决（调用方应等待） |
| `denied` | 1008 | 用户选「拒绝」或该 client 为 `deny` |
| `not_found` | — | 目标 id 不存在（如 `workout.plan`） |
| `timeout` | — | 查询预算超时（§6.4） |
| `busy` | — | 鉴权并发超限或锁竞争放弃 |
| `payload_too_large` | 1009 | 帧或消息超 256KiB |
| `internal` | — | 其余（`ReinError::Message` 的 `code()` 即 `internal`，error.rs:31-39） |

### 4.7 功能模块门禁（`module_disabled`）

用户能在「设置 › 打开或关闭功能」里关掉功能模块（`src/plugins/builtin/*`）。**关掉的不只是界面**：
对外方法里凡属于该模块的一律回 `module_disabled`，与界面入口、路由、AI 工具组一起关。

| 模块（插件 id） | 对外方法 | 条数 |
| --- | --- | --- |
| （内核：待办，不可关） | `schedule.list` / `listAll` / `create` / `update` / `delete` | 5 |
| `campus`（课表） | `schedule.campus` | 1 |
| `program`（健康方案） | `schedule.programs` / `schedule.programActive` | 2 |
| `sports`（运动） | `workout.*` 全部（课程 / 动作 / 曲线 / 会话 / 跑步 / 删除） | 14 |
| `focus`（专注） | `pomodoro.*` 全部（含 `start` / `pause` / `stop` 下行控制） | 6 |

判据落在 `protocol.rs::Method::plugin()`（**逐个方法**给归属，`schedule.*` 不是一个模块：它下面混着
待办、课表与健康方案三处数据），执行点在 `server.rs::handle_request` —— 短锁内、**scope 校验之前**
调 `store::module_gate`，所以客户端即便拿着全部 scope 也会被拒（记 `denied` 审计）。

- **快照谁给**：前端是唯一作者。`App.vue` 把「已启用模块 id」经 `gateway_set_enabled_modules`
  推给 Rust，落 `app_meta:gateway.enabledModules`（启动一次 + 每次拨动，与抢课的
  `campus_grab_set_enabled` 同一条纪律）。**用户关掉一个模块，其对外接口跟着关** ——
  否则外部程序仍能驱动一个界面上已经不显示的功能（`pomodoro.start` 足以启一个看不见的计时器）。
- **缺快照 = 全部放行**（`store::is_module_enabled` 的 fail-open，刻意）：快照由前端启动时推，
  而网关只可能从前端打开，真机上不存在「服务在跑但快照没推」的稳态；反过来 fail-closed 会把
  一次漏推放大成「对外接口整体不可用」。**空表才算全关**（两者在 `app_meta` 里分得清）。
- **不是安全边界**：安全边界仍是首帧令牌 + 逐次 scope + 用户授权；这道门禁是一致性闸门，
  所以它排在 scope 之前、且**不断连**（开关随时会拨回来，断连只会逼客户端重连再走一次授权）。
- **对客户端的含义**：这是唯一一个「昨天能调、今天不行、而你什么都没改」的错误码。收到它就
  提示用户去「设置 › 打开或关闭功能」把对应模块打开（错误文案里带了方法与去处），别当权限问题排障。

---

## 5. 授权与权限模型

### 5.1 四态状态机（逐条：状态/触发/存储/失效）

| 状态 | 触发 | 存储位置 | 失效条件 |
| --- | --- | --- | --- |
| `pending`（无记录） | 新客户端首帧无有效 `clientToken` | 内存 ExtHub（挂起请求队列） | 用户决策或超时（`timeoutMs`） |
| **允许本次会话** `allow-session` | 弹窗点「允许本次会话」 | 内存 `session.rs`：`conn_id → ConnGrant` | **连接关闭即清除**（结构性，不靠超时猜） |
| **始终允许** `allow-always` | 弹窗点「始终允许」 | `ext_clients.decision='allow'` + `scopes` + `token_hash` | `revoked_at` 置位 / 改窄 scopes / `gateway_revoke_client` |
| **忽略** `ignore` | 弹窗点「忽略」 | 不落决策；更新 `last_prompt_at`/`prompt_count` | 保持 `pending`；30s 内同类请求静默；连续 3 次静默挂起 |
| **拒绝** `deny` | 弹窗点「拒绝」 | `ext_clients.decision='deny'` | 设置页删除该行 → 回到无记录 |

- 会话态与连接**结构性绑定**：`conn_id` 由服务端在 accept 时生成，外部无法自报（自报即可伪造重连）。
  这是硬要求 1「链接中断即会话结束」唯一可靠的实现方式。
- `session grant` 可随时升级为 `always`；`deny` 行可由设置页解除；`allow` 行可撤销/收窄。
- **第二轮定稿**（完整规则见 §16）：授权超时 **60 秒**（`auth.rs` 的 `AUTH_PENDING_TIMEOUT_MS` 由 `30_000` 改 `60_000`），
  **以后端计时为准**，前端只显示倒计时；「允许本次会话」**不加任何宽限窗口**（用户硬性要求）；
  忽略/拒绝的静默与限频、以及超时/忽略计入按 IP 失败限频，均以 §16 为准。

### 5.2 token 格式与存储

- 生成：32 字节 `OsRng`（`rand = "0.8"`，Cargo.toml:47）→ base64url，前缀 `rein_ext_`。
- 库里**只存** `sha256(token)` 的 hex（`sha2 = "0.10"`，Cargo.toml:70）；明文只在用户批准那一刻回写一次，此后绝不复述。
- 比较：**恒定时间**，用 XOR 折叠（照抄 `src-tauri/src/modules/sync/crypto.rs` 的 `hello_mac_ok` 写法），
  绝不用 SQL 相等做密码学比较（SQL 查询本身不是恒定时间）。
- 撤销 = 置 `revoked_at`（或删行）+ 清该 client 全部 session grant；下次调用即 `unauthorized`。
- 沿用仓库既有纪律：密钥「只回末 4 位」（ARCHITECTURE §14）、sha256 摘要入库（`server/src/ai.mjs:11`）。

### 5.3 scope 定义与校验点

- 字符串（**10 条**）：`schedule.read` `schedule.create` `schedule.write` `schedule.delete`
  `workout.read` `workout.write` `workout.delete` `pomodoro.read` `pomodoro.write` `pomodoro.control`。
  `Scope` Rust 枚举的**唯一定义处**是 `src-tauri/src/modules/gateway/models.rs`（`Scope::ALL: [Scope; 10]` —
  第二轮由 7 条扩到 10 条）；前端与 mock 只消费同名串。
  第二轮新增 3 条：`schedule.delete`（删待办）、`workout.delete`（删运动记录）、`pomodoro.control`（控制运行态番茄钟）。
- 解析一律**精确匹配**（枚举集合 `find`），绝不用前缀/通配——杜绝 `schedule.read` 命中未来的 `schedule.read_secret`。
- **默认最小集 = 仅 `schedule.read`**（对应「小组件显示今天日程」）；任何写入 scope 默认**不勾**，
  必须用户在配对时逐项显式勾选；scope 与 client 绑定（不是全局开关）。
- **校验点**：每个入站 WS 调用在进入业务逻辑之前 `gateway::auth::require(conn, hub, conn_id, need)`；
  每次查 DB 校验、**不缓存**（缓存即撤销延迟生效）。handler 里必须先 `require` 再 `state.db.lock()`。
  （`require` 的唯一定义处是 `src-tauri/src/modules/gateway/auth.rs`；此处旧稿误写的 `scope::require`
  与 `scope.rs` 均不存在。）

### 5.4 审计字段（`ext_audit`，只落库）

`at`（ISO-8601）、`client_id`、`method`、`scope`、`decision`（`allowed｜denied｜error`）、`detail`、`ip`、
`duration_ms`。刻意**不设外键**（删客户端不带走历史，先例见 `db.rs:1158-1166` campus_ai_actions 的设计说明）。

---

## 6. 数据与同步纪律

### 6.1 单连接铁律（证据）

`state.rs:39` 定义 `Db(Mutex<Connection>)`，`state.rs:47` 是唯一取锁入口，`STANDARDS.md:10` 强制「连接一律走
`state::Db::lock()`」。网关**禁止**自己 `Connection::open`：钩子按连接注册，新连接若忘了装钩子，其写入永不入队。
`ARCHITECTURE.md:248`「单窗口单连接」；`ARCHITECTURE.md:296` 铁律 1「慢网络与 DB 锁不许同时持有」。
落地需要在 `Cargo.toml:49` 的 tokio features 追加 `"net"`（`mio`/`socket2` 已在依赖图，显式声明零成本）。

### 6.2 变更广播的落点（关键结论）

- **撕裂风险**：rusqlite/SQLite 的 `update_hook` 是**单槽**的——每连接只保留一个钩子，再次注册会**静默替换并释放**上一个
  （`rusqlite` 的 `Connection::update_hook` → `sqlite3_update_hook`，后者挂在 `sqlite3*` 句柄上）。
  **所以网关绝对不能自己装第二个钩子**，否则会顶掉同步捕获钩子且毫无报错。
- **必须复用同步已装的那个**：`install_hook`（`engine.rs:127-147`）在 `lib.rs:27` 装配，无条件执行；
  捕获线程 `SyncHub::start`（`lib.rs:68-69`，`engine.rs:492`）也无条件启动、`running` 初始为 `true`
  （`engine.rs:488`）、`loop_forever` 每 500ms `dirty.drain(500)`（`engine.rs:509`）。**故「没配置同步」时钩子照样在、捕获照样跑。**
- **具体落点函数**：把 `SyncHub::capture_batch`（`engine.rs:522`）与 `SyncHub::flush`（`engine.rs:534`）
  收归一个私有 helper：helper 在**持锁时**调 `capture` 收集事件、返回后由调用方在**锁外** `feed.publish(ev)`。
  `backfill`（`engine.rs:396`）复用 `capture` 但**显式不广播**（否则首启刷屏）。**广播必须在锁外**：
  `update_hook` 回调在 SQLite 语句执行中同步触发，禁止重入连接（`engine.rs:9`）。
- 为解决「内容未变也返回 `Some(uuid)`」（`engine.rs:363-374`）的假事件，`capture` 返回值三态化为
  `CaptureOutcome::{Unchanged, Changed{ uuid, kind, seq, deleted }}`，`append_log`（`engine.rs:160`）
  返回 `sync_log.seq`（`Result<i64>`）。事件 `ChangeEvent = { seq:i64, kind:String, uuid:String, deleted:bool, at:i64 }`。
- 广播原语：`tokio::sync::broadcast` 容量 256，封成 `ChangeFeed`；订阅者遇 `Lagged(n)` 一律全量重查，不试图补齐。
- **`flush` 路径的 `publish` 允许在调用方（`sync_run`）持锁期间发生**（与「广播必须在锁外」的字面表述的偏差，
  已认账）：`broadcast::Sender::send` 是非阻塞的，只碰自己的内部锁，不重入 SQLite 连接、不反向获取 `state` 锁，
  故不会形成死锁，也不触发本节真正担心的「钩子回调里重入连接」。真正危险的是在 `update_hook` 回调内 publish。

### 6.3 写事务与并发

- 一次对外写 = **一次取锁 + 一个事务**：`with_write_tx` 取锁后用 `transaction_with_behavior(Immediate)`；
  事务闭包内**禁止**再次 `db.lock()`（std Mutex 非重入，必死锁），只传 `&Connection`。
  （先例：`program/commands.rs` 的 `BEGIN`/`COMMIT`/`ROLLBACK`、`session/commands.rs:155-156` 的 `transaction()`。）
- 授权弹窗与所有网络往返必须**落在锁外**：handler 走「短锁读 → 无锁等待裁决/写 socket → 短锁写」三段式。
- `session_finish` 内部用可变事务：抽 `*_on` 时让其收 `&mut Connection`，命令体用 `let mut conn = state.db.lock();`。

### 6.4 查询预算

- 对外只暴露白名单类型化操作，不收原始 SQL。
- 强制时间窗 + 每页 `LIMIT` + 结果总行数上限，禁止无界全表（列表类默认 limit 100、上限 500）。
  **落地口径**：对外列表方法走各域新增的 `*_on_limited` 变体（`schedule.list/listAll`、`workout.list`、
  `pomodoro.list` 在 **SQL 侧**带 `LIMIT 500`），网关层再用 `cap_rows` 做一次 Rust 侧兜底；
  前端 tauri 命令仍用无 LIMIT 的本体（时间线要全量），两条路径分开。
  `workout.strengthHistory/strengthExercises/lastWeights/recentSets` 是「按动作/天数」的小结果集，未加 LIMIT。
- 每次执行外部查询时在同一把锁内设 `conn.progress_handler(N, deadline)`（本仓 `QUERY_BUDGET_MS = 2000`），
  超预算即中断并返回 `timeout`（rusqlite 0.32 现成 API）。

### 6.5 新增表（MIGRATION_0042，追加到 `db.rs:1474` MIGRATION_0041 之后，永不改历史条目）

```sql
CREATE TABLE ext_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT,                          -- sha256(token) hex；NULL 直到「始终允许」签发
  scopes TEXT NOT NULL DEFAULT '[]',        -- JSON 数组，如 ["schedule.read","workout.read"]
  decision TEXT NOT NULL,                   -- allow | deny
  last_ip TEXT, last_seen_at TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, updated_at TEXT NOT NULL, revoked_at TEXT,
  last_prompt_at TEXT, prompt_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ext_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, client_id TEXT,         -- 无外键：删客户端不带走历史
  method TEXT NOT NULL, scope TEXT NOT NULL,
  decision TEXT NOT NULL,                   -- allowed | denied | error
  detail TEXT, ip TEXT, duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ext_audit_at ON ext_audit(at DESC);
-- 第二轮增补（MIGRATION_0043）；历史条目 0042 不改
CREATE INDEX idx_ext_audit_client ON ext_audit(client_id, at DESC);
```

> `ext_audit.detail` 从第二轮起**承载请求参数摘要**（JSON 文本：按 scope 白名单挑字段、逐字段截断长度，
> 见 §17「审计参数」）。`origins`（§15 的 Origin 白名单）存 `app_meta` 键 `gateway.allowedOrigins`，**不建表列**。

- `ext_clients` / `ext_audit` **不进** `sync/tables.rs` 白名单（`tables.rs:1-2,87`）：凭据复制到第二台设备是安全决定，
  不该被同步默认替用户做（先例：`campus_accounts`、`ai_models.api_key` 均按此处理）。
- `enabled` / `bindMode` / `port` / `gateway.pairToken` 走 `app_meta` 键（`db.rs:1479-1497` 的 `meta_get`/`meta_set`/`meta_del`；
  `db.rs:1318-1319` 说明 app_meta 不参与多设备同步）。**运行态只写 app_meta，绝不写业务表**（写业务表会产生脏记录并被广播）。

---

## 7. 威胁模型与安全清单

| 攻击者 | 威胁 | 对策 |
| --- | --- | --- |
| **任意网页**（用户在浏览器打开恶意页） | 页面用 WebSocket 连 `127.0.0.1` 偷数据 | ① 握手拒一切带 `Origin` 的连接；② LAN 缺 `pairToken` 即拒；③ 首帧令牌是真正门槛，网页拿不到令牌；④ 每次调用逐次 scope 校验 |
| **同机其他进程**（同用户身份） | 连本机端口、或直接读 `rein.db` 拿令牌 | 令牌防不住同用户进程（它能直接读库，`identity.rs` 私钥也是明文落库的既有先例）——此为**已知限制**；对策是 OS 级隔离与最小授权（默认只读 `schedule.read`），非本接口能解决 |
| **同网段设备**（公共 WiFi/访客网） | 扫端口连入、发请求 | ① 默认「仅本机」不监听外网；② LAN 强制 `pairToken`；③ Host 白名单挡 DNS rebinding；④ 未鉴权并发≤8、失败限频封 IP；⑤ 界面明确风险提示（§11） |
| **用户离开电脑时** | 旁人点开弹窗随手「始终允许」 | ① 默认 scope 最小集（仅 `schedule.read`）；② 写入项需逐项勾选；③ 审计落库可事后追溯；④ 授权弹窗须前台可见（不做静默通过） |

---

## 8. 前端接入面

### 8.1 组件与文件

- 弹窗：新建 `src/components/settings/GatewayAuthSheet.vue`，用 `src/components/common/SheetModal.vue` 作壳
  （title「外部程序请求访问」）；body 顶部一行「谁在请求」（`clientName` + `origin`），下面逐条渲染 scopes 清单行；
  footer 放四个语义独立的按钮。挂到 `src/App.vue:260-276` 的全局常驻层（与 `VoiceSessionView`/`UpdatePrompt` 并列）。
- 单例状态机：新建 `src/system/externalAccessRuntime.ts`，在 `src/main.ts` 启动调用 `init()`
  （幂等，仿 `src/system/shareInbox.ts:24-34`「启动 poll 一次 + 收事件再 poll」），冷启动必须拉一次 `gateway_authorization_pending`。
- 设置页：`src/pages/SettingsPage.vue` 追加一张「外部访问」卡（`gtitle` + `frow` 入口，仿 `:162-168` 的多设备同步卡），
  **内嵌** `src/components/settings/ExternalAccessSection.vue`（开关 `ToggleSwitch`、绑定模式 `SegmentedControl`、
  客户端列表 `EmptyState` + 逐行「名称/权限摘要/最后活跃/撤销」，仿 `src/pages/SyncPage.vue` 的已配对设备列表）。
  > 历史计划里写的独立页 `src/pages/ExternalAccessPage.vue` 与 `/settings/external` 路由**已取消**，
  > 整块内嵌为上述分区（与 §3 文件表、§9.4 实际落地一致）；此处正文为历史计划，以代码为准。
- 服务：新建 `src/services/gatewayService.ts`，命令封装照抄 `src/services/pomodoroService.ts` 的对象字面量写法；
  事件桥照抄 `src/services/voiceService.ts:36-40` / `src/services/agentService.ts:23-33`（isTauri→`listen`，否则挂 mock 钩子）。

### 8.2 授权交互流程

1. 外部程序连接 → 服务端发 `gateway://authorization-required` → runtime 入队并开弹窗。
2. 用户四选一 → runtime 调 `gateway_authorization_respond(requestId, decision, scopes)`。
3. 「始终允许」→ 服务端回 `gateway.auth.granted`（带 `clientToken` 一次）→ 写入列表。
4. 「拒绝」→ 服务端回 `gateway.auth.denied` 并 `1008` 关连 → 记 `deny`。
5. 「忽略」→ 无回复、连接维持 `pending`；30s 限频。
6. 冷启动丢事件由 `gateway_authorization_pending` 兜底。

### 8.3 testid 命名族

入口 `settings-external-access`；弹窗 `gateway-auth-sheet`、四按钮 `gateway-auth-allow-session` /
`gateway-auth-allow-always` / `gateway-auth-ignore` / `gateway-auth-deny`、权限行 `gateway-auth-scope-<id>`；
设置页 `gateway-toggle-enabled`、`gateway-bind-mode`、客户端行 `gateway-client-<id>`、`gateway-client-revoke-<id>`。
（沿用 `SettingsPage.vue:200` `settings-data-clear` 的 kebab-case 域前缀命名法。）

---

## 9. 落地计划

### 9.1 存储层（Rust 域命令下沉 + 迁移 + 捕获三态化）

- [ ] `db.rs` 追加 `MIGRATION_0042`（§6.5），最后一项登记进 `MIGRATIONS`（`db.rs:1433-1475`）。
- [ ] `todo/commands.rs`：`list_todos`(:119)/`list_all_todos`(:140)/`create_todo`(:247)/`update_todo`(:296)/`delete_todo`(:330)
      下沉为 `pub(crate) fn *_on(&Connection, …)`，原命令退化为 `state.db.lock()` + 调 `*_on`。
- [ ] `exercise/commands.rs`：`list_workouts`(:13)/`create_workout`(:51) 下沉（`delete_workout` 不动）。
- [ ] `plan/commands.rs`：`list_workout_plans`(:65) 下沉；`get_workout_plan`(:79) 只拆锁，转调已有 `plan_by_id`。
- [ ] `pomodoro/commands.rs`：`save_pomodoro_session`(:25)/`list_pomodoro_sessions`(:49) 下沉。
- [ ] `session/commands.rs`：`strength_history`(:293)/`strength_exercises`(:335)/`strength_last_weights`(:364)/`strength_recent_sets`(:400) 下沉。
- [ ] `sync/engine.rs`：`capture` 三态化、`append_log` 返 `seq`、`capture_batch`(:522)/`flush`(:534) 改为「锁内收集、锁外 publish」。
- **验收**：`cargo check` 通过；为 `*_on` 各写一个在内存库上的单测（命令行为不变）。
  实际落地：`todo` / `exercise` / `pomodoro` 已有 `*_on_limited` 的 LIMIT 单测；`plan` / `session` 的 `*_on` 未补单测。
  `cargo clippy -- -D warnings` 仍红（17 处，全在网关之外的历史文件），本项未达标。

### 9.2 协议与域绑定（网关骨架 + server）

- [x] `Cargo.toml:49` 追加 `"net"`；`modules/mod.rs` 加 `pub mod gateway;`。
- [x] 新建 `gateway/{mod,server,protocol,methods,auth,models}.rs`（原计划的 `router/dto/handlers/{todo,workout,pomodoro}`
      已合并进 `protocol`（信封+方法注册表）/ `methods`（域绑定））。
- [x] `protocol.rs` 的 `Method` 注册表（§4.4 的 15 条），`server.rs` 的握手闸门 + 首帧令牌 + 限流 + `watch` 关停。
- **验收**：`cargo check` 通过；一个不连 UI 的单测：起 server → 直连 → 错令牌应 `1008`，对令牌应拿到方法结果。
  实际：`cargo check` 通过；**该 server 集成单测未写**（需要 tauri `AppHandle`/`State` 测试夹具，当前 `cargo test` 无一条经过 `handle_connection`）。

### 9.3 服务与授权（auth/store + 管理命令）

- [x] `gateway/models.rs`：`Scope` 枚举唯一定义处 + 精确匹配 `parse`；`gateway/auth.rs`：`require(...)` 强制点。
- [x] `gateway/store.rs`：`rein_ext_` 令牌生成、sha256 hex 入库、XOR 折叠恒定时间比较（`find_by_token` 只按
      decision/revoked 取候选、比较在 Rust 侧做，不靠 SQL 相等）。
- [x] `gateway/auth.rs`：`conn_id → ConnGrant` 内存表，连接关闭即清除；待决队列；按 client/IP 限流。
- [x] `gateway/store.rs`：ext_clients / ext_audit 读写 + `app_meta` 键（`gateway.pairToken`/`enabled`/`bindMode`/`port`）。
- [x] `gateway/mod.rs`：`ChangeFeed`（broadcast 256）`subscribe/publish`；接 §6.2 的广播落点。
- [x] `gateway/commands.rs`：§4.5 的 6 条管理命令；`lib.rs` manage `GatewayHub`、启动 server、注册进 `generate_handler!`。
- **验收**：`npm run contract` 三处数量相等且一致；单测覆盖四态转移、撤销后 `unauthorized`、scope 精确匹配拒绝前缀。
  实际：`node scripts/check-ipc-contract.mjs` → 273/273/273 一致；四态/撤销/scope 精确匹配均有单测；
  「无 `clientToken` 的新客户端进入 `pending`」的 **authorize 首帧路径单测未写**（现有测试是手工 `hub.begin_pending`）。

### 9.4 前端（类型/服务/弹窗/设置页/mock/e2e）

- [x] 新建 `src/types/externalAccess.ts` + `src/types/index.ts` 加 barrel 行。
- [x] 新建 `src/services/gatewayService.ts`、`src/system/externalAccessRuntime.ts`、`src/components/settings/GatewayAuthSheet.vue`。
- [x] 改 `src/App.vue`、`src/main.ts`、`src/pages/SettingsPage.vue`；**取消**独立页 `ExternalAccessPage.vue` 与
      `/settings/external` 路由，整块内嵌为 `src/components/settings/ExternalAccessSection.vue`。
- [x] `src/mock/server.ts` 补 6 条顶层 case + `mockGateway` 事件钩子 + e2e 触发入口；e2e 脚本实际名为 `scripts/e2e-external-api.mjs`。
- **验收**：`npm run lint && npm run typecheck && npm run build` 通过；`node scripts/e2e-external-api.mjs` 通过；
  `npm run contract` 一致。
  实际：`vue-tsc` 与 `eslint`（改动文件）通过、`contract` 一致；**`npm run build` 与 e2e 未跑**
  （e2e 需真机 App + WebView2 调试端口，环境不具备）。

### 9.5 依赖顺序

存储层 → 协议与域绑定（依赖 `*_on`）→ 服务与授权（依赖 server/router 骨架）→ 前端（依赖管理命令名与事件名冻结）。
接口层（§4 方法名/事件名/命令名）在动手前冻结，前端与服务层可并行。

---

## 10. 未决问题与风险（需人拍板）

**需拍板**
1. 小组件是**原生**（WPF/.NET/Node ws）还是 **HTML**（WebView2/Electron/file://）？HTML 会带 `Origin`，默认「全拒」会让它不可用，需 `allowedOrigins` 白名单。
2. 「忽略」是否持久化？现设计为不落决策、仅限频（30s/连续 3 次静默挂起），阈值待确认。
3. LAN 是否需要端到端加密？本轮**不做**（§11 已知限制）。
4. `schedule.update` 全量覆盖会清空 attachments/subtasks/recRule——是否接受「拒绝更新带附件待办」，或改为服务端保留原值。
5. 外部读运行态用推送还是轮询？（本轮番茄钟不做运行态，此项仅影响 v2）。
6. 对外中控是否允许「开始一场全新训练/番茄」，还是只允许调整进行中的（涉及二级确认）。

**风险**
- **capability 是假闸门**：自定义命令不受 `capabilities/default.json:4` 约束，鉴权只在每个入站 handler 的代码里；漏一处 = 全量泄露。必须把 `scope::require` 做成唯一入口，并加机械断言。
- **钩子单槽**：网关自装第二个 `update_hook` 会静默顶掉同步捕获（§6.2），表现为「本机还在改、别的设备再也不见」。
- **全库单锁**：外部慢查询会冻死 UI（§6.4 靠 progress_handler 兜底）；`sync_run` 持锁跑网络的既有反例（`sync/commands.rs:269-273`）不可照抄。
- **事务回滚留墓碑**：`engine.rs:344-354` 的 `d` 分支只改 `sync_objects`、不辨业务行是否还在；外部写入提高「删了又回滚」频率会放大此隐患。
- **LAN 防火墙**：仓库无任何防火墙引导；Windows 首次绑定会弹授权，用户取消则 LAN 静默失效（客户端只表现为超时）。
- **令牌不防同用户进程**：见 §7。

---

## 11. 本轮范围声明

- **局域网模式**：只做「绑定 `0.0.0.0` + 必须带 `pairToken` + 界面明确风险提示」，**不额外做端到端加密**，作为本轮已知限制。
- **番茄钟**：只暴露已落盘的会话数据（`pomodoro.list`/`pomodoro.save`）；**计时器运行态上报本轮不做**
  （计时态只在前端 Pinia store：`src/stores/pomodoro.ts`；后端仅 `save`/`list`，pomodoro/commands.rs:25,49）。
  —— 第二轮已把运行态上报补上（`pomodoro.status` 经 `app_meta:runtime.focus.v1`，见 §14.1）；此处保留第一轮的范围记录。
- **审计**：只落库（`ext_audit`），查看界面留到后续；本轮 `SettingsPage` 不建审计页。
- **不扩展**：不做 HTTP/REST、不做原始 SQL、不在 Android 启用、不做训练课运行态控制、不做 `delete_workout`。

---

## 12. 引用清单

正文引用的现存文件（本文写作时已真实存在）：

本章列的是正文引用到的现存文件。**机器可校验清单在本文档末尾**（那一段 check-refs 注释块），
格式与位置由校验脚本约定；本轮新增章节（§13–§17）引用的现存文件已并入该清单。

---

## 13. 第二轮范围扩展：新增方法与权限

> 本章是第二轮（用户已拍板范围）的**增量契约**。方法/scope 的注册处：
> `src-tauri/src/modules/gateway/protocol.rs` 的 `Method::ALL`（现 `[Method; 15]` → `[Method; 28]`）、
> `src-tauri/src/modules/gateway/models.rs` 的 `Scope::ALL`（现 `[Scope; 7]` → `[Scope; 10]`）。
> 两处枚举与 `as_str` / `parse` 同步改，既有单测（models.rs:409-454、protocol.rs:320-345）同步扩容。

### 13.1 新增 scope（3 条）

| scope 字符串 | 覆盖方法 | 拆分理由 |
| --- | --- | --- |
| `schedule.delete` | `schedule.delete` | 从 `schedule.write` 拆出：有写权 ≠ 有删权（用户要求「scope 增加删除权限」） |
| `workout.delete` | `workout.delete` | 删除运动记录（含 Health Connect 传播），风险独立 |
| `pomodoro.control` | `pomodoro.start/pause/stop` | 控制**运行中**的番茄钟，与「写已落盘会话记录」的 `pomodoro.write` 分离 |

`schedule.read` / `schedule.create` / `schedule.write` / `workout.read` / `workout.write` / `pomodoro.read` / `pomodoro.write`
保持原义（`workout.*` 运动数据、`schedule.*` 日程域＝待办＋课表＋训练方案）。仍**精确匹配**，无前缀通配。

### 13.2 新增方法（13 条）

日程域（scope 见行内；`ScheduleView` = campus/models.rs:661，`ProgramRecord` = program/models.rs:9）：

| 方法字符串 | 参数 | 返回 | scope | 映射现有 Rust 函数 |
| --- | --- | --- | --- | --- |
| `schedule.campus` | `semesterId?:int`, `from?:string`, `to?:string`（YYYY-MM-DD） | `ScheduleView` | `schedule.read` | `campus_schedule`（campus/commands.rs:1392） |
| `schedule.programs` | 无 | `ProgramRecord[]` | `schedule.read` | `program_list`（program/commands.rs:43） |
| `schedule.programActive` | 无 | `ProgramRecord ｜ null` | `schedule.read` | `program_get_active`（program/commands.rs:55） |

运动域（事件级写入走 §14.3 下行通道，对外只回受理回执）：

| 方法字符串 | 参数 | 返回 | scope | 映射 |
| --- | --- | --- | --- | --- |
| `workout.sessionActive` | 无 | `SessionLive ｜ null` | `workout.read` | 抽 `session_active_on`（session/commands.rs:119）＋补时投影（§14.2） |
| `workout.sessionStart` | `planId:string`, `planName:string`, `startedAt:string`, `state?:object` | `{accepted:true}` | `workout.write` | 下行 `start` → `session_start`（session/commands.rs:73） |
| `workout.sessionSnapshot` | `id:int`, `exIndex:int`, `setIndex:int`, `weightKg:float`, `state:object` | `{accepted:true}` | `workout.write` | 下行 `snapshot` → `session_snapshot`（session/commands.rs:97） |
| `workout.sessionFinish` | `sessionFinish:SessionFinishInput` | `{accepted:true}` | `workout.write` | 下行 `finish` → `session_finish`（session/commands.rs:151） |
| `workout.sessionAbort` | `id:int` | `{accepted:true}` | `workout.write` | 下行 `abort` → `session_abort`（session/commands.rs:223） |
| `workout.delete` | `id:int` | `{}` | `workout.delete` | `delete_workout`（exercise/commands.rs:118，§13.3） |

`SessionFinishInput` = `{ id:int, name:string, workoutType:string, date:string, durationMin:float, intensity?:string, kcal:float, note?:string, sets:FinishSet[] }`；
`FinishSet` = `{ exerciseKey:string, exerciseName:string, exerciseId?:string, kind:string, setNo:int, weightKg?:float, reps?:int, sec?:int, warmup?:bool }`
（对齐 `session/models.rs:29` 的 `FinishInput` / `:46` 的 `FinishSet`；`sets` 缺省 = 空）。

番茄钟域：

| 方法字符串 | 参数 | 返回 | scope | 映射 |
| --- | --- | --- | --- | --- |
| `pomodoro.status` | 无 | `FocusRuntime ｜ null` | `pomodoro.read` | 新建 `runtime::focus_state_on(conn)` 读 `app_meta` 键 `runtime.focus.v1`（§14.1） |
| `pomodoro.start` | `focusMin?:int`, `breakMin?:int`, `todoId?:int｜null` | `{accepted:true}` | `pomodoro.control` | 下行 `start` → `pomodoroStore.start()`（src/stores/pomodoro.ts:52） |
| `pomodoro.pause` | 无 | `{accepted:true}` | `pomodoro.control` | 下行 `pause` → `pomodoroStore.pause()`（:59） |
| `pomodoro.stop` | 无 | `{accepted:true}` | `pomodoro.control` | 下行 `stop` → `pomodoroStore.reset()`（:65） |

**`schedule.campus` 的副作用（必须写明）**：`campus_schedule` 内部会调用 `materialize_todos`
（campus/commands.rs:1421）把课表派生行写进 `todos`，随后调用 `auto_complete_past_courses`
给已下课的派生行自动打卡——都是幂等的**本地写**，会被同步钩子捕获。
对外语义是「读课表」，但它会顺带物化今天的日程行；契约接受这一副作用（否则「今天日程」会缺课表行）。
为复用，抽 `pub(crate) fn campus_schedule_on(conn: &Connection, semester_id: Option<i64>, from: Option<String>, to: Option<String>) -> Result<ScheduleView>`，命令退化为壳。

> **破坏性副作用（第二轮复核认账）**：物化是**先删后建**（`campus/commands.rs` 的 `materialize_todos`
> 第一步 `DELETE FROM todos WHERE status != 'done' AND course_session_id IN (…本账号课时…)`）。
> 也就是说，**只授 `schedule.read` 的连接调用 `schedule.campus`**（或任一 UI 打开课表）会：
> ① 删掉该账号名下 `status != 'done'` 的课表派生待办（`category='class'`），并按当前课表重建 ——
> 用户对这些派生行的编辑会丢失、回退成课表原样；`status='done'` 的历史行不受影响（永删的只有未完成行）。
> ② 这是**可被反复触发**的写放大（每调一次都重跑该 DELETE）。
> 本轮**接受**这一行为（`schedule.campus` 对外仍是 `schedule.read`，与 UI 打开课表同路径、同语义）；
> 需要「读不删派生行」时，把物化从读路径拆出（只由 `campus_sync` 触发）或另立一个写/同步 scope。

### 13.3 删除方法语义（与 UI 删除同路径）

- `todo.delete` → 内部 `delete_todo_on(conn, id)`（todo/commands.rs:428）＝ UI `delete_todo` 的本体
  （todo/commands.rs:330 退化为壳）。attachments/subtasks 是 `todos` 行内 JSON 列，随行删除，无额外副作用。
- `workout.delete` → 内部与 UI `delete_workout` **同一条路径**（exercise/commands.rs:118），删除语义照旧（该处 :126-137 注释）：
  - `source='local'`：删行；若已导出到 Health Connect 且回写开关开 → **顺手删 HC 侧副本**（`healthsync::propagate_delete`）。
  - `source='health_connect'`：HC 是权威，**只记墓碑**（`healthsync::add_tombstone`），不动 HC 侧。
  - **网关无 `tauri::Webview`**：把 `healthsync::commands::propagate_delete` / `dispatch` 的入参由
    `&tauri::Webview<tauri::Wry>` 泛化为 `&tauri::AppHandle`（`Webview` 路径经其 `app_handle()` 取 `AppHandle`）；
    抽 `pub(crate) fn delete_workout_on(conn: &Connection, id: i64) -> Result<Option<String>>`（返回 `Some(external_id)` = 需传播），
    命令与网关共用，**传播在锁外**由调用方用 `AppHandle` 触发（§6.1 单连接铁律）。

---

## 14. 运行态桥接

外部要读/控「进行中」的番茄钟与训练课，但运行态真源在前端（番茄钟：`src/stores/pomodoro.ts`；训练课：`src/stores/session.ts`）。
桥接分两段：**上行（状态写 app_meta）** 与 **下行（控制经 Tauri 事件落到前端）**。

### 14.1 番茄钟：秒级上报（上行）

- 落点：`app_meta` 键 `runtime.focus.v1`，值 = JSON `FocusRuntime`：

```jsonc
{ "phase": "focus" | "break", "running": true,
  "remainingSec": 1234,
  "plannedFocusMin": 25, "plannedBreakMin": 5,
  "phaseStartedAt": "2026-10-13T09:00:00Z",   // 相位起点墙钟
  "linkedTodoId": 42 | null, "completedRounds": 2,
  "reportedAt": "2026-10-13T09:12:03Z" }      // 本次上报时刻（UTC）
```

- 字段口径：形状由本节冻结（后端只存原样 JSON，不解析）。`plannedBreakMin` = 该相位将进入的
  **计划休息分钟**（专注相位报「这一段结束后将进入的休息」，长休周期命中即长休分钟；休息相位报当前休息长度）。
  相位总秒数在前端**进入相位时冻结**，`remainingSec` 与外部读到的进度都从它派生（不再随改设置漂移）。

- **谁写**：前端 `pomodoroStore`。`running` 时每 **1 秒**调一次 `focus_publish(snapshot)`；并在
  `start`/`pause`/`reset`/`finishPhase` 立即各上报一次（不等 1s 周期）。
- **谁清**：`pause`/`reset`/`finishPhase` 调 `focus_unpublish()`（删键）；进程退出不显式清，靠陈旧判定。
- **陈旧判定**：`now - reportedAt > FOCUS_RUNTIME_TTL_MS`（**5000 ms**）→ `pomodoro.status` 返回 `null`，
  运行态推送发 `null`。判定在**后端**做（不信前端）。
- **只写 app_meta，绝不写 `pomodoro_sessions`**（后者在同步白名单，写它会广播到其他设备）。
- 新增 Tauri 命令 `focus_publish` / `focus_unpublish`（前端→后端，三处同步）；`pomodoro.status` 走 `focus_state_on` 直读。

**重启恢复语义（用户定稿）**：启动自检在后端 setup（`db::init` 之后、与网关同批）执行 `runtime::recover_focus(conn, now)`：
1. 读 `runtime.focus.v1`；无键 → 无操作。
2. 若 `running==true` 且 `phaseStartedAt + remainingSec <= now`（倒计时归零发生在应用关闭期间）
   → 按「**计时确实走完**」用 `save_pomodoro_session_on` 补写一行：
   `startedAt=phaseStartedAt`、`endedAt=phaseStartedAt+remainingSec`、`focusMin=plannedFocusMin`、
   `breakMin=plannedBreakMin`（统一为「该轮计划休息分钟」，不再是固定 0——与前端三态口径一致：
   补写的是「关闭期间已走完」的整轮，`completed=true`），**并删键**（同一事务，幂等）。
   若 `linkedTodoId` 指向的待办已被删（外键失败），把 `todo_id` 回退为 `NULL` **重试一次**，
   避免整条恢复因一处关联失效而丢失。
3. 其余情况（未到零、或相位是 `break`）→ 仅删陈旧键，**不补写**（`break` 不落库，与前端 `finishPhase` 一致：只有 focus 写库，src/stores/pomodoro.ts）。

> 前端冷启动也做同一条接管（`src/stores/pomodoro.ts` 的 `init()` / `restoreLive()`）：读
> localStorage 进行中快照，走完的专注补写一条 `completed:true` 并向用户留一条 `notice`；
> 仍在走 / 暂停中的停在暂停态提示「继续吗」；投入 < 60s 丢弃。两条路径各管各的载体
> （前端管 localStorage，后端管 `app_meta`），不会重复补写。

### 14.2 训练课：活跃会话投影（读）

`workout.sessionActive` → `SessionLive`（读 `workout_sessions` 里 `status='active'` 最近一条）：

```jsonc
{ "id": 7, "planId": "…", "planName": "…", "status": "active",
  "startedAt": "…", "updatedAt": "…",
  "exIndex": 1, "setIndex": 3, "weightKg": 40.0,
  "elapsedSec": 1830.0,        // 服务端按快照间隔累加的真实流逝秒（session_snapshot 维护）
  "restLeftSec": 42,           // 仅当快照 state 处于休息时；已按 updatedAt 补时；否则 null
  "reportedAt": "…" }          // = updatedAt
```

`restLeftSec` **必须服务端补时**：`state_json.restLeft` 是「上次事件时刻」的值，前端自己都要按真实流逝补偿
（src/stores/session.ts:1126 起）；把补时收在投影里，外部不必复刻。`timedElapsed` 不落盘、**不作为权威**。

### 14.3 外部控制：下行通道（Tauri 事件 → 前端 store，接口只回受理回执）

外部控制**不直写**状态机表（直写会被前端内存旧值在下次 `touch()` 静默覆盖），而是：

```
外部方法 → 服务端校验 scope → app.emit("<下行事件>", {action,args}) → 前端 runtime 监听 → 调 store 动作
        → store 走既有落盘路径（session_snapshot / saveSession / focus_publish）→ 外部用 status/sessionActive 观察结果
```

对外方法在 emit 成功后**立即**回 `{accepted:true}`（受理回执，不代表已执行完）。

| 对外方法 | Tauri 事件（后端→前端） | 事件载荷 | 前端动作 | 前端最终调的现有命令 |
| --- | --- | --- | --- | --- |
| `pomodoro.start` | `gateway://pomodoro-command` | `{action:"start", args:{focusMin?,breakMin?,todoId?}}` | `pomodoroStore.start()` | `focus_publish` |
| `pomodoro.pause` | `gateway://pomodoro-command` | `{action:"pause", args:{}}` | `pomodoroStore.pause()` | `focus_publish` |
| `pomodoro.stop` | `gateway://pomodoro-command` | `{action:"stop", args:{}}` | `pomodoroStore.reset()` | `focus_unpublish` |
| `workout.sessionStart` | `gateway://session-command` | `{action:"start", args:{planId,planName,startedAt,state?}}` | `sessionStore.start(plan)` | `session_start`（session/commands.rs:73） |
| `workout.sessionSnapshot` | `gateway://session-command` | `{action:"snapshot", args:{id,exIndex,setIndex,weightKg,state}}` | `sessionStore` 持久化 | `session_snapshot`（:97） |
| `workout.sessionFinish` | `gateway://session-command` | `{action:"finish", args:{sessionFinish}}` | `sessionStore.finish(...)` | `session_finish`（:151） |
| `workout.sessionAbort` | `gateway://session-command` | `{action:"abort", args:{id}}` | `sessionStore.abort(id)` | `session_abort`（:223） |

- **冲突守卫**：若 Rein 自家 UI 正持有内存中的活跃会话，`sessionStart` 下行事件被前端**拒绝**（不再新开）；
  外部经 `workout.sessionActive` 观察到即知。番茄钟同理（已在计时则 `start` 幂等忽略，见 src/stores/pomodoro.ts:53）。
- **下行只触发、参数仅作意图记录（已知限制）**：`pomodoro.start` 的 `focusMin/breakMin/todoId`、
  `workout.sessionStart` 的 `startedAt/state` 当前**不被 store 采用** —— `pomodoroStore.start()` 无参（用本地设置时长），
  `sessionStore.start(plan)` 自行以 `new Date()` 定 `startedAt`、忽略外部 `state`、并用课程库里的 `planName`
  （`src/system/externalAccessRuntime.ts` 的 `applyPomodoroCommand` / `applySessionCommand`）。上表只写「→ store 动作」，
  外部以 `pomodoro.status` / `workout.sessionActive` 观察到的结果可能与请求参数不符。要让参数真正生效需改 store 动作签名（另立改动）。
- 下行事件名前端照抄；监听挂在 `externalAccessRuntime`（§8.1）。

### 14.4 谁写谁清（速查）

| 运行态 | 载体 | 写 | 清 | 陈旧 |
| --- | --- | --- | --- | --- |
| 番茄钟 | `app_meta:runtime.focus.v1` | 前端 1s `focus_publish` | 前端 `focus_unpublish`（pause/reset/finish） | `now-reportedAt > 5000ms` |
| 训练课 | `workout_sessions` 行 | 前端事件级 `session_snapshot` | `session_finish`/`session_abort` | 无（行即真源；`restLeftSec` 按 `updatedAt` 补时） |

### 14.5 WS 推送（走现有通道）

- 业务表变更：`gateway.change`（§4.5），**按连接 scope 过滤**（第二轮补齐，§17）——只有含某域 read 权限的连接才收该域 `kind` 的变更元数据。
- 运行态变更：新增 WS 事件 `gateway.runtime`，载荷 `{ kind:"focus", data:FocusRuntime|null, at:int }`；
  由后端在 `focus_publish`/`focus_unpublish` 后推给已鉴权且含 `pomodoro.read` 的连接。
- 端口变化：绑定实际端口与设置项不一致时（§17），向已连接客户端推 `{ event:"gateway.server", data:{ event:"port-changed", port } }`。

---

## 15. HTML 客户端与 Origin 白名单

目标场景（用户定稿）：桌面小组件是 **HTML**（WebView2 / Electron / file://），握手会带 `Origin`。
因此 §4.1 的「Origin 必须缺失」改为「**原生放行、网页需命中白名单**」。

### 15.1 握手规则（改写 §4.1 第 1 条）

固定顺序：
1. `Origin` **缺失或为空** → 放行（原生客户端，行为不变）。
2. `Origin` **非空** → 必须**精确命中**已批准白名单，否则 `403` 拒绝（记审计，见 §15.2b）。
3. `Host` 闸门照旧执行（不改），并补两处（§17）：`local_addr()` 为 `None` 时**跳过**该闸门；LAN 下**主机名**放行。
4. 握手成功仍是「未进网」：5 秒内发首帧令牌，未鉴权并发/限频照旧。

白名单匹配规则：**精确字符串相等**（大小写敏感），不做通配、不做子域包含、不做 URL 前缀。
`file://` 页面的 Origin 是字面量字符串 `"null"`——把它加白即放行本地 HTML 组件（Electron/WebView2 自定义 scheme 同理，以其实际 Origin 为准）。

### 15.2 白名单存储与写入时机

- **存储**：`app_meta` 键 `gateway.allowedOrigins`，值 = JSON 字符串数组（如 `["null","http://localhost:5173"]`）。
  与 `gateway.*` 其余设置同处，不建表列、不进同步白名单。
- **什么时候写进去**：
  - (a) 设置页「外部访问」分区新增「允许的网页来源」列表，用户手动增删 Origin 字符串。
  - (b) 被 403 拒绝的 Origin 会落一条审计（`ext_audit.detail` 含 origin）；设置页「被拦下的来源」列出这些 Origin，
    一键「加入白名单」= 写入 (a) 的列表。这是用户知道该填什么的唯一实用路径。

### 15.3 不变的部分（放行 Origin ≠ 放松鉴权）

- 首帧令牌校验、四态授权、每次调用逐次 scope 校验、Host 闸门 —— **全部不变**。
- `Origin` 只是**握手期**额外的一道门；放行某个 Origin 不会让该来源跳过令牌或拿到超出授权 scope 的数据。
- 默认最小集仍是仅 `schedule.read`；写入/删除/控制 scope 默认不勾。

---

## 16. 授权语义定稿

本章是用户对四态与未决项的**正式规则**，覆盖 §5.1 的早期表述。硬性要求「允许本次会话：链接中断即算会话结束」原样保留。

| 状态 | 触发 | 存储位置 | 失效条件 |
| --- | --- | --- | --- |
| `pending` | 新客户端首帧无有效 `clientToken` | 内存待决队列（`gateway/auth.rs`） | 用户决策、或 **60 秒**后端超时 |
| **允许本次会话** | 弹窗点「允许本次会话」 | 内存 `conn_id → ConnGrant`（`auth.rs`） | **连接一断即失效；重连重新问；无任何宽限窗口** |
| **始终允许** | 弹窗点「始终允许」 | `ext_clients.decision='allow'` + `scopes` + `token_hash`；签发 `rein_ext_…` 回写一次 | `revoked_at` 置位 / 收窄 scope / `gateway_revoke_client` |
| **忽略** | 弹窗点「忽略」 | 不落决策，只更新 `last_prompt_at` / `prompt_count`（一条 `decision='ignore'` 的**限频记录**，不含 token/scopes，读授权时等价于不存在） | 保持 `pending` 直到超时；同一 `client_id` **30 秒**内不重复弹窗；**连续 3 次忽略 → 该 client 静默挂起**（不再弹窗，连接按超时结束） |
| **拒绝** | 弹窗点「拒绝」 | `ext_clients.decision='deny'` | 立即 `1008` 断连；此后**静默拒绝**（不弹窗） |

**逐条规则**

1. **「允许本次会话」不加宽限窗口**（用户硬性要求）：`conn_id → ConnGrant` 随连接消亡即清；
   重连必落回 `pending` 重新问。**定时刷新的桌面小组件应当使用「始终允许」**，不要用「本次会话」——
   否则每条短连接都会重新弹窗。
2. **授权超时 = 60 秒**，常量 `AUTH_PENDING_TIMEOUT_MS` 由 `30_000` 改为 `60_000`（`gateway/auth.rs:32`）。
   **以后端计时为准**，前端只显示倒计时（`timeoutMs` 由 `gateway://authorization-required` 带给前端）。
3. **应用不在前台**：授权弹窗走全局常驻层（`src/App.vue`）之外，**同时**用 `notifyService`
   （`src/services/notifyService.ts` 的 `notifyGrabResult`/`ensureNotifyPermission`）发一条系统通知做降级；
   若通知权限不可得 → 该请求按「忽略」处理（规则 5 的限频照常计入）。
4. **拒绝** = 落 `deny` 行 + 立即 `1008` 断连 + 之后静默拒绝。设置页「被拦下」清单可**解除**（删该行 → 回到无记录）。
5. **忽略** = 不落决策、仅记限频；30 秒同 client 不重复弹窗；连续 3 次 → 该 client 静默挂起。
   设置页「被拦下」清单可解除静默（重置 `prompt_count`）。
6. **超时与忽略两条路径都计入按 IP 的失败限频**（第一轮缺口，§17 补齐）：待决超时、用户忽略
   都调用与「握手被拒」相同的 `note_failure`（`gateway/server.rs:383` 同款），
   纳入 `AUTH_FAIL_PER_MIN=5` / `AUTH_FAIL_WINDOW=60s` / `AUTH_BAN=600s`（`auth.rs:41-45`）。
7. 授权「始终允许」时可勾选 scope 子集；默认最小集仅 `schedule.read`；写入/删除/控制 scope 默认不勾。
8. `gateway_authorization_pending` 供冷启动补漏（事件会丢）。

---

## 17. 第二轮落地计划

依赖顺序同 §9.5：存储层 → 协议与域绑定 → 服务与授权 → 前端。**所有写操作仍必须走同一条
`state::Db::lock()`**（§6.1）；网关与域新抽的 `*_on` 都收 `&Connection`（`session_finish` 那条收 `&mut Connection`）。

### 17.1 存储层（各域 `*_on` 与删除/会话/方案抽函数）

- [ ] `todo`：`delete_todo_on` 已存在（todo/commands.rs:428）——`schedule.delete` 改指它，无需新抽。
- [ ] `session/commands.rs`：抽 `session_start_on` / `session_snapshot_on` / `session_abort_on` /
      `session_active_on`，`session_finish_on(&mut Connection, …)`（:73/:97/:119/:151/:223 命令退化为壳）。
- [ ] `exercise/commands.rs`：抽 `delete_workout_on(conn, id) -> Result<Option<String>>`（:118 命令退化为壳）。
- [ ] `campus/commands.rs`：抽 `campus_schedule_on(conn, semester_id, from, to)`（:1392）。
- [ ] `program/commands.rs`：抽 `program_list_on(conn)` / `program_get_active_on(conn)`（:43/:55）。
- [ ] `plan/commands.rs`：补 `list_workout_plans_on_limited(conn, limit)`（**SQL 侧 LIMIT**，§17.4 复核项）。
- [x] `db.rs`：追加 `MIGRATION_0043`（`idx_ext_audit_client`，§6.5）；不改 0042。
- [x] 新建 `modules/gateway/runtime.rs`：`focus_state_on` / `focus_publish_on` / `focus_unpublish_on` / `recover_focus`（§14.1）。
- 依赖：无。**验收**：`cargo check` 通过；`*_on` 在内存库单测（行为与原命令一致），`recover_focus` 覆盖「关闭期间走完 → 补写一行」「未到零 → 只清键」两例。

### 17.2 协议与域绑定（枚举扩容 + 方法绑定 + 下行事件）

- [ ] `gateway/models.rs`：`Scope` 增 `ScheduleDelete`/`WorkoutDelete`/`PomodoroControl`（`ALL` 7→10），扩 `as_str/parse` 与单测。
- [ ] `gateway/protocol.rs`：`Method` 增 13 条（`ALL` 15→28），改 `ScheduleDelete.scope()` → `schedule.delete`，扩 `name/scope/from_name` 与单测。
- [ ] `gateway/methods.rs`：13 条新方法的 `dispatch` 分支（读走 `*_on`，控制走下行 emit）；`check_len` 覆盖所有新写方法（§17.4）。
- [x] `gateway/server.rs`：`gate_origin` 改白名单（§15.1）；`gate_host` 补 `local_addr=None` 跳过 + 主机名放行；`gateway.change` 按 scope 过滤；`gateway.runtime` / `port-changed` 推送。
      （第二轮收口：`handle_request` 改用 `methods::dispatch_with_effects`，在**锁外**执行 `Effect::Emit`（下行控制）与 `Effect::PropagateDelete`（Health Connect 删除传播）——此前直接调 `dispatch` 把整包 effects 丢弃，外部控制与删除传播在真机上是死的。）
- 依赖：17.1。**验收**：`cargo test` 的 `Method`/`Scope` 枚举单测通过；Origin 三态（缺失/命中/未命中）与 Host（IP/主机名/None）单测。

### 17.3 服务与授权（下行事件 + 命令 + 审计）

- [ ] `gateway/auth.rs`：`AUTH_PENDING_TIMEOUT_MS` 改 `60_000`；忽略/超时计入 `note_failure`（§16.6）；连续 3 次忽略 → 静默挂起。
- [ ] `gateway/server.rs`：把 `gateway://pomodoro-command` / `gateway://session-command` 的 emit 接进方法派发；emit 后回 `{accepted:true}`。
- [ ] `gateway/store.rs`：审计 `detail` 写参数摘要（§17.4）；`allowedOrigins` 增删读；`gateway_audit_recent` 的查询。
- [ ] `gateway/commands.rs`：新增 `gateway_audit_recent(limit?:int, clientId?:string)`；注册进 `lib.rs`（`generate_handler!`）。
- [ ] `lib.rs`：启动自检调用 `runtime::recover_focus`；注册 `focus_publish` / `focus_unpublish` / `gateway_audit_recent`（三条命令三处同步）。
- 依赖：17.1、17.2。**验收**：`node scripts/check-ipc-contract.mjs` 三处数量相等（现 273/273/273 → +4 = 277/277/277）；四态单测含「超时计入失败限频」「连续 3 次忽略静默」。
- **未做（如实认账）**：经过 `handle_connection` 的 **server 级集成单测**（错令牌 1008 / 对令牌拿结果、无 `clientToken` 首帧进 pending、下行 `Effect::Emit` 与 `PropagateDelete` 的锁外落地）仍未写 —— 需要 tauri `AppHandle`/`State` 测试夹具（`tauri` 的 `test` feature：`mock_app`/`mock_context`），当前 `cargo test` 无一条经过 `handle_connection`。effects 的**接线**由 `methods` 层单测（`control_dispatch_emits_effect_for_the_service_layer` / `workout_delete_effects_handle_health_connect_semantics`）与代码审阅覆盖，端到端行为未在单测里跑。`runtime::recover_focus` 的「关闭期间走完 → 补写一行」「未到零 → 只清键」两例已补内存库单测。

### 17.4 前端（上报/下行监听/白名单/审计界面）

- [ ] `src/stores/pomodoro.ts`：`running` 时 1s `focus_publish`；`start/pause/reset/finishPhase` 立即上报/清除。
- [ ] `src/system/externalAccessRuntime.ts`：监听 `gateway://pomodoro-command` / `gateway://session-command` → 调 store 动作；
      处理后台弹窗 + `notifyService` 通知降级。
- [ ] `src/components/settings/ExternalAccessSection.vue`：新增「允许的网页来源」（增删 Origin）、
      「被拦下的来源」（从审计读，一键加白）、「最近访问记录」（`gateway_audit_recent`）。
- [ ] `src/services/gatewayService.ts`：补 `auditRecent`；`src/mock/server.ts` 补 `focus_publish`/`focus_unpublish`/`gateway_audit_recent` 三条顶层 case 与 `mockGateway` 下行事件钩子。
- [ ] `src/types/externalAccess.ts`：补 `FocusRuntime` / `SessionLive` / 白名单与审计类型；barrel 不变。
- 依赖：17.2（方法/事件名冻结）、17.3（命令名冻结）。**验收**：`npm run lint && npm run typecheck && npm run build` 通过；`npm run contract` 一致；`node scripts/e2e-external-api.mjs`（扩授权/白名单/审计三幕）。

### 17.5 第一轮复核意见收口（逐条）

- [ ] **待决路径失败限频**：待决超时与「忽略」计入按 IP 失败限频（§16.6，17.3）。
- [ ] **列表 SQL 侧 LIMIT（含 plan）**：`list_workout_plans_on_limited` 补齐（§6.4 现只覆盖 todos/workouts/pomodoro，plan 漏了）。
- [ ] **变更推送按 scope 过滤**：`gateway.change` 只推连接 scope 覆盖的域（§14.5、17.2）。
- [ ] **审计参数**：`ext_audit.detail` 写请求参数摘要（按 scope 白名单挑字段、逐字段截断），
      并加 `gateway_audit_recent` 让设置页看最近记录（§17.3/§17.4）。
- [ ] **写字段长度校验**：`check_len`（methods.rs:218-222 的 `MAX_TITLE=500`/`MAX_TEXT=10_000`）覆盖
      所有第二轮写入方法（含 `sessionFinish` 的 `name`/`note`）。
- [ ] **Host 闸门在 `local_addr()` 为 `None` 时跳过**（当前 server.rs:232-233 是「按拒处理」）。
- [ ] **LAN 下用主机名连接被 403**：`gate_host` 放行集合加入本机主机名（Windows 取 `COMPUTERNAME`，其余 `hostname`），
      与既有 IP + `localhost` 别名并列。
- [ ] **文档偏差清理**：§5.3 的 `scope.rs` 实为 `gateway/models.rs`（本轮已改）；§8.1 的
      `ExternalAccessPage.vue`/`/settings/external` 实为内嵌 `ExternalAccessSection.vue`（§3 已注）；其余以代码为准。

---

## 12b. 引用清单（机器可校验）

正文（含 §1–§17）引用到的、写作时**已真实存在**的工作区文件。计划新建的文件一律不进本清单。

<!-- check-refs -->
src-tauri/src/lib.rs
src-tauri/src/state.rs
src-tauri/src/error.rs
src-tauri/src/db.rs
src-tauri/src/modules/sync/engine.rs
src-tauri/src/modules/sync/tables.rs
src-tauri/src/modules/sync/crypto.rs
src-tauri/src/modules/todo/commands.rs
src-tauri/src/modules/session/commands.rs
src-tauri/src/modules/exercise/commands.rs
src-tauri/src/modules/plan/commands.rs
src-tauri/src/modules/pomodoro/commands.rs
src-tauri/src/modules/pomodoro/models.rs
src-tauri/src/modules/todo/models.rs
src-tauri/src/modules/session/models.rs
src-tauri/src/modules/exercise/models.rs
src-tauri/src/modules/plan/models.rs
src-tauri/src/modules/campus/commands.rs
src-tauri/src/modules/campus/models.rs
src-tauri/src/modules/program/commands.rs
src-tauri/src/modules/program/models.rs
src-tauri/src/modules/gateway/mod.rs
src-tauri/src/modules/gateway/models.rs
src-tauri/src/modules/gateway/protocol.rs
src-tauri/src/modules/gateway/methods.rs
src-tauri/src/modules/gateway/auth.rs
src-tauri/src/modules/gateway/store.rs
src-tauri/src/modules/gateway/server.rs
src-tauri/src/modules/gateway/commands.rs
src-tauri/Cargo.toml
src-tauri/capabilities/default.json
scripts/check-ipc-contract.mjs
scripts/e2e-data-clear.mjs
scripts/e2e-external-api.mjs
docs/STANDARDS.md
docs/ARCHITECTURE.md
docs/SYNC.md
src/App.vue
src/main.ts
src/router.ts
src/pages/SettingsPage.vue
src/stores/session.ts
src/stores/pomodoro.ts
src/services/agentService.ts
src/services/gatewayService.ts
src/services/notifyService.ts
src/services/pomodoroService.ts
src/services/voiceService.ts
src/system/externalAccessRuntime.ts
src/components/settings/GatewayAuthSheet.vue
src/components/settings/ExternalAccessSection.vue
src/mock/server.ts
src/types/index.ts
src/types/externalAccess.ts
<!-- /check-refs -->
