# 组件审查：DaySpine.vue

> `src/components/workbench/DaySpine.vue` · 404 行 · 桌面主页一日脊柱：今日记录按时间轴纵向陈列，未来安排虚线标示，含「现在」呼吸点

**评级：B**（整体扎实，有应修项）

## 总评

时间轴的动效功底好：呼吸点用纯 opacity 循环（不碰 transform/layout），且自带 `prefers-reduced-motion` 显式关闭，超出全局兜底的自觉；事件色经 `--ec` 自定义属性派发、图标底 color-mix 派生，零硬编码色。核心隐患在工程与状态层：v-for 用数组索引作 key 而 rows 会动态插入行，存在复用错位风险并堵死后续入场动画；「现在」时刻只在挂载时计算一次，页面长开后整条脊柱的时间语义失真。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `L199 <template v-for="(row, i) in rows" :key="i">` | `:key="row.type === 'ev' ? row.e.key : 'now'"`（SpineEvent 已有稳定 key 字段） | rows 会在中部插入「现在」行、头部插入新记录，索引 key 导致节点内容错位复用；也是引入 TransitionGroup 的前置条件 | P1 |
| 2 | `L32 const now = nowMin()`（仅初始化一次的非响应式常量） | 注入响应式时钟（定时器或页面聚焦时刷新 now） | now 决定呼吸点插入位置（L176）、plan 判定（L158）与「现在」chip 文案（L201），跨小时长开页面后全部失真，「进行中/计划」语义过期 | P1 |
| 3 | `L198-222` events 变化直接重渲染，新记录卡瞬时闪现 | TransitionGroup 包裹列表，enter 用 opacity + translateY(6px) 约 200ms ease-out，配 move 过渡 | 新饮食/记账落地时卡片凭空出现，进场应有轻量淡入（依赖问题 1 的稳定 key） | P2 |
| 4 | `L216 <span class="esb">{{ row.e.sub }}</span>`（.esb 无等宽设置） | `.esb { font-variant-numeric: tabular-nums; }` | 进行中番茄的副标题是每秒刷新的 mm:ss（L122），比例字宽导致秒位跳动 | P2 |

## 做得好的

- L335-339 / L359-380 呼吸点脉冲只动 opacity（1.6s 循环），无 layout 参与，性能正确、节奏克制。
- L398-403 显式 `prefers-reduced-motion: reduce` 关闭脉冲动画，超出 base.css 全局兜底的自觉。
- L201 / L210 / L218 时间与数值全部套 `.num`。
- L208 通过 `--ec` 自定义属性向子树派发事件色；L299 图标底用 color-mix 从令牌派生——全组件零硬编码颜色。
- L328-332 未来计划虚线卡与已发生实体卡视觉分层清晰；L223 空态有引导文案。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：行 key 改用稳定业务 id；「现在」改为响应式时钟驱动。
- **P2**（打磨项）：TransitionGroup 入场/move 过渡；`.esb` 补 tabular-nums 防秒位跳动。
