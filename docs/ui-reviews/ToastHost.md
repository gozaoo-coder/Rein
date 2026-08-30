# 组件审查：ToastHost.vue

> `src/components/common/ToastHost.vue` · 60 行 · 底部悬浮毛玻璃 toast 容器（TransitionGroup 进出场）

**评级：B**

## 总评

结构干净的小组件，动效选型正确：用的是 CSS transition 而非 keyframes（toast 高频连发时可打断、平滑重定位，正是 Sonner 原则第 5 条），只动 `opacity + transform`，`aria-live="polite"` 也在位。两个缺口：配色完全是魔法值绕开了令牌体系（亮暗各一套硬编码），以及进出场同速同曲线——退场可以更快更收敛。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L30/L33 `background: rgba(250, 250, 250, 0.92)`、`color: #1d1d1f` | tokens 新增 `--toast-bg` / 复用 `--surface-translucent` + `var(--text-1)` | 项目规范 §4 颜色零魔法值；L44-46 暗色块又硬编码一份，改主题要记得改两处 | P1 |
| 2 | L49-59 进入与离开同为 250ms 标准曲线 | 拆开：leave-active 单独 `transition-duration: 200ms` 且曲线换 `ease-out` | 「退场永远比进场快」；toast 消失是用户已处理完的信号，不该恋战 | P2 |
| 3 | L30-32 `backdrop-filter: blur(14px)` 无 `@supports` 兜底 | 外层先给实底色，`@supports (backdrop-filter: blur(1px))` 内再降透明度上毛玻璃 | 老 WebView 不支持时 92% 白仍可读，属不可见细节兜底 | P2 |
| 4 | L20 `bottom: calc(var(--tabbar-h) + 26px)` 未含 `--safe-bottom`/`--wbar-reserve` | `bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 26px + var(--wbar-reserve, 0px))` | 全面屏手势条与悬浮运动条停靠 bottom 时会盖住 toast（页面内容有预留而 fixed 元素没有） | P1 |

## 做得好的

- L9-11：`TransitionGroup` + transition 实现，多条 toast 连续出入时其余项平滑让位，可打断。
- L8：`aria-live="polite"` 让读屏播报 toast 文案。
- L26：容器 `pointer-events: none`，toast 永远不会挡住下层点击。
- L55-58：进出同路径（自下方 10px 浮入/沉走），方向一致。

## 修复建议排序

- **P0**：无。
- **P1**：① 魔法色收编令牌（#1）；② bottom 定位补 safe-area 与 wbar 预留（#4，全面屏上是可见遮挡 bug）。
- **P2**：退场加速、backdrop-filter 兜底。
