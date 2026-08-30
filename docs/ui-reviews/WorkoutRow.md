# 组件审查：WorkoutRow.vue

> `src/components/exercise/WorkoutRow.vue` · 121 行 · 运动记录行：点击开详情，悬浮显删除键（触屏常显弱化态），运动页与记录页共用

**评级：B**

## 总评

小而完整的列表行：分隔线用 `:not(:first-child)` 保证跨实例成立、删除键的触屏策略（hover 隐藏 / `hover:none` 下 0.55 常显）考虑了移动优先、数值全部 `.num`。两个实质问题：行是 `role="button"` 的 li 却没挂 `.pressable`，整行按压无任何缩放反馈——这正是全局基线管不到的非 button 可点元素；其次是图标底色与千卡值的手写运动绿不引用令牌且不随暗色提亮。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L34-37 `<li class="row item" role="button" tabindex="0" @click="$emit('detail')" @keydown.enter="$emit('detail')">` | `<li class="row item pressable" role="button" …>` | 非 button 可点元素缺可见按压反馈：base.css 的 `:active scale(0.96)` 只覆盖 button/.pressable，整行点下去毫无确认感——任务口径中明确算问题 | P1 |
| 2 | L72-74 `.ic { background: rgba(146, 232, 42, 0.18); color: #5ba800; }` + L96-98 `.kcal { color: #5ba800; … }` | 底色换 `var(--c-exercise-soft)`；文字色新增令牌（如 `--c-exercise-text`）或 `color-mix(in srgb, var(--c-exercise) 65%, var(--text-1))` 派生 | 手写运动绿偏离令牌体系；`#5ba800` 在暗色表面（#1c1c1e）上对比度不足 ~3:1，而 tokens 已为暗色把 `--c-exercise` 提亮到 #a4f04b，此处绕开了该机制 | P1 |
| 3 | L38-39 只有 `@keydown.enter="$emit('detail')"` | 补 `@keydown.space.prevent="$emit('detail')"` | `role="button"` 键盘契约含 Space；空格是最符合「按钮」直觉的激活键 | P2 |
| 4 | L112-114 `.item:hover .del { opacity: 1; }` 裸露在全局作用域 | 包进 `@media (hover: hover) and (pointer: fine) { … }` | 触屏 hybrid 设备上 tap 会触发粘滞 hover，删除键点亮后不熄；方法论要求 hover 效果按 hover 能力隔离（现有 hover:none 兜底只救纯触屏） | P2 |
| 5 | L106-114 删除键仅 hover/focus-none 策略下可见，键盘聚焦时图标仍 opacity:0 | 补 `.item:focus-within .del { opacity: 1; }` | 键盘 Tab 到删除键时只有焦点环没有图标，「看不见的可聚焦元素」对键盘用户是死区 | P2 |

## 做得好的

- L64-66 分隔线注释点明跨组件实例仍成立的选型理由，`:not(:first-child)` 配合父级分组列表正确。
- L50 删除按钮带 aria-label「删除记录」且 `@click.stop` 防止误触发行导航。
- L44/L47-48 元信息与 kcal/时长全部 `.num` 等宽。
- L116-120 `@media (hover: none)` 下删除键 0.55 常显——触屏无 hover 时保证功能可达，方向完全正确。
- L109 删除键过渡只动 opacity，合成器友好。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：① 行补 `.pressable` 按压反馈（L34-37）；② 手写运动绿改走/派生令牌并适配暗色（L72-74、L96-98）。
- **P2**（打磨项）：③ 补 Space 激活（L38-39）；④ hover 态包进 `(hover: hover) and (pointer: fine)`（L112-114）；⑤ `:focus-within` 显形删除键（L106-114）。
