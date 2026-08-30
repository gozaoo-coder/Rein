# Rein 组件 UI 审查总索引

> 2026-08-26 · 基于 Emil Kowalski 设计工程方法论对 `src/components/` 全部 **56 个组件**的逐一审查。
> 审查口径见 [_GUIDE.md](_GUIDE.md)；每组件一份报告 `<ComponentName>.md`，Before/After 均摘录真实代码并标注行号。

## 总览

| 评级 | 数量 | 口径 |
| --- | --- | --- |
| **A / A-** | 16 | 范本级，仅剩 P2 打磨项 |
| **B** | 32 | 整体扎实，有 P1 应修项 |
| **C** | 8 | 存在方法论硬伤（P0），需优先修 |

**整体结论**：项目动效骨架健康——全局基线（`:active` 按压、reduced-motion 兜底、焦点环）让薄组件免费获得正确手感；SheetModal 的进出不对称节奏、ActiveWorkoutBar 的弹簧拖拽、VirtualTimeline 的虚拟化手势都是范本级实现。问题集中在三类：①一处反模式被多处复制（layout 属性动画）；②令牌体系有「漏网之鱼」且已产生真实 bug；③非 button 可点元素的可达性系统性缺位。

## 🔴 最优先：两处「失效令牌」真 bug

以下引用的 CSS 变量在 tokens.css 及全仓库均未定义，整条 `transition` 声明非法被丢弃——动画从未执行过：

| 位置 | 引用 | 后果 |
| --- | --- | --- |
| [WorkoutDetailDrawer.md](WorkoutDetailDrawer.md) L495 | `var(--dur-slow)` | 分段条过渡整体失效（该行动画的还是 width，双重问题） |
| [ModelFormSheet.md](ModelFormSheet.md) L252 | `var(--ease-spring)` | 开关滑块瞬跳 |

## 🟠 项目级反模式：layout 属性动画（6 处同源）

「`transition: width/height` + `--dur-sheet`(420ms)」组合在数据条上被反复复制，每帧触发 relayout 且时长曲线双违规。修法一致：改 `scaleX/scaleY`（配 transform-origin）或 `clip-path: inset()`，一次 PR 统一落地：

[MacroBars](MacroBars.md) L79 · [MicrosCard](MicrosCard.md) L114 · [LedgerStats](LedgerStats.md) L232+L371 · [ExerciseBars](ExerciseBars.md) · [MonthView](MonthView.md) · [WeekView](WeekView.md)

## 🟡 令牌缺口横向清单（建议一批新增，全库替换）

| 建议新增令牌 | 现状 | 涉及报告 |
| --- | --- | --- |
| `--on-accent: #ffffff` | accent 底白字硬编码 ~10 处 | SmartAddSheet、PageHeader、FoodPickerSheet、BudgetSheet、LedgerEntrySheet 等 |
| `--scrim` | 全屏遮罩两套数值并存（0.4 / 0.32） | SheetModal vs ActionSheet、HistoryDrawer |
| `--danger-soft` / `--ok-soft` | soft 底色手写且数值漂移（0.10/0.12）、暗色硬编码 | FoodDetailDrawer、LedgerEntrySheet、DietChecksCard、BodyTrackerCard |
| `--fs-display-*` | 大数字 40/44/34px 各页自定 | FoodDetailDrawer、EnergySummary、TargetCalculator、PomodoroCard |
| `--shadow-thumb` / `--shadow-cta` | 手写阴影三源复制 | SegmentedControl、FoodPickerSheet、LedgerStats |
| （修正）`--ease-spring` / `--dur-slow` | 被引用但未定义 → 补定义或删引用 | 见上节两处 bug |

其他高频 P1：`transition: all` ×4（SmartAddSheet L525、TodoEditorSheet L231、TodoItem L72、AddWorkoutSheet）；异步写入按钮无 busy 态防连点 ×2（FoodParseSheet、FoodPickerSheet；正面典型是 LedgerEntrySheet 的 `canSave 含 !saving`）。

## 🔵 系统性缺口：非 button 可点元素

全局按压反馈只挂在 `button/.pressable` 上，以下自定义可点区域无反馈也无键盘路径：BodyTrackerCard 历史条目（裸 li）、BentoOverview 整卡 div ×2、MuscleMap 整图容器、FoodParseEditor 信息区 div、TodoItem 正文 div、MonthView/WeekView 日历格 li、HomeTodoCard「查看全部」router-link。统一修法：换 button 语义或补 `.pressable` + tabindex。

## 「勾选完成」微交互缺口（同一模式跨三域）

最高频的正反馈时刻普遍是半成品——对勾图标 `v-if` 瞬现、完成态文字删除线瞬跳：[TodoItem](TodoItem.md)、[DesktopInspector](DesktopInspector.md)、[SmartAddSheet](SmartAddSheet.md)。标准修法已写入各报告（120ms 对勾 scale-in + text-decoration-color 过渡），可提炼为一个小组件复用。

---

## 分域评级表

### common/（基础组件）
| 组件 | 评级 | 一句话 |
| --- | --- | --- |
| [SheetModal](SheetModal.md) | B+ | 抽屉基石接近范本：不对称进出、指针捕获、键盘调档俱全；缺速度吸附与 Esc |
| [ToastHost](ToastHost.md) | B | TransitionGroup 选型正确；魔法色 + fixed 定位未避让悬浮运动条 |
| [ActionSheet](ActionSheet.md) | B | 同速进出违反「退出更快」；遮罩色与 SheetModal 不一致 |
| [SegmentedControl](SegmentedControl.md) | B | thumb 平移方案正确；缺 tablist 语义 |
| [SmartAddSheet](SmartAddSheet.md) | B | 确认流成熟；transition:all + 忙碌态清空竞态 |
| [CountdownOverlay](CountdownOverlay.md) | B | 过冲 pop 仪式感到位；done 延迟回调有清理竞态 |
| [NumberStepper](NumberStepper.md) | A | 边界钳制与禁用态齐备的标准件 |
| [RingProgress](RingProgress.md) | A | dashoffset 方案的教科书实现 |
| [ActivityRings](ActivityRings.md) | A | 纯组合薄封装，比例恒定 |
| [QuickTile](QuickTile.md) | A | 40 行零缺陷磁贴 |
| [EmptyState](EmptyState.md) | A | 克制正确，可选 CTA 插槽 |

### layout/（导航壳层）
| 组件 | 评级 | 一句话 |
| --- | --- | --- |
| [TabBar](TabBar.md) | A | reduced-transparency 兜底全项目唯一；高频 tab 正确地不加动效 |
| [PageHeader](PageHeader.md) | B | :slotted 统一规范用心；accent 白字 + 双按压深度 |
| [DesktopRail](DesktopRail.md) | A | 显式列举过渡属性的全项目正面对照 |
| [DesktopInspector](DesktopInspector.md) | B | AI 问句输入被吞（P1 功能缺陷）+ 完成态文字瞬跳 |

### diet/
| 组件 | 评级 | 一句话 |
| --- | --- | --- |
| [FoodDetailDrawer](FoodDetailDrawer.md) | B | sticky 记录坞 + 反色 CTA 是亮点；微量条静态贴图感 |
| [FoodParseEditor](FoodParseEditor.md) | B | 行内编辑链路完整；索引 key + 删除 = 错位隐患 |
| [FoodPickerSheet](FoodPickerSheet.md) | B | 搜索零动画是正确克制；confirmAdd 可连点双写 |

### ledger/
| 组件 | 评级 | 一句话 |
| --- | --- | --- |
| [LedgerList](LedgerList.md) | A- | 符号语言与 aria-label 干净；死样式一条 |
| [BudgetSheet](BudgetSheet.md) | A- | 表单可访问性三件套齐全；仅 on-accent 缺口 |
| [LedgerEntrySheet](LedgerEntrySheet.md) | B | canSave 含 saving 的防连点同类最佳；删除无确认 |
| [LedgerStats](LedgerStats.md) | C | width/height 动画双踩红线（反模式复制源之一） |

### nutrition/
| 组件 | 评级 | 一句话 |
| --- | --- | --- |
| [MacroBars](MacroBars.md) | C | width 600ms 双违规，反模式源头之一 |
| [MicrosCard](MicrosCard.md) | C | 与 MacroBars 同源问题 ×十几条，layout 压力更大 |
| [BodyTrackerCard](BodyTrackerCard.md) | C | 核心交互挂裸 li 无反馈无键盘；BMI 三组魔法色 |
| [EnergySummary](EnergySummary.md) | B | 数字排版堪称范本；44px 阶梯外字号 |
| [DietChecksCard](DietChecksCard.md) | B | 状态变色诚实；完成态绿色硬编码三处 |
| [AiTargetAdjustCard](AiTargetAdjustCard.md) | B | 建议 v-if 瞬现 + 忙碌态宽度跳变两处打磨 |
| [TargetCalculator](TargetCalculator.md) | B | 表单手感成熟；34px 展示字号未入阶梯 |
| [TargetsEditor](TargetsEditor.md) | A | 受控组合教科书：零状态零魔法值 |
| [MacroDetailCard](MacroDetailCard.md) | A | 纯静态展示卡零瑕疵 |

### exercise/
| 组件 | 评级 | 一句话 |
| --- | --- | --- |
| [ActiveWorkoutBar](ActiveWorkoutBar.md) | B | 弹簧拖拽停靠范本级（速度解算/橡皮筋/可打断）；令牌卫生欠账 |
| [WorkoutDetailDrawer](WorkoutDetailDrawer.md) | C | 数据层最扎实，但 --dur-slow 失效 + width 动画双重伤 |
| [MuscleMap](MuscleMap.md) | B | SVG 分层工程精良；整图可点区无 role/键盘路径（2×P1） |
| [ExerciseBars](ExerciseBars.md) | C | 仅一处 transition:height，改 scaleY 即升 A |
| [ExerciseWeekCard](ExerciseWeekCard.md) | A | 可点卡片教科书：焦点环/Enter/stop 冒泡/reduced-motion 全齐 |
| [ExerciseDetailDrawer](ExerciseDetailDrawer.md) | B | badge 青色系手写且暗色分支漂移 |
| [PlanRecentCard](PlanRecentCard.md) | A | 无应修项 |
| [AddWorkoutSheet](AddWorkoutSheet.md) | B | chips transition:all + 手写阴影 + 裸字号 |
| [WorkoutRow](WorkoutRow.md) | B | 运动绿 #5ba800 绕开 tokens 暗色提亮机制 |

### todo/
| 组件 | 评级 | 一句话 |
| --- | --- | --- |
| [VirtualTimeline](VirtualTimeline.md) | B | 工程密度最高；捏合越捏越快（指数加速）待修 |
| [TodoItem](TodoItem.md) | B | hover:none 触屏分支是亮点；勾选时刻过渡半成品 |
| [TodoEditorSheet](TodoEditorSheet.md) | B | 表单秩序井然；chip transition:all |
| [TodoListCard](TodoListCard.md) | B | 渐进披露结构最佳；空态文案指向不存在的输入框 |
| [HomeTodoCard](HomeTodoCard.md) | B | router-link 游离在按压体系外 |
| [MonthView](MonthView.md) | C | 进度条 width 动画红线 + 日历格 li 无键盘可达 |
| [WeekView](WeekView.md) | C | 进度填充 height 动画红线（同根同源） |
| [ScheduleCard](ScheduleCard.md) | A | 极薄组合层，交互正确下沉 |
| [TimelineSheet](TimelineSheet.md) | A | 35 行纯编排零错误 |

### ai/ · pomodoro/ · workbench/
| 组件 | 评级 | 一句话 |
| --- | --- | --- |
| [ManageModelsButton](ManageModelsButton.md) | A | 全令牌零缺陷，点击即跳零动画 |
| [ModelFormSheet](ModelFormSheet.md) | B | --ease-spring 失效致开关瞬跳；保存等待态同类最佳 |
| [FoodParseSheet](FoodParseSheet.md) | B | 动效全委托基线；提交可连点重复写入 |
| [HistoryDrawer](HistoryDrawer.md) | B | 遮罩色 0.32 与主抽屉不一致 |
| [PomodoroCard](PomodoroCard.md) | B | 动态 aria-label 切换是亮点；38px 裸字号 |
| [BentoOverview](BentoOverview.md) | B | 内联魔法色成灾 + 两卡不可键盘达 |
| [DaySpine](DaySpine.md) | B | 呼吸点纯 opacity + 显式 reduced-motion 自觉；v-for 索引 key 隐患 |

## 建议修复路线

1. **第一批（~半天，纯收益）**：修两处失效令牌引用；新增 `--on-accent/--scrim/--danger-soft/--ok-soft` 并全库替换；清掉 4 处 `transition: all`。
2. **第二批（一个 PR）**：6 处 width/height 动画统一改 `scaleX/scaleY` 或 `clip-path`，时长归 `--dur-base`、曲线归 `--ease-standard`。
3. **第三批**：非 button 可点元素补 button 语义/`.pressable`；「勾选完成」微交互做成模板（对勾 120ms scale-in + 删除线 color 过渡）铺到三个域；FoodParseSheet/FoodPickerSheet 补 busy 态。
