# 组件审查：ActivityRings.vue

> `src/components/common/ActivityRings.vue` · 47 行 · Apple Fitness 式三环（同心、外大内小）

**评级：A**

## 总评

纯组合层的薄封装，把三份 RingProgress 绝对定位居中叠出同心环。外环大而粗、内环小而细的线宽递增（10/12/15）复刻了 Apple Fitness 的透视语言；动画质量完全继承自 RingProgress 的 dashoffset 方案。只有常量可读性和 aria 两处打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L30 `:stroke="[10, 12, 15][i] ?? 10"` | 提取具名常量 `const RING_STROKES = [10, 12, 15]` 并注释「外→内」 | 魔法数组藏在模板里，后来者需要反推哪一档对应哪个环 | P2 |
| 2 | L29 内环尺寸 `size - i * (size * 0.24)` 硬编码间距比例 | 提取 `RING_GAP = 0.24` 常量（与 #1 同处） | 同上；两处魔法值共同定义了三环的视觉密度，改一处忘另一处会失衡 | P2 |
| 3 | 根元素无语义 | 加 `role="img"` + `aria-label` prop（如「今日活动三环完成度」），内部环设 `aria-hidden` | 与 RingProgress 相同的读屏缺口，且嵌套三层会被逐个朗读 | P2 |

## 做得好的

- L41-46：每层 `translate(-50%, -50%)` 居中叠加，transform-only 无 layout 参与。
- L29-30：size 与 stroke 都在 viewBox 归一化坐标系内工作，任意 size 下三环比例恒定。
- L23-31：完全复用 RingProgress 的动画系统，没有重复实现——单一动效真相源。

## 修复建议排序

- **P0/P1**：无。
- **P2**：常量提取（#1/#2）、aria 聚合到根（#3）。
