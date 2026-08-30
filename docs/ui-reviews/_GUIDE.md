# Rein 组件 UI 审查指南

> 2026-08-26 · 基于 Emil Kowalski 设计工程方法论（`C:\Users\Administrator\.zcode\skills\emil-design-eng\SKILL.md`）对 `src/components/` 全部 56 个组件的逐一审查。
>
> 本目录每个组件一份报告：`<ComponentName>.md`。本文件是共用背景与评级口径。

## 审查基准

1. **方法论**：Emil Kowalski 设计工程哲学 —— 动效决策框架（该不该动/目的/缓动/时长）、按压反馈、transform-origin、可打断性、性能（只动 transform/opacity）、reduced-motion、stagger、不对称进出节奏等。
2. **项目令牌**：`src/styles/tokens.css` —— 颜色/圆角/阴影/字号/时长/缓动一律引用令牌，魔法值违规。
3. **全局基线**：`src/styles/base.css` 已提供：
   - `button, .pressable` 的 `:active { transform: scale(0.96) }` 按压反馈（组件无需重复实现，但非 button 的可点元素需自带 `.pressable` 或等价物）；
   - `:focus-visible` 焦点环；
   - 全局 `prefers-reduced-motion` 兜底；
   - `.num`（tabular-nums 数字等宽）。
4. **项目规范**：`docs/STANDARDS.md` §4 —— 可交互元素必须有可见按压/悬停态与 aria-label（图标按钮必填）；动效遵守 ARCHITECTURE §5（标准曲线、进出同路径、`:active` 反馈）。
5. **平台语境**：这是 Tauri 移动优先应用（iOS HIG 风格 + Android WebView），触控为主；hover 态需考虑触屏误触发，但桌面工作台模式下 hover 也有意义。

## 报告格式（每份一致）

```markdown
# 组件审查：ComponentName.vue

> `src/components/<域>/ComponentName.vue` · N 行 · <一句话职责>

**评级：A / B / C**（A=可直接作为范本；B=整体扎实，有应修项；C=存在手感/规范硬伤）

## 总评
2-4 句：组件交互形态、动效现状、最突出的问题与亮点。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `<现有代码摘录>` | `<建议改法>` | <方法论依据，一句话> | P0/P1/P2 |

（Before/After 必须是真实代码对照，引用行号如 `L123`；每行一个问题）

## 做得好的
- 具体到行号的亮点（没有就写「无」）。

## 修复建议排序
- **P0**（明显手感缺陷或违反方法论核心）：…
- **P1**（应修）：…
- **P2**（打磨项）：…
```

## 优先级口径

- **P0**：违反方法论核心原则且用户可感 —— 如 ease-in 用于进入、时长 >300ms 的 UI 动效、scale(0) 出现、不可打断的关键手势动画、动画 layout 属性（width/height/top/left）、键盘高频操作被加动画。
- **P1**：违反项目自身规范或一致性缺口 —— 魔法值不引用令牌、缺 aria-label、缺 reduced-motion 处理（全局兜底之外的 transform 动画）、hover 未做触屏隔离、进出不同路径。
- **P2**：打磨项 —— stagger 缺失、blur 技巧可用、transform-origin 可更精准、退出节奏可更快等。
