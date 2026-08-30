# 组件审查：ScheduleCard.vue

> `src/components/todo/ScheduleCard.vue` · 52 行 · 今日日程卡：折叠时间线预览，点按弹完整时间线抽屉

**评级：A**

## 总评

极薄的组合组件：把 VirtualTimeline 的 preview 形态嵌进卡片、点按经 `emit('open')` 开 TimelineSheet，自己只负责标题与计数。交互细节全部正确下沉——预览宿主是 `<button>`，自动继承 base.css 的 scale(0.96) 按压反馈与 VirtualTimeline 自带的 aria-label；预览/抽屉复用同一数据源与同一组件，形态一致。仅有一处大面积按压面的打磨建议。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L35 `<VirtualTimeline :todos="store.allTodos" :date preview @open="open = true" />` 整块 288px 高的 button 继承全局 `:active scale(0.96)` | 在卡片作用域内对 `.vt.preview:active { transform: scale(0.985) }` 局部覆盖更小的缩放 | Emil 要求按压缩放保持 subtle（0.95-0.98），且面积越大同比例位移越显眼：288px 高的整卡按 0.96 缩放晃动感明显，大表面宜取区间上限 | P2 |

## 做得好的

- L31：计数用 `.num` 且 `v-if="scheduledCount"` 为零时隐藏，不出现「0 个安排」的噪声。
- L35 + L38：preview 与 TimelineSheet 复用同一份 `store.allTodos`，折叠态与展开态内容严格一致，无「点进去世界变了」的割裂。
- 职责分离干净：本组件零自定义动效代码，按压/焦点环全部由 button 语义与全局基线免费获得。

## 修复建议排序

- **P0/P1**：无。
- **P2**：大面积按压面改用更小的缩放比例（#1）。
