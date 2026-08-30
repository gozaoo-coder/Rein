# 组件审查：HomeTodoCard.vue

> `src/components/todo/HomeTodoCard.vue` · 109 行 · 主页「待办」卡：按紧急度展示 Top3 预览 + 添加入口 + 全部页跳转

**评级：B**

## 总评

轻量聚合卡，自身几乎不带动效逻辑（勾选/编辑正确下沉到 TodoItem），令牌纪律好、按钮均有 aria-label 并自动获得全局按压反馈。主要缺口在唯一的文字链入口「查看全部」——它是 router-link（渲染为 `<a>`），游离在 base.css 只覆盖 button/.pressable 的按压体系之外，触屏按下零回应；其次是列表增删与紧急度重排完全瞬时，勾选一条后其余条目硬跳换位。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L49 `<router-link class="more" to="/todos">查看全部</router-link>` | `<router-link class="more pressable" to="/todos">查看全部</router-link>` | 非 button 的可点元素需自带 `.pressable` 或等价物；这是本卡两个入口之一，按下无任何可见反馈违背「界面要回应用户」的核心原则 | P1 |
| 2 | L41-43 `<ul v-if="urgent.length" class="list"><TodoItem v-for="t in urgent" ... /></ul>` 普通 v-for | 换 `<TransitionGroup>`，配 FLIP move 类与进出场（`--dur-fast` + `--ease-standard`，opacity + translateY(4px)） | 勾选改变紧急度排序时其余条目瞬跳换位、删除条目时下方内容硬顶上来；列表增删/重排应有过渡，「防止突兀变化」正是动效的合法目的 | P2 |
| 3 | L100-104 `.more { margin-left: 6px; font-weight: 700; color: var(--accent); }` 行内文字链接，热区≈一行文字高 | 给 `.more` 加 `padding: 6px 0 6px 6px` 并用等值负 margin 平衡布局，热区扩到 ≥32px | 触控目标过小，且紧邻 foot 说明文字，指尖易误触相邻文本 | P2 |

## 做得好的

- L31：添加按钮带 `aria-label="添加待办"`，原生 button 自动获得全局 scale(0.96) 按压反馈。
- L35 / L53：两处计数都包了 `.num`（tabular-nums），数字增减不抖宽度。
- L83-85：`.all-link` 自定义 `:active` 透明度反馈，与全局 scale 叠成双重确认。
- L44：空态文案直接指引「点右上角 +」，可发现性考虑周到。
- 全文件颜色/字号引用令牌，零魔法颜色与魔法时长。

## 修复建议排序

- **P0**：无。
- **P1**：「查看全部」链接补按压反馈（#1）。
- **P2**：TransitionGroup 列表过渡（#2）、`.more` 热区（#3）。
