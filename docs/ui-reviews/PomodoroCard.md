# 组件审查：PomodoroCard.vue

> `src/components/pomodoro/PomodoroCard.vue` · 170 行 · 番茄钟卡片：环形进度内倒计时，可关联今日待办，完成轮次点亮圆点

**评级：B**（整体扎实，有应修项）

## 总评

倒计时卡片的数字功底扎实：所有动态数字都套了 `.num`，每秒刷新宽度零抖动；图标按钮 aria-label 完整且随状态动态切换。问题集中在两处脱离令牌的视觉规格（38px 计时字号、主按钮魔法阴影），以及若干打磨项——select 去掉原生外观后没有任何下拉指示、专注/休息相位切换时环色与文案瞬时对调、图标硬切无过渡。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `L96 font-size: 38px` | 新增展示级字号令牌（如 `--fs-display`）或复用 `var(--fs-large-title)` | 字号阶梯最大 32px（--fs-large-title），38px 是脱离阶梯的魔法字号 | P1 |
| 2 | `L122 box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22)` | `var(--shadow-float)` | 魔法阴影不引用令牌；dark 模式下 shadow-card 被置 none 而它不受管理，亮暗投影表现不一致 | P1 |
| 3 | `L146 appearance: none;`（无任何替代箭头） | background 内联 SVG chevron 或右侧叠加指示图标 | 去掉原生下拉箭头后 select 没有任何可供性线索，看起来像静态灰块 | P2 |
| 4 | `L42 :color-var="pomo.phase === 'focus' ? '--c-intake' : '--c-exercise'"`（配合 L47 文案瞬切） | RingProgress 描边色加约 250ms ease 的 stroke 过渡，相位文案交叉淡化 | 专注⇄休息切换时环色与状态文案瞬时对调，iOS 计时器的做法是颜色平滑过渡 | P2 |
| 5 | `L59-60 <Pause v-if="pomo.running" ... /> <Play v-else ... />` | blur(2px) + opacity 约 200ms 交叉淡化替代硬切 | 播放/暂停图标瞬换；方法论 blur 技巧正好适用于小尺寸状态内容切换 | P2 |
| 6 | `L166-168 .rdot.on { background: var(--c-intake); border-color: transparent; }` | 补 `transition: background-color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard)` | 轮次圆点点亮为瞬时跳变，小面积颜色状态变化应有快速过渡 | P2 |

## 做得好的

- L36 / L46 / L71 所有动态数字（番茄数、倒计时、专注分钟）均套 `.num`，倒计时每秒跳动宽度完全稳定。
- L51 重置按钮有 aria-label；L56 主按钮按运行状态动态切换 aria-label（暂停/开始）。
- L42-43 环色通过 CSS 变量名（`--c-intake`/`--c-exercise`）传参，未硬编码色值。
- L64 已完成待办在选择器中 disabled，防误选不可专注项。
- 全部控件为原生 button/select，按压反馈由 base.css 全局基线覆盖。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：38px 计时字号令牌化；主按钮魔法阴影改 `--shadow-float`。
- **P2**（打磨项）：select 补下拉指示；相位切换颜色/文案过渡；播放暂停图标 blur 交叉淡化；轮次点补过渡。
