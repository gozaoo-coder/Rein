# 组件审查：FoodParseEditor.vue

> `src/components/diet/FoodParseEditor.vue` · 311 行 · 可编辑食物解析列表：行内改重量、份快捷换算、删除

**评级：B**

## 总评

行内编辑的交互链路相当完整：点克重芯片 → 自动 focus+select、Enter 提交、Esc 取消、blur 兜底，`inputmode="decimal"` 调起数字键盘；未匹配项的视觉降级与「确认时不会写入」的文案也诚实。两个实质问题：列表用索引作 key 且支持删除（Vue 就地复用会在删除时错位），以及进入编辑时份单位区瞬现撑开布局。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L142 `:key="i"`（索引）+ L132-137 支持任意位置删除 | `:key` 改用稳定标识（ParsedFoodItem 已有 `key` 字段则用之；否则以对象引用 WeakMap 生成 uid） | 删除中间项后索引前移，Vue 就地复用会让后续行的编辑态/输入草稿/焦点串位——恰好在用户正在编辑的场景里触发 | P1 |
| 2 | L149-158 编辑展开时 `.units` 快捷区 v-if 瞬现，行高瞬间撑开 | 包一层 grid-template-rows 0fr→1fr（或 max-height）+ opacity 的 200ms 过渡 | 正在打字的位置下方突然弹出按钮组，下方内容被无动画地推走；轻展开让位移可追踪 | P1 |
| 3 | L132-137 removeRow 直接过滤，被删行瞬间消失 | `<TransitionGroup>`：leave 时 `opacity→0 + max-height→0 + margin/border→0` 折叠，200ms ease-out | AI 结果是用户逐条审阅的心智清单，「消失」应有去向感；折叠动画同时避免剩余行瞬跳上移 | P2 |
| 4 | L143 `<div class="info" @click="beginEdit(i)">` 非 button 可点区域无按压反馈 | 加 `.pressable` 类或改 button 语义（chip 入口已可键盘到达，此处补视觉反馈即可） | 点信息区进编辑是该行最大热区，但点击零反馈；全局 :active 只挂在 button/.pressable 上 | P2 |
| 5 | L225 `.tag { font-size: 10px }` | `font-size: var(--fs-micro)`（11px） | 阶梯外魔法字号且低于最小档；10px 中文渲染发虚 | P2 |
| 6 | 误删无挽回 | removeRow 后 toast「已移除 · 撤销」，5 秒内可恢复 | 解析结果删错要重新跑一次 AI 生成，代价不对称；undo 是移动端删除的标准兜底 | P2 |

## 做得好的

- L98-106：进入编辑自动全选数值，直接输入即可覆盖——省去「先删后打」两步。
- L169-174：aria-label、inputmode、Enter/Esc/blur 四路收束齐全。
- L307-310：删除按钮 `:active` 时变红底——危险操作的颜色预览反馈，按下去就知道会删。
- L36-44：WeakMap 基准克重让估算值按编辑比例缩放，改 100g→200g 不丢比例关系。
- L77：未匹配项明说后果（「确认时不会写入」），不留惊喜。

## 修复建议排序

- **P0**：无。
- **P1**：① key 稳定化（#1）；② 单位区展开过渡（#2）。
- **P2**：删除退场折叠（#3）、info 区按压反馈（#4）、10px 字号（#5）、undo（#6）。
