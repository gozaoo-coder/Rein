# 组件审查：QuickTile.vue

> `src/components/common/QuickTile.vue` · 40 行 · 快捷入口磁贴：圆形图标 + 文字标签

**评级：A**

## 总评

40 行的标准磁贴，该有的都有：原生 button 自带全局按压反馈与焦点环、卡片底/圆角/阴影全走令牌、整块可点且宽度撑满触控友好。唯一值得留意的是颜色经 props 内联注入的口子——约定靠自觉，令牌纪律在调用方手里。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L12 `:style="{ background: iconBg, color: iconColor }"` 接受任意颜色字符串 | JSDoc 注明「必须传 `var(--xxx)` 令牌引用」；或改为 `tone?: 'accent' \| 'ok' \| …` 枚举映射到类名 | 内联样式绕开了「颜色零魔法值」的静态检查；一旦调用方图省事传 hex，暗色模式立刻破功 | P2 |

## 做得好的

- L11：button 承载整个磁贴，全局 `:active scale(0.96)` 与 `:focus-visible` 自动生效，零额外代码。
- L24-26：radius/shadow/background 全部引用令牌。
- L32-39：图标圆底 40×40，加上文字标签整体热区远超触控标准。

## 修复建议排序

- **P0/P1**：无。
- **P2**：iconBg/iconColor 的令牌约定固化（#1）。
