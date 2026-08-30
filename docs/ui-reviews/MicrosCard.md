# 组件审查：MicrosCard.vue

> `src/components/nutrition/MicrosCard.vue` · 123 行 · 微量元素全览：逐项对照 DRI 的迷你进度条列表

**评级：C**（A=可直接作为范本；B=整体扎实，有应修项；C=存在手感/规范硬伤）

## 总评
与 MacroBars 同构的迷你条形列表，超标语义（≤ 上限项变红）表达清晰，数值 `.num` 纪律良好。核心问题与 MacroBars 完全同源：`.bar i` 动画 `width` 且 600ms 超长——本卡多达十几条微条同时爬行，layout 压力比 MacroBars 更大，是营养详情页最该优先修的一处。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L40 `:style="{ width: `${c.pct}%`, … }"` + L114 `transition: width 600ms var(--ease-sheet)` | L40 改绑 `:style="{ '--p': `${c.pct}%`, background: … }"`；L114 改 `.bar i { clip-path: inset(0 calc(100% - var(--p)) 0 0); transition: clip-path var(--dur-base) var(--ease-standard); }` | `width` 动画每帧触发布局，违反只动 transform/opacity/clip-path 的性能铁律；clip-path 方案不参与布局且保留 `border-radius: inherit` 圆头 | P0 |
| 2 | L114 `transition: width 600ms var(--ease-sheet)` | 时长收敛至 `var(--dur-base)`（250ms），曲线换 `var(--ease-standard)` | UI 动效应 <300ms：进入详情页时十几条微条齐刷 600ms，页面显得迟迟未就绪；抽屉曲线亦非此场景所用 | P0 |

## 做得好的
- L17-L18：`pct` 除零防护 + 封顶 100%；`over` 仅对 `isLimit === true` 生效，上限/下限语义在数据层分清。
- L32/L76-L78：超标项整行文字变 `--danger`，与 L40 条形变红形成双重信号，「不要超过」的警示一眼可辨。
- L35：数值挂 `.num`，DRI 对照读数不跳动。
- L40：条形颜色引用 `--danger / --accent` 令牌（三元切换在绑定内完成，无 `!important` 对抗——这点比 MacroBars 干净）。
- L103-L108：4px 细轨道 + `overflow: hidden` + 圆角继承，微条形态精致。

## 修复建议排序
- **P0**（明显手感缺陷或违反方法论核心）：width → clip-path 并收敛时长至 `--dur-base`（问题 1、2，可与 MacroBars 一并修）。
- **P1**（应修）：无。
- **P2**（打磨项）：如需进一步打磨，可为 `.item.over` 的变红补一条 `color var(--dur-fast)` 过渡，使超标瞬间不生硬。
