# 组件审查：EnergySummary.vue

> `src/components/nutrition/EnergySummary.vue` · 132 行 · 能量与营养总览：三环 + 摄入/消耗/剩余 + 宏量进度条入口

**评级：B**（A=可直接作为范本；B=整体扎实，有应修项；C=存在手感/规范硬伤）

## 总评
页面级核心卡片，自身动效极少（环形与进度条分别委托 ActivityRings / MacroBars），数字排版与 `.num` 纪律堪称范本，「详情」按钮显式带 `.pressable`。唯一应修项是主数字 44px 为阶梯外魔法字号；打磨层面，加餐后大数字直接跳变，可考虑低频数值补间。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L93 `.intake { font-size: 44px; … }` | 在 tokens.css 字号阶梯新增展示级令牌（如 `--fs-display: 44px`）后引用 `font-size: var(--fs-display);` | 字号必须引用令牌：44px 是全站阶梯（最大 `--fs-large-title: 32px`）外的魔法值，其他页面的主数字无法与之对齐 | P1 |
| 2 | L40 `<span class="num intake">{{ n.kcalIntake }}</span>`（记录食物后数值直接跳变） | 低频更新可用轻量补间：watch 数值后以 rAF 或 Motion spring 做 250-400ms 数字滚动（reduced-motion 下直跳） | 摄入热量是用户最关注的单一指标，平滑计数让「+300 大卡」的变化可感知、有因果感；更新频率低（每次记录一笔），不违反高频不加动画原则 | P2 |

## 做得好的
- L30：「详情」按钮显式叠加 `pressable` 类——虽是 button 已被 base.css 覆盖，但显式声明表达了「这是可点元素」的意图，一致性友好。
- L33/L40/L41/L47/L51：日期、摄入、目标、消耗、剩余全部挂 `.num`，等宽数字在 44px 大字下尤为关键，做对了。
- L46/L50：图例圆点颜色引用 `--c-exercise / --c-balance` 域色令牌，与三环同源。
- 组件自身零 transition/keyframes，动效职责正确下沉到 ActivityRings 与 MacroBars，无重复实现。
- L21-L23：`goDetail` 有 `linkTo` 才渲染按钮，无可导航时不留死按钮。

## 修复建议排序
- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：44px 主数字新增展示级字号令牌并引用（问题 1）。
- **P2**（打磨项）：摄入大数字低频补间滚动（问题 2）。
