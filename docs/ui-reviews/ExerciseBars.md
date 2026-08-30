# 组件审查：ExerciseBars.vue

> `src/components/exercise/ExerciseBars.vue` · 66 行 · 运动分钟柱状图（周 7 柱 / 年 12 柱），今日柱高亮

**评级：C**

## 总评

结构极简、令牌使用干净、`.num` 标签与 today 高亮模式都对，但唯一的动效踩在方法论的性能红线上：柱体填充用 `transition: height` 做生长动画，height 是 layout 属性，每次数据到达（周卡挂载后 `loadWeek` 异步回填、当日补记运动）都会触发 7 个元素的重排重绘。这是本组件唯一的问题——修掉即可从 C 升到 A。曲线选择本身没错（数据形变属「屏上移动」，`--ease-sheet` 的强 in-out 合适）。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L50 `transition: height var(--dur-base) var(--ease-sheet);` | 柱体改为整高 + `transform: scaleY()`、`transform-origin: bottom`（或用 `clip-path: inset(0 0 calc(100% - var(--v)) 0)` 揭示），过渡属性换成 transform/clip-path | 只动 transform/opacity 是方法论性能核心规则；height 触发 layout→paint 全链路，Android WebView 低端机上批量柱体同帧生长易掉帧 | P0 |

> 配套改动：L17 `:style="{ height: `${(b.value / maxMin) * 100}%` }"` 需同步改为写入 CSS 变量供 scaleY/clip-path 消费；注意 scaleY 会轻微纵向拉伸柱顶圆角，介意可用 clip-path 方案保留形状。

## 做得好的

- L10 `Math.max(60, …)` 归一化保底 60 分钟刻度，避免全零数据下除零与柱体比例失真。
- L17/L53-55 高亮只切 opacity（0.45 → 1），不额外换色，GPU 合成友好。
- L19 标签 `.num` 等宽；全部颜色/圆角/时长引用令牌，零魔法值。
- L38 轨道 `--radius-full` 与 L47 `border-radius: inherit` 让填充圆角自动跟随轨道，一处定义。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：① height 过渡改 transform scaleY / clip-path（L50，配套 L17）。
- **P1**（应修）：无。
- **P2**（打磨项）：② 可为每根柱补充 aria-label（如「周三 · 45 分钟」），当前数值对读屏不可达。
