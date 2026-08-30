# 组件审查：MonthView.vue

> `src/components/todo/MonthView.vue` · 147 行 · 月历完成度视图：格子下进度条表示当日完成比例

**评级：C**

## 总评

信息层级干净的月历格：导航按钮、`.num`、今日/选中态、满进度转绿都规范，时长缓动也全走令牌。但存在一处方法论性能红线把它拉到 C——进度条填充直接过渡 `width`（layout 属性）；同时日历格是整块可点的 `<li>`，既没有按压反馈也没有键盘可达性，而格子正是本视图最高频的点击目标。换月瞬跳属打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L141 `.bar i { transition: width var(--dur-base) var(--ease-standard); }`（配合 L69 `:style="{ width: `${ratioOf(c.date) * 100}%` }"`） | `.bar i` 改固定满宽 + `transform: scaleX(ratio); transform-origin: left;` 过渡 transform（或 `clip-path: inset(0 X% 0 0)`） | 动画 layout 属性每帧触发 relayout/repaint，方法论性能红线「只动 transform 和 opacity」；视觉等效的 scaleX/clip-path 走合成器。数据加载后从 0 填充到目标值的行为可完整保留 | P0 |
| 2 | L56-65 `<li class="cell col center" @click="c.date && emit('select', c.date)">` 可点但无任何按压态（L102-107 样式仅 cursor:pointer） | 给 `.cell` 补 `.cell:active { transform: scale(0.96) }` 或挂 `.pressable` 类 | 日历格是本视图最高频点击目标，触屏按下零反馈；base.css 只覆盖 button/.pressable，li 必须自带 | P1 |
| 3 | L55-72 `<li>` 无 `role`/`tabindex`/键盘事件 | 有日期的格子加 `role="button" :tabindex="0"` + `@keydown.enter/.space` 触发同一 emit | 键盘用户完全无法选日期；可交互元素的可达性契约（配合全局 `:focus-visible` 焦点环即可生效） | P1 |
| 4 | L25-29 `shift()` 直接替换 year/month，标题与 42 格瞬时跳变 | 换月方向感知过渡：旧网格 translateX(∓12px)+fade 出、新网格反向入，150-200ms ease-out | 月切换是低频操作，适合标准动效；瞬跳丢失月份更替的方向感与空间连续性 | P2 |
| 5 | L102-107 `.cell` 无 hover 态 | 在 `@media (hover: hover) and (pointer: fine)` 内补 `.cell:hover { background: var(--surface-2) }` | 桌面工作台模式下悬停可暗示可点性；需触屏隔离避免 tap 后 hover 粘滞 | P2 |

## 做得好的

- L50 / L52：前后翻月按钮均有 aria-label。
- L67：日期数字统一 `.num`。
- L69 + L144-146：满进度条转 `--ok` 绿色，语义色使用正确。
- L106 / L141：时长与缓动全部引用 `--dur-*` / `--ease-*` 令牌（属性选错但值规范）。
- L113-115 / L122-125：选中态 `--accent-soft` 底色、今日 accent 强调，与全应用视觉一致。

## 修复建议排序

- **P0**：进度条 width 过渡改 transform/clip-path（#1）。
- **P1**：格子按压反馈（#2）、键盘可达性（#3）。
- **P2**：换月方向感过渡（#4）、hover 触屏隔离补充（#5）。
