# 组件审查：ModelFormSheet.vue

> `src/components/ai/ModelFormSheet.vue` · 280 行 · 添加/编辑 AI 模型表单弹层：名称、接入方式、API Key、模型 ID 与默认开关

**评级：B**（整体扎实，有应修项）

## 总评

表单弹层，内容层无动效负担，等待态处理（保存中禁用 + 文案切换）是同类组件里做得最好的。最严重的问题是 iOS 风格开关的滑块引用了不存在的 `--ease-spring` 令牌——全库检索仅此一处引用、无任何定义，未定义的 var() 使整条 transition 声明失效，滑块实际是瞬间跳变，意图中的弹性动画从未生效。另有开关缺可访问名称与少量魔法阴影。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `L252 transition: transform var(--dur-fast) var(--ease-spring)` | 在 tokens.css 新增 `--ease-spring`（如 `cubic-bezier(0.34, 1.56, 0.64, 1)`）或改用 `var(--ease-sheet)` | 引用未定义令牌导致整条声明无效：滑块平移（L260 translateX(21px)）无任何过渡，瞬间跳变 | P1 |
| 2 | `L167-173 <button class="toggle" role="switch" :aria-checked="isDefault">` | 补 `aria-label="设为默认"` 或 `aria-labelledby` 关联相邻文案 | switch 无可访问名称：「设为默认」在相邻 p 标签中未建立程序关联，读屏只读到裸开关状态 | P1 |
| 3 | `L251 box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2)` | 收敛为 `var(--shadow-float)` 或在 tokens.css 新增微阴影令牌并纳入 dark 块 | 魔法阴影不引用令牌；dark 模式下 shadow-card 被置 none 而它不受管理，亮暗表现不一致 | P1 |
| 4 | `L250 background: #fff`、`L267 color: #fff` | 新增 `--on-accent` 类语义令牌统一引用 | 硬编码白色散落于各组件按钮，语义化后便于主题级统一调整 | P2 |

## 做得好的

- L178-180 saving 期间禁用按钮防重复提交，文案切「保存中…」——文本式诚实等待反馈，没有多余 spinner。
- L170-171 `role="switch"` + `:aria-checked` 状态语义正确（只差名称关联）。
- L125-163 label for/id 全部显式关联；`inputmode="url"`、密码框 `autocomplete="off"` 细节到位。
- L238-240 开关底色过渡正确引用令牌时长与标准曲线（`var(--dur-fast) var(--ease-standard)`）。
- L160-162 datalist 为模型 ID 提供建议项，降低输入成本。
- 进出场动效完全委托 SheetModal 基线，零重复实现。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：补定义或替换 `--ease-spring` 让开关动画真正生效；开关补可访问名称；滑块阴影令牌化。
- **P2**（打磨项）：硬编码白色收敛为语义令牌。
