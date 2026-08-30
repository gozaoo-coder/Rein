# 组件审查：MuscleMap.vue

> `src/components/exercise/MuscleMap.vue` · 422 行 · 全身肌群激活图：正/背/侧三视图 SVG 分层着色，interactive 时点击弹出按档位排序的肌群列表

**评级：B**

## 总评

SVG 工程质量高：底图 + 肌群层同 viewBox 堆叠、层序即命中优先级有注释（L63）、`pointer-events: visiblePainted` 让点击只落在画了的 path 上（L274-276）、每层注入 `<title>` 提供悬停提示、档位色全部引用运动绿令牌。短板在交互语义：整图可点却是个无角色、无 tabindex、无键盘路径、无按压反馈的裸 div——「可点但键盘用户永远够不着」是本组件唯一的实质缺陷；解剖插画的手写灰/赭红色板未令牌化属可接受的美术决策，列为打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L172 `<div class="mmap col" :class="{ interactive }" @click="onMapTap">` | interactive 时补 `role="button"` `:tabindex="0"` `aria-label="查看全部激活肌群"` `@keydown.enter.prevent="onMapTap"` `@keydown.space.prevent="onMapTap"` | 可交互元素必须有键盘路径与可及名；当前 taphint（L208）只服务视觉用户，读屏与键盘用户无法触达抽屉 | P1 |
| 2 | L278-284 `.interactive { cursor: pointer; }`（无任何按压态） | `.interactive:active .figs { transform: scale(0.98); }` 配合 `transition: transform var(--dur-fast) var(--ease-standard)`，或直接挂全局 `.pressable` 类 | 非 button 的可点元素缺可见按压反馈——tap 后抽屉弹出前的瞬间没有任何「界面听到了」的确认 | P1 |
| 3 | L290/L294/L298 `.layer.base { fill: rgba(120, 110, 95, 0.38); } .layer.idle { fill: rgba(183, 92, 74, 0.3); } stroke: rgba(90, 45, 30, 0.4);` | 抽成 `--anatomy-base/--anatomy-idle/--anatomy-stroke` 令牌（含暗色块） | 解剖色板共 6 组手写 RGBA 且亮暗各一份，散落在组件里难以整体调色；虽属美术用色非 UI chrome，收进 tokens 才能一处换肤 | P2 |

## 做得好的

- L269-276 `pointer-events: none` 层级 + `visiblePainted` path 命中：空白区域点击穿透到卡片，命中模型精确且零 JS 几何计算。
- L118-128 每层动态注入 `<title>`（含档位文案），桌面悬停即得原生 tooltip。
- L146-162 肌群列表按档位降序、同档保持配置顺序（注释点明依赖稳定排序）——排序逻辑与展示意图一致。
- L317-327 三档激活色全走 `--c-exercise-soft / --heat-mid / --c-exercise`，图例（L354-365）与抽屉圆点（L391-401）同源同色。
- 静态 SVG 仅切换 class 改 fill，无逐帧动画、无 layout 参与，性能干净。
- L62/L109-111/L245 等处注释把层叠顺序、渲染策略、对齐锚定都讲清楚，可维护性好。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：① interactive 补 role/tabindex/aria-label/键盘事件（L172）；② 补可见按压反馈（L278-284）。
- **P2**（打磨项）：③ 解剖色板令牌化（L290-314）。
