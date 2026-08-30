# 代码审查报告 · 2026-08-31

- 提交：`c8ade6e feat(program): 健康方案页重建，并修复审查发现的回归与数据缺陷`
- 范围：Rein 全部未提交改动，97 个修改文件 + 46 个新增文件（+26021 / −791）
- 门槛：`npm run typecheck` ✅ ｜ `cargo clippy -- -D warnings` ✅ ｜ `vite build` ✅

> 仓库根在上级目录 `C:\Users\Administrator\Documents\Code`，同级还有 Chordial、
> AITools、EffiSuite 等兄弟项目。本次提交严格限定 `Rein/` 路径，未混入无关改动。

---

## 一、质量门槛

| 门槛 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 修复过程中曾因 `ProgramMeal.mealType` 缺失报错，已修 |
| `cargo clippy -- -D warnings` | 修复后通过 | 原 2 处 error，见下 |
| `npm run build` | 通过（改用临时 outDir） | `dist/` 清空被沙箱 safe-delete 守卫拦截，非代码问题 |

Clippy 原始 2 处 error（均在 `modules/todo/commands.rs`）：

1. `unnecessary_cast` — `dow_of(d) as i64`，`dow_of` 本就返回 `i64`。
2. `type_complexity` — 8 元素元组 `Vec<(i64, String, Option<String>, …)>`。
   顺带发现该函数对每个模板行又回查一次 `rec_rule/date`（N+1），已合并进首查询，
   并用 `RecTemplate` 结构体替换元组。

---

## 二、P0 正确性缺陷（已修）

### 1. `stores/session.ts` redoLastSet 相位回归
`phase.value = 'exercise'` 被写死，旧版是 `ex.kind === 'strength' ? 'exercise' : 'timed-ready'`。
计时/有氧动作同样会写 `doneSets`，因此重做一个平板支撑会跳进力量组界面、
无法再启动计时器。**已用 `git show HEAD~:...` 比对确认是回归**，已恢复三元判断。

### 2. `stores/session.ts` 空课程启动崩溃
`weightFor(p.exercises[0]!)` 对空 `exercises` 抛 TypeError；旧代码 `p.exercises[0]?.weightKg ?? 0` 是安全的。已改为条件取值。

### 3. `mock/server.ts` 演示做组明细无限累积
演示播种写在模块顶层裸块、无条件 `strengthSets.push(...)`，而 `strengthSets` 持久化在
localStorage 且 id 自增永不命中去重 —— 每次加载多一份（20→40→60…），
污染力量曲线与「上次重量」，localStorage 无上限增长。
已仿照既有 `PLAN_SEED_VERSION` 加种子版本闸门（`workouts.push` 保持无条件，
因为 workouts 不持久化、每次必须重播）。

### 4. `BentoOverview.vue` 桌面端「今日饮食」磁贴恒空
注释写「数据由 HomePage 挂载链加载」，但 HomePage 已无 `diet.load`。
组件 `onMounted` 只加载 `exercise.loadWeek`，导致该磁贴恒显示 0 笔 0 kcal。
已改为组件自加载 `diet.load` + `nutrition.loadSummary`。

### 5. `utils/programEngine.ts` rebuildBlob 后 dayIndex 重复
`past` 保留原序号、`future` 由 `expandDays` 从 0 重新编号，直接拼接后
「第 N 天 / 总天数」每次调整都回退并重复。已续接 `past.length` 偏移。

### 6. AI 调参的 NaN / Infinity 穿透钳制
`clampNum = Math.min(max, Math.max(min, v))`，而 `Math.max(min, NaN)` 恒为 NaN；
AI 侧只判 `typeof === 'number'`（NaN 通过）。NaN 会写进 params_json 渲染成「NaN 大卡」。
已在入口加 `finiteOr()` 统一丢弃非有限值。

### 7. `stores/program.ts` adjust 无并发保护
连点或 AI 重复触发会让两次 adjust 基于同一份旧参数计算、后写覆盖前写
（丢更新 + 日程重排两次），且版本号 `record.version + 1` 的假设被打破
（后端是 `version = version + 1`）。已加 in-flight 闸门。

### 8. 加餐槽位永不消解
引擎产出「上午加餐 / 下午加餐」，`MEAL_LABELS.snack` 是「加餐」，
`slotToMealType` 用相等比较恒返回 null，「下一餐」把加餐判定为永远未记录。
改为从引擎下发 `mealType`（结构化解法，不再反查展示名），
并抽出共享 helper `mealTypeOfSlot()`（含「加餐」优先于「午」的顺序约束）。

### 9. `ProgramPage.vue` 聚焦日菜单异步竞态
`watch` 回调内 `await` 无时序保护，快速点选日期时旧响应覆盖新日期菜单。
已用 Vue 的 `onCleanup` 标记过期结果。

### 10. UTC 取日期偏一天
`new Date().toISOString().slice(0, 10)` 取的是 UTC，UTC+8 的 00:00–08:00 会算成昨天。
影响体重航道「今天」标签与 AIPage 草稿时间（会出现「昨天 07:00」）。
已改用本地时区 `todayStr()` / `toDateStr()`。

### 11. `diffDays` / 重复间隔用毫秒差，与 Rust 不等价
Rust 用 `NaiveDate` 日历日相减，前端用本地午夜相减（夏令时日只有 23/25 小时），
mock 与真实后端可能物化出不同实例。已改 UTC 日历日，并让 `recurrence.ts` 复用 `diffDays`。

---

## 三、P1 架构与健壮性（已修）

- **数据损坏即白屏**：`ProgramPage` 的 `blob` / `adjustments` computed 裸调
  `parseBlob` 与 `JSON.parse`，`WrapupPage` 的 `onMounted` 无 try/catch ——
  方案数据损坏时整页崩或永久停在「加载中」。已降级为明确错误态并给回退入口。
- **规则 4 违规**：`SessionPage.applyWeight` 直接改 `s.weight`，未 `touch()`
  → 快照不落盘，进程被杀后恢复回预填值。已新增 store action `setWeight()`。
- **规则 7 违规**：ProfilePage 结余用 `Math.round(cents/100)` 手拼并丢分位，
  与同页 `ledgerSub` 口径不一。已统一走 `fmtCents()`（新增千分位选项）。

---

## 四、架构合规核查（通过）

- **IPC 三同步**：14 个 program 命令在 `commands.rs` / `lib.rs generate_handler!` /
  `programService.ts` 三方齐备；全量 87 条命令与 mock 分派逐条比对，无单侧缺失。
- **规则 2**：components/stores/pages 均无 `@tauri-apps/api` 直连，唯一出口是 `transport.ts`。
- **规则 3**：类型均从 barrel `@/types` 导入。
- **规则 6**：`db.rs` 纯追加（+106/−0，新增 0012/0013）。
- **规则 7**：Rust 结构体均带 `#[serde(rename_all = "camelCase")]`。
- 新增代码无 `any`、无遗留 `console.log`。

---

## 五、未处理项（需你决定）

| 项 | 说明 | 建议 |
| --- | --- | --- |
| 生产包含 mock chunk | `server-*.js` 896 kB（gzip 132 kB）进产物。Tauri 下永不 fetch，但增大安装包 | 用 `import.meta.env.DEV` 门控，让 Rollup 从生产构建摇掉 |
| `ProgramPage.vue` 1225 行 | script 段 558 行；另有 `ProgramEvolutionChart`(515)、`ProgramEvidenceSheet`(489) | 拆出采购清单 / 手动调参 / 历史列表子组件 |
| 训练天数上限三处不一致 | ProgramPage 6、`ProgramConstraints` [3,4,5,6]、`programEngine` 7 | 收敛到 `ADJUSTMENT_LIMITS` 单一来源 |
| 忌口过滤单向匹配 | 只做 `allergen.includes(kw)`，自定义整句（如「花生过敏」）静默不排除；同名逻辑在 RecipeLibraryPage 重复一份 | 抽公共函数并补反方向 |
| 周期网格星期错位 | 固定「一…日」表头 vs 按 startDate 每 7 天切片，startDate 非周一时整列错位 | 按 `dowOf(startDate)` 算首行偏移 |
| `bodyMetrics` 三处硬上限 100 | 长方案取不到起点体重 | 改为按方案区间查询 |
| 死代码 | `programCurves.ts` 的 `jetlagRisk` / `sleepVerdict` / `TIER_JETLAG_TOLERANCE` 零引用 | 删除 |
| `Rein/{[sS]})()` | 0 字节乱码文件（误操作产物），未提交 | 确认后删除 |
| `Rein/.workbuddy/` | 项目记忆目录，未提交 | 视需要决定是否入库 |
