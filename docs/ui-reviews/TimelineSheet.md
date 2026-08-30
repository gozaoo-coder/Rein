# 组件审查：TimelineSheet.vue

> `src/components/todo/TimelineSheet.vue` · 35 行 · 完整时间线抽屉：虚拟化连续时间轴（含历史/未来），打开时自动定位到「现在」附近

**评级：A**

## 总评

35 行的纯编排组件：SheetModal（large 档）承载 VirtualTimeline 的 full 形态，自己只做一件事——每次打开后在下一帧调 `scrollToNow()` 兜底定位。进出动画、手势、可打断性全部委托给两个被复用的成熟组件，本层无动效代码即无动效错误。本轮未发现问题。

## 问题清单

本轮审查未发现问题。（`watch(open)` + `nextTick` + 组件内 onMounted 双保险的定位时序经核对无冲突：抽屉 v-if 每次挂载会重新锚定，watch 调用只是幂等兜底。）

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| — | — | — | 未发现违反方法论或项目规范的问题 | — |

## 做得好的

- L20-28：`watch(open)` 中先 `await nextTick()` 再 `scrollToNow()`，等 DOM 挂载完成才量取滚动容器，注释还说明了「v-if 每次挂载已自动锚定、此处仅兜底」——对时序的自觉清晰。
- L32：`initial-snap="large"` 让长时间轴一打开就有足够的可视纵深，避免 small 档下时间轴局促。
- L33：`ref="timeline"` + defineExpose 的命令式滚动桥接，是「声明式渲染 + 少量必要命令式」的干净范例。

## 修复建议排序

- **P0/P1/P2**：无。
