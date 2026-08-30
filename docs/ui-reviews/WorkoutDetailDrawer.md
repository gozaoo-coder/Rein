# 组件审查：WorkoutDetailDrawer.vue

> `src/components/exercise/WorkoutDetailDrawer.vue` · 593 行 · 运动详情抽屉：跑步（轨迹/配速/分段）/ 训练课（做组明细）/ 概要三态渲染真实数据

**评级：C**

## 总评

数据层是全组件最扎实的：三种来源按真实快照渲染、课程被删后退化为序号展示、无海拔不显示爬升、「不做任何虚构」贯彻到位，所有数值无一遗漏地 `.num`。但动效与令牌层有两处硬伤：L495 引用了**不存在的 `--dur-slow` 令牌**（tokens.css 只有 fast/base/sheet），声明计算期失效导致意图中的分段条过渡从未发生；且该行动画的属性是 width——方法论点名的 layout 属性。另有多处手写运动绿（`#5ba800` 等）不随暗色主题提亮，对比度存在风险。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L495 `transition: width var(--dur-slow) var(--ease-standard);` | `transition: transform var(--dur-base) var(--ease-standard);` | `--dur-slow` 在 tokens.css 及全仓库均未定义 → 自定义属性声明失效，transition 整体回退初始值，动画从未执行（引用断链的确定性 bug） | P0 |
| 2 | L342 `<i :style="{ width: `${row.widthPct}%`, background: row.color }" />` + L495 对 width 的过渡 | 底条固定 100% 宽，填充条改 `transform: scaleX(var(--v))` + `transform-origin: left`（或 `clip-path: inset(0 calc(100% - var(--v)) 0 0)`） | width 是 layout 属性：切换记录时逐行触发重排重绘；只动 transform/opacity 是方法论性能核心规则 | P0 |
| 3 | L577-578 `.chip { background: rgba(146, 232, 42, 0.16); color: #5ba800; }` | `background: var(--c-exercise-soft); color: color-mix(in srgb, var(--c-exercise) 70%, var(--text-1));` 或新增完成态文字令牌 | 手写运动绿偏离 `--c-exercise-soft`（alpha 0.16 vs 0.2）；`#5ba800` 不随暗色主题提亮，深色表面上对比度下滑——tokens 已为暗色专门提亮 `--c-exercise`，此处绕开了该机制 | P1 |
| 4 | L411 `.early { color: #fa114f; }` | `color: var(--c-intake);` | 与 `--c-intake` 精确同值却写死，「提前结束」警示色在主题调整时脱管 | P1 |
| 5 | L529/L534 `.cell .v { font-size: 26px; … } .cell .v .sub { font-size: 15px; … }` | `var(--fs-title1)` / `var(--fs-callout)` | 两处均与字号阶梯精确相等（26px=title1、15px=callout）却写死 | P1 |
| 6 | L576 `border-radius: 999px;` | `border-radius: var(--radius-full);` | 项目已有胶囊半径令牌，等价替换零成本 | P1 |
| 7 | L424 `border-radius: 18px;`（routebox）、L486-487/L494 `.bar/.bar i { border-radius: 7px; }`、L522 `border-radius: 16px;`（cell） | 收进圆角阶梯（18→`--radius-l` 或 22、16→`--radius-m` 或 14）或新增令牌 | 阶梯外无主值散落多处；轨迹块刻意复用 hero 暗色语言是对的，但圆角不必脱离阶梯 | P2 |
| 8 | L196-201 `splitColor()` 内硬编码 `fast = [146, 232, 42]` / `slow = [250, 17, 79]` | 从 CSS 变量读取一次（`getComputedStyle(document.documentElement).getPropertyValue('--c-exercise')`）缓存后插值 | JS 里复制了 `--c-exercise/--c-intake` 的 RGB 分量，暗色主题下 tokens 提亮为 [164,240,75]/[255,55,95] 时色带不跟随 | P2 |
| 9 | L315 加载失败有提示，但 `detail === null` 加载中期间内容区空白 | 加载中渲染骨架格（dgrid 占位灰块）或「载入中…」微文案 | 抽屉打开到数据就绪之间内容突现；骨架可消除 pop-in，符合感知性能原则 | P2 |

## 做得好的

- 全文件数值展示无一漏网：L313/L326/L330-334/L340/L344/L352-355/L362/L365/L374-377 全部 `.num`，等宽纪律本批最佳。
- L143-153 距离优先取总结页确认值（note 首段），GPS 快照仅作兜底且 `dm > 5` 过滤漂移——对数据诚实。
- L243-252/L263-274 课程被删除或事后编辑时，落盘的做组数据仍以序号/「其他动作」完整呈现，不虚构、不丢弃。
- L420-455 轨迹块复用 `--hero-*` 暗色轨迹语言（沉浸页同款网格 + 发光轨迹线），跨页视觉一致。
- L174-187 目标行区分 time/distance/自由跑且如实报告达成与否。
- L64 异步竞态防护：抽屉已切换/关闭时丢弃过期加载结果。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：① 删除/修正断链的 `--dur-slow` 引用（L495）；② 分段条宽度动画改 transform scaleX 或 clip-path（L495 配套 L342）。
- **P1**（应修）：③ 完成态 chips 运动绿改走令牌并适配暗色（L577-579）；④ 「提前结束」警示色换 `--c-intake`（L411）；⑤ 数值字号对齐阶梯（L529/L534）；⑥ 999px 换 `--radius-full`（L576）。
- **P2**（打磨项）：⑦ 其余阶梯外圆角收编（L424/L486/L494/L522）；⑧ splitColor 色带从令牌取值（L196-201）；⑨ 加载中骨架（L315 前后）。
