# 组件审查：DietChecksCard.vue

> `src/components/nutrition/DietChecksCard.vue` · 121 行 · 六大类食物覆盖情况打卡（纯状态展示，不可点）

**评级：B**（A=可直接作为范本；B=整体扎实，有应修项；C=存在手感/规范硬伤）

## 总评
只读状态卡，chip 形态正确地未做成可点元素（避免了假按钮），完成态切换已带背景/文字颜色的令牌化过渡，计数挂 `.num`。主要问题是完成态用了三处魔法绿色（rgba 底 + 亮暗两套硬编码文字色），绕开了令牌体系；次要打磨是勾号 `✓` 以文本三元切换瞬间出现/消失。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L106-L108 `.chip.done { background: rgba(52, 199, 89, 0.16); color: #248a3d; }` 与 L110-L114 暗色覆盖 `color: #30d158;` | tokens.css 新增 `--ok-soft: color-mix(in srgb, var(--ok) 16%, transparent)` 与 `--ok-strong`（暗色块内提亮），组件改引 `background: var(--ok-soft); color: var(--ok-strong);` | 魔法颜色违反令牌规范：`rgba(52,199,89,…)` 就是 `--ok` 的手写透明版，`#30d158` 与记账域 `--led-refund` 撞值，跨域复用硬编码色会随换肤失联 | P1 |
| 2 | L41 `<span class="mark">{{ c.done ? '✓' : '' }}</span>`（勾号随状态瞬间插入/移除） | 常驻渲染 `<span class="mark" :class="{ on: c.done }">✓</span>`，CSS：`.mark { opacity: 0; transform: scale(0.5); transition: opacity var(--dur-fast) var(--ease-standard), transform var(--dur-fast) var(--ease-standard); } .mark.on { opacity: 1; transform: scale(1); }` | 勾号凭空蹦出缺少「完成」的确认感；小 scale+fade 过渡给出轻量反馈，且 transform/opacity 不触发布局 | P2 |

## 做得好的
- L95：chip 的 `transition: background-color … , color …` 精确声明属性且引用 `--dur-base / --ease-standard` 令牌——打卡状态变色是全组件唯一动效，做得干净。
- L36：计数值挂 `.num`，打卡过程中 `/6` 计数不跳动。
- chip 为纯状态展示而非按钮，未误加按压反馈或 `cursor: pointer`，交互语义诚实。
- 全部圆角、字号、灰阶均引用令牌（L90-L103），仅问题 1 的绿系例外。

## 修复建议排序
- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：完成态魔法绿收敛为 `--ok-soft / --ok-strong` 令牌（问题 1）。
- **P2**（打磨项）：勾号加 scale+fade 出现过渡（问题 2）。
