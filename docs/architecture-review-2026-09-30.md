# Rein 架构审查与优化（2026-09-30）

一次全量的架构走查 + 已落地优化。每条结论都带可复现的命令或数字；没验证过的猜测一律标「待验证」。

## 结论摘要

- **地基是扎实的**：分层（页面 / store / service / IPC / Rust）、IPC 契约的三处同步、数据库迁移只追加、
  设计令牌唯一来源 —— 这几条都真的在执行，不是写在文档里的口号。
  `npm run contract` 报到 218/218/218 一致，`vue-tsc` 零错，`eslint` 零 error。
- **最大的浪费在产物里，不在代码里**：6800 行的浏览器内存后端（连同 896 KB 的 `foods.json`）
  被打进桌面端安装包 —— 那条分支在 Tauri 里永远不可达。
- **次大的浪费在首屏主包**：`stores/ai` 被 App 根部的两处静态 import 够到，
  于是 AI 工具注册表 + 18 个工具域（约 140 KB）+ 160 KB 解剖 SVG 全部落在阻塞启动的那一个 chunk 上。
  这与文档里已经写下的「AI 层不静态进主包」相悖 —— 属于**文档对、代码漂了**。
- **最大的残余风险在 Rust 单体文件**：`campus/grab.rs` 5416 行、190 处 `unwrap/expect/panic!`，
  是全部后端里最集中的一处。

## 一、站得住的部分（改之前先想清楚为什么它是对的）

| 机制 | 为什么它值钱 |
| --- | --- |
| IPC 契约三同步 + `npm run contract` | 218 条命令在 Rust / services / mock 三处机器比对。这是全项目**唯一**能挡住「加了命令忘了接前端」的闸门，也是 mock 能长期不腐的原因 |
| 迁移只追加（`db.rs::MIGRATIONS` 下标即版本） | 老库升级路径不需要人脑推演 |
| `services/transport.ts` 唯一出口 | 组件/store 摸不到 `@tauri-apps/api`，mock 与 Rust 可以整段替换 |
| 40+ 个 CDP e2e 脚本 | 这套 UI 的绝对像素布局（430×932 标定）靠人眼看不住，脚本是唯一能发现「徽章拆行」这类漂移的手段。**本次优化的每一步都靠它兜底** |
| 设计令牌 / 分组装载策略等「单一事实」原则 | 项目里凡是有两份实现的地方，注释里都写了「两份必然漂」。这是对的 |

## 二、已落地（4 项优化 + 1 个崩溃修复 + 2 条测试漂移修正）

### 1. 桌面端不再打包内存 mock 后端（−1.05 MB / −31%）

- 改动：`vite.config.ts` 在 `TAURI_ENV_PLATFORM` 存在时把 `@/mock/server` alias 到
  新增的 `src/mock/disabled.ts`（同名导出 `mockInvoke` / `mockCampus` / `mockVoice`，命中即抛）。
- 判据：`tauri build` 会在 `beforeBuildCommand` 前注入该变量；纯浏览器 `npm run dev` 没有它，
  所以浏览器开发/预览照旧走真 mock（所有 e2e 都是在浏览器模式下跑绿的）。
- 实测：mock chunk `1,052,085 B → 0`；`dist/` 合计 ≈3.38 MB → 2.34 MB。

### 2. 切断 App 入口到 AI 工具层的静态依赖（首屏 −202 KB）

- 根因：`App.vue → utils/campusAi → stores/ai → ai/tools/registry → 18 个工具域`，
  以及 `App.vue → VoiceSessionView → stores/ai`、`VoiceSessionView → system/voiceRuntime → stores/ai`。
  三条静态边把整整一层 AI 工具拖进首屏。
- 改动：三处引用全部改成**函数内动态 import**（`aiStore()` / `ensureAiStore()` /
  `import('@/utils/campusAi')`）。语音视图在被打开时预热 AI store，键盘回退与「最近一条助手回复」
  在未加载时返回 null —— 这条 computed 本来也只服务键盘回退面板。
- 实测：`stores/ai` + `ai/tools/*` 从首屏 chunk 移出，落到懒加载的 `registry-*.js`（166 KB）；
  首屏 `796,947 → 553,647 B`。

### 3. 重资产明细按需加载（首屏再 −171 KB）

- 肌群三视图是 160 KB 的解剖 SVG（`?raw` 内联），却出现在**挂着 App 根部的** `SessionOverlay` 里。
- 改动：`SessionOverlay` 用 `defineAsyncComponent` 引入 `MuscleMap` 与 `ExerciseDetailDrawer`
  —— 两者的渲染点都在 `v-if` 分支里，用户不开到那一屏就不下载。
- 实测：新出现 `MuscleMap-*.js`（164 KB）懒加载 chunk；首屏 `553,647 → 394,459 B`。
- 累计首屏：`796,947 → 394,459 B（−50%）`。
- **口径说明**：代码分割不减少总字节，只是把 402 KB 从「阻塞启动」挪到「用到才下」
  （`registry-*.js` 166 KB + `MuscleMap-*.js` 164 KB + 若干小的）。真正减少总量的只有第 1 项的 1.05 MB。
  两者都算收益，但只有前者影响开屏。

### 4. 修掉「开始录音后转写区永远是空的」（e2e-voice 由红转绿 30/30）

- 症状：`scripts/e2e-voice.mjs` 在 C3「4 句定稿」处超时。
- 根因（用 CDP 抓 `window.__rejections` 定位）：`TimeSpine.vue::estimateDur` 写成
  `props.segments[i]!`，而 `total` 对**空数组**会调 `estimateDur(-1)` → `undefined.durMs` 抛在 computed 里
  → 整块会话视图的渲染被打断，之后每次重渲染继续抛。
  空数组是真实状态：刚进「转写中」、ASR 还没吐第一句时就是那个形状。
- 改动：越界返回 0（一行守卫）。
- **这是既有 bug，不是本次优化引入的**：把三个语音文件 `git checkout` 回 HEAD 后复现同样的失败。

### 5. 修掉两条已经红着没人发现的断言（e2e-ai-tools 20/22 → 23/23）

- `按需组数 === 8`：`campus` 拆出子模块 `campusGrab` 之后是 9 组，断言没跟着改。
- `开着课表 → 命中即装（且带全 10 个教务工具）`：它用的命中词是「选课」，
  而「选课 / 抢课」只在外层默认关闭的 `campusGrab` 词表里 —— 这条断言从来没有真正在判门禁。
- 改动：按需组数改 9；门禁拆成两条（父开 → `campus`；父开子开 → `campusGrab` 整组 9 个工具）。
  顺带发现并留了一条新断言：教务工具**不能按名字前缀数**（只有 `campus_status` 带 `campus_` 前缀）。

### 6. 清掉 Rust 里唯一一条「纯噪音」告警

`modules/sync/transport/udp.rs` 的 `use base64::{...}` 未使用。`cargo check` 告警 16 → 15。

## 三、验证记录

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | 0 error / 10 warning（全在 `src/mock/server.ts` 的 `any`，且该文件已不进桌面端） |
| IPC 契约 | `npm run contract` | 218 / 218 / 218 一致 |
| Rust | `cargo check` | 0 error / 15 warning（均为 `modules/sync` 的死代码） |
| 构建 | `npm run build`（含 `TAURI_ENV_PLATFORM`） | 成功，无 mock chunk |
| 布局 | `node scripts/e2e-layout-guard.mjs` | 27 路由 + 操作边界 全通过 |
| 肌群图 | `node scripts/e2e-muscle-map.mjs` | 29 / 29 |
| 语音 | `node scripts/e2e-voice.mjs` | 30 / 30（改前红） |
| AI 工具 | `node scripts/e2e-ai-tools.mjs` | 23 / 23（改前 20 / 22） |
| 训练课 | `node scripts/e2e-session-timed.mjs` | 27 / 27 |

## 四、待办（按「收益 ÷ 风险」排序，本次未做）

1. **`campus/grab.rs`（5416 行 / 190 处 unwrap）** —— 后端最大的单体。
   建议按「帧编解码 / 会话状态机 / 任务编排 / 错误吸收」拆成子模块，且优先把
   `#[tauri::command]` 边界上的 `unwrap` 换成 `ReinError`（命令里 panic = 前端只看到一句无码的错误）。
2. **全后端 1284 处 `.unwrap()`** —— 不必全清，但要有一条判据：
   *命令边界、线程边界、锁* 三类必须转错误；纯解析后立即使用的局部推导可以留。
   顺带把 `servers`/`sync` 那 15 条死代码告警收掉（0.5.0 刚落的同步模块，多半是留给下一步的 API）。
3. **`campus` 组策略与工具归属漂移** —— `GROUP_POLICY.campus` 的 hint 说「培养方案、学分完成度与**课程清单**」，
   但 `course_lessons` 之类的读课表工具全被划进了默认关闭的 `campusGrab`；
   打开的课表（抢课关着）时，AI 手里只剩 `campus_program` 一个工具。
   要么把「读课表」类工具挪回 `campus`，要么改 hint —— 两者不能各说各话。
   另外 `docs/ARCHITECTURE.md` 仍写「按需 8 组」，实际是 9 组。
4. **`src/mock/server.ts` 6800 行单文件** —— 它对扩展的抵抗力靠 `npm run contract` 兜着，
   但一个 switch 里塞 218 个命令，人已经很难按域定位。建议按域拆成 `mock/<domain>.ts` + 一个汇总表。
5. **AI 工具注册表仍是静态 import**（`registry.ts` 顶部 18 个域）—— 现在整体按需加载已经够用；
   若还要瘦，就把「按需组」改成按组动态 import（`resolveToolPlan` 与 `load_tools` 相应改异步），
   这是一次结构性改动，建议单独排期。
6. **首屏还能再瘦**：`SessionOverlay` 80 KB + `VoiceSessionView` 45 KB + `TimeSpine` 22 KB 仍常驻。
   语音视图可以改成「首次打开再挂载」，但要处理入场动画在挂载后不播的问题（`Transition` 需要 `appear`），
   收益 ~70 KB、风险中等，本次没做。
7. `dist` 里的 `manualChunks` 仍为空 —— 桌面端从本地磁盘读，拆 vendor 只影响缓存命中率、不影响首屏，**不建议动**。

## 五、性能（2026-09-30 实测）

口径：**生产构建**（`npm run build` + `npm run preview`）+ 无头 Edge/CDP；数据库用 `node:sqlite`
对**真库副本**（3.1 MB / 762 页 / 2722 食物 / 253 知识块）测。

### 5.1 前端运行时：没有可捡的收益

| 指标 | 实测 |
| --- | --- |
| 冷启动 | domInteractive 9 ms · DCL 63 ms · load 81 ms · **FCP 184 ms** · 堆 12.5 MB |
| 首屏长任务（>50 ms） | **0 个**（冷启动与全部 16 条路由） |
| 逐路由挂载（hash 切换 → 两帧） | 124–155 ms（无头 rAF 量化，无长任务） |
| 空闲 3 秒 DOM 变更（主页 / 待办 / AI） | **0 次**，无长任务 —— 没有偷偷在跑的轮询或动画 |
| 滚动主线程占用（主页 / AI / 待办，各 2.5 s） | rAF 间隔 p50 3.3 ms · p95 3.4 ms · max 5.3 ms · 长任务 0 |

主线程是干净的。这套 UI 贵在**光栅**（玻璃折射），而那一族已经有台架
（`scripts/e2e-glass-perf.mjs`）盯着，本次没动。列表也都做了截断（食物库 `slice(0, CAP)` + 展开）
或虚拟化（`VirtualTimeline`），没有「几千个 DOM」的页面。

### 5.2 数据库写路径：找到并修掉 24.5 倍

真库体检发现 `synchronous` 是 **2 = FULL** —— 代码从没显式设过它，吃的是 SQLite 默认值。
WAL 模式下 FULL 意味着**每次提交都 fsync 一次 WAL**，而 Rein 的写恰恰是大量单语句自动提交
（会话快照、抢课任务推进、待办勾选、同步游标）。同一台机器、同一写形状（2000 次自动提交 INSERT/UPDATE）：

| | 总耗时 | 每次写 |
| --- | --- | --- |
| `synchronous=FULL` | 2342.8 ms | 1.171 ms |
| `synchronous=NORMAL` | **95.5 ms** | **0.048 ms** |
| | **24.5×** | |

- 改动：`db.rs::tune()` 显式设 `synchronous=NORMAL`（WAL 的官方推荐档），三条连接级 pragma 收口到一个函数。
- 为什么不损坏数据：WAL 下的 NORMAL 只可能丢「断电前最后若干次已提交事务」，不会损坏库；
  真需要「写到就必须在」的链路，应当给那一条链路单独开 FULL 事务，而不是把全局拖回 FULL。
- 回归：新增 `db::tests::tune_locks_connection_pragmas`。这条测试是必要的 ——
  `synchronous` 被删掉不会让任何功能测试变红，只会让写路径悄悄慢 24 倍。

### 5.3 IPC 往返：量级健康

浏览器模式下把 `transport.invoke` 临时插桩计数（**条数**可移植到 Tauri；mock 的 ~120 ms/次是人造延迟，
不看绝对值），测完已还原：

- **冷启动 16 条 / 15 种**：update_status×2、share_poll、session_active、campus_grab_set_enabled、
  list_meals、sync_recurrences、get_daily_summary、get_profile、list_body_metrics、list_ledger_entries、
  get_ledger_budget、program_get_active、update_check、list_all_todos、program_list。
- **逐路由 1–15 条**：最多是 `#/sports`（15）、`#/campus/course-select`（9）、`#/ai`（6）。
- 唯一瑕疵：少数命令在一次挂载里被调两次（`list_exercises` / `strength_history` / `ai_chat_list` / `update_status`）。
  来源是 `if (!loaded) await load()` 这种**非并发安全**的懒加载守卫 —— 两个调用方同时看到「未加载」就各发一次。
  收益只有一两条 IPC（个位数毫秒），本次没动；要收的正确做法是在 store 里缓存 **in-flight promise**，
  而不是再加一个布尔标志。

### 5.4 查询计划：热查询全部走索引

`EXPLAIN QUERY PLAN` 逐条查过：日期汇总 / 日期待办 / 按动作取做组 / 活动会话 / AI 会话消息 /
KB 文档块 / KB 向量 / 抢课到点任务 —— **全部 `SEARCH ... USING INDEX`**。唯一全表扫描是
`foods.name LIKE '%…%'`（模糊搜索 2722 行，亚毫秒级；为它上 FTS 是过度设计）。

### 5.5 顺带：本机端口占用（环境问题，非项目问题）

`npm run dev` 现在会 `EACCES: listen 0.0.0.0:1420` —— 1420 落进了 Windows 保留端口区间
（`netsh interface ipv4 show excludedportrange protocol=tcp` 显示 1359–1458，Hyper-V/WSL 动态预留）。
这会让 `npm run dev` 与所有依赖 1420 的 e2e 一起挂。释放：管理员 `net stop winnat && net start winnat`；
临时绕开：`npm run dev -- --port 1740` + `$env:REIN_E2E_URL='http://localhost:1740'`。

## 六、第二轮审查：CI 门槛、全量 e2e、仓库卫生

### 6.1 `cargo clippy -- -D warnings` 在 main 上是红的（已修绿）

`docs/STANDARDS.md` §7 与 `.github/workflows/ci.yml` 的 rust job 都把 **`cargo clippy --lib -- -D warnings`**
写成合并门槛，而它当时**失败**，报 **25 个 error**（15 条 dead_code + 10 条风格 lint）。
也就是说：**写着「合并前必须全绿」的闸门，实际上一直没过**。已全部处理，现在 errors=0。

死代码分两类的处置不同 —— 判据是「它是不是同一份逻辑的第二条实现」：

| 处置 | 项 | 理由 |
| --- | --- | --- |
| 删除（9） | `apply::set_group` · `apply::record_run` · `runner::last_run` · `runner::fingerprint` · `runner::rendezvous_addr` · `crypto::secret_b64` / `secret_from_b64` · `udp::UdpLink::peer` · `crypto::counters` | `record_run` 与 `runner` 记结果是**同一批 last_* 键的两份写法**（一个累积、一个覆盖），`set_group` 与 `runner::pair_claim` 是 `sync_peers` 的两份写法 —— 同一份数据两个写入点必然漂。其余是纯转发/纯访问器 |
| 保留 + `#[allow(dead_code)]` + 理由（6） | `crypto::is_lower`（测试读） · `blobs::size_of`（回收路径判据） · `models::SyncSettings` / `SyncSettingsPatch`（设置面尚未实现） · `protocol::Peer.name` · `transport::Endpoint.dial` | 删掉等于让「已定下的语义」消失；每处都写清为什么留着 |

其中 `crypto::counters` 用 `#[cfg(test)]` 而不是 `allow` —— 它本来就只该出现在测试里。

10 条风格 lint 是真修，不是压制：`loop { let Some(i) = … else { break } }` → `while let`、手写 `Option::map`、
可折叠的 `if`/`match`、以及两处类型别名（顺带**去掉了分块缓冲里那个从没被读过的第 8 个字段**）。
`Media::JsonMedia` → `Media::Json`（枚举名不再复读）是重命名而非豁免。
`too_many_arguments` 只在两处保留并写明理由：表登记器与一轮同步的状态参数，刻意平铺。

### 6.2 全量 e2e：10 个脚本、479 项断言全绿

| 脚本 | 结果 |
| --- | --- |
| e2e-layout-guard | 27 条路由 + 操作边界 ✓ |
| e2e-page-header | 35/35 |
| e2e-feature-toggles | 39/39 |
| e2e-todo-duration | 12 项 |
| e2e-record | 23/23 |
| e2e-exercise-library | 47/47 |
| e2e-strength | 27/27 |
| e2e-kb | 81/81 |
| e2e-food-ai | 31/31 |
| e2e-update-notes | 11/11 |

加上前一轮的 e2e-voice 30/30、e2e-ai-tools 23/23、e2e-muscle-map 29/29、e2e-session-timed 27/27 ——
本次审查跑过的界面回归共 **14 个脚本**。

### 6.3 仓库卫生（扫描结果）

- **死文件：0**。以 `src/main.ts` 为根做静态引用闭包，324 个源文件里只有两个不可达：
  `src/mock/disabled.ts`（构建期 alias 才引用，静态扫描看不见，符合预期）与 `src/vite-env.d.ts`（类型声明）。
- **未使用的运行时依赖：0**。`dependencies` 全部在 src 里被 import。
- **数据库完整性**：`integrity_check = ok`、`foreign_key_check = 空`、`quick_check = ok`（真库 3.1 MB / 762 页）。
- **唯一一处值得记一笔的存储**：`app_meta` 占了 944 KB —— 其中 `campus_program:1` 是 **921 KB 的培养方案原始响应缓存**
  （代码里写明「响应可达 900KB+，拉一次落缓存」）。这是有意为之、读取走主键索引、AI 侧也把它投影成四种小视图再给模型，
  所以不是 bug；但它与「`app_meta` 只放界面级偏好」这条自述有出入，将来要搬的话记得连 WAL 写入量一起看。

### 6.4 顺手加固：dev server 别被一次保存带走

Windows 下 chokidar 撞 `EBUSY` 时**整个 dev server 会退出**（不是降级）。本次审查里它死了两次，
每次都把正在跑的 e2e 批处理打成一片红（3 个脚本因此误报失败，重跑后 81/81、31/31、11/11 全过）。
`vite.config.ts` 的 `server.watch.ignored` 因此补上了原子写的临时形态（`**/*.tmpdir/**`、`**/.*.tmp`、`**/*~`），
并实测「改一次源码后 dev server 仍存活」。

## 七、第三轮：把「一次崩溃」与「永久瘫痪」分开

### 7.1 发现：持锁 panic 会永久瘫掉数据层

`AppState.db` 是一把全局 `Mutex<Connection>`，全仓 **236 处**调用点都写成 `state.db.lock().unwrap()`
（这也是 `STANDARDS.md` §1 唯一放行的 unwrap 场景）。问题不在 unwrap 本身，而在于它把两种后果绑死了：

- 持锁线程 panic → **一次性故障**（Tauri 把错误报给前端，用户重试即可）；
- 同一刻 Mutex 被标记中毒 → **之后每一条命令的 `lock().unwrap()` 都继续 panic** →
  整个数据层在重启前不可用，而 panic 的那条命令可能只是「查一下今天的课表」。

这个 crate 里有 1284 处 `unwrap()`（抓到的 HTML、解析出的 JSON、按列取值），一次 panic 落在持锁区并不罕见；
`campus/*` 这类要解析教务页面的域尤其如此。

### 7.2 改动：让编译器保证没有漏网的 unwrap

`state::Db` 包住那把 Mutex，换取四条性质：

| 设计 | 理由 |
| --- | --- |
| `lock()` 直接返回 `MutexGuard`（不是 `Result`） | 调用点**不需要也不能** unwrap；漏改的地方是**编译错误**而不是又一个静默 panic 点。236 处替换正是靠这条约束一次做完的 |
| 中毒时 `into_inner()` 取回连接 | SQLite 连接本身没有中毒这个概念，数据仍然可用 |
| 恢复时补一次 `ROLLBACK` | panic 可能落在 `BEGIN` 之后；不回滚的话后续写入会一直撞 `cannot start a transaction within a transaction` |
| panic 照旧抛给前端 | 这不是「吞掉 panic」，只是不让它带走整个应用；丢掉的仅是该命令未提交的改动 —— 崩溃本来就该丢的东西 |

另外两处顺带收口：`campus::commands` 的 `recover_session` / `select_context` 签名由 `&Mutex<Connection>` 改成 `&Db`
（它们本来就自己安排锁的边界）；`grab.rs` 里那句 `if let Ok(conn) = state.db.lock()` 也随之去掉 —— 中毒时静默跳过写时钟
不再是正确行为。

### 7.3 验证

- 新增 `state::tests::poisoned_lock_recovers_with_rollback`：一个线程在事务中途 panic，断言另一侧仍能拿锁、能写库，
  且半截事务已回滚（表里只剩恢复后写入的那一行）。**这条测试是必要的** —— 把恢复逻辑改回 `lock().unwrap()`
  不会让任何功能测试变红，只会让「一次崩溃」重新变成「永久瘫痪」。
- 236 处替换后残留 `db.lock().unwrap()` = 0（脚本核对 + 编译器强制）。
- `cargo clippy --lib -- -D warnings` → **errors=0**；`cargo test --lib` → **424 passed / 0 failed**（6 ignored，总数 430）。

### 7.4 还剩什么

- `CampusHub` / `VoiceHub` 的小锁仍是 `.lock().unwrap()`：它们的爆炸半径只有一个域的内存缓存，
  `STANDARDS.md` 已写明允许；要一并收口就复用 `Db` 这套模式，收益小于上面这一处。
- 本次没有动「1284 处业务 unwrap」本身。正确的做法是**先有不瘫的底座**（这一轮），
  再按「命令边界 / 线程边界 / 锁」三类逐步把推导型 unwrap 换成 `ReinError`。

## 八、复现

```bash
# 1. STANDARDS.md §7 那套门槛（与 CI 逐条对应）
npm run contract && npm run lint && npm run typecheck && npm run build
cd src-tauri && cargo clippy --lib -- -D warnings && cargo test --lib

# 2. 界面回归（先起 dev；本机 1420 被 Windows 保留，换 1740 并把地址指给 e2e）
npm run dev -- --port 1740
$env:REIN_E2E_URL='http://localhost:1740'
node scripts/e2e-layout-guard.mjs ; node scripts/e2e-page-header.mjs ; node scripts/e2e-feature-toggles.mjs
node scripts/e2e-voice.mjs ; node scripts/e2e-ai-tools.mjs ; node scripts/e2e-muscle-map.mjs ; node scripts/e2e-session-timed.mjs
node scripts/e2e-kb.mjs ; node scripts/e2e-food-ai.mjs ; node scripts/e2e-record.mjs ; node scripts/e2e-strength.mjs

# 3. 桌面端产物：不应出现 server-*.js（mock 后端已剔除）
$env:TAURI_ENV_PLATFORM='windows'; npm run build
```

**注意**：1420 现在落在 Windows 的保留端口区间里（见 §5.5），不加 `--port` 会 `EACCES`。
