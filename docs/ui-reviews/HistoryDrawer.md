# 组件审查：HistoryDrawer.vue

> `src/components/ai/HistoryDrawer.vue` · 196 行 · AI 历史会话抽屉：左侧滑入的会话列表，点击切换/新建对话

**评级：B**（整体扎实，有应修项）

## 总评

抽屉动效骨架正确：遮罩只动 opacity 且用 `--dur-fast` 快速过渡；面板沿进出同路径 `translateX(-100%)` 滑动，使用 `--ease-sheet` Apple 曲线令牌；420ms 属于方法论中 drawer 允许的 200-500ms 区间。主要问题是遮罩颜色硬编码且与 SheetModal 的遮罩深度（0.4）不一致——同为全屏遮罩却是两种黑。进出场同速、列表无 stagger、选中态无过渡属打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `L83 background: rgba(0, 0, 0, 0.32)` | 提取 `--mask` 令牌统一（SheetModal L318 为 0.4，此处 0.32） | 魔法色不引用令牌；同类全屏遮罩两种深度，弹层间切换观感不一致 | P1 |
| 2 | `L187-189 .dk-panel-enter-active, .dk-panel-leave-active { transition: transform var(--dur-sheet, ...) }` | leave 单独声明 `transition: transform 240ms var(--ease-sheet)` | 进出场同速；退出应比进入更干脆（SheetModal 基线即为进 420ms / 出 280ms 的不对称节奏） | P2 |
| 3 | `L61-72 <ul class="dk-list">` 条目随面板整体同时出现 | 每项 30-50ms 级联淡入 + translateY(6px)（reduced-motion 由全局兜底） | 多元素同时出现缺 stagger，级联入场更自然 | P2 |
| 4 | `L189 var(--dur-sheet, 0.32s) var(--ease-sheet, cubic-bezier(0.32, 0.72, 0, 1))` | 直接 `var(--dur-sheet) var(--ease-sheet)` | fallback 值 0.32s 与令牌实际 420ms 漂移、缓动曲线重复内联；令牌必然存在，fallback 只会造成静默不一致 | P2 |
| 5 | `L155 .dk-item.on { background: color-mix(...) }` | 补 `transition: background-color var(--dur-fast) var(--ease-standard)` | 切换会话时选中底色瞬时跳变，颜色类状态变化应有 150ms 级过渡 | P2 |

## 做得好的

- L177-184 遮罩过渡只动 opacity，`--dur-fast` + `--ease-standard`，性能与手感都对。
- L192-195 进出同路径（从左滑入、原路滑回），符合 ARCHITECTURE 进出同路径约定。
- L47 `role="dialog"` + `aria-label="历史记录"`；L51 / L55 图标按钮均有 aria-label。
- L156 选中色用 color-mix 从 `--accent` 令牌派生，未硬编码色值。
- 全部可点元素为原生 button，按压反馈由 base.css 全局基线覆盖。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：遮罩色令牌化并与 SheetModal 遮罩深度对齐。
- **P2**（打磨项）：退出节奏加快、列表 stagger、去掉漂移的 fallback 值、选中态补过渡。
