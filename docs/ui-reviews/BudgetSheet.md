# 组件审查：BudgetSheet.vue

> `src/components/ledger/BudgetSheet.vue` · 185 行 · 月度总预算设置：快捷金额 + 自定义输入 + 清除

**评级：A-**

## 总评

小表单的规范度很高：`<label>` 原生包裹输入框、aria-label、preset 选中态走 accent-soft、保存按钮按有效性禁用并带过渡声明。仅一处令牌缺口和两个低风险打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L176 `.save { color: #fff }` | 引用新增令牌 `--on-accent` | 全项目第 7+ 处 accent 白字硬编码，等批量收编 | P1 |
| 2 | L48-53 清除预算一键直达 + toast | 先弹 ActionSheet 确认（danger 样式），或按钮文字改 danger 色以示区分 | 清除是破坏性操作却与普通文本钮视觉同级；误触成本虽低（可重设），但确认/警示至少占一样 | P2 |
| 3 | L39-53 save/clear await IPC 无忙碌态 | 加 saving ref 禁用双按钮（setBudget 幂等故降为打磨） | 与 FoodPickerSheet/FoodParseSheet 同类问题；此处重复提交无实害，优先级最低 | P2 |
| 4 | L157-160 chip.on 选中态仅底色变化 | 维持现状即可；若增强可用 scale 微脉冲标记「刚选中」 | preset 点击已有全局 bg 过渡 + 即时高亮，反馈闭环完整——此条仅登记可选增强 | P2 |

## 做得好的

- L59-70：label 包裹 + aria-label + inputmode="decimal"，表单可访问性三件套齐全。
- L95：`:disabled="cents() <= 0"` 无效输入即禁用保存，状态诚实。
- L172-179：保存按钮显式声明 opacity 过渡而非依赖隐式行为。
- L22/L78：preset 与输入值双向联动（String(p) === val 高亮），输入 2000 也能点亮对应 chip。

## 修复建议排序

- **P0**：无。
- **P1**：① --on-accent 令牌化（#1）。
- **P2**：清除预算加确认或危险色（#2）、busy 态（#3）、选中微脉冲可选（#4）。
