# 组件审查：LedgerEntrySheet.vue

> `src/components/ledger/LedgerEntrySheet.vue` · 366 行 · 记一笔/编辑账目：分类宫格 + 自绘数字键盘 + 日期 + 备注

**评级：B**

## 总评

记账核心表单的完成度是同类最佳：自绘键盘 44px 键高 + `:active` 变底、金额位数双限、`canSave` 把 saving 一并算入防连点（比 FoodPickerSheet/FoodParseSheet 的裸 await 更成熟）、分类宫格选中态 scale(1.08) + 双环描边带 transform 过渡、原生 date input 以透明覆盖层藏在 chip 下保住系统选择器。缺口是删除一键直达无挽回，以及 danger soft 底色的第三份手写副本（数值还和前两份不一致）。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L112-118 remove 直接删库 + toast「已删除」 | 删除前 ActionSheet 确认；或 toast 带「撤销」5 秒回滚 | 账目是真金白银的数据且无回收站，误触即永久丢失——解析草稿可重新生成，这条不行；破坏性操作的确认/撤销至少要有其一 | P1 |
| 2 | L347 `background: rgba(255, 59, 48, 0.1)` | 引用统一令牌 `--danger-soft` | 已是 danger soft 第三份手写副本（FoodDetailDrawer 0.12 / 此处 0.10），数值漂移证明靠复制维持不了一致性 | P1 |
| 3 | L357 `.save { color: #fff }` | 引用 `--on-accent` | accent 白字第 8 处 | P1 |
| 4 | L56-61 switchKind 切换收支时宫格瞬间整组替换 | 宫格包 `<Transition mode="out-in">` 做 150ms opacity 微淡入，或对按键做 30ms stagger 浮出 | 支出↔收入是表单内最大的内容突变，瞬换让用户丢失「我刚才看的是哪格」的空间锚点；150ms 足够轻不拖慢录入 | P2 |
| 5 | L229 `.cat i { color: #fff }` | 提取 `--on-tint: #ffffff`（分类色/任意彩底上的前景约定） | 分类底色是数据驱动的任意色，白字不会随主题出错，故降为 P2；但「彩底白字」的语义值得一个具名令牌 | P2 |

## 做得好的

- L83/L89：`canSave = … && !saving.value` 把忙碌态纳入可用性判断，保存期间按钮禁用——全项目写入类按钮里唯一做对的实现。
- L218-220 / L312-314：键盘与宫格都有 `:active` 底色反馈，配合全局 scale 构成双层按压感。
- L222-236：选中分类 scale(1.08) + `box-shadow` 双环，且 transform 有显式过渡声明——选中态的放大是「呼吸感」而非跳变。
- L65-80：数字键盘输入规则完备（退格/去重小数点/首位 0 替换/位数上限），边界处理扎实。
- L157-164：今天/昨天快捷 chip + 原生 date input 透明覆盖，兼顾效率与系统能力。

## 修复建议排序

- **P0**：无。
- **P1**：① 删除确认/撤销（#1）；② danger-soft 收编（#2）；③ on-accent 收编（#3）。
- **P2**：收支宫格切换过渡（#4）、on-tint 令牌（#5）。
