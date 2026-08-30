# 组件审查：LedgerStats.vue

> `src/components/ledger/LedgerStats.vue` · 399 行 · 月度统计：收支汇总 + 预算进度 + 分类占比环 + 近 6 月趋势柱

**评级：C**

## 总评

信息设计与可访问性意识都在线：donut 有 `role="img"` + aria-label、预算进度条三态色全走令牌、趋势柱可点切换月份且带 aria-label、`.num` 无死角。但它是「width/height 动画 + `--dur-sheet` 曲线」这个项目级反模式的又一处复制源——预算条动 width、趋势柱动 height，都是触发 layout 的属性，且都用了 420ms 的抽屉曲线（曲线语义完全错位）。nutrition 组的 MacroBars/MicrosCard 已发现同款，四处应一并修。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L227-233 `.track i { transition: width var(--dur-sheet) var(--ease-sheet) }` | 改 scaleX：`transform: scaleX(progress); transform-origin: left; transition: transform var(--dur-base) var(--ease-standard)` | 动画 width 每帧触发 layout；`--dur-sheet`(420ms) 超 300ms 且是弹层专用曲线，用在数据条上语义错位——与 MacroBars L79 完全同源的反模式 | P0 |
| 2 | L368-372 `.bars i { transition: height var(--dur-sheet) … }` | 柱高改 scaleY（origin bottom）或保持静态：月度趋势切换频率极低，直接跳变亦可接受 | 同 #1：height 动画触发 layout；12 根柱 × 切月时整组重排，低端 WebView 上掉帧可见 | P0 |
| 3 | L277 `.seg-ring { transition: stroke-dasharray var(--dur-sheet) var(--ease-sheet) }` | 属性保留，时长换 `var(--dur-base)`、曲线换 `var(--ease-standard)` | stroke-dasharray 动画本身是 donut 正确做法；但 420ms 抽屉曲线超时且场景错位 | P1 |
| 4 | L72/L76/L167 内联 `style="color: var(--led-expense)"` 等 | 收进类（`.ex-c { color: var(--led-expense) }`） | 虽引用了令牌，但内联样式绕开 scoped 体系不可复用不可覆盖；同一文件内出现三次 | P2 |
| 5 | L88-90 超支时按钮文字变为「超支 ¥xx」 | 状态与动作分离：按钮恒为「调整」，旁边加 danger 色状态徽标 | 一个按钮两种身份：读屏会念出「超支 ¥320，按钮」，状态被误读为动作；颜色语义也随文案漂移 | P2 |

## 做得好的

- L115：SVG 带 `role="img"` 和中文 aria-label——图表可访问性在 56 个组件里屈指可数。
- L93/L235-241：预算条 ok/warn/over 三态全部引用语义令牌，80% 阈值预警逻辑清晰。
- L154-163：趋势柱是 button，支持键盘切月并带完整 aria-label。
- L49-54 / L126-129：dasharray 按占比精确分配、rotate 角度累积计算正确，分段间 2.5 单位留隙避免视觉粘连。
- L107/L147：两处空状态都有引导文案而非留白。

## 修复建议排序

- **P0**：① 预算条 width→scaleX（#1）；② 趋势柱 height→scaleY 或静态（#2）。与 MacroBars/MicrosCard 是同一个反模式，建议一次 PR 统一修掉。
- **P1**：③ donut 时长/曲线归位（#3）。
- **P2**：内联样式收编（#4）、超支状态与动作分离（#5）。
