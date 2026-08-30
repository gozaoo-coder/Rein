# 组件审查：AddWorkoutSheet.vue

> `src/components/exercise/AddWorkoutSheet.vue` · 158 行 · 快速记录运动：类型 chips + 时长步进器 + 强度分段 + MET 估算预览

**评级：B**

## 总评

表单结构干净：步进器有 aria-label、数值全走 `.num`、kcal 随类型/时长/强度实时联动给出即时反馈、保存按钮用语义色 `--ok`。动效问题集中且典型——chips 的 `transition: all` 是方法论点名的第一条反模式，步进器旋钮的手写阴影与数字区 26px 裸字号则违反令牌规则。无进场/退场自有动画（交给 SheetModal），无 layout 属性动画。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L103 `transition: all var(--dur-fast) var(--ease-standard);` | `transition: background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard);` | 方法论检查清单第一条：`all` 会让未来新增的任何属性（如 transform）被意外卷入过渡，选中态只需要背景与文字两色变化 | P1 |
| 2 | L123 `box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1), 0 0 0 0.5px var(--line);` | 提升为令牌（如 `--shadow-knob`）后引用，或复用 `--shadow-float` | tokens.css 明令禁止魔法阴影；暗色模式下该黑色阴影未随主题调整（tokens 暗色把 card 阴影置 none） | P1 |
| 3 | L131 `.stepper b { font-size: 26px; }` | `font-size: var(--fs-title1);` | 26px 与字号阶梯 `--fs-title1` 精确相等却写死；换字体阶梯时此处脱管 | P1 |
| 4 | L61 `<button class="chip" :class="{ on: t === type }" @click="type = t">` | `<button type="button" class="chip" …>`（L69/L71/L81 步进与保存键同改） | 组件内其余按钮均显式 `type="button"`，chips 缺失虽无 form 不致误提交，但一致性缺口应补齐 | P2 |

## 做得好的

- L69/L71 步进器图标按钮带完整 aria-label（「减少5分钟」「增加5分钟」）。
- L70/L80 数值统一 `.num` 等宽，时长增减与 kcal 联动时数字不跳宽。
- L34-36 `bump` 对 5–240 分钟双向钳制，边界输入不产生非法值。
- L30-32 kcal 实时估算即输即反馈，用户在保存前就能看到后果——好的即时性。
- 所有可交互元素均为原生 button，自动继承 base.css 的按压缩放与焦点环，无需重复实现。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：① chips `transition: all` 收窄为 background-color/color（L103）；② 步进器旋钮阴影令牌化（L123）；③ 26px 字号换 `--fs-title1`（L131）。
- **P2**（打磨项）：④ 四处按钮补 `type="button"`（L61/L69/L71/L81）。
