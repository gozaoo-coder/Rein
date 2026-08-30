# 组件审查：TabBar.vue

> `src/components/layout/TabBar.vue` · 74 行 · 底部标签导航，固定四个一级页面

**评级：A**

## 总评

苹果味很正的底部导航：毛玻璃 + 饱和度提升、`prefers-reduced-transparency` 降级、选中态用 stroke-width 加粗做光学补偿而非换图标、色彩过渡只声明 color 一个属性。尤其值得表扬的是它的克制——tab 一天切换几十次，这里没有加任何位移弹跳，完全符合「高频操作砍动效」的决策框架。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L25 `:stroke-width="route.name === it.name ? 2.4 : 1.9"` 属性切换瞬跳 | 接受瞬跳（SVG 属性经 props 重渲染，无过渡路径）；若要平滑需改为双层图标叠 opacity | 选中/取消的一帧内线宽突变，肉眼可见轻微「闪」；但为 tab 级高频操作加过渡又违背高频原则——两害相权，维持现状并知晓即可 | P2 |
| 2 | L43-45 仅靠 `prefers-reduced-transparency` 兜底 | 外层先给 `background: var(--surface)` 实底，`@supports (backdrop-filter: blur(1px))` 内再换半透明 + 模糊 | 不支持 backdrop-filter 的旧 Android WebView 上 72% 半透明底直接压在内容上，对比度不足；@supports 才是无感降级 | P2 |

## 做得好的

- L49-55：`prefers-reduced-transparency` 媒体查询——全项目唯一一处，对无障碍/低透偏好用户的尊重远超行业平均。
- L25：选中态 stroke-width 2.4 vs 1.9 的光学加粗，比换 filled 图标更轻且保持视觉连续。
- L57-73：过渡只写 `color` 单属性，激活变色干脆利落；tab 全宽均分，触控目标无可挑剔。
- L39-40：高度含 `--safe-bottom` 且内容 padding-bottom 让出安全区。

## 修复建议排序

- **P0/P1**：无。
- **P2**：stroke-width 切换的已知取舍文档化（#1）、backdrop-filter 的 @supports 实底兜底（#2）。
