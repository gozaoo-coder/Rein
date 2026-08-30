# 组件审查：PlanRecentCard.vue

> `src/components/exercise/PlanRecentCard.vue` · 182 行 · 训练课程卡：最近三个课程的列表 + 播放键快速开始 + 冲突接续弹层

**评级：A**

## 总评

交互闭环完整、防御性好的列表卡：每个按钮显式 `type="button"`，播放键带模板化 aria-label 并在异步启动期间 `disabled` 防双击，会话冲突走 ActionSheet 二次引导而不是静默失败；空态（创建第一个课程）与常态（新建课程）是两个视觉权重不同的入口，层级正确。全部令牌化、零自有动画。剩余均为锦上添花项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L151-153 `.play:disabled { opacity: 0.4; }`（`quickStart` await 期间的唯一反馈） | 启动期间把 Play 图标换成 spinner 或给按钮加 `animation: spin … linear infinite` | `session.start` 含 IO，慢设备上可能超过一瞬；仅变暗与「不可用」语义混淆——用户分不清是禁用还是处理中 | P2 |
| 2 | L50-68 列表项随数据一次性出现 | 如需打磨可加 30-80ms 间隔的 stagger 淡入 | 多元素同时进场缺少 cascading 节奏；但最多三项且常驻缓存数据，收益有限 | P2 |

## 做得好的

- L44/L51/L59/L71/L75 全部 button 显式 `type="button"`，本批组件中执行最齐的一个。
- L62-64 播放键 `:aria-label="`开始「${p.name}」`"` 带上下文课程名 + `:disabled="startingId === p.id"` 精确锁定正在启动的那一项而非整列。
- L28-37 `try/finally` 保证启动失败后 startingId 复位，不会留下永久禁用的按钮。
- L79-85 会话冲突不静默丢弃：ActionSheet 明示「已有进行中的训练」并直接引导前往接续路由。
- L54-56 元信息行 `.num` 等宽 + 双段 ellipsis（L122-139），长课程名不破版式。
- L155-176 空态入口（大 padding 灰底）与新建入口（小 padding）视觉分级，主次分明。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：无。
- **P2**（打磨项）：① 异步启动期给播放键 loading 形态（L151-153）；② 列表进场 stagger（L50-68）。
