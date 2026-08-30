# 组件审查：MacroBars.vue

> `src/components/nutrition/MacroBars.vue` · 86 行 · 蛋白质/碳水/脂肪/钠四条宏量进度条（EnergySummary 内嵌）

**评级：C**（A=可直接作为范本；B=整体扎实，有应修项；C=存在手感/规范硬伤）

## 总评
结构、配色、`.num` 纪律都好，超标变红的设计意图也正确。但进度条填充动画踩了两条方法论红线：动画 `width` 触发 layout，且时长 600ms 远超 300ms 上限——每次记录食物后整组条形都在重排流上慢速爬行，低性能 Android WebView 上会掉帧。这是营养页复用组件，修复收益放大。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L26 `:style="{ width: `${pctOf(m)}%`, … }"` + L79 `.fill { transition: width 600ms … }` | L26 改绑 CSS 变量 `:style="{ '--p': `${pctOf(m)}%` }"`；L79 改 `.fill { clip-path: inset(0 calc(100% - var(--p)) 0 0); transition: clip-path var(--dur-base) var(--ease-standard); }` | 动画 `width` 每帧触发布局→绘制，违反「只动 transform/opacity（及 clip-path）」性能铁律；clip-path 不参与布局且保留 `border-radius: inherit` 圆头 | P0 |
| 2 | L79 `transition: width 600ms var(--ease-sheet)` | 时长收敛到 `var(--dur-base)`（250ms），曲线换默认 `var(--ease-standard)`（抽屉曲线留给弹层） | UI 动效应 <300ms；600ms 让「记录一笔食物」的反馈显得迟缓，且抽屉曲线用错场景 | P0 |
| 3 | L84 `.fill.over { background: var(--danger) !important; }` | 颜色在绑定里算好：`:style="{ background: isOver ? 'var(--danger)' : `var(${m.colorVar})` }"`（模板内联判断或 computed），删掉 `!important` | 内联 style 与 `!important` 打架是自造的优先级陷阱；数据驱动颜色后规则可预测、可测试 | P2 |

## 做得好的
- L7：`pctOf` 对 target≤0 除零防护 + 封顶 100%，数据边界处理干净。
- L18：数值挂 `.num`，记录食物时「123 / 130 g」不跳动。
- L15/L26：颜色经 `m.colorVar` 引用 `--c-protein / --c-carb / --c-fat / --c-sodium` 域色令牌，暗色模式自动跟随。
- L71-L74：轨道 `--radius-full` + `overflow: hidden`，填充圆角继承父级（`border-radius: inherit`），细条形态正确。
- 初次加载时 store 异步水合会让宽度从 0 过渡到目标值——改 clip-path 后这一入场动效天然保留。

## 修复建议排序
- **P0**（明显手感缺陷或违反方法论核心）：width → clip-path（问题 1）；600ms 收敛至 `--dur-base` 并换标准曲线（问题 2）。
- **P1**（应修）：无。
- **P2**（打磨项）：去除 `.over` 的 `!important`，颜色改为数据驱动（问题 3）。
