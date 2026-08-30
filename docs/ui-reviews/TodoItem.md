# 组件审查：TodoItem.vue

> `src/components/todo/TodoItem.vue` · 136 行 · 单条待办行：点勾选切换完成，点正文打开编辑，悬停显示操作按钮

**评级：B**

## 总评

待办应用的核心交互单元，hover/触屏分支、动态 aria-label、令牌纪律都做对了。但「勾选完成」这一最高频时刻的过渡是半成品：圆形底色在过渡，对勾图标却经 `v-if` 瞬间弹现，标题变色与删除线也是瞬跳——状态切换的关键帧没有连贯性；另有 `transition: all` 与可点正文缺按压反馈/键盘语义两处应修项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L21 `<Check v-if="todo.status === 'done'" :size="13" :stroke-width="3.2" />` 图标瞬现瞬失 | 包 `<Transition name="check">`：进场 `scale(0.6)→1 + opacity 0→1`，160ms ease-out；离场对称或直接淡出 | 勾选是本应用最高频的状态切换，圆底在 150ms 过渡而对勾瞬间蹦出，同一时刻两种节奏；图标也不该从无到有凭空出现 | P1 |
| 2 | L72 `.check { transition: all var(--dur-fast) var(--ease-standard); }` | `transition: transform var(--dur-fast) var(--ease-standard), background-color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard);` | 方法论红线：禁用 `transition: all`，只声明实际变化的属性（此处还覆盖了 base.css 对 button 的精确声明） | P1 |
| 3 | L23 `<div class="flex-1 body" @click="editorOpen = true">` 可点 div 无按压态、无键盘语义 | 加 `role="button" tabindex="0" @keydown.enter/.space="editorOpen = true"` 并挂 `.pressable`（注意不能整行改 button——内部已嵌套 check/edit/del 按钮） | 正文是触屏上打开编辑的主路径，按下零反馈；且 div 可点但键盘用户无法触达编辑 | P1 |
| 4 | L89-92 `.done .title { color: var(--text-3); text-decoration: line-through; }` 颜色与删除线瞬跳 | `.title` 补 `transition: color var(--dur-fast) var(--ease-standard)`；删除线如需渐进可用 `::after` 1px 线 + `transform: scaleX(0→1); transform-origin: left` 模拟 | 完成态的三要素（圆底/对勾/文字）应同步渐变而非各自为政；scaleX 划线还能给出「划掉」的方向感 | P2 |
| 5 | L40-45 edit/del 按钮 `padding: 2px` + 16px 图标 ≈ 20px 热区 | 扩大到 ≥36px（视觉图标不变，加 padding 或伪元素扩大命中区） | 触控目标远低于 HIG 44pt 下限；两钮间距仅 8px（L116），指尖易误触相邻的删除 | P2 |

## 做得好的

- L20：勾选按钮 aria-label 随状态切换（标记完成/标记未完成），读屏语义准确。
- L131-135：`@media (hover: none)` 给触屏设备常显 ops（0.55 透明度）——hover 揭示只给指针设备，正确做了触屏隔离，这是很多列表组件都漏掉的分支。
- L115-119：ops 的显隐走 opacity 过渡，桌面 hover 时滑入不闪现。
- L26：时间元信息用 `.num`。
- L28 / L30-36：分类色点与重要程度色均引用 CATEGORY_META/priorityMeta 的 `colorVar` 令牌体系，零硬编码颜色。

## 修复建议排序

- **P0**：无。
- **P1**：对勾图标过渡（#1）、`.check` 的 transition:all（#2）、可点正文的按压反馈与键盘语义（#3）。
- **P2**：完成态标题颜色/删除线渐进（#4）、edit/del 热区（#5）。
