# 组件审查：FoodParseSheet.vue

> `src/components/ai/FoodParseSheet.vue` · 184 行 · 食物草稿编辑弹层：编辑解析卡后写入今日饮食或存回草稿箱

**评级：B**（整体扎实，有应修项）

## 总评

底部弹层的编辑器容器，自身几乎不含动效代码：进出场、拖拽吸附、不对称节奏全部委托 SheetModal 基线（进 420ms / 出 280ms、进出同路径、Apple sheet 曲线），这是正确的复用方式。视觉样式全部走令牌，干净利落。最突出的问题是主操作「写入今日…」是异步请求却没有等待态——await 期间按钮仍可点击，既缺感知反馈也可能连点造成重复写入。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `L113 <button class="primary" :disabled="stats.matched === 0" @click="commit">`（配合 L68 `async function commit()`，await 期间无任何状态） | 增加 `committing` ref，`:disabled="!canCommit"`（含 committing 判断），await 期间文案切「写入中…」 | commit 是异步请求：等待期无感知处理，且按钮可重复点击导致重复写入（对照 ModelFormSheet L178-180 已有正确做法） | P1 |
| 2 | `L96 识别到 {{ stats.total }} 项 · ≈{{ stats.totalKcal }} 大卡`（外层 p 无等宽处理，L128-131 仅设字号字重） | `<p class="flex-1 num">` | 统计数字随编辑实时变化，比例字宽导致行宽抖动；base.css 的 `.num`（tabular-nums）正为此设 | P2 |

## 做得好的

- L91 复用 SheetModal：进出场动效、不对称节奏、拖拽高度吸附全部来自基线组件，零重复实现。
- L94 缩略图有 `alt="照片缩略图"`，图片可访问性到位。
- L110-115 两个操作按钮均为原生 button，自动继承 base.css 的 `:active scale(0.96)` 按压反馈；L161-163 / L174-176 disabled 态有明确视觉降级。
- L117 `matched === 0` 时给出完整空态文案：先解释原因，再指出路（存草稿稍后处理）。
- L133-183 颜色/圆角/字号全部引用令牌（`--radius-full`、`--surface-2`、`--ok`、`--fs-subhead` 等），无魔法值。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：commit 异步期间补等待态并禁用按钮，防重复写入。
- **P2**（打磨项）：汇总统计行补 `.num` 等宽数字。
