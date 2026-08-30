# 组件审查：FoodDetailDrawer.vue

> `src/components/diet/FoodDetailDrawer.vue` · 326 行 · 食品详情抽屉：热量宏量 + 份量换算 + 微量对照 DRI

**评级：B**

## 总评

内容架构与排版是亮点：供能占比堆叠条用 `flex: m.pct` 纯数据驱动、底部「记录」按钮的 sticky 悬浮 + 渐变遮罩 + `pointer-events` 穿透三件套（L302-312 注释把意图讲得清清楚楚）是全项目少见的讲究细节；反色 CTA 用 `--text-1`/`--bg` 令牌实现亮暗自适应也是聪明的做法。扣分在微量进度条完全静态无入场，以及 danger soft 底色手写。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L265 `background: rgba(255, 59, 48, 0.12)`（「上限」badge 底色） | tokens 新增 `--danger-soft: rgba(255, 59, 48, 0.12)` 并引用 | 这是 `--danger` 的手工透明副本；nutrition 组已发现同构缺口（`--ok-soft`），两个 soft 令牌应一并建立 | P1 |
| 2 | L110-112 微量条 `.fill` 无任何过渡，打开抽屉即终值 | 打开时从 0 生长：`.fill { transform-origin: left; transform: scaleX(var(--p)); transition: transform var(--dur-base) var(--ease-standard) }` + 挂载后置位（或 clip-path） | 抽屉展开本身有 420ms 动画，内部条形却静态贴好——数据「长出来」与抽屉上滑的时间感连续，瞬现则像贴图；注意用 scaleX 而非 width（layout 属性） | P2 |
| 3 | L159-163 `.kcal b { font-size: 40px }` 阶梯外字号 | tokens 补 `--fs-display-l: 40px`（与 nutrition 组发现的 44px/34px 一并建 display 阶梯） | 字号阶梯最大只到 32px，各页大数字各自为政（40/44/34/26px 已出现四种）；规范要求引用令牌 | P2 |
| 4 | L318 `border-radius: 26px`（52px 高 CTA 的胶囊） | `border-radius: var(--radius-full)` | 视觉等价的巧合魔法值；radius-full 语义就是胶囊，无需写死一半高度 | P2 |
| 5 | L323 `box-shadow: 0 8px 20px rgba(29,29,31,0.22)` | tokens 新增 `--shadow-cta` 并引用 | 手写阴影第三处复制源（另见 SegmentedControl thumb、FoodPickerSheet stepper）；暗色下黑阴影不可见但也不出错，优先级让位于色彩类 | P2 |
| 6 | L72-78 供能占比堆叠条无入场 | 与 #2 同批处理：容器加载时各段从 0 以 stagger 30ms 展开（scaleX） | 详情页的「解释性动画」时刻——三段占比一眼看懂比数字列表更直观，值得 250ms 的生长 | P2 |

## 做得好的

- L304-312：record-dock 的 sticky + 负 margin 贴边 + 渐变遮罩 + `pointer-events: none`（按钮单独恢复 auto）——内容可滚过按钮区且手势穿透，工程与体验双赢。
- L319-320：CTA 反色方案 `background: var(--text-1); color: var(--bg)`，零新增令牌实现亮暗两套反差。
- L21-34：供能占比计算含除零防护与 <0.5% 过滤，边界干净。
- L46-49：fmt 按 100 以上取整/以下留一位小数，数字噪声控制得当。
- 全文 `.num` 覆盖完整，金额克重无一跳动。

## 修复建议排序

- **P0**：无。
- **P1**：① `--danger-soft` 令牌化（#1）。
- **P2**：条形入场动画（#2/#6）、display 字号阶梯（#3）、胶囊圆角与阴影令牌化（#4/#5）。
