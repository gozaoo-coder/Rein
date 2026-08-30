# 组件审查：RingProgress.vue

> `src/components/common/RingProgress.vue` · 72 行 · 单个 SVG 进度环，Apple 活动环基本单元

**评级：A**

## 总评

教科书级的 SVG 进度环实现：`stroke-dashoffset` 驱动（GPU 合成的 stroke 动画，不触发 layout）、`--ease-sheet` 曲线、圆头端帽、`rotate(-90deg)` 让环从 12 点钟起步——与 Apple Fitness 的方向语言一致。viewBox 归一化让任意 size 下线宽比例恒定。仅剩时长与可访问性两处可选打磨。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L61 `transition: stroke-dashoffset 700ms var(--ease-sheet)` | 收紧至 500-600ms 或维持现状（数据仪式感可辩护） | 超 300ms 上限；但进度环属「每日一次的数据展示」而非高频 UI 反馈，Apple Fitness 同样慢涨。若保留，建议文档注明这是有意的例外 | P2 |
| 2 | 根元素无语义 | `.ring` 加 `role="img"` + `aria-label` prop（如「摄入 82%」）并透传 | 环形进度对读屏是完全静默的图形；中心数字若无文本关联则信息丢失 | P2 |

## 做得好的

- L19/L34：dashoffset = C×(1-pct) 直接映射，pct 双向钳制 [0,1]，溢出封顶但中心 slot 可继续表达真实数值。
- L56-62：动画只涉及 `stroke-dashoffset` 与静态 transform，无 layout/paint 开销；reduced-motion 下被全局兜底归零。
- L59-60：旋转起点写死在 viewBox 坐标系（50px 50px），不随 CSS 尺寸缩放出错。
- L16：R 按 `50 - stroke/2 - 1` 内缩，粗环不会出血裁切。

## 修复建议排序

- **P0/P1**：无。
- **P2**：时长决策文档化或收紧（#1）、`role="img"` + aria-label（#2）。
