# 组件审查：EmptyState.vue

> `src/components/common/EmptyState.vue` · 37 行 · 空状态：图标 + 标题 + 提示

**评级：A**

## 总评

极简且正确的空状态组件：图标细线风格统一（stroke 1.6）、文字色阶 text-2/text-3 拉开层级、无任何多余样式。两个「可以更好」：内容切换进来的瞬间是硬切，以及缺少行动按钮插槽——空状态的终点是引导用户走出空态。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L13-17 内容静态渲染 | 外层加一次性入场 `@starting-style`/transition：`opacity 0→1` + `translateY(6px)→0`，250ms ease-out | 列表清空、筛选无结果时旧内容消失空态瞬跳，衔接生硬；轻淡入即可标示状态迁移（仅 opacity 微位移，不喧宾夺主） | P2 |
| 2 | 无 CTA 插槽 | 增加 `<slot name="action">`（如「记录第一笔」「添加待办」按钮） | Apple HIG 对 empty state 的要求是解释+行动；纯提示把用户晾在原地。属 UX 完整性而非动效问题 | P2 |

## 做得好的

- L14：图标 stroke-width 1.6 与全站 lucide 细线风格一致。
- L21-35：间距紧凑、色阶克制（text-3 图标 / text-2 标题 / text-3 提示），不与页面主内容抢注意力。

## 修复建议排序

- **P0/P1**：无。
- **P2**：轻量入场过渡（#1）、CTA 插槽（#2）。
