# 组件审查：ExerciseWeekCard.vue

> `src/components/exercise/ExerciseWeekCard.vue` · 118 行 · 本周运动概览卡：柱状图 + 汇总 + 能量平衡联动说明，整卡可点

**评级：A**

## 总评

可点卡片的教科书式实现：整卡走 `.pressable` 获得全局按压缩放与 `:focus-visible` 焦点环、Enter 键可达，内部「详情」角标是独立 button 并 `@click.stop` 阻断冒泡；所有数字（周分钟/周大卡/今日大卡）逐一 `.num`。reduced-motion 下主动关掉图表高度过渡的 `:deep()` 处理说明作者清楚子组件的运动来源。仅剩两处键盘语义打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L38-41 `:role="linkTo ? 'button' : undefined" :tabindex="linkTo ? 0 : undefined" @keydown.enter="goDetail"` | 补 `@keydown.space.prevent="goDetail"`（或抽一个 CardLink 工具组件统一处理） | `role="button"` 的键盘契约包含 Space；当前只响应 Enter，键盘用户按最直觉的空格键无反应 | P2 |
| 2 | L43-51 role="button" 的 section 内嵌真实 `<button class="more">` | 外层改为仅标题区可点，或外层用绝对定位透明链接层替代 role=button | 交互元素嵌套交互元素：读屏会把整卡内容（含内按钮文字）念成外层按钮的可及名，层级混乱 | P2 |

## 做得好的

- L37-41 可点态三件套齐全：`.pressable`（全局按压反馈）、`tabindex`、`@keydown.enter`——非 button 元素该做的一样不缺。
- L47 内层「详情」按钮带 aria-label 且 `@click.stop` 防双触发。
- L112-117 reduced-motion 下用 `:deep()` 关闭 ExerciseBars 的高度过渡并注释了职责边界（「交由全局 .pressable 过渡」）——对子组件运动有清醒认知。
- L46/L57 三处数值全部 `.num`；L56 Flame 图标色引用 `--c-exercise` 令牌。
- 分隔线/文字层级/圆角全令牌化，零魔法值。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：无。
- **P2**（打磨项）：① 补 Space 键激活（L38-41）；② 解除交互嵌套语义（L43-51）。
