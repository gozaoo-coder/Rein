# 组件审查：ActiveWorkoutBar.vue

> `src/components/exercise/ActiveWorkoutBar.vue` · 508 行 · 悬浮运动条：可拖拽停靠五槽位（顶/底全宽条 + 左右 64px 方块泊车），弹簧物理由 `useDragDock` 提供

**评级：B**

## 总评

交互与动效是全套组件中的范本级：手势完全交给 `useDragDock`（速度采样窗口、0.35px/ms 轻弹阈值、慢放投影最近槽位、iOS 式橡皮筋阻尼、settle 弹簧可被打断且继承速度、多指保护），组件侧只做三层结构分离（root 定位 / pos 仅 transform / body 视觉），位移全程走 translate3d；首帧静默恢复不播入场（L38-46）、进出同路径按停靠方向浮入（L353-371）、双层内容交叉淡变用 visibility 延迟切换（L299-308）、reduced-motion 与 reduced-transparency 双兜底，细节密度极高。扣分项集中在令牌卫生：拖拽抬升阴影与按钮圆角是手写魔法值，违反 tokens.css「阴影/圆角一律引用令牌」的硬规则。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L287 `.dock-body.dragging { box-shadow: 0 14px 36px rgba(0, 0, 0, 0.3); }` | 阴影提升为令牌（如 `--shadow-drag: 0 14px 36px rgba(0,0,0,0.3)`）后引用 `box-shadow: var(--shadow-drag)` | tokens.css 头部明令禁止魔法阴影；拖拽态是高频可见态，换肤时该值会脱管 | P1 |
| 2 | L452 `.abtn { … border-radius: 19px; }` | `border-radius: var(--radius-full)` | 高 38px 的胶囊键，19px 就是半高写法，项目已有等价令牌 `--radius-full`，直接替换视觉零差异 | P1 |
| 3 | L271 `.dock-body.is-blob { … border-radius: 20px; }` | 收进圆角阶梯（`--radius-l` 或新增 `--radius-blob` 令牌） | 20px 介于 radius-m(14) 与 radius-l(22) 之间的无主值；方块是常驻 UI，应可随全局换肤 | P2 |
| 4 | L341-346 `.wdock-enter-active, .wdock-leave-active { transition: opacity var(--dur-sheet) var(--ease-sheet), transform var(--dur-sheet) var(--ease-sheet); }` | 进场保留 `--dur-sheet`(420ms)，退场改 `transition-duration: calc(var(--dur-sheet) * 0.6)` 一类更短时长 | 进出同速违反不对称节奏原则——退出应快于进入（系统在响应，不需要仪式感）；非模态悬浮条也更接近 toast 族，420ms 略拖 | P2 |

## 做得好的

- L38-46 冷启动静默恢复不播入场动画：对「用户没主动唤起」的出现克制处理，方法论第 1 问（该不该动）的标准答案。
- L128+useDragDock 全程只写 `transform`（composable L198-201 `translate3d`），配合 L229 `will-change: transform`，位移零 layout/paint。
- L299-308 隐藏层 `visibility 0s linear var(--dur-fast)` 延迟到淡出结束才不可见——交叉淡变不留点击空洞，经典细节。
- L247-250 手势期 `touch-action: none; user-select: none; -webkit-touch-callout: none` 三连，浏览器不让接管滚动/选中/长按菜单。
- L483-507 reduced-motion 下逐条降级：去掉位移、保留 opacity 确认、停掉呼吸点；L256-262 还覆盖了 `prefers-reduced-transparency`，超出基线要求。
- L177/L188 图标按钮与泊车形态均有 aria-label，L133 整条有 region 语义。
- L57-76 bottom 停靠写入 `--wbar-reserve` 并在已滚底时自动跟随滚动——事件驱动（非逐帧）更新 CSS 变量，用法正确。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：① 拖拽抬升阴影令牌化（L287）；② `.abtn` 圆角换 `--radius-full`（L452）。
- **P2**（打磨项）：③ 方块 20px 圆角收进阶梯或令牌化（L271）；④ 退场节奏快于进场（L341-346）。
