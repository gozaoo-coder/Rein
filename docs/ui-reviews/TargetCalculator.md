# 组件审查：TargetCalculator.vue

> `src/components/nutrition/TargetCalculator.vue` · 391 行 · 身体参数 → BMR/TDEE → 营养目标推荐，采用前二次确认

**评级：B**（A=可直接作为范本；B=整体扎实，有应修项；C=存在手感/规范硬伤）

## 总评
表单手感设计成熟：参数快照静默落库、卸载补存、实时重算、差异预览、ActionSheet 二次确认，链路完整。全部控件委托 NumberStepper / SegmentedControl，按压反馈与连点手感继承自通用组件；本组件自身无任何动画代码，也就无违规动效。唯一应修项是推荐热量 34px 魔法字号。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L308-L309 `.kcal b { font-size: 34px; font-weight: 200; letter-spacing: -1px; }` | tokens.css 字号阶梯新增展示级令牌（如 `--fs-display-2: 34px`，与 EnergySummary 的 44px 配套）后引用 `font-size: var(--fs-display-2);` | 字号必须引用令牌：34px 是阶梯（最大 32px）外魔法值，与 EnergySummary 主数字同属「展示级大数」，应一并入阶梯统一管理 | P1 |

## 做得好的
- L73-L87：参数变更防抖 600ms 静默保存 + `onBeforeUnmount` 补存，`ready` 门闩防止默认值覆盖快照——用户无感知、数据不丢，正是「隐形细节」式工程。
- L234-L240：采用动作经 ActionSheet 二次确认且明示后果（「将覆盖当前每日目标」），破坏性操作有缓冲。
- L215/L221/L225/L227：推荐热量、五项细胞格、BMR/TDEE 公式行、差异文案全部挂 `.num`——stepper 连点时数字高频变化仍不跳动。
- 正确地未给实时计算结果加过渡动画：stepper 连点是高频操作，数值即时跟随才是对的（方法论：键盘/高频操作不加动画）。
- L128-L130：`diffsText` 把差异压成一行「蛋白质 90→120 · …」，采用前可预读结果，减少确认弹层里的信息量。
- 全部颜色、圆角、字号（除问题 1）引用令牌；`.adopt` 主按钮由 base.css 提供 scale(0.96) 按压反馈。

## 修复建议排序
- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：34px 展示字号入令牌阶梯（问题 1）。
- **P2**（打磨项）：无。
