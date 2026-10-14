# 跑步定位/运动学「防抖快通道」改造交付报告

> 版本：0.5.18（工作树状态，未发布）
> 日期：2026-10-14
> 范围：解决「起步数秒不出数、显示刷新慢、入账滞后」——在不改 29 个 K/L 稳通道常量的前提下，
> 新增**显示专用快通道 dispM** + **节拍对齐** + **TS 通路补齐**，保持成绩单/结算/判定零回归。
> 证据分级：本报告区分【已跑过】（本会话执行并给出命令与输出）、【已读码】（给出 path:line）、
> 【材料引用】（来自本轮交办材料，注明来源）。**真机验收本轮未执行**（无 adb 设备），凡真机项一律标「未跑」。
> **可核对规则**：凡出现在 §7.1 命令表中的数字算【已跑过】；§7.1 未列出的脚本一律算【材料引用】；Kotlin 侧（本机无法执行 java/kotlinc/adb）一律【已读码】；§4 延迟链中我未复跑的环已就地标注「材料」。

---

## ① 一句话结论

单路距离估计在两种拓扑上不可兼得——**稳通道（4 点方向防抖）**静止族鲁棒但起步/折返滞后（首个非零 4000ms、折返 7000ms、折返累距 −99.6%），**逐点位移快通道**起步快但在噪声大的静止族**比稳通道还差**（快通道 ±8m 圆盘 100/100、σ=5m 高斯 50/50 超 6m；稳通道同族 79/100、49/50，本已不能接受）；因此定案为**双通道拆分**：29 常量一字不改的稳通道继续做唯一权威（入账/判定/结算/持久化），另起一条**显示专用 `dispM = max(distM+pendingD, haversine(段锚点, 当前点))`** 只喂 hero 距离数字，把「首个非零」从 4000/7000ms 压到 **1000ms**、把显示刷新从「滞后 3 点」压到**每 fix 一次（≤1s）**，同时用下界性证明 `dispM` 恒 ≤ 1Hz 折线长度（5000 组随机走位 0 反例）。

---

## ② 为什么原方案不通用（拓扑审计的数字）

### 2.1 稳通道单路：起步/折返都破「≤2s + ≤5%」

本会话实跑 `.zcode/tmp/frozen-verify.mjs`（node v26.4.0，输出见 §7）：

```
绕圈 r=5m   distM=286.7 (-4.4%)  firstNonZero=4000ms  enters=0 exits=0 jc=0
跑道 400m   distM=291.1 (-3.0%)  firstNonZero=4000ms  enters=0 exits=0 jc=0
直线        distM=291.0 (-3.0%)  firstNonZero=4000ms  enters=0 exits=0 jc=0
随便跑 σ15° distM(5seed均值)=291.0 (-3.0%)
```

- 稳通道**首个非零**：绕圈/跑道/直线 = **4000ms**、**折返 5m = 7000ms**（`.zcode/tmp/frozen-verify.mjs`；V12 的 `稳首个入账=7000ms` 同源）→ 破「首个非零显示 ≤2s」。
- 原因是结构性的：4 点方向防抖 `JITTER_WINDOW=4` 要攒满 4 个点才确认（`RunAutoPause.kt:311-336` `guardStep`：攒满后 `commitValid(guard.removeFirst())` 确认的是**最老**那个点），再叠 1s 聚合窗（`:506-519`）→ 天然滞后 ≈3 点 + ≤1 采样间隔。1Hz/3m/s 下即 ≈4000ms（折返因方向防抖抹平掉头而更晚）。

### 2.2 拓扑审计：防抖对高转角拓扑的代价

本会话实跑 `.zcode/tmp/topo-audit.mjs`：

```
折返跑 5m@3m/s   truth=300.00 cur=  1.15 err=-99.62% poly=220.00 jc=48 turnMed=180.00
绕圈跑 r=5m@3m/s truth=300.00 cur=286.65 err= -4.45% poly=295.52 jc= 0 turnMed= 68.75
跑道跑 400m@3m/s truth=300.00 cur=290.97 err= -3.01% poly=299.96 jc= 0 turnMed=  0.00
直线跑 3m/s      truth=300.00 cur=291.00 err= -3.00% poly=300.00 jc= 0
随便跑 ±50°/s    truth=300.00 cur=291.00 err= -3.00% poly=300.00 jc= 0
随便跑 ±90°/s    truth=300.00 cur=206.02 err=-31.33% poly=300.00 jc=27 turnMed= 83.05
随便跑 ±120°/s   truth=300.00 cur=174.20 err=-41.93% poly=300.00 jc=36 turnMed=104.98
静止 ±3m 游走    truth=  0.00 cur=  0.00 err=  0.00% poly= 63.59 jc=45
```

> 注（跑道折线两个值）：`topo-audit.mjs` 的跑道用 `straight=84.4、lap=400`（`topo-audit.mjs:230`），其 `poly=299.96m`；而 V18/frozen 系的跑道用 `L=84.39、Rr=36.5、lap≈400.08`（`frozen-fastchan.mjs:19`），其折线 `301.5m`。两个脚本**跑道几何参数不同**，折线长度不可直接互比（§6.2 V18 用的是后者）。

- 折返（每次 180° 掉头，`turnMed=180°`）：防抖把之字形压平，稳通道只剩 **1.15m（−99.6%）**。
- 高转角自由跑（±90°/s、±120°/s）：`jc=27/36` 次校正，稳通道掉 **−31% / −42%**。
- 也就是说：方向防抖是**本族在 r≥8m、σ≈acc 噪声量级、以及折返场景下静止/转角鲁棒性的主要来源**（`.zcode/tmp/frozen-verify.mjs`：2D 圆盘 r=8m 稳 79/100 超、σ=5m 稳 49/50 超；`jc≈30~45`）。
- **限定**：在 2D 圆盘 r=3m 这一档，快通道同样 0/100 超 6m（见 §6.2 V14），即该档并非「只有防抖能守住」——快通道靠**段锚点弦长下界**也守住了。**本报告没有做「关掉 JITTER_WINDOW 再跑」的 ablation 对照**，故「唯一来源」不成立；这里只主张「防抖是 r≥8m/折返下的主要来源」。所以「为了折返精度去改/取消防抖」这条路被排除（取消防抖后 r≥8m 与折返会更差）。

### 2.3 逐点位移快通道单路：在噪声量级下不可靠

- acc≥5m 时，3m/s×1s 的单步位移 3m 落在位置噪声量级内（逐点判据的下界是单步 ≳2σ√2≈14m，见 §9）。
- 本会话实跑 `.zcode/tmp/frozen-fastchan.mjs` 的静止族：`2D r=8m ×100seed: dispM>6=100/100`（稳通道同族 79/100）、`高斯σ=5m ×50seed: dispM>6=50/50`。
- **限定**：该结论只在「单步位移落在噪声量级」时成立（r≥8m 或 σ≈acc）；在 2D r=3m 一档两者同为 0/100（§6.2 V14，相等而非更差）。故「任何逐点位移快通道只会更差」的全称句不成立，正确表述是：**在 r≥8m 或 σ≈acc 的噪声量级下，逐点位移通道只会比稳通道更差**。

### 2.4 结论

- 唯一能当**权威**（入账/判定/结算）的是防抖后的稳通道（零改动 → 零回归）。
- 唯一能保证 **≤1s 可见刷新**的是不等防抖的快通道。
- 二者**职责拆开**：稳通道 29 常量一字不改；快通道只喂 hero 距离。

---

## ③ 定案方案与规格要点（含全部常量）

### 3.1 定案

混合方案「**K/L 稳通道（零改动） + 快通道（显示专用低滞后估计） + 节拍对齐 + TS 通路补齐**」。
**不采用**任何「做距离源替换」的候选方案（均被对抗评审与实测证伪，见 §2）。

### 3.2 快通道定义（`RunAutoPause.kt:353-370` `fastChannel`）

```
segAnchor : Option<(lat,lon)>   // 当前 running 段的显示锚点；初值 null
dispM     : f64 = max(0.0, baselineDistanceM)   // 单调不减、跨段不重置（跨 run 由 begin/resetLocal 归零）

仅当 fix 是 accepted 时:
  steady = distM + pendingD
  net    = haversine(segAnchor, fix)      // 当前 running 段弦长
  dispM  = max(dispM, net, steady)
```

- 两项都是真路径长度的**下界** ⇒ `dispM` 恒 ≤ 1Hz 采样折线长度（不重复计距）；单调不减 ⇒ 显示值永不回退。
- **插入点统一规则**：「在该分支对 `pendingD` 的最后一次写之后、`win.push` 之前」：
  - 常规路径：`RunAutoPause.kt:524`（`out.accepted=true` 之后、`win.addLast` 之前）；
  - 空窗 `handleGap`：`RunAutoPause.kt:601`（`pendingD=0.0`（`:596`）之后）；
  - Rust 对应 `model.rs:644` / `:735`；TS 对应 `runGate.ts` 的 `bumpDisp` 调用点。
- 段锚点复位：段内首个 accepted fix（`segAnchor==null` 时落座）；`out.brk==true`；`setManualPaused(true)`（`:686-699`）与 `settleAutoPause()`（`:667-680`）置 null；**`enter()`（`:613-625`）不动 `segAnchor`**（进入后无 accepted fix，退出由 brk 覆盖）。
- 读取约定：**权威读数是 `RunCore.dispM`**；`Outcome.dispM`（`:154`）是本次 fix 的搬运副本，规定在 `onFix` 的**每条返回路径**上都赋 `= dispM`（含 dropped/jumped/manual/auto 早退，`RunAutoPause.kt:442/461/476/493/552`），二者恒等；向量断言读 `core.dispM`。

### 3.3 稳通道 29 常量（冻结，一字不改；`RunAutoPause.kt:41-85` / `model.rs:73-114`）

```
ACC_GATE_M=30.0        DT_ACCEPT_SEC=10.0    DMAX_MIN_M=40.0        DMAX_DT_FACTOR=8.0
STALE_SKIP_SEC=5.0     GAP_MIN_SEC=10.0      GAP_SLOW_MPS=1.6667
VMAX_FLOOR_MPS=6.0     VMAX_CEIL_MPS=10.0    VMAX_FACTOR=1.5        VMAX_BACK_SEC=60.0
DIST_FLOOR_MPS=0.5     PACE_MIN_MPS=0.8333   PACE_MIN_DIST_M=2.0    PACE_STALE_SEC=15.0
ENTER_WINDOW_SEC=10.0  ENTER_HOLD_SEC=8.0    ENTER_MIN_FIXES=3      ENTER_MIN_SPAN_SEC=6.0  ENTER_STREAK=3
EXIT_WINDOW_SEC=6.0    EXIT_MIN_FIXES=2      EXIT_MIN_SPAN_SEC=3.0  EXIT_HOLD_SEC=5.0       EXIT_STREAK=2
EXIT_ANCHOR_M=10.0     EXIT_CREDIT_MAX_M=60.0
JITTER_WINDOW=4        JITTER_MAX_TURN_DEG=90.0
```

派生：`enter=clamp(pace,300,1200)`、`exit∈[300,enter−30]`、`vEnter=1000/enter`、`vExit=1000/exit`（缺省 600/540）。

### 3.4 快通道/呈现常量

```
DISP_MIN_M = 1.0          // hero 显示非零门（呈现层）   — RunAutoPause.kt:90 / model.rs:1109 / runGate.ts:65
HERO_METER_MAX_M = 100.0  // <100m 显整数米，≥100m 显 km 2 位小数 — RunAutoPause.kt:93 / model.rs:1111 / runGate.ts:66
```

### 3.5 节拍/呈现常量的目标值与落地状态

（含数值改动的不止节拍：§3.4 还新增 `DISP_MIN_M`/`HERO_METER_MAX_M` 两个呈现常量。）

```
FLUSH_MS    5000→1500  (RunTrackingService.kt:68)   ← 已落地（实测现值 1_500L）
FLUSH_LINES 5→3        (:67)                        ← 已落地（实测现值 3）
TICK_MS     2000→1000  (workoutRuntime.ts:251)      ← 已落地（补记 1）
PUSH_MIN_MS 5000→1000  (workoutRuntime.ts:253)      ← 已落地（补记 1）
PUSH_HEARTBEAT_MS = 15000 不变 (:255，实测现值 15_000)
```

> 节拍数值改动现已全部落地：`FLUSH_MS`/`FLUSH_LINES` 由本轮实现者落地；`TICK_MS`/`PUSH_MIN_MS` 由主会话在本轮之后按用户决定补改（**补记 1**，见文末）。两者的**真机校验仍未做**（系统是否节流 1Hz 通知，见 §8.1-4 / §8.2-3）。
> `FLUSH_LINES` 取 3 的理由：与 `FLUSH_MS=1500` 组成「3 行**或** 1500ms 先到先刷」（`RunTrackingService.kt:432-437 appendTrack` / `:120-126 flushTick`）；1Hz 下 3 行≈3s > 1500ms，故**实际由 1500ms 定时主导**，落盘上限 ≈1500ms。取更小只是更频繁 IO，取更大则放宽上限。

### 3.6 时效契约（冻结规格 §4）

| 项 | 值 | 机制/作用域 | 状态 |
|---|---|---|---|
| 采集间隔 | 1000ms（min 500ms） | `RunTrackingService.kt:276-295`，不改 | 已读码 |
| native 发布 | 每被接受 fix 一次（≤1000ms） | `:415 publishLive()`（非定时） | 已读码 |
| JS 推送 | 同节拍（≤1000ms） | `:511 pushJs` | 已读码 |
| 前端轮询 | 1000ms | `run.ts:672` | 已读码 |
| **首个非零显示** | **1000ms** | `dispM ≥ DISP_MIN_M` | V9 实测@直线3m/s；「任意 v≥1 m/s」为**推理**（见下注） |
| 显示值刷新 | ≤1000ms（绕圈/跑道/直线/随便跑） | 快通道每 fix；**折返例外** | V17 实测 |
| 显示下界性 | `dispM ≤ 1Hz 折线长度` | §3.2（5000 组 0 反例） | V18 实测 |
| native 轨迹文件落盘 | ≤1500ms | FLUSH_MS=1500 / FLUSH_LINES=3 | 已改值/已读码 |
| 会话快照落盘 | 满足任一即落：落点计数达 5 / 距上次落盘 15s / 定时 10s（**不改**） | `run.ts:1045` / `:430-437` | 非 ≤2s 口径 |
| 通知刷新 | ≤2000ms（1s 比较拍 + 1s 数字节流） | TICK_MS=1000/PUSH_MIN_MS=1000 | **已落地**（补记 1）；系统是否节流需真机验证，**未验** |
| 入账 distM 追平真值位置 | ≈4000ms（**>2s**） | 稳通道，不改 | §9 |

「首个非零 = 1000ms」的 UI 条件：hero 若用 2 位小数公里，数位变化要 `dispM ≥ 5m`（3m/s 下 t=2s；折返永远不到 → 恒显 `—`）。故 hero 改为 `<100m 显整数米`（§5·RunPage.vue），任意 v≥1 m/s 时 1000ms 即出现非零数位。

> 注（§3.6 证据分级）：「首个非零显示 1000ms」的**实测**只覆盖直线 3m/s（V9）；「任意 v≥1 m/s」是**推理**（t=1s 时 `net≈v·1s ≥ DISP_MIN_M=1.0`），未跑 v=1/1.5/2 m/s 变体。
> 注（折返 hero 权威说法，回应「显示到底什么」）：采用本 spec 的 hero 规则（`<100m` 显整数米）时，折返场景 `dispM` 很快 ≥1.0 → hero **显示一个整数米数字**，但 100s 内只变化 **4 次**、且在 **≈5 m 处饱和**（V17 实测折返 4/100、V10 折返 dispM=5.0）——即「显示值几乎冻结」，**不是** `—`。只有当采用被否决的 2 位小数公里规则时，折返才恒显 `—`（那 5m 折返永远不到 5m 阈值）。

---

## ④ 时效改造：延迟链逐环对照

> 两张表都是**最坏串行和**。表中「ms」是各环相对真值的滞后。数字来自本轮交办材料给出的实测/读码，代码锚点由我本会话复核（见 §7）。
>
> **行号约定**：§4.1（改造前）的 `run.ts` 行号（`:946` 轮询 / `:1316` 持久化）取自交办材料的**改造前**版本，属**历史行号**；本轮 run.ts 已重构（web 闸门抽到 `runGate.ts`），当前文件里轮询在 `:672`、持久化在 `:1045`，即 §4.2 的行号。两表行号不同不是矛盾，是**代码被改了**。
>
> **为什么「改造后」合计反而大 500ms**：这 500ms 全来自**前端轮询**一环（1000→2000）。它**不是本次改造引入的回归**——轮询间隔没改（`run.ts:672` 仍 1000ms）；「改造前」的 1000ms 只算了「等下一拍」，「改造后」的 2000ms 补上了 `tracking_live` 是「缓存+异步刷新」这一事实（见 §4.2 该行：1000 等一拍 + 1000 读到的是上一拍快照）。两表对**同一段未改动代码**给了不同估计，后者更完整。
>
> **本改造真正快在哪**：收益不在这些**权威/持久化**环节（它们按设计一字不改），而在**显示快通道**——首个非零 4000/7000ms → 1000ms、显示刷新「滞后 3 点」→「每 fix（≤1s）」（V9/V17 实测，§6）。

### 4.1 改造前（最坏合计 23016ms）

| 环节 | ms | 证据 |
|---|---:|---|
| 定位采集间隔 | 1000 | `RunTrackingService.kt:278` `LocationRequest.Builder(1_000L).setMinUpdateIntervalMillis(500L)`；GPS 兜底 `:291`。1Hz，最坏滞后一个间隔 |
| 防抖确认滞后 | 3000 | `RunAutoPause.kt:311-336 guardStep`：窗口攒满 4 后 `commitValid(guard.removeFirst())` 确认最老点；`:29` 注释「所有判定滞后约 3 个点（1Hz 下约 3s）」；`.zcode/tmp/sim.mjs` 输出 `missing=9.00m = 3.00 fixes` |
| 1s 距离聚合窗 | 1000 | `:506-519` pendingD 攒到 `winSec>=1.0` 才入账；我实跑 `.zcode/tmp/lag.mjs`（均匀 dt）：1Hz→3000ms（窗附加 0）；**材料另报** 1Hz±50ms 抖动最高 4081ms（当前脚本只跑均匀 dt，本轮未复现该抖动分支） |
| native 快照发布(FLUSH) | 0 | `flushTick`（`:120-126/:297`）只调 `flushTrack()`；`publishLive` 已由 `:412` 每被接受 fix 同步发布（`:489-507`）。**「挂在 5s flushTick」不成立** |
| JS 推送 | 16 | `:506 pushJs` → `:510-519 evaluateJavascript`（每 fix，非周期）；一帧绘制 ≈16ms |
| 前端轮询 | 1000 | `run.ts:946` `setInterval(pollNativeLive,1000)` 读 `tracking_live` 缓存 |
| 通知渲染 | 7000 | `workoutRuntime.ts:251 TICK_MS=2000` + `:253 PUSH_MIN_MS=5000`，数字类最坏 2000+5000 |
| 入库持久化 | 10000 | `run.ts:1316` `persistTimer` 每 10s 一次 |

### 4.2 改造后（最坏合计 18516ms；通知节拍见补记 1）

| 环节 | ms | 证据 |
|---|---:|---|
| 定位采集间隔 | 1000 | 同前（`:280-283` fused 名义 1000ms、下限 500ms；`:293` GPS 兜底） |
| 防抖确认滞后 | 3000 | 同前（`:313`/`:336` 确认最老点）；`.zcode/tmp/lag-probe.mjs`：「稳通道 distM 滞后点数: 全部 3」 |
| 1s 距离聚合窗 | 500 | `:504-519` L4；`.zcode/tmp/lag-probe2.mjs`：1Hz 附加 0ms、500ms 采点最坏 500ms |
| native 快照发布(FLUSH) | 0 | `:415` `handleFix` 末尾无条件 `publishLive()`（除精度门 dropped）；`:492-512` 即时写 `liveJson`+`pushJs`。`FLUSH_MS=1_500L` 的 `flushTick`（`:120-126`）现在只写轨迹文件 |
| JS 推送 | 16 | 同前（`:515-524 pushJs` = `main.post{}` + `findWebView().evaluateJavascript`）；宿主无法实测，按一帧估计（**估计值，非实测**） |
| 前端轮询 | 2000 | `run.ts:669-673 startNativePoll`（1000ms + 立即拉一次）；读路径是「缓存+异步刷新」：`commands.rs:128-138 tracking_live` 先触发 `android_live` 再返回 `live_cached()`；`mod.rs:374-384` 完成后才写缓存 → 本次调用拿到上一拍快照。最坏 1000（等一拍）+1000（落后一拍） |
| 通知渲染 | 2000 | `workoutRuntime.ts:251/253/532`：TICK_MS=1000 + PUSH_MIN_MS=1000（补记 1），结构类下一拍即推、数字类最坏 1000+1000 |
| 入库持久化 | 10000 | `run.ts:1045 persistTimer` 每 10s；native 轨迹文件侧 `RunTrackingService.kt:67/68`（1500ms/3 行）更小，取最大者 |

> 结论：**权威/持久化链的滞后按设计不变**（这是零回归的前提）；显示专用快通道的收益单独由 V9/V17 度量。

---

## ⑤ 三镜像改了什么（逐文件）

### 5.1 Kotlin（真源，`src-tauri/gen/android/.../RunAutoPause.kt` + `RunTrackingService.kt`）

- `RunCore` 新增 `private var segAnchor: GuardPoint?`（`:249`）与 `var dispM`（`:198`，初值 `max(0.0, baselineDistanceM)`，`private set`，与 `distM`（`:190`）同 clamp）。
- `Outcome` 新增 `var dispM`（`:154`），并在 **`onFix` 每条返回路径**（`:442/461/476/493/552`、`handleGap` 末 `:608`）赋 `= dispM`。
- 新增 `fastChannel(f, brk)`（`:363-370`）；插入点 A 常规路径 `:524`、B `handleGap` `:601`；复位点 `settleAutoPause`（`:678`）/`setManualPaused`（`:691`），`enter()`（`:613`）不动。
- 新增呈现常量 `DISP_MIN_M=1.0`（`:90`）、`HERO_METER_MAX_M=100.0`（`:93`）。
- 向量表扩到 **V1..V21**（`:906-1425`），新增 `v9()..v21()` + `enuToLatLon`（`:766`）/`Mulberry32`（`:778`）/四拓扑 2D 生成器（`:790-868`）；`runVectors()`（`:1025-1029`）已含 21 条。
- `RunTrackingService.kt`：`publishLive()`（`:492-512`）追加 `,"dispM":<jnum(c.dispM)>`（`:508`，读 `RunCore.dispM`）；`FLUSH_MS 5000→1500`（`:68`）、`FLUSH_LINES 5→3`（`:67`）；`selfTest` 去掉 `BuildConfig.DEBUG` 门（`:172-179`，单调用点在 `onCreate`、放后台线程）；`seq=` 日志新增 `dispM=`（`:378`）。

### 5.2 Rust（规格镜像，`src-tauri/src/modules/tracking/model.rs`）

- `Core` 新增 `pub disp_m: f64`（`:257`，初值 `baseline_dist_m.max(0.0)`，`:307`）与 `private seg_anchor: Option<(f64,f64)>`（`:289`）。
- 新增 `bump_disp(f,brk)`（`:452`）：`disp_m = max(disp_m, net, steady)`；`seg_anchor` 复位规则同 Kotlin。
- 插入点：常规路径 `:644`、`handle_gap` `:735`；复位 `settle_auto_pause`（`:826`）/`set_manual_paused`（`:846`）；`enter()`（`:751`）不动；`on_fix` 每条返回路径赋 `out.disp_m=self.disp_m`（`:547/570/589/606/644/685`）。
- 新常量 `DISP_MIN_M=1.0`（`:1109`）、`HERO_METER_MAX_M=100.0`（`:1111`）、`V_TOPO=3.0`（`:1116`）、`N_TOPO=101`（`:1117`）。
- 向量表 V9..V21（`:1348-1701`）+ `enu_to_lat_lon`/`Mulberry32`/`gen_turnback|circle|track|straight|random`/`disk_stat`/`disk_stat_jump`/`polyline_len`；`run_vectors()`（`:1703-1727`）覆盖全表。
- **未做**：`mod.rs:34 FALLBACK_LIVE_JSON` **未追加** `,"dispM":0`（实测该串无 `dispM`）——规格 mirrorNotes【Rust·兜底】要求补，本次未落地。

### 5.3 TS（桌面/降级通路）

- **新建** `src/stores/runGate.ts`（1527 行）：把 web 侧防抖/判定/自动暂停/空窗的纯逻辑抽成**零依赖模块**（无 Vue/pinia/window/别名），逐字对齐 K/L 29 常量（`:23-62`）与状态机，并含快通道 `dispM`（`:231`、`bumpDisp` `:449-456`、`segAnchor` `:265/391/693/703`）；补齐 `STALE_SKIP_SEC=5s` 门（`:30/471/493/552/571`）；`runVectors()`（`:1503`）+ `boundSearch()`（`:1289`，5000 组）。
- `src/stores/run.ts`：新增 `const distDisplayM = ref(0)`（`:137`）与 `bumpDisplay`（`:139-140`）；四处出口——`applyLive`（`:625-627`，读 `live.dispM`，防御式可选）、web 常规路径 `bumpDisplay(gate.dispM)`（`:470`）、`seedWebFromNative`（`:720`）；跨 run 归零 `begin`（`:1003`）/`resetLocal`（`:1237`）、`applyRecord` 播种（`:1324`）。web 采集路径整体改由 `RunGate` 承担（`newGate` `:226-228`、`onWebFix` `:511-525`、`gate.setManualPaused` `:1058/1075`）。
- `src/pages/RunPage.vue`：新增单一 computed `heroDist`（`:221-224`：`≥100m → km 2 位；<100m 且 ≥1m → 整数米；否则 '—'`），hero 改为 value/unit **两个同源节点**（`:1191-1192`）；`kmText`（`:213`）与其两个消费者（`:337` splitsHint、`:465` 结束确认）**不动**，快通道不进结算/确认文案。
- **新建** `scripts/run-vectors.mjs`（26 行）：`node scripts/run-vectors.mjs` 直接 import `runGate.ts` 跑 V1..V21，全 pass → exit 0。
- **未做**：`src/services/trackingService.ts:31-63 NativeRunLive` **未加** `dispM` 字段、`:77 FALLBACK_LIVE` **未加** `dispM:0`（run.ts 用 `(live as NativeRunLive & {dispM?:number}).dispM` 逃生读取）；`src/system/workoutRuntime.ts:251/253` 的 `TICK_MS`/`PUSH_MIN_MS` 本轮**未改**（补记 1：主会话后来已改为 1000/1000）。

---

## ⑥ 向量表（新旧去留 + 新条目）

### 6.1 旧向量 V1..V8（保留，口径不变）

| id | 名称 | 实测（我本会话跑出） |
|---|---|---|
| V1 | 停跑 3m/s 20s→静止抖动 8~12s 进入 | `enterDelay=10000ms` `autoPaused=true` |
| V2 | 接 V1 走 2m/s ≥10m 且 ≤11s 退出 | `entered=true exitDelay=10000ms exitCredit=19.9m` |
| V3 | 运行中 6s 无 fix → 不进不出 | `entered=false exited=false` |
| V4 | 手动暂停 30s → 不进 | `entered=false autoPaused=false` |
| V5 | 站立 ±3m 游走 120s → 0 次退出 | `enters=1 exits=0` |
| V6 | 起步即停（3s 收点）约 12s 进入 | `enterDelay=12000ms` |
| V7 | 站立 ±3m 游走 120s → distM≤6 且 jc>0 | `dist=0.0 jc=30` |
| V8 | 直线 3m/s 30 点 → distM≈78m 且 0 校正 | `dist=78.0 jc=0` |

> V7 加固为「distM≤6 **且** jc>0」，绑死 4 点防抖；V8 显式记录依赖 `expect=3×(30−4)=78`（防抖预热丢 3 段）。

### 6.2 新向量 V9..V21（锁快通道时效/下界性、五拓扑、静止族、段首复位、acc 门、不回归锁）

> 记号约定（本节与 §6.3 通用）：`X/Y` = `dispM / comm`（`comm`=稳通道 `distM`）；`>6=N/M` = M 个 seed 中 N 个超 6m。

| id | 名称 | 实测值 |
|---|---|---|
| V9 | 快通道起步时效（直线 3m/s,1Hz,acc5） | `firstDisplay=1000ms`，t=1/2/3s=`3.00/6.00/9.00` |
| V10 | 快通道五拓扑 100s 末值 | 折返`5.0` 绕圈`286.7` 跑道`291.1` 直线`300.0` 随便跑`291.0` |
| V11 | 稳通道四拓扑 ≤5%（100s） | 绕圈`286.7` 跑道`291.1` 直线`291.0` 随便跑`291.0` |
| V12 | 折返 5m@3m/s 100s（documented-fail） | 1Hz 折线`220.0m`、稳`1.1m`、快`5.0m`、稳首个入账`7000ms` |
| V13 | 静止 1D WANDER ±3m 120s | 稳`0.0` 快`2.7` `enters=1` |
| V14 | 静止 2D 圆盘 r=3m 100s×100seed | 稳>6=`0/100`(max4.3)、快>6=`0/100`(max5.7) |
| V15 | 静止 2D 圆盘 r=8m 100s×100seed（documented-fail） | 稳>6=`79/100`(max106.4)、快>6=`100/100`(max106.4) |
| V16 | 静止 2D r=8m+跳变 ×50seed（documented-fail） | 稳>6=`48/50`、快>6=`50/50`(max233.0)、`jumpCount=0` |
| V17 | 刷新节奏（四拓扑）100s 内 dispM 变化 ≥90 | 绕圈`100` 跑道`101` 直线`101` 随便跑`101`（折返`4`，不列入） |
| V18 | 快通道下界性：dispM ≤ 1Hz 折线长度 | `直线300.0≤300.0 绕圈286.7≤295.5 跑道291.1≤301.5`；**超出量 = max(0, dispM−折线) = `0.000`**（5000 组搜索 0 反例；搜索中 `dispM−折线` 的最大值（最接近 0 者）= `−1.821`，即从未为正） |
| V19 | acc 值无关/精度门 | acc5=15=29.9→`291.000`、acc31→`0.000` |
| V20 | 回归锁：精度门/单跳/空窗三分支/手动暂停 | 全 lock（acc35→dropped、100m@1s→jumped、slow/fast/drop、手动不进） |
| V21 | 快通道段首复位（无跨段重复计距） | A ENTER `57.9/57.3`、brk `79.2/79.2`、末 `87.2/87.2`；B 空窗 `46.0=46.0`；C 手停末 `27.0/24.0`（100m 不计入） |

> 注 V16「jumpCount=0」：注入的 +25m(acc25)/+22m(acc28) 位置跳变按设计**落在两道门之内**（acc ≤ `ACC_GATE_M=30`、单步 d ≤ `max(40,8·dt)=40m`），因此被**接受**、不计入 `jumpCount`（`jumpCount` 只统计被单跳门**丢弃**的点）。即「有跳变却 `jumpCount=0`」不矛盾——正因为不被过滤，这 25/22m 漂移才原样体现在两通道末值里。
> 注 V19：`acc5=15=29.9→291.000` 读作「acc 取 5 / 15 / 29.9（均 ≤ 门 30），三次得到的 distM 都是 291.000」；`acc31→0.000` 即被 `ACC_GATE_M=30` 丢弃。
> 注 max 并列：V15/V16 中稳/快两通道 max 相同（106.4 / 233.0），是因为最坏 seed 里段锚点弦长 `net` 未超过 `steady=distM+pendingD`，`dispM=max(steady,net)` 退化为稳通道；σ=5m 高斯族同理（frozen-fastchan 报快 `50/50(max185.2)`、frozen-verify 报稳 `49/50(max185.2)`）。

### 6.3 三镜像同一张表的**落地差异**（本会话静态核对）

数值结论三边一致（我本会话已跑 Rust/TS，见 §7），但**判据容差/覆盖面/字段**存在未收敛项：

| 项 | Kotlin | Rust | TS(`runGate.ts`) |
|---|---|---|---|
| V9 首个非零判据 | `firstNonZero==1000L && firstGe1==1000L`（`:1190`） | `first_nz==Some(1000)`（`:1366`） | `firstDisplay<=2000`（`:1112`） |
| V10 折返锁 | `abs(turnback-5.0)<1.0`（`:1208`） | `(4.5..=5.5).contains(&tb)`（`:1389`） | **无折返锁**，仅 `tb<30`（`:1132`） |
| V19 判据 | 严格浮点相等（`:1340`） | `(d5-d15).abs()<1e-6`（`:1513`） | `±0.5` 区间（`:1357`） |
| V18 5000 组搜索 | 有（`:1316-1325`） | **无** `gen_bound`/搜索（`:1488-1504`） | 有 `boundSearch`（`:1289`） |
| V21 断言 | 锁 enter_comm=57.3、空窗 46.0、手停 comm=24 | 不锁 enter_comm、B 用 52.0、C 不锁 comm=24 | 锁 `57.3/46.0/24.0`（±0.6） |
| 命名（非数值） | `VEC_N`/`VEC_V`（`:759-760`） | `N_TOPO`/`V_TOPO`（`:1116-1117`） | — |

> 均为**容差/覆盖面**差异，**数值结果**三边一致（Rust/TS 实测、Kotlin 静态读码）；但 **V9 时效**与 **V10 折返**这两条的**判据强度未收敛**：TS 的 V9 允 `≤2000ms`、V10 **不锁折返**（仅 `tb<30`）——即规格两大卖点（首个非零 1000ms、折返 5m 边界）在 TS 侧**尚未获得与 Kotlin/Rust 等价的担保**；另 Rust 的 V18 **无 5000 组搜索**。按冻结规格【三镜像浮点对齐】「V9..V21 的 sticky 断言用区间，不得 float 相等」，Kotlin 的严格相等与 Rust 的 1e-6 亦属**待收敛**项。另：Kotlin 侧本轮**未执行**（本机无 java/kotlinc/adb），上表 Kotlin 列为静态读码。

### 6.4 _core.mjs 的取证缺口（材料出处）

规格 limits 指出：`.zcode/tmp/_core.mjs` 常规路径缺 `out.brk`（:146-149），故暂停/恢复路径需用补了 brk 的 `_core2.mjs` 才覆盖（`frozen-brk.mjs` 即用它）。V21 的 brk 数值来自 `_core2.mjs`。**施工前应把 brk 补进 `_core.mjs`**（已收入 §8.0 阻塞项 B-1）。

---

## ⑦ 验证记录（跑过的命令与结果）

### 7.1 本会话实际执行的命令

| # | 命令 | 结果 | 我是否亲跑 |
|---|---|---|---|
| 1 | `node scripts/run-vectors.mjs` | 21 行 pass + `apvector pass=21 fail=0`，exit 0 | ✅ 亲跑 |
| 2 | `cd src-tauri && cargo test --lib tracking -- --nocapture` | `apvector pass=21 fail=0`；`test result: ok. 7 passed; 0 failed` | ✅ 亲跑 |
| 3 | `npx vue-tsc --noEmit -p tsconfig.app.json` | 无输出，`TYPECHECK_EXIT=0` | ✅ 亲跑 |
| 4 | `node .zcode/tmp/frozen-fastchan.mjs` | 折返`5.0/1.1` 绕圈`286.7` 跑道`291.1` 直线`300.0/291.0` 随便跑`291.0`；静止族 `r=3m 0/100(max5.7)`、`r=8m 100/100(max106.4)`、`σ5m 50/50(max185.2)`、`r=8m+跳变 50/50(max233.0)`；起步 t=1/2/3s `3/6/9` | ✅ 亲跑 |
| 5 | `node .zcode/tmp/frozen-brk.mjs` | EXIT 后 brk `dispM=79.2=comm`、末 `87.2/87.2`；空窗 fast `46.0=comm`；手停末 `27.0/24.0` | ✅ 亲跑 |
| 6 | `node .zcode/tmp/frozen-verify.mjs` | 稳通道首个非零 绕圈/跑道/直线`4000ms`；静止 `r=8m 79/100`、`σ5m 49/50`；折返 1Hz/2/5/10/20Hz 折线 `220/260/284/292/296m` | ✅ 亲跑 |
| 7 | `node .zcode/tmp/review-fastchan-bound.mjs` | `dispM 超折线最大值: 0.000`、`steady 超折线最大值: 0.000` | ✅ 亲跑 |
| 8 | `node .zcode/tmp/topo-audit.mjs` | 见 §2.2 | ✅ 亲跑 |
| 9 | `node .zcode/tmp/sim.mjs` | `final distM=108.00m physical@lastFix=117.00m missing=9.00m = 3.00 fixes` | ✅ 亲跑 |
| 10 | `node .zcode/tmp/lag.mjs` | 均匀 dt：1Hz→`maxLag=3000ms=3.00 fixes`、300ms→1800ms、2s→6000ms（**脚本只跑均匀 dt，无 1Hz±50ms 抖动分支**） | ✅ 亲跑 |
| 11 | `node .zcode/tmp/lag-probe.mjs` | 稳通道滞后点数全 3、快通道全 0；`distM 首次非零于 i=4`、`dispM 于 i=1` | ✅ 亲跑 |
| 12 | `node .zcode/tmp/lag-probe2.mjs` | 1Hz：窗口附加=0；2Hz(500ms)：附加=`0/500` 交替（最坏 500ms） | ✅ 亲跑 |

### 7.2 合闸状态（来自本轮 workflow，非我执行）

交办材料给出：`cargo=true`、`typecheck=true`、`前端向量表=true`、`安卓构建=true`。
- 其中 `cargo` / `typecheck` / `前端向量表` 我本会话**独立复跑并确认**（上表 #1/#2/#3）。
- **安卓构建（Gradle/APK）我未跑**（本机无 java/kotlinc/adb，`where` 全部未找到），按材料记为「闸门报告已通过，本轮未复核」。

### 7.3 真机取证

**跳过**：无 adb 在线设备（手机没连上）。以下均**未执行**：
- `adb logcat -s ReinRunTrack` 看 `apvector pass/fail` 与 `seq=` 行的 `dispM=`；
- 通知 1Hz 刷新是否被系统节流；
- 熄屏/切后台连续性、折返/绕圈真机误差。

### 7.4 工具环境（本机实测）

```
java: (none)   javac: (none)   kotlinc: (none)   adb: (none)   node: v26.4.0
```

---

## ⑧ 没验到的清单与如何自己复看

### 8.0 开工前阻塞项（集中，避免散落）

| # | 项 | 现状 | 出处 |
|---|---|---|---|
| B-1 | `.zcode/tmp/_core.mjs` 补 `out.brk` | 缺（暂停/恢复路径只有 `_core2.mjs` 覆盖） | §6.4 |
| B-2 | `trackingService.ts`：`NativeRunLive` 加 `dispM`、`FALLBACK_LIVE` 加 `dispM:0` | 未加（run.ts 靠 `(live as ...).dispM` 逃生） | §5.3 / §8.1-5 |
| B-3 | `mod.rs:34 FALLBACK_LIVE_JSON` 加 `,"dispM":0` | 未加 | §5.2 / §8.1-6 |
| B-4 | `workoutRuntime.ts`：`TICK_MS 2000→1000`、`PUSH_MIN_MS 5000→1000` | **已落地**（补记 1） | §3.5 / §8.1-4 |
| B-5 | V9/V10 判据强度三边收敛（TS `≤2000`→`==1000`、补折返锁；Kotlin/Rust 容差改区间；Rust 补 V18 5000 组搜索） | 未收敛 | §6.3 |
| B-6 | 真机取证（`apvector` / `dispM=` / 通知节流） | 未跑（无设备） | §7.3 / §8.3 |

### 8.1 没验到的清单

1. **Kotlin 侧**：本报告写作时本机 PATH 上无 java/kotlinc/adb，`RunAutoPause.kt` 的 V1..V21 与 `RunTrackingService.kt` 未编译/未运行；§6.3 的 Kotlin 列是**静态读码**。实现者自述其在 Android Studio JBR21 + kotlinc 下编译并跑出 `apvector pass=21 fail=0`（**补记 1 已由主会话独立复核**：用 Android Studio 自带 kotlinc 编译 `RunAutoPause.kt` + 一个只调 `selfTest()` 的 main，跑出 `apvector pass=21 fail=0`；仍未做的是 `RunTrackingService.kt` 的编译与真机运行）。
2. **安卓构建/APK**：未跑。
3. **真机一切**：无设备（§7.3）。
4. **通知 1Hz 刷新**：常量已落地（补记 1，现值 1000/1000 → 数字类最坏 ≤2000ms）；**但真机未验**——系统是否对 1Hz 通知更新节流、锁屏上是否真能看到数字在跳，仍需实机确认。
5. **`trackingService.ts` 的 `dispM` 字段**：未加（run.ts 用逃生读取）；规格要求的类型字段是**编译期望**，当前靠防御式读取通过 typecheck。
6. **`mod.rs FALLBACK_LIVE_JSON` 的 `dispM`**：未加。
   **但运行链路不受这两处影响**：native 的 live JSON 由 Kotlin 侧发出 `dispM`（`RunTrackingService.kt:508`），Rust `android_live` 缓存的是**原始字符串**（`mod.rs:374-384`）、`tracking_live` 原样返回，前端 `applyLive` 从解析后的对象读 `dispM`（`run.ts:625-627`）——接口字段只是**类型层**缺口，不阻断运行时。桌面/无缓存兜底（`FALLBACK_LIVE`/`FALLBACK_LIVE_JSON`）没有 `dispM` 时，`run.ts` 退回 `live.distanceM`（即稳通道，退化为旧行为，不崩）。
7. **run-vectors 的 fail→exit1 分支**：只跑过全通 exit 0（`process.exit(failed===0?0:1)` 为直读代码）。
8. **`_core.mjs` 补 brk**：仍缺，暂停/恢复路径只有 `_core2.mjs` 覆盖。

### 8.2 如何自己复看（命令）

```bat
:: 三镜像向量表
node scripts\run-vectors.mjs                         :: 期望 apvector pass=21 fail=0（exit 0）
cd src-tauri && cargo test --lib tracking -- --nocapture  :: 期望 7 passed; 0 failed 且 apvector pass=21
npx vue-tsc --noEmit -p tsconfig.app.json            :: 期望无输出（exit 0）

:: 独立取证脚本（node v26）
node .zcode\tmp\frozen-fastchan.mjs                  :: 快通道五拓扑/静止族/起步
node .zcode\tmp\frozen-brk.mjs                       :: 暂停/空窗段首复位（用 _core2.mjs）
node .zcode\tmp\frozen-verify.mjs                    :: 稳通道首个非零/静止族/折线采样率
node .zcode\tmp\review-fastchan-bound.mjs            :: 下界性 0 反例
node .zcode\tmp\topo-audit.mjs                       :: 拓扑审计
node .zcode\tmp\sim.mjs                              :: 防抖滞后=3 fixes（missing=9.00m）
node .zcode\tmp\lag.mjs                              :: 延迟链：均匀 dt 下的总滞后
node .zcode\tmp\lag-probe.mjs                        :: 稳 3 点 / 快 0 点滞后
node .zcode\tmp\lag-probe2.mjs                       :: 1s 聚合窗附加滞后
:: haversine 浮点差取证：port_hav.rs / port_hav.mjs（产物 hav_rust.txt / hav_node.txt，2359/200000 处 1~2 ULP 差）
```

### 8.3 如何自己复看（真机操作步骤）

```bat
:: 1) 装包（覆盖安装保留数据；APK 由闸门构建产出）
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk

:: 2) 采集器日志：看 apvector 行 + 每条 seq= 的 dispM=
adb logcat -s ReinRunTrack
::    期望：apvector pass=21 fail=0；seq= 行含 dispM=<m>
::    关注：gap=slow|fast|drop、jitter turn=... jc=...、apcheck in=/3 out=/2

:: 3) 通知渲染
adb shell dumpsys notification --noredact | findstr /C:"com.gozaoo.rein"
::    看数字类是否 ≤1s 刷新；被系统节流则回落 TICK_MS=1500 并把该验收降级为 ≤1.5s

:: 4) 前台服务/进程存活
adb shell dumpsys activity services com.gozaoo.rein
```

**手机侧操作**：
1. 开跑后立刻看 hero 距离：任意 v≥1 m/s 应在 **1s 内**出现非零（`<100m` 显整数米，`≥100m` 显 km 2 位）。
2. 直线/绕圈/跑道/随便跑：距离数字应**每 1s 变化一次**（不必等 4s）。
3. 折返（小幅度来回）：hero **会卡住**（dispM 值几乎不变）——这是已知边界（§9），不是卡死。
4. 站立不动：距离不涨（≤6m），8~12s 后进入自动暂停。

---

## ⑨ 能做到与做不到的边界

### 9.1 能做到（有实测证据）

- **首个非零显示 1000ms**：V9 **实测@直线 3m/s**（`firstDisplay=1000ms`、t=1/2/3s=`3.00/6.00/9.00`）；「任意 v≥1 m/s」为**推理**（hero 用 `<100m 显整数米` + `DISP_MIN_M=1.0`，见 §3.6 注），未跑 v=1/1.5/2 变体。
- **显示值刷新 ≤1s（四拓扑）**：绕圈/跑道/直线/随便跑 100s 内变化 `100/101/101/101` 次（V17 实测）。
- **下界性**：`dispM ≤ 1Hz 折线长度`，5000 组随机走位 0 反例（V18；`review-fastchan-bound.mjs` 最大超出 0.000）。
- **零回归（本改造）**：29 常量与状态机一字未改（读码），V1..V8 当前值见 §6.1（Rust 我实测：V1=10000、V2=10000/19.9、V6=12000、V7=0.0/jc30、V8=78.0/jc0；V3/V4/V5 见 §6.1）。
  **诚实边界**：不存在「本改造前」的 V1..V8 数值基线可对照（无法运行改造前代码），「未变」的依据是**代码未动**这一读码事实 + 材料断言，**不是前后两次实跑对照**。另：更早一版报告 `docs/RUN-MODE-REWORK.md:106` 记 V1=8000ms、V2=6000ms/12.0m，那是**加入 4 点防抖之前的年代**，不能当本轮基线。
- **TS 已纳入同表同值（有限度）**：`STALE_SKIP_SEC=5s` 门已补（`runGate.ts:471`）、有 vector runner（`scripts/run-vectors.mjs`），故 TS 现已可跑同一张 V1..V21；但 V9/V10 判据强度与 Rust 的 V18 覆盖面仍有未收敛项（§6.3），故只算「同表同值、判据未完全等价」。
- **轨迹文件落盘 ≤1500ms**：`FLUSH_MS=1500`/`FLUSH_LINES=3` 已落地（读码）。

### 9.2 做不到（物理/信息上限，如实报告）

1. **折返 5m ≤5%**：1Hz 采样折线只 `220.0m`（真值 300，**−26.7%**）；实测 2/5/10/20Hz → `260/284/292/296m`，即 **5Hz 仍 −5.33%（不达标）**，要到 **>5Hz（约 5.3Hz 起）、10Hz 才 −2.7%**。但即便提高采样率，4 点方向防抖仍按设计抹平 180° 掉头（稳通道实测 1.1m / 快通道 5.0m），去掉防抖则 r≥8m 与折返更差。**结论：1Hz + 现有防抖下不可能；单纯提采样率也不解决防抖抹平。**
2. **折返场景「显示值刷新 ≤1s」**：`frozen-fastchan.mjs` 实测折返 dispM 值变化仅 **4/100**（卡在 ≤5.0m）。该验收**只在绕圈/跑道/直线/随便跑成立**；折返不成立。
3. **静止「±8m 游走」≤6m**：2D 圆盘 r=8m 100s×100seed，稳通道 `79/100` 超（max 106.4）、快通道 `100/100`；加偶发 +25/+22m 跳变（过 30m 门与单跳门）→ 稳 `48/50`、快 `50/50`（max 233.0）。**做不到。**（这是稳通道算法固有限制，**非本改造引入**——29 常量与防抖一字未改；对真实用户而言，口袋抖动若达 ±8m 量级即会明显虚增。）
4. **位置噪声 σ≈acc 时静止 ≤6m**：每步高斯 σ=5m 的静止 100s×50seed，稳通道 `49/50` 超（max 185.2、均值 99.5）。5m 精度下分辨 1m 位移物理不可能：逐点判据下界是单步 ≳2σ√2≈**14m**。
5. **入账 distM 相对真值位置滞后 ≤2s**：实测 ≈**4000ms**（3 点防抖 + ≤1s 聚合）。要 ≤2s 必须缩/取消防抖，与「静止 ≤6m」冲突。
6. **15m 报告精度**：本族不消费 acc 数值（V19）；干净几何与 5m 同值，真机噪声随 acc 放大后与第 4 条同因失败。
7. **UI 单位分辨率**：hero 用 2 位小数公里时，数位变化要 `dispM ≥ 5m`（0.005km）→ 3m/s 下 t=2s、2m/s 下 t=3s；折返永远不到 5m → 恒显 `—`。故本 spec 把 hero 改为 `<100m 整数米`（§5·RunPage.vue），才能满足「任意 v≥1 m/s 时 ≤2s 出现非零数位」。
8. **通知 1Hz 刷新**：常量已落地（补记 1），但真机验系统节流仍未做。

### 9.3 明确不做的改动（为什么）

- `JITTER_WINDOW=4` / `JITTER_MAX_TURN_DEG=90`：不改，是静止 ≤6m 在 **r≥8m/σ≈acc 噪声量级/折返**场景下的主要来源（§2.2；本报告未做关掉它的 ablation，故不主张「唯一」）。
- L4 1s 窗 + `DIST_FLOOR_MPS=0.5`：不改，V2/V8 口径绑定。
- 采集 1Hz：不改；提高采样对折返无独立收益（方向防抖仍抹平 180°），净收益 0。
- 会话快照落盘节奏（`run.ts:1045`/`:430-437`）：不改，它是崩溃恢复上限，不是入账滞后。
- `kmText`（`RunPage.vue:213`）与其消费者（`:337`/`:465`）：不改，快通道不得进结算/确认文案。

### 9.4 三镜像浮点对齐

`dispM` 只用 haversine + max；共用 haversine 在 Node/Rust 有 1~2 ULP 差（`.zcode/tmp/port_hav.mjs`（Node）与 `.zcode/tmp/port_hav.rs`（Rust，产物 `.zcode/tmp/hav_node.txt` / `hav_rust.txt`）在 2359/200000 处不一致），故 V9..V21 的 sticky 断言用区间（±0.5m 或 [285,315]），**不得 float 相等**。§6.3 的 Kotlin 严格相等 / Rust 1e-6 属待收敛项。

---

## 补记 1：通知节拍落地 + Kotlin 自测复核（本报告之后）

本报告写作时 `TICK_MS`/`PUSH_MIN_MS` 仍是 2000/5000（§3.5「未落地」），Kotlin 侧未复核。报告交付后由主会话补齐：

| 项 | 改动 | 证据 |
|---|---|---|
| `TICK_MS` | 2000 → **1000** | `src/system/workoutRuntime.ts:251`（现值实读 1000） |
| `PUSH_MIN_MS` | 5000 → **1000** | `src/system/workoutRuntime.ts:253`（现值实读 1000） |
| Kotlin 自测复核 | 21/21 pass | Android Studio 自带 kotlinc 编译 `RunAutoPause.kt` + 只调 `RunAutoPause.selfTest()` 的 main → `apvector pass=21 fail=0`（V1..V21 逐条 pass，含 documented-fail 的 V12/V15/V16） |

- 效果口径：通知栏数字类更新最坏由 **7000ms**（2000 比较拍 + 5000 节流）降到 **2000ms**（1000 + 1000）；结构类（相位 / 自动暂停 / 文案骨架）仍下一拍即推，心跳兜底 `PUSH_HEARTBEAT_MS=15000` 不变。
- §4.2 的「最坏合计」随之由 23516ms 更正为 **18516ms**（`23516 − 7000 + 2000`）。
- 复核命令：`npm run typecheck` 退出 0；APK 按新常量重建。
- **仍未验**：系统是否对 1Hz 通知更新节流、锁屏上是否真能看到数字在跳 —— 需真机（§8.2-3）。
- 范围说明：§5 的「未做」清单是**本轮实现者**当时的记录；补记 1 之后这两处节拍常量不再是缺口，**其余缺口仍然存在**（`dispM` 类型字段未加、`mod.rs` 兜底串未加、V9/V10 判据未收敛、折返 documented-fail）。

---

## 附：本报告的诚实边界

- **真机一切未验**（无 adb 设备）：`apvector` 真机行、通知 1Hz、熄屏连续性、真机拓扑误差——均未执行。
- **Kotlin 侧**：报告写作时为静态读码（本机无 java/kotlinc/adb）；**补记 1 已由主会话独立复核**（Android Studio 自带 kotlinc 编译 `RunAutoPause.kt` → `apvector pass=21 fail=0`）。`RunTrackingService.kt` 与真机仍未执行。
- **Rust / TS / typecheck 为我亲自跑通**（§7.1 #1/#2/#3），是「机器验过」的部分；§7.1 #4~#12 的取证脚本亦为我亲跑。
- **代码级推算**：延迟链（§4）、快通道插入点、镜像差异（§6.3）——均为读码 + 脚本推演，非真机。
- 凡标「未跑」「未落地」的，就是没做，不要当成通过。
