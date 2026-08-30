# 组件审查：NumberStepper.vue

> `src/components/common/NumberStepper.vue` · 83 行 · 紧凑数字步进器（±按钮 + 数值 + 单位）

**评级：A**

## 总评

克制的标准件：min/max 收敛、`aria-label` 与 `:disabled` 边界禁用齐备、数值用 `.num`（tabular-nums）保证位数变化时不左右抖动、按钮走全局 `:active` 按压反馈。剩下的都是打磨项——数值跳变可以更有生命感，长按连发是原生 stepper 的肌肉记忆。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L19-22 点击一次步进一格，长按无连发 | pointerdown 后 500ms 延迟进入 ~100ms 间隔的 repeat，pointerup/cancel 停止 | 目标从 40kg 调到 80kg 要按 40 次；原生 UIStepper 都支持按住连发，缺失违背「界面听用户的」直觉 | P2 |
| 2 | L32 数值瞬间替换 | 变化时给 `.val b` 一个 120ms 的 `filter: blur(2px)→0` + 微 scale 脉冲（key 驱动重放） | Emil blur 技巧：让数字滚动感更顺，掩盖两帧状态重叠；高频操作下保持 <150ms | P2 |
| 3 | L54-63 按钮固定 30×30 | 视觉不变，外扩热区至 ≥36×36（padding 或伪元素扩大命中区） | 低于 44pt 推荐值；目标设置页低频使用故降级为打磨项 | P2 |

## 做得好的

- L20：`Math.min/max` 双向收敛，越界点击静默钳制不发脏值。
- L29/L33：`:disabled="modelValue <= min"` 与 min/max 严格对应，禁用态即真实边界，配合全局 opacity 过渡平滑变灰。
- L32：`.num` 类防数字跳动，`<small>` 单位降级层级正确。

## 修复建议排序

- **P0/P1**：无。
- **P2**：长按连发（#1）、数字变化 blur 脉冲（#2）、热区外扩（#3）。
