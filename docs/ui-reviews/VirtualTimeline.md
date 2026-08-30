# 组件审查：VirtualTimeline.vue

> `src/components/todo/VirtualTimeline.vue` · 571 行 · 虚拟化连续时间轴：窗口化渲染 + 双指/Ctrl+滚轮缩放 + 折叠/展开双形态

**评级：B**

## 总评

全项目工程密度最高的组件，方法论执行度整体很高：虚拟化只渲染可视窗 ±600px、单指滚动交给原生合成器保动量、捏合以视口锚点保持时刻不动、preview 用一次性 transform 锚定、done 块透明度平滑过渡、令牌纪律严格。扣分集中在手势数学与边界：捏合缩放的因子基准写错导致越捏越快（指数级加速的硬手感缺陷）、缩放手势没有按 preview 态禁用会弄脏冻结预览、外加一处字号魔法值。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L199 `pinch = st ? { d0: st.d, yCenter: st.yCenter } : null`（d0 固定为手势起点间距，全程不更新）；L212 `zoom(st.d / pinch.d0, pinch.yCenter)` | L212 改为 `zoom(st.d / pinch.d0, ...)` 后追加 `pinch.d0 = st.d`，把因子变成相邻两帧的增量 | `zoom()` 内 px0 是「当前」pxPerHour（已含此前所有帧的缩放），却乘上相对起点的累计比例——总缩放变成 ∏(dᵢ/d₀) 指数复利，两指捏合越到后面窜得越快，直接操纵手感失真 | P1 |
| 2 | L170-176 `onWheel` 与 L202-214 `onTouchMove` 未区分形态，preview 态同样可缩放 | 两入口顶部加 `if (isPreview.value) return` | preview 是靠 L258-260 一次性写入的 transform 冻结的画面：缩放改 `pxPerHour` 后 content 高度变化而 translateY 不重算，折叠预览轴直接错位；冻结态也不该响应手势 | P1 |
| 3 | L528 `.now-tag { font-size: 10px; }` | `font-size: var(--fs-micro);`（11px） | 字号阶梯最小档就是 `--fs-micro`，10px 是游离于令牌体系外的魔法值，违反「字号一律引用令牌」的项目规范 | P1 |
| 4 | L467 `.block { transition: transform var(--dur-fast) var(--ease-standard), opacity var(--dur-fast); }` — opacity 只给了时长没给曲线 | `opacity var(--dur-fast) var(--ease-standard)` | 无缓动函数时回落到浏览器默认 `ease`，与同声明里 transform 的自定义曲线不同步，勾选完成时两个属性节奏不一致 | P2 |
| 5 | L95 `const nowTop = computed(() => yOf(today, nowMin()))` — `nowMin()` 非响应式 | 组件可见时用分钟级 `setInterval` 更新一个 `nowMinRef`，computed 改为依赖它 | nowline 与 gauge 的「现在」标签只在其他依赖（如缩放）变化时才顺带刷新；应用跨小时停留后红线位置与真实时刻脱节 | P2 |
| 6 | L147-151 `onScroll()` 每个滚动事件同步直写 `scrollTop.value`，连带 range/ticks/dayHeads/blocks/gauge 五个 computed 全量重算 | 用 `requestAnimationFrame` 合帧：事件里只记 `pending = el.scrollTop`，帧回调再写入 ref | 高频滚动下每帧重建数组带来 GC 压力，低端 Android WebView 上可能掉帧；虚拟化的收益不该被响应式风暴吃掉 | P2 |

## 做得好的

- L66-70 + L34：可视窗外预留 600px BUFFER，正常速度滚动看不到白块，虚拟化对用户完全隐形——这正是「看不见的细节」。
- L290-297 + L503-508：零高 sticky 钉子实现顶部时间条，不挤占内容布局；注释还解释了为什么必须放在 `.content` 之前，边角案例思考到位。
- L348 `touch-action: pan-y` 把单指滚动交给合成器保住惯性；L282-284 `touchstart.passive` / 非 passive `touchmove` 的组合精确控制 preventDefault 权限。
- L205-209：滚动中落下第二指才开启捏合并免首帧跳变，多指切换保护正确。
- L160-168：缩放以视口内指定 y 为轴心反解 scrollTop，「该处时刻不动」的数学完全正确。
- L258-260：preview 锚定直接写 `transform: translateY()`，GPU 友好且不受布局影响。
- L467 + L494-500：done 块走 opacity + 删除线过渡，勾选完成不平滑瞬跳（比列表视图的 TodoItem 做得好）。
- L279 / L333：preview 宿主与「回到现在」按钮均有 aria-label；L375-378 preview 自定义了 inset 焦点环。
- L338-340 + L548-558：底部渐隐 + 「查看完整时间线」胶囊，把可点性暗示做进视觉而非依赖运气。
- 全文件颜色/圆角/时长/缓动引用令牌（#3 的 10px 是唯一漏网）。

## 修复建议排序

- **P0**：无。
- **P1**：捏合因子改增量制（#1，手感影响最直接）、preview 态禁用缩放手势（#2）、10px 收编令牌（#3）。
- **P2**：opacity 补缓动（#4）、now-line 时效性 ticker（#5）、滚动 rAF 合帧（#6）。
