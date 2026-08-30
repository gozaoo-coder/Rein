# 组件审查：ActionSheet.vue

> `src/components/common/ActionSheet.vue` · 123 行 · iOS 操作面板：底部圆角卡片 + 选项列表 + 取消

**评级：B**

## 总评

交互骨架正确：进出同路径自底弹起、`--ease-sheet` 曲线、CSS transition 可打断、选项按钮 50px 满足触控标准、danger 用语义令牌。但作为「确认类操作」面板，它进出场完全同速同曲线（都是 420ms sheet 曲线）——取消一个操作比发起它快得多才对；遮罩色与 SheetModal 各写了一份且数值还不一致（0.32 vs 0.4），恰好证明了该有 `--scrim` 令牌。Escape 与焦点管理在桌面工作台模式下缺位。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L112-117 进出场共用 `var(--dur-sheet)`（420ms） | 拆分：enter 保持 `--dur-sheet`，leave 改 `transform var(--dur-base) var(--ease-standard), opacity 200ms ease-out` | 同速进出违反「退出更快」原则；取消操作的心理节奏应干脆利落，420ms 显拖沓 | P1 |
| 2 | L58 `background: rgba(0, 0, 0, 0.32)` | 引用统一 `--scrim` 令牌 | 与 SheetModal 的 0.4 已产生两套遮罩深浅，叠开时肉眼可见不一致 | P1 |
| 3 | L34-49 `role="dialog"` 无 Escape 监听 | 打开时监听 `keydown Escape → emit('close')` | 键盘用户的本能出口；dialog 角色隐含契约 | P2 |
| 4 | L118-121 enter-from 仅 `translateY(24px)` + fade | 改为 `translate(-50%, calc(100% + 40px))` 全量滑入（或至少 60px+），保留 opacity 微调 | iOS action sheet 的身份就是「从屏幕外滑上来」；24px 位移配 420ms sheet 曲线，曲线的势能没释放完就到位了，显得又慢又飘 | P2 |
| 5 | L35 打开无焦点移入、关闭不归还 | 打开后聚焦第一个选项（或卡片本身 `tabindex="-1"`），关闭归还原元素 | 配合 #3 构成完整键盘路径 | P2 |
| 6 | L37-46 选项列表语义为普通按钮组 | 卡片加 `role="menu"`、选项加 `role="menuitem"`（或维持 dialog + 首项聚焦） | 读屏用户听到的是三个无上下文的按钮，缺少「操作面板」的容器语义 | P2 |

## 做得好的

- L111-122：进出同路径自底弹起，方向感一致。
- L115：`--ease-sheet` 曲线用在弹层上是对的选型。
- L83-90：选项 50px 高，触控达标；`.opt` 是原生 button，自带全局 `:active` 按压反馈。
- L92-94：danger 色引用 `--danger` 令牌，未硬编码红色。

## 修复建议排序

- **P0**：无。
- **P1**：① 进出场拆速（#1）；② 遮罩令牌统一（#2）。
- **P2**：Escape + 焦点管理（#3/#5）、全量滑入的入场形态（#4）、菜单语义（#6）。
