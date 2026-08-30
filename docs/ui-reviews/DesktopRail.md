# 组件审查：DesktopRail.vue

> `src/components/layout/DesktopRail.vue` · 102 行 · 桌面三窗格壳左侧导航轨，替代移动端 TabBar

**评级：A**

## 总评

小而正确的桌面导航：42px 图标钮达标触控/悬停目标、hover 提亮 + active 双色底、aria-label 与 title 齐全。L85-87 的过渡声明是全项目的正面教材——只列 `color, background-color` 两个属性，正是 Emil 反复强调的写法。剩余都是打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L94-97 选中态仅底色/图标色瞬切 | 增加共享高亮块：单一 `.indicator` 元素按选中 index `translateY()` 滑动到对应项（FLIP 或固定行高计算），180ms ease-out | 导航位切换是空间隐喻最强的时刻，「高亮块滑过去」比「这里突然变色」更能表达页面在移动；桌面鼠标操作频率适中，180ms 不拖沓 | P2 |
| 2 | L21 logo 26×26，小于其余 42px 项 | 视觉不变，热区扩到 ≥36px（padding 或伪元素外扩） | logo 可点击回主页但命中区是全轨最小；误触率与挫败感集中在第一颗钮上 | P2 |
| 3 | L32/L42 stroke-width 2.2/1.9 切换无过渡 | 同 TabBar：接受瞬跳或双层图标叠 opacity | 与 TabBar 相同的取舍，两处应保持同一决策（建议都维持现状并文档化） | P2 |

## 做得好的

- L85-87：`transition: color …, background-color …` 显式列举——checklist 第一条的标准答案，可作为项目内引用范例。
- L76-79：42×42 圆角方块，桌面 hover 与触屏点按双达标。
- L20/L29-30：nav 有 `aria-label="主导航"`，每项 aria-label + title 双份提示。
- L69：logo 用三环域色 conic-gradient 合成品牌记忆点，零图片资源。
- L99-101：`.me` 置底 `margin-top: auto`，主次分区符合 macOS 侧栏惯例。

## 修复建议排序

- **P0/P1**：无。
- **P2**：选中高亮块滑动（#1）、logo 热区（#2）、stroke-width 决策与 TabBar 对齐（#3）。
