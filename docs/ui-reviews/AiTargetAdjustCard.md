# 组件审查：AiTargetAdjustCard.vue

> `src/components/nutrition/AiTargetAdjustCard.vue` · 237 行 · AI 一句话生成目标调整建议，确认后才生效

**评级：B**（A=可直接作为范本；B=整体扎实，有应修项；C=存在手感/规范硬伤）

## 总评
输入栏 + 示例 chip + 建议卡三段式结构，全部交互元素均为真 `<button>`，按压反馈、焦点环、禁用态淡出由 base.css 全量继承，无一处自绘魔法时长。最突出的问题是建议卡（`.proposal`）经 `v-if` 插入/移除时无任何过渡，内容块瞬间撑开布局，与整体细腻的基线不符；其余仅有打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L69 `<div v-if="ai.targetProposal" class="proposal">`（出现/消失均为瞬时，L83「知道了」点击后同样瞬移除） | 用 `<Transition name="pop">` 包裹，CSS：`.pop-enter-from { opacity: 0; transform: translateY(6px) scale(0.98); }` `.pop-enter-active { transition: opacity var(--dur-base) var(--ease-standard), transform var(--dur-base) var(--ease-standard); }` 退场用更快的 `var(--dur-fast)` | 内容块凭空出现/消失违反「防止突兀变化」目的；进快出更快的不对称节奏符合方法论 | P2 |
| 2 | L57 `{{ ai.busy ? '…' : '生成' }}` | 忙碌态保持按钮宽度：`.send { min-width: 64px; }` 或换成固定尺寸 spinner | 文案切换导致按钮宽度跳变，输入框随之轻微抖动；等宽占位消除布局位移 | P2 |

## 做得好的
- L53/L56：输入框与发送按钮均有 `aria-label`，符合项目规范对可交互元素的可达性要求。
- L56：`:disabled="ai.busy || !draft.trim()"` 空输入即禁用，且 base.css 的 button 过渡含 `opacity`，禁用态 0.35 淡入平滑（L134-136）。
- L74：数值对比 `{{ Math.round(c.from) }} → {{ Math.round(c.to) }}` 挂 `.num`（tabular-nums），数字变化不跳动。
- 全组件零动画魔法值：未出现任何自写 duration/easing，全部依赖令牌与全局基线，风格天然一致。
- L54：`@keydown.enter` 直接触发提交，键盘路径零延迟无动画，符合「高频操作不加动画」。

## 修复建议排序
- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：无。
- **P2**（打磨项）：建议卡加进出过渡（问题 1）；发送按钮忙碌态定宽防抖动（问题 2）。
