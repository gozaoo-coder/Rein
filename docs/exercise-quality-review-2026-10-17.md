# 全运动系统质量审核 · 专家团流程（2026-10-17）

> 门槛：**任何专家结论都必须回源码复核后才计入清单**。本轮已驳回 1 条（见「被驳回的指控」）。
> 复核命令：`npm run typecheck` / `npm run lint` / `npm run contract`（本轮三者全绿）。

---

## 1. 工作流（三层）

| 层 | 谁 | 做什么 | 产出 |
| --- | --- | --- | --- |
| L1 侦察 | 并行 explore 代理 | 把运动系统的**数据层 / UI 层 / agent 基建**分别测绘成地图（表结构、纯函数、组件清单、IPC 契约） | 文件级地图，供 L2 定向阅读 |
| L2 专家评审 | `cmdc -p --permission-mode plan`（**只读**，3 条并行） | ① 训练学（S&C）② 交互/UX ③ UI/视觉规范，各自按固定表格输出「问题 / 证据 / 建议改法 / 优先级」 | 3 份专家报告 |
| L3 主审 | 本代理 | 逐条复核证据 → 分级 → 落地修复 → 跑校验 → 回写本文件 | 修复 + 清单 |

三条硬纪律：

1. 专家代理一律 `--permission-mode plan`（只读、无副作用），且被要求「宁可少列，不可列假问题」；
2. **专家结论不是结论**，只有能给出真实行号引用或「具体输入 → 当前输出 → 期望输出」反例的条目才进清单；
3. 训练学改动必须同时更新文件头的科学依据注释 —— 这个仓库把公式出处写在代码里，注释与实现漂移本身就是缺陷。

> ⚠️ 运行注意：`cmdc -p` 在**后台**模式下输出不被捕获（日志恒 0 字节）。必须前台运行才能拿到报告；
> 一次给太多文件会超出 `--max-turns` 而失败，分量要小。UI 专家本轮 600s 超时未交付，下轮拆分重跑。

---

## 2. 本轮已修复（5 项，均已过 typecheck / lint / contract）

### A1 · 高次数把 e1RM 算成 Infinity / 负数 / 36 倍工作重量

`src/utils/trainingAdvice.ts` · **阻断级** · 全端 1RM 的唯一入口（曲线、PR、下次建议基线都吃它）

```js
// Before：reps > 12 直接进 Brzycki，分母 (37 − r) 在 r≥37 时归零/变负
if (reps > 12) return (weightKg * 36) / (37 - reps)
// After：超过可估区间一律「不可估」
export const MAX_E1RM_REPS = 20
if (reps > MAX_E1RM_REPS) return 0
if (reps > 12) return (weightKg * 36) / (37 - reps)
```

反例（实测，`weightKg=20`）：`reps=36 → 720kg`、`reps=37 → Infinity`、`reps=40 → −240kg`。
用户可见路径：一次 37 次的腿弯举会让重量建议说明抽屉显示「今日极限 ≈ **Infinity** kg」，
并让 `strengthStats` 的 e1RM PR 记下一个 720kg 的历史最高。

上限取 20 的理由（写进代码注释）：r=20 时 Brzycki 给 2.12×，与经典 rep-max 表
（20 次 ≈ 50% → 2.0×）相差约 6%；再往上误差超线性放大，而 20 次以上已属肌耐力范畴。

### A2 · 该动作「本周组数」的窗口多算了一天

`src/utils/trainingAdvice.ts` · 中 · 与练够分同概念却不同窗口

```js
// Before：[today−7, today] = 8 个日历天
const windowStart = shiftDate(today, -volumeDays)
// After：[today−6, today] = 7 个日历天，与 trainingScore.SCORE_WEEK_DAYS 同口径
const windowStart = shiftDate(today, -(volumeDays - 1))
```

`compareTrainingScore` 侧用的是 `addDays(today, -(SCORE_WEEK_DAYS - 1))`（`trainingScore.ts`），
两边对同一节课会给出两个不同的「本周 X 组」，差一天足以跨过 MEV/MAV 档位边界。

### A3 · 上次那一组「不可估」时，e1RM 差值会伪造成巨大 PR（A1 的连带）

`src/utils/sessionSummary.ts`

```js
// Before：基线取 0，于是「本次 − 0」= 本次全值，凭空一个 e1RM PR
r.e1rmDelta = round1(r.bestE1rm - estimateOneRepMax(r.lastWeightKg, r.lastReps))
// After：基线不可估 = 没有基线，不给差值
const lastE1rm = estimateOneRepMax(r.lastWeightKg, r.lastReps)
if (lastE1rm > 0) r.e1rmDelta = round1(r.bestE1rm - lastE1rm)
```

A1 落地后这条路径才出现（旧代码里 25 次的上次给 3.0×，delta 恒为负、不会报 PR），属必须同时收紧的连带改动。

### A4 · 稳定档（激活 1）的频率口径：有氧与力量不对称

`src/utils/aerobicLoad.ts` · 中 · **快走一次会把核心记成「今天练过」**

```js
// Before：所有档位都记频率日
cur.days.add(w.date)
// After：只收辅助及以上，与 trainingScore.ts 力量侧 if (lv >= 2) 同口径
if (lv >= 2) cur.days.add(w.date)
```

力量侧刻意只让 `lv >= 2` 的组记频率日（注释：稳定肌群不该被算作「今天专门练过核心」），
而有氧侧无条件记。触发例：`walk` 的激活表含 `abs: 1` → 核心拿到频率 1 次（频率分 55）；
同样只被 level-1 顺带刺激的核心走力量路径却记 0 次、被判「不够」并要求加练。
**组数照计**（稳定档折算 0.25 组），只是不再冒充一次专门训练。

### A5 · 六段档位阈值有两份来源

`src/utils/trainingScore.ts` · 低 · 漂移风险

`config/muscles.SCORE_BANDS` 与 `scoreBandOf` 各硬编码了一遍 0/40/60/75/90/100。
而 `TrainingScoreSheet.vue:295` 的图例渲染的正是 `SCORE_BANDS`、并靠
`b.label === current.band` 点亮当前档 —— 两边数字漂移会让某一档**永远点不亮**。
改为查表（`SCORE_BANDS.find(b => score >= b.min)`），不再重抄数字。

---

## 3. 被驳回的指控（复核后不计入）

**「1RM 公式的切换方向反了，r>10 时应改用 Epley」** —— 事实部分成立，结论不成立。

- 成立的事实：两式在 **r=10 交叉**（同为 1.333×），r>10 时 Brzycki 一律更高
  （r=20：Epley 1.667 vs Brzycki 2.118）；所以代码注释写的理由「**高次数下 Epley 高估**」
  与事实相反 —— 切到 Brzycki 是**抬高**估值，不是压低。
- 不成立的部分：专家用「两式互比」当判据，得出「Epley 在 13–20 次更准」。
  对照经典 rep-max 百分比表（*20 次 ≈ 50% 1RM*，即 2.0×），Brzycki 给 2.12×（+6%），
  Epley 给 1.67×（**−17%**）；r=1 时 Brzycki 精确给 1.000×，Epley 给 1.033×。
  Brzycki 本就是那张表的反函数，用它在高次数端是对的，**Epley 才是被换掉的那一支**。

**处置**：不改公式，只把错误注释改成事实（含交叉点与「抬高而非压低」的说明），
并把 A1 的上限注释补上「20 是这条曲线还站得住的最后一格」的标定理由。

---

## 4. 待决 / 未落地

### 4.1 本轮新发现（口径取舍类，需决策）

| # | 优先级 | 位置 | 现象 |
| --- | --- | --- | --- |
| B1 | P2 | `stores/session.ts`（`ex.reps ?? 0`）· `sessionSummary.ts:215`（`?? 0`）· `WorkoutDetailDrawer.vue:464`（`row.reps ?? 1`） | 有重量无次数时，同一节课的容量在三处给出不同值（前两处 0，详情抽屉按 1 计）。三处都有各自的注释，属**口径取舍**不是笔误，需先定「未知次数算 0 还是算 1」再统一 |
| B2 | P2 | `trainingScore.ts` | 重量分：本周 `avgWeight` 按激活档加权，4 周基线 `baseWeight` 是简单平均。同一评估组的组来自不同激活档（「肩」同时吃肩推 level 3 与卧推 level 2）时两边不同口径 |

### 4.2 交互/无障碍（专家 L2 交付，已附行号，待落地）

| # | 优先级 | 位置 | 现象 |
| --- | --- | --- | --- |
| B3 | **P0** | `MainActivity.kt` 无 `onBackPressed`；`SessionOverlay.vue` 全篇无 `keydown` | 全屏沉浸层没有「返回这一层」的语义：Android 硬件返回会走 WebView 历史或退出 App（都不会收起训练），桌面 Esc 也无人接管 —— 而 `AppMenu` / `SheetModal` / `ReadinessDialog` 都处理了 Esc |
| B4 | **P0** | `SessionOverlay.vue:1479` | **✅ 第七轮已落地主体**（见 §12.1）：沉浸层不是无障碍意义上的模态 —— 根节点无 `role="dialog"` / `aria-modal`、焦点不进层，底部 `TabBar` 未被 `inert`。**`inert` 那半边仍未做**，见 §12.2 |
| B5 | P1 | `session.ts:749`·`RunTrackingService.kt:162`（`IMPORTANCE_LOW`） | 核心循环无非视觉反馈：完成一组 / 休息归零 / 3·2·1 倒数既无震动也无声音。Manifest 已有 VIBRATE 权限，仓库在 todo 时间线已用过 `navigator.vibrate(8)` —— 健身房场景手机常不在手里 |
| B6 | P1 | `SessionOverlay.vue:1310`（可点组格）与 `:1329`（具名主按钮） | 同一块坞里，组格当前格与主按钮做**同一件事**（完成本组）。进度指示器兼任主操作，误触即 `completeSet()` 直接进休息，撤销要进「更多 → 上一组」 |
| B7 | P2 | `SessionOverlay.vue:221`（`CAP_H=36`）· `SessionCourseDrawer.vue:375/317` | 触控目标不一致：全仓其它地方很讲究 44（步进钮 44、菜单项 44、抽屉关闭热区 44），而顶栏三枚胶囊 36px、抽屉 `···` 32×32、`更换` 胶囊约 28 高 |
| B8 | P2 | **✅ 第五轮已落地**（见 §10.2）`SessionOverlay.vue:1201`·`CountdownOverlay.vue:82` | 休息倒数与 `flashOverlay` 闪现提示均无 `aria-live` / `role="timer"`，视障用户听不到节奏推进 |

### 4.3 上一轮已验证、仍未落地（`docs/MOTION-MODE-EXPERIENCE.md` §5）

按该文档自述，R1 / R2 已落地，**R3–R14 全部只有设计**。其中与训练质量最相关的：

| # | 严重度 | 一句话 |
| --- | --- | --- |
| R4 | **high** | **✅ 第三轮已落地**（见 §7.2）换动作身份不进快照：接管后动作回退，且已按新动作做完的组以**原动作** `exerciseId` 落库（与 §4「`exercise_id` 是曲线聚合键」冲突） |
| R6 | **high** | **✅ 第三轮已落地**（见 §7.2）拉课程列表失败被当成「课程已删」→ 整场会话静默作废，已完成组的唯一副本丢失 |
| R3 | 中 | **✅ 第二轮已落地**（见 §6.1）换动作后不重算建议，新动作沿用**被换掉动作**的处方重量，「今日建议」整行消失 |
| R9 | 中 | **✅ 第二轮已落地**（见 §6.1）坞内组格按完成数定位，跳过一组后 ✓ 整体前移一格，错落在写着「跳过」的那格上 |
| R7 | 中 | **✅ 第五轮已落地**（见 §10.1）恢复时 `setIndex` 只保底不封顶，且 `doneCount` 遍历全部键、`buildSetRows` 只遍历当前课程动作 |
| R11 / R14 / R10 | 低–中 | summary 无「回到训练」入口 / 沉浸页滚动反馈接错容器（挂到 window） / 收起形变期未真摘折射（缺 `!important`） |
| R13 | 低 | **✅ 第五轮已落地**（见 §10.1）抽屉菜单标题 / 跳转提示用旧动作名 |
| R12 | 中 | **✅ 第三轮已落地**（R6 的连带，见 §7.2）冲突分支按显式信号判定，且不清掉跑步指引 |

---

## 5. 第一轮的下一轮计划（已在 §6 执行）

1. ~~重跑 UI 专家~~ → 见 §6.1（拆批 + 后台写文件规避输出捕获失败）
2. ~~落地 R9 / R3~~ → 见 §6.2
3. ~~复核 R1 / R2~~ → 见 §6.3（**已确认落地**）
4. B1 / B2 → 仍未动语义，见 §6.4

---

## 6. 第二轮（2026-10-17 续）

### 6.1 UI 专家批次 A（已交付，14 条，全部带行号）

**运行方式的修正**：`cmdc -p` 在**后台**模式下输出不被捕获（日志恒 0 字节），改用
`powershell` 后台 + `cmdc -p ... *> <文件>`。注意 PowerShell 5.1 的 `*>` 写的是 **UTF-16**，
读之前要先 `Get-Content -Raw | Set-Content -Encoding UTF8` 转码，否则中文全成乱码。

本批只给了 8 个文件（SessionOverlay / SessionCourseDrawer / SessionSummaryPane /
SessionBigNumberInput / SessionGlassButton / ActiveWorkoutBar / ReadinessDialog / common/SheetModal），
因此这次没有超时。专家自述「曲线选择 / 进出路径 / `scale(0)` / reduced-motion / 图标钮
aria-label 均未发现违规」——即零个 P0 的方法论硬伤。

### 6.2 本轮已修复（10 项，均过 typecheck / lint / contract）

**行为类（用户可感）**

| # | 位置 | 改法 |
| --- | --- | --- |
| 1 | `SessionOverlay.vue` 坞内组格 | **R9**：改读 store 的 `setSlots`（与顶栏「n/N 组」胶囊、全课抽屉同源），每格按自己的状态渲染 `done / skipped / cur`；删掉 `curTile` / `workingDone` 那套「已完成数前推」。跳过格用 `.dtile.skipped`（`opacity: --disabled-opacity` + 组号划掉），与抽屉 `.setrow.is-skipped` 同一套语言 |
| 2 | `session.ts` `swapExercise` | **R3**：`weightKg` 显式改取**新动作**在库内的 `defaultWeightKg`（库内没有就置空，不再继承被换动作的处方重量）；`Promise.all([mergeLastWeights([新id]), loadAdvice()])` 异步补齐，落地后在「仍是同一个动作且用户没改过重量」时才把预填升级为个性化建议 |
| 3 | `session.ts` 新增 `mergeLastWeights` | 定向补取上次做组重量并**合并**进表。与原 `loadLastWeights` 的唯一区别是写入方式 —— 原函数整表替换，中途补一个动作会把它其它动作的上次重量全部清空 |

**颜色档位类（tokens.css 契约：「必须读出来的信息都不该放在 `--text-3`」）**

| # | 位置 | Before → After |
| --- | --- | --- |
| 4 | `SessionSummaryPane.vue` `.stlabel` | 四格数值的标签名（容量/用时/消耗/每组耗时）`--text-3` → `--text-2` |
| 5 | `SessionCourseDrawer.vue` `.pmeta` | 「已完成 n/N 组」`--text-3` → `--text-2`（顶栏同义的胶囊本就是 `--text-2`） |
| 6 | `SessionCourseDrawer.vue` `.excount` | 每个动作的「2/4 组」`t-3` → `t-2`（旁边 `.exsub` 才是补充说明，留 `--text-3`） |
| 7 | `SessionBigNumberInput.vue` `.wunit` | 大数字的单位（kg/次）`--text-3` → `--text-2`：15px 不属于 WCAG 的 large text，`--text-3`（3.6:1）在这个字号上过不了 AA，而单位是必读的 |

**字号令牌化（`tokens.css`：阶梯外禁止裸字号）**

| # | 位置 | Before → After |
| --- | --- | --- |
| 8 | `SessionOverlay.vue` `.actname` | `40px` → `var(--fs-display-m)`（同值，桌面壳降阶梯时跟随） |
| 9 | `SessionSummaryPane.vue` `.herofallback` / `.stval` / `.expr` | `40px` → `--fs-display-m`；`19px` → `--fs-title3`；**`10px` → `--fs-micro`**（10px 破了 11px 的字号下限 R4，而它正是「这一行有 PR」的唯一文字标记） |

**触控命中区（视觉不动，用 `::after` 撑到 44）**

| # | 位置 | Before → After |
| --- | --- | --- |
| 10 | `ReadinessDialog.vue` `.rd-x` | 28×28 → 44（仿 `SheetModal.vue` 的 `.close::after{inset:-7px}`）；`SessionCourseDrawer.vue` `.morebtn` 32×32（还带 `-4px` 负 margin，实际更小）→ 44；`ActiveWorkoutBar.vue` `.abtn` 高 38 → 44（浮条总高不变，只撑热区） |

**动效**

| # | 位置 | Before → After |
| --- | --- | --- |
| — | `SessionSummaryPane.vue` `.sumpane` | `animation: fadeUp var(--dur-sheet)`（420ms）→ `var(--dur-base)`（250ms）：它与 `SessionOverlay` 的 `.pane` **共用同一组 keyframes**，那里是 250ms（注释写明「组间切换每天数十次，420ms 跟不上手速」）。同组 keyframes 两个时长本身就不成立，且 `--dur-sheet` 是抽屉面板的令牌、语义对不上 |

### 6.3 R1 / R2 复核（结论：**确实已落地**）

不采信文档自述，回代码核对：

- `session.ts:611` `useToast().toast(\`开课失败：…\`)` 后原样抛 —— R2 的可见回执在 store 里；
  `PlanRecentCard.vue:40`、`MuscleCatchupSheet.vue:187` 均有「由 store 负责提示」的 catch；
- `finishError` 已成型并有三处消费：`session.ts:1142/1175` 写入、`:1157` 「已保存，但统计刷新失败」
  与非阻塞刷新分离、`SessionOverlay.vue:1028-1029` 优先于 `persistError` 展示、`run.ts` 同构、
  `RunPage.vue:1076` 有对应警示条。

**仍未做**：`PlanDetailPage.vue` / `HomeFooter.vue` 两个调用点依旧只 try/finally 无 catch
（文档 §6.1 已自述，属既有行为、非本轮引入）。

### 6.4 仍未落地 / 待决

- **B1 / B2 未动语义**（容量三处回落口径 0 / 0 / 1；重量分基线加权不对称）—— 属口径决策，
  先出提案再改，见 §4.1。
- **B3–B8 交互/无障碍六条全部仍在**（返回层语义、`aria-modal`/`inert`、震动/声音、
  组格兼任主按钮、顶部胶囊 36px、`aria-live`）。
- **R4 / R6 / R7 / R10–R14 仍未落地**（R4/R6 为 high，见 §4.3）。
- 本轮 UI 批次留下的 **P2/P1 未改项**（附专家原判据）：
  - `SessionOverlay.vue` `.restnum: 76px` / `.timernum: 64px`、`SessionSummaryPane.vue` `.heropct: 30px`
    —— **没有对应令牌，且不改令牌文件就无法收编**。`tokens.css` 里 `--fs-display-xl/2xl`（84/56）
    正是上一轮为 RunPage 两个裸字号新建的，所以新建是既有做法；但令牌命名契约写着「冻结」，
    该叫什么应由令牌所有者定，故本轮**只报不改**。
  - `SheetModal.vue:462` `transition: height`（动 layout 属性，_GUIDE 的 P0 口径）—— 该处注释已论证
    「换 transform 会切掉拖拽手柄」，属**有意豁免**；建议把这条豁免正式写进 `_GUIDE` 的 P0 定义，
    否则每轮都会被重新报一次。
  - `ActiveWorkoutBar.vue` 按压语法（`150ms` 线性 + `scale(0.94)`）与 `SessionOverlay`
    （`--dur-slow + --ease-spring` + `:active` 120ms）不同档；`SessionOverlay` 的
    `.setcard`（14/16）与 `.blockcard`（16/18）两套内距；`SessionBigNumberInput` `.wok`
    「确定」热区约 28px（伪元素扩热区会与相邻的数值键重叠，需连版式一起调，故未动）。
  - 非 transform/opacity 的补间 3 处（`ActiveWorkoutBar:310` box-shadow、`ReadinessDialog:437/470`
    clip-path、`SessionOverlay:2103` background-color/color）—— 只重绘、不触发布局，程度轻。

### 6.5 第三轮计划（已在 §7 执行）

1. 落地 **R4** 与 **R6**（R12 是 R6 的连带）→ 见 §7.2
2. UI 专家**批次 B**（其余 12 个组件）→ 见 §7.1
3. **B1 / B2** 的口径决策提案 → 仍未做，见 §7.4
4. 交互侧一条低风险项 → 未做，见 §7.4

---

## 7. 第三轮（2026-10-17 续）

### 7.1 UI 专家批次 B（已交付，12 条）

专家自述**动效维度零问题**：全部 transition 只落在 `color / background-color / clip-path`，
时长走 `--dur-fast/base`（≤250ms），无 `scale(0)`、无 layout 属性动画、无 >300ms 的 UI 动效，
`reduced-motion` 由 base.css 全局兜底。问题集中在颜色档位、命中区与三处「同类控件不同排法」。

### 7.2 本轮已修复（8 项，均过 typecheck / lint / contract）

**R4 · 换动作的身份进快照**（文档原判 high）

- `types/session.ts`：新增 `PlanExerciseOverride` 与 `SessionSnapshotState.exerciseOverrides`
  （可选字段，键 = 课程条目 id）。
- `session.ts`：新增 `exerciseOverrides` ref；`snapshotState()` 带上它；`swapExercise` 登记；
  `applyRecord` 在**重建 plan 之后立刻**重放；`applyExternalSnapshot` 同样重放
  （外部客户端 / AI 换过动作时，本地 plan 也得跟着走，否则下一拍 `touch()` 会用本地那份
  「没换过」的 plan 把外部状态写回去）；`endLocal` 复位。
- **与文档 R4 方案的一处偏离（更稳）**：重放**不走**公开的 `swapExercise` —— 它带
  `canSwapExercise`（「该动作一组都没做」）的前置校验，恢复时 `doneSets` 可能已经赋值，
  走它会让「换过动作且已做组」这个**主场景**被静默拒绝。改为 `applyExerciseOverrides`
  直接写 plan，与恢复的字段顺序**无关**，因此不再依赖「必须插在 doneSets 恢复之前」这条脆弱约定。
- 端到端可行性已核：mock 是 `JSON.parse(JSON.stringify(args.stateJson))` 整体克隆
  （`mock/server.ts:6159`），Rust 侧 `state_json` 是通用列 —— 新增字段**不需要**动 mock / Rust / IPC，
  `npm run contract` 仍 285/285 一致。

**R6 · 区分「课程列表拉取失败」与「课程确已删除」**（文档原判 high）

`applyRecord` 改为返回 `ApplyRecordResult = 'restored' | 'deleted' | 'retry'`：

| 结果 | 触发 | 处置 |
| --- | --- | --- |
| `'retry'` | `planStore.ensureLoaded()` 抛错（后端 / 网络抖动） | **不 discard**、不落本地态、服务端 active 行保留，等回前台 / 下次启动再试 |
| `'deleted'` | 加载成功但库里确实没有这门课 | `discardById`，按中断脏数据作废 |
| `'restored'` | 正常恢复 | —— |

`hydrateFromServer` 返回 `result === 'restored'`；损坏记录那条 catch 里再套一层 try
（作废本身失败时不再往上抛，否则会变成未处理的 Promise 拒绝）。

**R12 · 冲突分支按显式信号判定**（R6 的连带，两条阻断点都按文档风险条处理）

`start()` 的冲突分支：① 判定用 `applyRecord` 的返回值，**不用 `phase === 'idle'`**
（`'retry'` 时 phase 同样是 idle，会被误判成「已作废」）；② 走到非跑步分支就清
`foreignRoute`（跑步分支在上面已 `return`，不会被误清）；③ `'deleted'` 时不再弹
「请先接续」这条对已作废会话的伪提示，继续正常开课；④ **`'retry'` 必须返回冲突** ——
继续往下走会调 `session_start`，而后端会 `UPDATE workout_sessions SET status='aborted'
WHERE status='active'`，正好销毁掉 R6 想保留的那条会话。

**UI 四条（批次 B）**

| # | 位置 | Before → After |
| --- | --- | --- |
| 5 | `ExerciseLibrarySheet.vue` `.op.danger` | `color: var(--danger)` → `var(--danger-strong)`：12px 小字压白底，#ff3b30 实测约 3.55:1 过不了 AA，而 tokens.css 的契约写明「实底档当文字用对比度不够、文字档才是给文字用的」 |
| 6 | `ExercisePickerSheet.vue` `.fcount` | `color: var(--accent)` → `var(--accent-strong)`：它是 `--accent-soft` 底上的文字，同一条两档约定 |
| 7 | `StrengthExercisePicker.vue` 搜索框 | 补 `aria-label="搜索动作"`（同域 `ExercisePickerSheet` 的搜索框已有） |
| 8 | `WorkoutRow.vue` `.item` | 补 `@media (hover: hover)` 悬停态（同域 `.prow:hover` 已是这个做法）；触屏上 hover 会「粘住」，所以只在真有指针的档位给 |
| — | `ExerciseLibrarySheet.vue` `.op` | 约 33px 高 → 命中区撑到 44（`::after` 外扩，视觉不动）：这三枚是「编辑 / 隐藏 / 删除」的唯一入口，删除还不可逆 |

### 7.3 被驳回的指控（复核后不计入）

**批次 B #5：「`ExerciseHistoryPanel.vue:87-89` 的 `.state` 没有 `color`，会落到 `--text-1`，
应补 `--text-3`」—— 不成立。** 模板实际写的是 `class="state t-3"`
（`:50` 加载中、`:51` 空态），`t-3` 是 base.css 的工具类（`base.css:319 → color: var(--text-3)`），
颜色本来就是 `--text-3`。专家只读了 `<style>` 块、没回头核模板。**无需改动**。

（这是本项目连续两轮出现「专家断言 vs 源码事实」不一致；§1 的复核纪律不是形式主义。）

### 7.4 仍未落地 / 待决

**交互 / 无障碍（B3–B8，全部仍在）**：返回层语义（Android 硬件返回 + 桌面 Esc）、
`role="dialog"` / `aria-modal` / `inert`、震动与声音、组格兼任主按钮、顶部胶囊 36px、`aria-live`。

**R7 / R10 / R11 / R13 / R14 仍在**（R7 中、其余低–中）。R4 落地后，R13（抽屉菜单标题用旧动作名）
的价值上升了一档：换动作现在能跨恢复存活了，菜单标题与行内名的口径分离就更显眼。

**口径决策（需先出提案，不动语义）**：
- **B1** 容量三处回落口径 0 / 0 / 1（`session.ts` / `sessionSummary.ts` / `WorkoutDetailDrawer.vue`）。
- **B2** 重量分：本周 `avgWeight` 按激活档加权、4 周基线 `baseWeight` 是简单平均。

**批次 B 留下的设计一致性项（未动，需择一）**：
- 「统计格」同一语言在 3 处三种排法（`ExerciseDetailDrawer` / `ExerciseLibrarySheet` / `WorkoutDetailDrawer`），
  标签与数值的字号档位互相打架；
- 选动作列表行不一致（`ExercisePickerSheet` `.rowitem` 10px 内距 + subhead/700 vs
  `StrengthExercisePicker` `.prow` 13px 内距 + body/600）；
- 主按钮圆角分道（`ExerciseFormSheet` / `ExerciseFilterSheet` 走 `--radius-s`，
  `MuscleCatchupSheet` 走 `--radius-full`）；
- `ExerciseBars.vue` `.label.today { color: var(--accent) }` 与「色相只出现在图标 / 色点 / 图表上」
  的颜色配额有张力；`WorkoutDetailDrawer.vue:338-341` 的 `[146,232,42]` / `[250,17,79]`
  正是 `--c-exercise` / `--c-intake` 的裸三元组（JS 侧插值，换肤不跟随）；`MuscleMap.vue`
  六处解剖底色 rgba 未收编。

**命中区 <44px（批次 B 指出的另外三处，未动）**：`ExerciseHistoryPanel` `.more`（`padding: 8px 0`）、
`ExerciseFilterSheet` `.chip`（`padding: 7px 13px`）。`.chip` 在 `flex-wrap` 行里，伪元素外扩会与相邻
chip 重叠，需要连版式一起调，故留待批量处理。

### 7.5 第四轮计划

1. **R7**（恢复时 `setIndex` 封顶 + `doneCount` 与 `buildSetRows` 遍历同一批动作）—— 与 R4 同族，
   趁热做完；注意 R4 刚引入的覆盖表也在 `plan.exercises` 上，别让钳制逻辑与它互相打架。
2. **R13**（抽屉菜单标题 / 跳转提示改走 `resolveName`）—— 小、纯展示，R4 之后价值上升。
3. 出一张**设计一致性决策表**（统计格 / 列表行 / 主按钮圆角 / 颜色配额四处），只要结论不要改动，
   交令牌与组件所有者拍板。
4. 交互侧挑一条：**B3 的桌面 Esc 分支**（不碰 Android 原生，与 `SheetModal` / `AppMenu` 的 Esc
   栈式处理对齐）或 **B8 `aria-live`**（纯增益、零视觉变化）。

---

## 8. 待拍板清单（每项已回源码核实，含行号）

> 这些是**取舍**不是笔误：几处甚至各自写了理由（如统计格三处、`splitColor` 的「配速色带」注释）。
> 我不单方面改。每项给出选项与我的建议；说「都按建议」我就照建议一次改完。
> **没核过的现状不列进来** —— 前两轮已因此驳回两条专家断言（§3、§7.3）。

### D1 · 有重量、没记次数的那一组，算多少容量

现状三处三种口径（同一节课会让「训练中实时容量」「总结页容量」「运动详情容量」给出不同值）：

| 位置 | 算法 | 出处 |
| --- | --- | --- |
| 训练中实时 | `d.reps ?? 课程处方次数`，都没有 → **0** | `stores/session.ts` `totalVolume` |
| 总结页 | `d.reps ?? 0` | `utils/sessionSummary.ts:215` |
| 运动详情 | `d.reps ?? 课程处方次数 ?? 1` | `components/exercise/WorkoutDetailDrawer.vue:463-464`（注释：避免凭空夸大） |

- **A** 三处统一为 **0**（未知次数 = 不计入这组的容量）→ 与全仓「取不到就不编」的纪律一致；明细仍如实显示「62.5kg」（`setChip` 已是这个行为）
- **B** 三处统一为 **1**（至少做了 1 次）→ 不隐藏这组的贡献，但是编出来的数
- **C** 三处统一为「课程处方次数 → 0」，并抽一个共用函数
- **我的建议：C**（口径与 A 相同，但把三处的回落链收敛成一份，`WorkoutDetailDrawer` 拿不到处方时才 0）

### D2 · 重量分：本周加权、4 周基线不加权

`utils/trainingScore.ts`：本周 `avgWeight` 按激活档加权（`weightSum += w * weightKg`），
4 周基线 `baseWeight` 是简单平均（`b.sum += s.weightKg`）。同一个评估组同时吃 level 3 与 level 2
的组时（「肩」吃肩推 + 卧推），比值会偏，而 `weightScoreOf` 用这个比值分 100/80/60/40 四档。
注释只写了「基线不滤激活档」，没写为什么不加权。

- **A** 基线也按激活档加权（口径一致）
- **B** 保持现状，把「基线为什么不加权」写进注释
- **我的建议：A**

### D3 · 「统计格」在三处三种排法

| 位置 | 标签 | 数值 |
| --- | --- | --- |
| `ExerciseDetailDrawer.vue:301-313` | `caption` + `--text-2` | `title2` / 300 |
| `ExerciseLibrarySheet.vue:465-478` | `micro` + `--text-3` | `subhead` / 700 |
| `WorkoutDetailDrawer.vue:931-948` | `caption` + `--text-3` | `title1` / 200 |

后两处**各自写了理由**：DetailDrawer 写「micro/text-3 会把『4 是组数还是次数』变成猜谜」，
WorkoutDetailDrawer 写「字段名不吃 11px」。**只有动作库那处把标签压到 `micro` + `--text-3`** ——
它正是另外两处明文反对的那一档，属自我矛盾的那一个。

- **A** 只统一**标签轴**（一律 `caption` + `--text-2`，即采纳那两处自己写的理由）；数值档按格子宽度保留差异（窄格 `subhead`、宽格 `title1/2`）
- **B** 两轴全统一（标签 `caption`/`--text-2` + 数值 `subhead`/700）
- **C** 保持现状
- **我的建议：A**（数值档随容器宽度变化是合理的；标签档是纯粹的口径漂移）

### D4 · 「从列表选一个动作」两种行节奏

| 位置 | 行内距 | 名称 | 用途 |
| --- | --- | --- | --- |
| `ExercisePickerSheet.vue:226-231` | `10px 2px`，gap 2 | `subhead` / 700 | 浏览式挑选 |
| `StrengthExercisePicker.vue:119-136` | `13px 2px`，gap 10 | `body` / 600 | **训练中**临时换动作 |

- **A** 统一到 `13px` + `body`/600（触控优先；训练中那处是单手持机场景，行高更大的那个是对的方向）
- **B** 统一到 `10px` + `subhead`/700（一屏更多行）
- **我的建议：A**

### D5 · 全宽主按钮的圆角

| 位置 | 形状 | 圆角 |
| --- | --- | --- |
| `ExerciseFormSheet.vue:324-328` | `width:100%` 通栏 | `--radius-s` |
| `ExerciseFilterSheet.vue:258-261` | `flex:1` 通栏 | `--radius-s` |
| `MuscleCatchupSheet.vue:522-525` | 内联胶囊 | `--radius-full` |

注意 `ExerciseFilterSheet` 的注释自称「完成 = `.primary` 主按钮」，而另一个 `.primary`
是胶囊 —— 命名同族、形状分道。

- **A** 全宽主按钮统一**胶囊**（`--radius-full`），与内联主按钮一致（视觉会变）
- **B** 全宽主按钮统一 `--radius-s`（圆角矩形），内联胶囊改跟随
- **C** 现状即「通栏=圆角矩形、内联=胶囊」，把这条规则写进 `_GUIDE` 登记（零改动）
- **我的建议：A**（iOS 通栏主操作就是胶囊；但要接受两枚按钮的高光形状变化）

### D6 · `ExerciseBars` 的「今天」标签用了主色

`ExerciseBars.vue:60-68`：`.label` 是 `micro` + `--text-3`，`.label.today` 改成 `--accent`。
STANDARDS §4 的色彩配额写的是「色相只出现在图标 / 色点 / 图表上」，而这是一个**文字标签**。

- **A** 改中性 `--text-1`（比同排的 `--text-3` 亮一档，「今天」仍可辨）
- **B** 保留 `--accent`，并在 STANDARDS §4 登记一条豁免（坐标轴上的「当前位置」标签可着色）
- **我的建议：A**（尊重自己写下的标准；若你更看重「今天」的显著性则选 B）

### D7 · 配速渐变在 JS 里硬编码了令牌的裸三元组

`WorkoutDetailDrawer.vue:337-343`：`const fast = [146, 232, 42]` / `slow = [250, 17, 79]`
—— 正是 `--c-exercise`（#92e82a）与 `--c-intake`（#fa114f）的十进制三元组。函数注释说它是
「Apple 配速色带的简化版」。

这里有个**语义问题**：它看起来是「配速色带」而不是「运动环 / 摄入环」，两者只是数值相同 ——
直接把 JS 改去读 `--c-exercise` / `--c-intake` 会把「配速」绑死在两个环的语义上。

- **A** 为配速色带立一对专用令牌（如 `--pace-fast` / `--pace-slow`），承认它是独立语义
- **B** 直接读 `--c-exercise` / `--c-intake`（换肤跟随，但两个语义被绑在一起）
- **C** 保持现状
- **我的建议：A**（核实后我改了原来的判断：不该绑到环色上）

### D8 · `MuscleMap` 的六处解剖底色 rgba

`MuscleMap.vue:553/557/563/568/579/587` 是成片的裸 `rgba(...)`（皮肤 / 骨骼 / 深层肌的底色）。

- **A** 收成一组解剖底色令牌（`--mmap-*`，亮暗各一份）
- **B** 保持现状，在文件头注明「解剖底色是素材色，不随主题令牌走」
- **我的建议：B**（它是从 BodyParts3D 网格生成时定的素材色，不是主题色；收成令牌只是搬运。
  若你要的是「颜色全部可主题化」，则选 A，我会连亮暗两档一起定值）

### D9 · 沉浸层三处超展示级裸字号

`SessionOverlay.vue` `.restnum: 76px`（:2010）、`.timernum: 64px`（:2024），
`SessionSummaryPane.vue` `.heropct: 30px`（:390）。`tokens.css` 的展示级阶梯只到
`--fs-display-l/m/s`（44/40/34）与两个「一屏只有一个」的 `--fs-display-xl/2xl`（84/56，
上一轮正是为 RunPage 的两个裸字号建的）。

- **A** 新建按角色命名的令牌（如 `--fs-readout-lg/md`），**零视觉改动**，与建 84/56 的先例一致
- **B** 落回既有档（76→84 `--fs-display-xl`、64→56 `--fs-display-2xl`、30→32 `--fs-large-title`）—— 收编干净但**视觉会变**
- **C** 保持裸值，在 `_GUIDE` 登记「沉浸层单屏读数豁免阶梯」
- **我的建议：A**（令牌命名契约写着「冻结」，所以新名字该由你定：给我三个名字我就落）

### D10 · 两处仍需 ≥44px 的命中区

`ExerciseHistoryPanel.vue:154` `.more{padding: 8px 0}`、`ExerciseFilterSheet.vue:205-207`
`.chip{padding: 7px 13px}`。

- **A** 都撑到 44（`.chip` 在 `flex-wrap` 行里，伪元素外扩会与相邻 chip 重叠，要改成 `min-height: 44px`，会抬高整行）
- **B** 只把 `.more` 用伪元素外扩（不影响版式），`.chip` 保持——chip 是「多选筛选项」，
  与勾选框同族，误触代价低
- **我的建议：B**

---

## 9. 拍板结果与落地（2026-10-17 第四轮）

业主决定：**D1 B · D2 A · D3 A · D4 A · D5 A · D7 A · D8 B · D9 A · D10 B**
（**D6 未点**，保持现状未动 —— 见 §9.3）

### 9.1 已落地（9 项，typecheck / lint 通过）

| # | 决定 | 落地内容 |
| --- | --- | --- |
| D1 | B（次数缺失按 **1** 次兜底） | 新增 `utils/sessionSummary.ts::setVolumeKg(weightKg, reps, plannedReps?)` 作为**全端唯一**的容量口径，回落链 `逐组登记 → 课程处方 → 1`，四处调用点全部收编：`stores/session.ts` 的 `totalVolume`、`sessionSummary.buildExerciseRows`、`WorkoutDetailDrawer.courseTotals`、**`strengthStats.buildExerciseHistory`（本轮新发现的第 4 处**，之前也按 0 算，会从容量 PR 里静默消失）。函数注释写明「它只管容量，e1RM 缺次数时仍应为『不可估』」 |
| D2 | A（基线也加权） | `trainingScore.ts` 的 4 周基线 `b.sum += w * weightKg; b.n += w`，与本周 `avgWeight` 同一套按激活档折算的口径 |
| D3 | A（只统一标签轴） | 标签一律 `caption` + `--text-2`：改 `ExerciseLibrarySheet .cell em`（`micro`/`--text-3` → `caption`/`--text-2`）与 `WorkoutDetailDrawer .cell .k`（`--text-3` → `--text-2`）；`ExerciseDetailDrawer` 本就是这一档（三处里唯一无需改的）。数值档按格子宽度保留差异 |
| D4 | A（13px / body 600） | `ExercisePickerSheet .rowitem` 内距 `10px → 13px`、`.ename` `subhead/700 → body/600`，与 `StrengthExercisePicker .prow` 对齐 |
| D5 | A（通栏主按钮统一胶囊） | `ExerciseFormSheet .save`、`ExerciseFilterSheet .done` 的 `--radius-s` → `--radius-full` |
| D7 | A（配速专用令牌） | `tokens.css` 新增 `--pace-fast` / `--pace-slow`；`WorkoutDetailDrawer.splitColor` 从「JS 里硬编码十进制三元组插值」改为返回 `color-mix(in srgb, var(--pace-slow) N%, var(--pace-fast))` |
| D8 | B（保持现状 + 注明） | `MuscleMap.vue` 文件头新增「为什么底色是裸 rgba（令牌纪律的一处**有意豁免**）」，写清它是解剖素材色、要改该改 `scripts/build-anatomy.mjs` 的调色而不是 tokens.css。六处 rgba 未动 |
| D9 | A（新建读数档） | `tokens.css` 新增 `--fs-readout-lg/md/sm`（76/64/30px），**值与迁入前完全一致**；收编 `SessionOverlay .restnum` / `.timernum` 与 `SessionSummaryPane .heropct` |
| D10 | B（只扩 `.more`） | `ExerciseHistoryPanel .more` 用 `::after` 把命中区从约 32px 撑到 44（落在它 8px 的 margin 里）；`.chip` 保持，并在注释里写明为什么不这么处理（`flex-wrap` 行内伪元素外扩会与相邻 chip 抢点击） |

### 9.2 D9 的命名（我起的，可一条命令改）

新增的三个令牌名是我拟的：`--fs-readout-lg|md|sm`（`display-*` 是卡内主数值，
`readout-*` 是沉浸层单屏读数，是一条新的命名轴）。要换命名法只需动 `tokens.css` 一处 +
三处引用（`SessionOverlay` 两处、`SessionSummaryPane` 一处）。

### 9.3 D6 未决（保持现状）

`ExerciseBars.vue:60-68` 的 `.label.today { color: var(--accent) }` 与 STANDARDS §4
「色相只出现在图标 / 色点 / 图表上」的张力，业主本轮未表态 → **未动**，仍留在 §8 D6。

### 9.4 ⚠️ 本轮 `npm run contract` 为红 —— 与运动系统无关，是在制品

第四轮跑契约检查时失败：

```
命令数：Rust 286 / services 286 / mock 285
IPC 契约不一致：- mock 缺 gateway_set_enabled_modules（Rust 已注册）
```

**不是我引入的**：`gateway_set_enabled_modules` 在 `src-tauri/src/lib.rs:426`、
`src-tauri/src/modules/gateway/commands.rs:81`、`src/services/gatewayService.ts:121`
三处都已存在，而 `mock/server.ts` 还没有同名实现。同时本轮 `git status` 显示工作树里有
**另一批并行的在制品**（gateway 模块整组、`src/plugins/builtin/*` 的新插件 focus / ledger /
nutrition / record / sync / voice、`src/components/pomodoro/Focus{,Notice}FloatBar.vue`、
`src/utils/notifyTone.ts`、`docs/PROJECT-2026-10/`，以及新目录 `promo/`、`site/`）。

前两轮契约是 285/285/285 全绿，所以那条 Rust 命令是在本会话进行中间落地的。
**我没有去补那个 mock 实现** —— 它属于那条在制品的作者，而且契约脚本的报错信息本身
就在指导他「新增命令必须三处同步」。运动系统的改动**不涉及任何 IPC**（R4 的新字段走
`state_json` 这个通用列），所以这条红与本次审核的结论无关。
唯一的代价：本轮无法再用契约检查作为「我这批改动没碰 IPC」的机器证据 ——
但 `typecheck` 与 `lint` 仍全绿，且本轮改动清单里没有任何 Rust / services / mock 文件。

**后续更新（第六轮）**：那条在制品把 mock 侧补上了，现在 `npm run contract` 报
`286 / 286 / 286 → IPC 契约一致 ✓`，已恢复绿色。诊断得到印证 —— 当时那条红确实与运动系统无关。

---

## 10. 第五轮（2026-10-17 续）· R7 / R13 / B8

### 10.1 已落地（2 项，typecheck / lint 通过）

**R7 · 恢复时把进度对齐到当前课程**（`stores/session.ts`）

恢复是按 planId 重新从课程库取 plan 的，而课程可能在会话进行中被编辑过（删掉一个动作、
或把某动作的组数调小）。此时两个口径直接错位：`doneCount` 遍历 `doneSets` 的**全部键**，
而 `buildSetRows` / `totalVolume` 只遍历当前课程的动作 —— 于是界面出现「5/4 组完成」
（分子大于分母），而那些多出来的组在保存时又被静默丢掉。计数说它们算，记录里却没有它们。

两处改动：

- 新增 `alignProgressToPlan()`：只遍历当前课程的动作重建 `doneSets` / `extraSets` /
  `skippedSets`（不在课程里的键被自然丢弃；每个动作的正式组裁到它自己的 `effSets`，
  跳过登记也裁到同一范围）。**正常恢复时它是恒等操作**（每个键都在课程里、每组数都不越界）。
- 新增 `clampSetIndex()`：组号钳到当前动作的实际组数，**上下界都要有** —— 从前只写了
  `Math.max(1, rec.setIndex)`，所以「第 5/1 组」这种越界读数会出现。`exIndex` 也补了下界
  （从前是 `Math.min(rec.exIndex, len-1)`，负数会取到 `undefined` 的当前动作）。
- 顺序是死的：`doneSets/extraSets/skippedSets` 必须先赋值，`alignProgressToPlan()` 之后
  才 `clampSetIndex()` —— 两者都要用**对齐后**的 `extraSets` 算 `effSets`。

**R13 · 抽屉的动作名统一走库内名**（`SessionCourseDrawer.vue`）

新增 `slotName(slot)`（`lib.resolveName(s.plan.exercises[slot.exIdx])`，越界回落快照名），
替换「···」菜单标题与跳转 toast 里的 `slot.exName`。`SessionSetSlot.exName` 只是课程条目
写入时的名称快照 —— 换过动作或库内改过名之后它就旧了，于是同一行同一组、行内显示新名
而菜单标题显示旧名。R4 落地后换动作能跨恢复存活，这条的价值随之上升。

### 10.2 顺带落地：B8（无障碍播报）

| 位置 | 改动 | 理由 |
| --- | --- | --- |
| `CountdownOverlay.vue` 整层 | `role="status"` + `aria-live="polite"` + `aria-atomic` | 3·2·1 与「开始第 N 组」是**离散事件**，正是 live region 的用途；此前视障用户完全听不到节奏推进 |
| `SessionOverlay.vue` 休息倒数 / 计时中 | `role="timer"` + `aria-label="休息倒计时"` / `"已用时"` | `role="timer"` 的隐式 `aria-live` 就是 `off` —— 这两处每 100ms–1s 变一次，**逐秒播报会淹没其他信息**；给它语义后读屏用户可主动读到当前值 |

**如实声明一处局限**（写进 `CountdownOverlay` 的文件头）：该层是 `v-if` 挂载的，
live region 与内容同时进入 DOM，部分读屏会忽略「区域出现时已带内容」的变化。彻底稳妥的
做法是常驻一个空 region 再由 store 事件更新它的文本 —— 那要把它挪到页面根部并改驱动方式，
**本轮没做**。改动后的状态是「有些读屏会念、没有一个会漏」，不劣于改动前。

### 10.3 R4 的一处连带疏漏（本轮发现并修）

`applyRecord` 里 `void loadLastWeights(p.exercises.map((e) => e.exerciseId))` 用的是
**尚未重放覆盖**的那份 `p` —— 换进来的动作因此查不到「上次重量」，`weightFor` 少一级回落。
改为 `plan.value.exercises`（重放之后）。这是第三轮 R4 留下的，本轮连同 R7 一起修。

### 10.4 第六轮候选

- **R11**（summary 加「回到训练 / 撤销最后一组」入口）—— `redoLastSet` 本来就能从 summary 回退，
  只是界面没有入口；属「补一个按钮」，但要与「summary 是终态」的既有叙事对齐。
- **R14**（沉浸页滚动反馈接错容器，`useScrolled` 解析到了 window）—— **✅ 第六轮已落地，见 §11.1**。
- **R10**（收起形变期浮条折射未真摘：`.immersive-measuring .dock-body` 缺 `!important`）—— **✅ 第六轮已落地，见 §11.1**。
- **B6**（组格不再兼任主按钮）—— 与第二轮 R9 刚改过的「按状态渲染」相邻，要一起设计。
- **B3 的桌面 Esc 分支**（不碰 Android 原生）。
- **B5**（震动 / 声音的第二通道）—— 需要产品判断「健身房场景要不要出声音」。
- **D6**（`ExerciseBars` 的「今天」标签颜色）—— 业主未表态，仍挂 §8。

---

## 11. 第六轮（2026-10-17 续）· R14 / R10 + 一条新发现

### 11.1 已落地（2 项，typecheck / lint / contract 全绿）

**R14 · 沉浸页滚动反馈接上真正的滚动容器**（`SessionOverlay.vue`）

`useScrolled` 的解析是**从 `el.parentElement` 起步**的（`useScrolled.ts:38`，它不看传入元素
自身），而原来的 ref 挂在滚动框 `.scrollbody` 自己身上、父链（`.session-page` →
`.session-layer`）两级 overflow 都是 hidden → 一路解析到 window。训练中真正在滚的是
`.scrollbody`，`window.scrollY` 恒为 0，`is-scrolled` 因此永不置位 —— 那条「内容滑到玻璃
底下、影子变重」的浮起反馈等于没接上。

改法：ref 从 `<main class="scrollbody">` 移到它的直接子元素 `<div class="rubber-layer">`
（`scrollProbeEl`），父链第一跳就命中 `.scrollbody`。顺带解掉旧注释里那笔账 ——
从前解析到文档，主页一滚它也翻，所以模板处必须与 `immersiveOpen` 相与；现在解析结果
与开合无关，那个相与仍留着（语义更清楚），但不再是「防串台」的必需品。

**R10 · 收起形变期真正摘掉浮条折射**（`ActiveWorkoutBar.vue`）

`.dock-body` 的 `backdrop-filter` 是**内联样式**（`glassStyle` 在 liquidGlass 档生成
`url(#…) saturate(…)`），而内联的普通声明胜过作者的普通声明 ——
`.wdock-root.immersive-measuring .dock-body { backdrop-filter: none }` 因此恒不生效，
收起那 400ms 里整条全宽玻璃仍在逐帧重算折射（采样点全被形变壳盖住，白付一笔）。
两条声明各加 `!important`，与 `SessionOverlay.vue` 压 `GlassSurface` 内联 `url()` 的
`.session-layer.is-morphing :deep(.sgbtn)` 同一手法。

### 11.2 ⚠️ 新发现 N1：抽屉的 Esc 关闭**从未接线**（`sheetStack` 是只写的）

第六轮本来要做 B3（给沉浸层加桌面 Esc），先去核对「Esc 的层级阶梯」，
结果发现**阶梯本身是半截的**：

- `SheetModal.vue:28` 有一个模块级的 `const sheetStack: ((e: KeyboardEvent) => void)[] = []`，
  注释写着「打开中的抽屉栈：Esc 只关最上层，嵌套弹层逐层退出」；`:128` 定义了 `onEsc`
  （带「只响应栈顶」的判据），`:140` 打开时 push、`:146`/`:355` 关闭或卸载时 splice。
- 但**全仓没有任何地方把它注册为监听器**：`SheetModal.vue` 里的 `addEventListener` 只有
  `resize` / `touchmove` / `touchend` / `touchcancel` 四类；`grep -n "addEventListener('keydown'"`
  在 `src/` 下只有六处（`App.vue` 的桌面壳、`useBentoLayout`、`VoiceInputMask`、
  `VoiceLayoutsPage`、`AppMenu`、`ReadinessDialog`），`sheetStack` 不在其中。
- `sheetStack` 又是 `<script setup>` 的模块私有变量，外部无法调用。

**结论**：按 Esc **关不掉任何抽屉**。`sheetStack` + `onEsc` 是只写不读的死代码。

这同时**推翻了一句被两次引用的话**：`docs/MOTION-MODE-EXPERIENCE.md` §4「嵌套弹层不会
互相踩」与 `docs/ui-reviews/_GUIDE.md` 都按「SheetModal 有打开的抽屉栈，Esc 只关最上层」
来论证，而那条阶梯并没有接上（`AppMenu` 与 `ReadinessDialog` 各自的 Esc 是真的，
只有抽屉这一层是空的）。

### 11.3 因此 B3 本轮**不做**（并说明为什么不能单独做）

给沉浸层加「Esc → 收起」看似一行监听，但它必须知道「当前没有上层弹层」——
而现在没有任何可读信号：

- 抽屉（`SheetModal`）的 Esc 是死的（N1），所以抽屉开着时按 Esc，只有沉浸层会响应 →
  **整层收起、抽屉还留在屏幕上**，比今天「什么都不发生」更糟；
- `sheetStack` 是模块私有的，拿不到；
- 自己再挂一个 window 监听也不行：`AppMenu` 的监听只看自己的 `open`，两个 window 监听
  在同一个 target 上是按注册顺序触发的（要拦住同 target 的其他监听得用
  `stopImmediatePropagation`），顺序一变就出错。抽屉里叠一个「跳至该组」菜单时，
  一次 Esc 会连菜单带抽屉一起关 —— 正是模块文档点名「不许改坏」的那条。

**要做就得先把阶梯做真**：抽一个共享模块（如 `src/system/escStack.ts`）导出
`pushEsc/popEsc`，让 `SheetModal` 与 `AppMenu` **共同**入栈（替换 `SheetModal` 私有的
`sheetStack`），再由 `SessionOverlay` 作为栈底加入。那是一次跨 3 个共享组件的改动，
已经越出「运动系统」这一轮的边界，且它的失败模式（一次 Esc 关掉两层）是全局的 ——
所以这里只给结论与方案，不动手。Android 硬件返回那半边另需原生 Kotlin，也不在本轮范围。

### 11.4 剩下什么

承接 §10.4，去掉本轮做掉的两条：

| # | 优先级 | 一句话 | 备注 |
| --- | --- | --- | --- |
| **N1** | 中（跨域） | 抽屉 Esc 从未接线（`sheetStack` 只写） | 新发现；是 B3 的前置，且影响全 App 的抽屉 |
| B3 | P0（无障碍/平台约定） | 沉浸层没有「返回这一层」的语义 | **被 N1 阻塞**；Android 半边需原生 Kotlin |
| B5 | P1 | 核心循环无震动 / 声音 | 需产品判断 |
| B6 | P1 | 组格兼任主按钮 | 与 R9 的「按状态渲染」同处，要一起设计 |
| R11 | 中 | summary 无「回到训练」入口 | `redoLastSet` 本就能回退，缺的是入口 |
| B4 | P0（无障碍） | 沉浸层不是无障碍模态（无 `role="dialog"`/`aria-modal`/`inert`） | **✅ 第七轮已落地主体，见 §12.1；`inert` 余项见 §12.2** |
| B7 | P2 | **✅ 第七轮已落地**（见 §12.1）顶部三枚胶囊 36px、`更换` 胶囊约 28px | 已统一到 44 |
| D6 | P2 | `ExerciseBars` 的「今天」标签用主色 | 等业主一句话 |

---

## 12. 第七轮（2026-10-17 续）· B4 / B7 / R11

### 12.1 已落地（3 项，typecheck / lint / contract 全绿）

**B4 · 沉浸层成为无障碍意义上的模态**（`SessionOverlay.vue`）

原来：根节点没有 `role="dialog"` / `aria-modal`，焦点也不进层 —— 键盘与读屏用户会在被
遮住的页面元素间穿梭（`TabBar` 只是被 z-index 盖住，DOM 仍在焦点序与无障碍树里）。

这次做了什么：

| 项 | 落地 |
| --- | --- |
| 角色 | `:role="immersiveOpen ? 'dialog' : undefined"` + `:aria-modal` + `aria-label="训练课"` |
| 关层时 | `:aria-hidden="immersiveOpen ? undefined : 'true'"` |
| 焦点 | `tabindex="-1"`，开层 `layerRef.focus({ preventScroll: true })`，关层还给开层前那个元素（它已被卸载则 `blur`） |

**关键取舍：角色属性必须跟着开合走，不能常挂。** 本层是**常驻挂载**的（收起只是
`opacity: 0` + `pointer-events: none`，不卸载），若把 `role="dialog"` / `aria-modal` 常挂上去，
无障碍树里就始终存在一个看不见的 dialog —— 没开课的用户也能"进"到里面去。
同理，关层后必须把焦点还回去，否则焦点会停在一个 `aria-hidden="true"` 的元素上（两边都不成立）。
层自己给了 `:focus { outline: none }`：它不是可交互控件，程序化聚焦只为把焦点带进来，
层内各控件的焦点环不受影响。

也已核对：悬浮运动条 `ActiveWorkoutBar` 挂在 `App.vue:316`、本层挂在 `:334`，两者是**兄弟**
而非父子 —— 所以收起时的 `aria-hidden` 不会把浮条（收起后唯一的入口）一起藏掉。

**B7 · 把触控命中区统一到 44**

- 顶栏三枚胶囊（收起 / 全课进度 / 结束）：`CAP_H` **36 → 44**。没有走「伪元素把热区撑到 44」
  那条路 —— 胶囊的材质根是 `GlassSurface`，它带 `overflow: hidden`（折射层要按圆角裁），
  伪元素外扩会被裁掉、撑不出来，所以直接把视觉高度抬到 44。`--cap-h` 与 `topHeight`
  共用这一个常量，内容区留白自动跟随。**这是本轮唯一的可见视觉变化**（顶栏会高 8px），
  要退回把这一行常量改回 36 即可。
- 抽屉里的「更换」胶囊（约 27px）：视觉不动，`::after { inset: -9px -4px }` 撑到 45px；
  竖向那 9px 落进 `.exblock` 的 18px `margin-top` 与表头的 8px `padding-bottom` 里，不与相邻内容抢点击。

**R11 · 总结页的回头路**（`SessionSummaryPane.vue`）

进 summary 后 `addExtraSet` 被封、全课抽屉的「跳至该组」也回不去（目标组必然落在游标之前），
于是「少做一组 / 最后一组记错」只剩保存错的那份或放弃整节课两条路。而 `store.redoLastSet`
本来就能从任何相位回退（它没有 phase 门槛）—— 缺的只是入口。

落地：完成环正下方加一枚次按钮「撤销最后一组，继续训练」（`completion.done > 0` 才出现，
44px 高、描边白底 + 中性字，不与底簇那颗实底「保存训练」抢焦点），点击调 `s.redoLastSet()`，
成功即 `phase` 离开 summary、本组件卸载、沉浸页回到做组界面；失败（没有可撤销的组）给明文 toast。

### 12.2 B4 的剩余部分（未做，如实记录）

**没有做 `inert`**：`aria-modal="true"` 已经在 ARIA 语义上告诉 AT「忽略背景」，但**键盘用户
仍然可以 Tab 到被遮住的页面元素**（层内没有焦点陷阱，ARIA 的 `aria-modal` 不拦 Tab）。
彻底的做法是给外壳（`App.vue` 的 `.app-frame`）加 `inert` —— 那需要跨组件定位外壳元素，
与 §11.3 的 N1/B3 同属「外壳级」改动，一并留给下一轮。

### 12.3 全部剩余（承接 §11.4）

| # | 优先级 | 一句话 | 归谁 |
| --- | --- | --- | --- |
| **N1** | 中（跨域） | 抽屉 Esc 从未接线（`sheetStack` 只写） | 需共享 `escStack` 模块；B3 的前置 |
| B3 | P0 | 沉浸层没有「返回这一层」的语义 | 被 N1 阻塞；Android 半边需原生 Kotlin |
| B4 余项 | P1 | 外壳加 `inert`（键盘 Tab 仍能走到被遮住的元素） | 同样是外壳级改动 |
| B6 | P1 | 组格兼任主按钮 | 与 R9 的「按状态渲染」同处，要一起设计 |
| B5 | P1 | 核心循环无震动 / 声音 | 需产品判断 |
| D6 | P2 | `ExerciseBars` 的「今天」标签用主色 | 等业主一句话 |

**训练学与数据正确性两条线已经没有未决项**：R3/R4/R6/R7/R9/R10/R12/R13/R14 全部落地，
D1–D5/D7–D10 全部按拍板落地；剩下的是交互习惯（N1/B3/B6/B5）、外壳级无障碍（B4 余项）
与一条业主待决的颜色配额（D6）。
