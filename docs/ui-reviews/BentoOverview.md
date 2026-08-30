# 组件审查：BentoOverview.vue

> `src/components/workbench/BentoOverview.vue` · 237 行 · 桌面主页便当总览：能量磁贴 + 待办 + 番茄/AI + 快捷入口 + 记账/运动概览

**评级：B**（整体扎实，有应修项）

## 总评

桌面总览的布局与卡片视觉高度令牌化（grid-template-areas 清晰，表面统一走 `--surface`/`--radius-xl`/`--shadow-card`），可点区域普遍带 `.pressable`，动效克制、无方法论违规。最大的问题是一批绕过令牌的内联魔法色：AI 磁贴紫底、专注红底、运动绿 `#5ba800` 各自硬编码，暗色模式不会自适应；其次是两个整卡可点的 div 没有键盘可达性——按压态有了，焦点与触发没跟上。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `L52 style="background: rgba(88, 86, 214, 0.14)"`（L75 再次出现） | `color-mix(in srgb, var(--cat-study) 14%, transparent)` 或新增 `--cat-study-soft` 令牌 | 魔法色绕开令牌体系，dark 块提亮 `--cat-study` 时此底色不会跟随（项目已有 color-mix 先例） | P1 |
| 2 | `L72 icon-bg="rgba(250, 17, 79, 0.12)"` | `color-mix(in srgb, var(--c-intake) 12%, transparent)` | 同上，intake 软底硬编码，暗色不自适应 | P1 |
| 3 | `L69 icon-color="#5ba800"`（L108 再次出现） | 定义令牌（如 `--c-exercise-strong`）并纳入 dark 提亮块 | 对比度修正绿两次散落内联；正是最需要随主题调整的那类颜色 | P1 |
| 4 | `L82 <div class="pressable inner" @click="router.push({ name: 'ledger' })">`（L107 运动概览同构） | 改 `<button>` 或补 `role="button"` + `tabindex="0"` + Enter/Space 处理 | 可点 div 不可聚焦：键盘用户无法进入记账/运动概览，可见按压反馈未配齐可达性 | P1 |
| 5 | `L88 :style="{ width: budgetPct + '%', background: 'var(--accent)' }"` | 若做进度入场动画，改用 `transform: scaleX()` + `transform-origin: left` | width 变化触发 layout；当前虽无动画，先立规矩防止后续补过渡时踩性能坑 | P2 |
| 6 | 五个磁贴区（L42-115）首屏一次性同时出现 | 入场加 opacity + translateY(8px) 的 30-60ms 级联 | 多元素同时出现缺 stagger，级联入场更自然且不阻塞交互 | P2 |
| 7 | `L51-59、L87-98、L108` 大量内联样式 | 迁入 scoped 类 | 内联样式让令牌审计困难——上面三条魔法色正藏在其中 | P2 |

## 做得好的

- L58 `.ask`、L82/L107 `.inner` 带 `.pressable`、L113 `.go` 为原生 button——可点元素按压反馈覆盖完整。
- L86 / L93-97 金额与百分比数字均套 `.num`。
- L124-133 grid-template-areas 布局语义清晰；卡片表面全部走令牌（L143-145、L150-153）。
- L118-119 弹层复用 SmartAddSheet/AddWorkoutSheet 基线组件，不自造进出场动效。
- L33-36 预算百分比钳制在 0-100，边界处理稳。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：三处内联魔法色令牌化/color-mix 化；两个可点 div 补键盘可达性。
- **P2**（打磨项）：进度条动画立 scaleX 规矩、磁贴入场 stagger、内联样式收敛入类。
