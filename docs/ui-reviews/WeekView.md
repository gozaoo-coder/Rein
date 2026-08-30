# 组件审查：WeekView.vue

> `src/components/todo/WeekView.vue` · 107 行 · 周视图：本周每日完成度竖向进度条 + 完成计数，点选日期

**评级：C**

## 总评

小而规整的周历：`.num` 计数、满进度转绿、选中/今日态、令牌引用都到位，连进度填充都选了 `--ease-sheet` 这条有品味的曲线。但两处硬伤把它拉到 C——竖向进度条动画直接过渡 `height`（layout 属性，方法论性能红线），以及整列可点的 `<li>` 没有任何按压反馈与键盘可达性，而列正是本视图唯一的点击目标。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L92 `.fill { transition: height var(--dur-base) var(--ease-sheet); }`（配合 L44 `:style="{ height: `${ratioOf(d) * 100}%` }"`） | `.fill` 改固定满高 + `transform: scaleY(ratio); transform-origin: bottom;` 过渡 transform（或 `clip-path: inset(X% 0 0 0)` 避免圆角压扁） | 动画 layout 属性每帧触发 relayout/repaint，方法论性能红线「只动 transform 和 opacity」；数据加载后从 0 涨到目标值的入场表现可完整保留，且 `--ease-sheet` 的曲线选择应一并保留 | P0 |
| 2 | L34-41 `<li class="col center" @click="emit('select', d)">` 可点但无按压态（L57-64 样式仅 cursor:pointer + 背景过渡） | 给 li 补 `li:active { transform: scale(0.96) }` 或挂 `.pressable` 类 | 列是本视图唯一交互目标，触屏按下零反馈；base.css 只覆盖 button/.pressable，li 必须自带 | P1 |
| 3 | L34-48 `<li>` 无 `role`/`tabindex`/键盘事件 | 加 `role="button" tabindex="0"` + `@keydown.enter/.space` 触发同一 emit | 键盘用户无法选择日期；补上后全局 `:focus-visible` 焦点环自动生效 | P1 |

## 做得好的

- L46：完成计数 `done/total` 用 `.num` 等宽。
- L92：缓动选了 `--ease-sheet`（Apple sheet 曲线）——曲线品味正确，只是用错了属性。
- L95-97：满进度转 `--ok` 绿色，语义色正确。
- L66-68 / L104-106：选中态 `--accent-soft`、今日 accent 强调，与 MonthView 语言完全一致。
- L18-20：onMounted 拉取整周 stats，首屏即有数据可画。

## 修复建议排序

- **P0**：进度条 height 过渡改 transform/clip-path（#1）。
- **P1**：列按压反馈（#2）、键盘可达性（#3）。
