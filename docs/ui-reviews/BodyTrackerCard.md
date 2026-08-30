# 组件审查：BodyTrackerCard.vue

> `src/components/nutrition/BodyTrackerCard.vue` · 521 行 · 体重·身高按天记录、BMI 与趋势图、历史列表

**评级：C**

## 总评
信息密度最高的营养域卡片：统计格、SVG 趋势图、历史列表、记录弹层俱全，`.num` 纪律和令牌使用总体优秀。但核心交互「点历史条目删记录」挂在裸 `<li>` 上——只有 `cursor: pointer`，无按压反馈、无按钮语义，触屏上点了像没点上，是全组件最刺手的一处；另有 BMI 标签三组魔法色与一处魔法字号。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L228 `<li v-for="(m, i) in n.metrics.slice(0, 5)" :key="m.id" @click="tapEntry(m)">`（L438 仅有 `cursor: pointer`） | 改为真 `<button class="hist-row">`（样式重置由 base.css 提供），或保留 `<li>` 但加 `.pressable` + `role="button"` + `tabindex="0"` + Enter/Space 处理 | 非 button 的可点元素缺可见按压态是手感硬伤：触屏无任何按下反馈；且 `li` 不可聚焦，键盘无法触达删除入口 | P0 |
| 2 | L380/L385/L390 `background: rgba(52, 199, 89, 0.14)` / `rgba(255, 159, 10, 0.14)` / `rgba(255, 59, 48, 0.12)` | 在 tokens.css 新增 `--ok-soft / --warn-soft / --danger-soft` 后引用：`background: var(--ok-soft)`（warn/bad 同理） | 魔法颜色违反令牌规范；三个 soft 底色应随主题统一管理，暗色块（L110-114 已示范覆盖文字色的做法）无法调整散落的 rgba | P1 |
| 3 | L339 `.stats b { font-size: 20px; }` | `font-size: var(--fs-title2);`（21px） | 字号必须引用阶梯令牌；20px 是阶梯外魔法值，21px 视觉差异可忽略 | P1 |
| 4 | L364-L365 `.delta.up { color: var(--c-carb); }`（降为 `var(--c-protein)`） | 改用语义色 `var(--warn)` / `var(--ok)`，或在 tokens.css 新增方向语义色 | 体重升降借用了宏量营养素域色，语义错位；若未来调整碳水配色会误伤体重涨跌的表意 | P2 |
| 5 | L212-L220 趋势折线在新增记录后几何形状直接跳变（无描线过渡） | 可选：对 polyline 用 `stroke-dasharray/stroke-dashoffset` 做 250-400ms ease-out 描线入场（数据变化时触发一次） | 数据图形从无到有的跳变略显生硬；stroke-dashoffset 不触发布局，属合规动画属性 | P2 |

## 做得好的
- L176/L189/L193 及全部历史行数值挂 `.num`，体重小数、BMI、日期宽度稳定不抖。
- L204：趋势 SVG `aria-hidden="true"` 且 L200 figcaption 以文字给出「近 N 次 / 最低·最高」，图表信息有文本等价物。
- L113-L117：表单预填回溯最近非空值 → 资料 → 默认值的三级兜底，弹层每次打开都是合理初值。
- L273-L275：保存按钮 `:disabled="saving"` + 文案切换「保存中…」，防重复提交；按钮宽度 100%（L502）文案切换不引起布局位移。
- L206-L209：渐变填充用 `stop-color="var(--accent)"` 引用令牌，主题切换自动跟随。

## 修复建议排序
- **P0**（明显手感缺陷或违反方法论核心）：历史条目改为 button 或补 `.pressable` + 键盘可达（问题 1）。
- **P1**（应修）：BMI 标签魔法色收敛为 soft 令牌（问题 2）；`.stats b` 字号换 `--fs-title2`（问题 3）。
- **P2**（打磨项）：delta 方向色改语义色（问题 4）；趋势图可选描线入场（问题 5）。
