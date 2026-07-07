# Rein 组件样式规范

> 配套 [design-system.md](file:///c:/Users/Administrator/Documents/Code/Rein/docs/design-system.md)。本文档规定组件级实现规范：结构、命名、token 消费、无障碍、测试要点。

---

## 1. Vue 组件结构规范

### 1.1 SFC 顺序

```vue
<script setup lang="ts">
// 1. JSDoc 组件说明（用途 + 设计档位映射）
// 2. import（外部 → 内部 → 类型 → composables）
// 3. defineProps / withDefaults
// 4. defineEmits
// 5. defineModel（如有）
// 6. computed / ref / reactive
// 7. 生命周期（onMounted 等）
// 8. function（事件处理）
</script>

<template>
  <!-- 单根元素优先；多根用 fragment -->
</template>

<style scoped>
/* 1. 根类名（组件名 kebab-case） */
/* 2. 子元素类名（BEM-lite：block__element） */
/* 3. 修饰类（--modifier） */
/* 4. 状态类（.is-active / .is-disabled） */
/* 5. 响应式（@media） */
</style>
```

### 1.2 命名

| 类型 | 规则 | 示例 |
|------|------|------|
| 组件文件 | PascalCase.vue | `GlassCard.vue` |
| 组件名 | PascalCase | `GlassCard` |
| props | camelCase | `hoverHalo` |
| emits | kebab-case 事件名 | `update:model-value` |
| CSS 类 | kebab-case，BEM-lite | `.glass-card-root`、`.glass-card-root--active` |
| CSS 变量 | `--{namespace}-{role}` | `--card-padding`、`--glass-bg` |

### 1.3 类型安全

- props 必须用 `defineProps<T>()` + `withDefaults`
- emits 必须用 `defineEmits<{ (e: 'name', payload: T): void }>()`
- 联合类型用 `as const` 字面量
- 禁止 `any`（除 `props: Record<string, any>` 动态卡片配置）

---

## 2. 设计 token 消费规范

### 2.1 允许的 token 前缀（组件内）

| 前缀 | 用途 | 示例 |
|------|------|------|
| `--color-*` | 语义颜色 | `var(--color-text)` |
| `--space-*` | 间距 | `var(--space-4)` |
| `--radius-*` | 圆角 | `var(--radius-lg)` |
| `--text-*` | 字号 | `var(--text-base)` |
| `--fw-*` / `--lh-*` | 字重 / 行高 | `var(--fw-semibold)` |
| `--font-*` | 字体族 | `var(--font-sans)` |
| `--dur-*` / `--ease-*` | 动效 | `var(--dur-fast)` |
| `--shadow-*` | 阴影 | `var(--shadow-md)` |

### 2.2 禁止的 token（组件内）

| 前缀 | 原因 |
|------|------|
| `--brand-*` | 原始阶梯，应用 `--color-primary` |
| `--bg-*` | 原始阶梯，应用 `--color-bg*` |
| `--text-*`（颜色语境） | 原始阶梯，应用 `--color-text*` |
| `--material-*-bg` 等 | 通过 `.glass-{tier}` 或 `<GlassCard>` 消费 |
| `--glow-*` | 通过 `.glow-{semantic}` 或 `<GlassCard glow>` 消费 |

### 2.3 组件局部变量

组件可在 `:scoped` 内定义局部 CSS 变量（通过 inline style 注入），用 `--{component}-{role}` 命名：

```vue
<style scoped>
.glass-card-root {
  padding: var(--card-padding);     /* 局部 */
  border-radius: var(--card-radius); /* 局部 */
  color: var(--color-text);         /* 全局语义 */
}
</style>
```

---

## 3. 玻璃表面实现规范

### 3.1 优先用 GlassCard 组件

```vue
<!-- 推荐 -->
<GlassCard tier="medium" glow="primary" :hover-halo="true" :interactive="true">
  ...
</GlassCard>
```

### 3.2 必须用工具类的场景

当无法用 GlassCard（如原生 `<header>` / `<nav>` / `<button>`）时，用工具类组合：

```vue
<header class="app-top-bar glass-ultra-thin safe-area-top">
<nav class="app-tab-bar glass-thin safe-area-bottom">
<button class="fab glass-medium glow-primary halo-hover">
```

### 3.3 禁止

- ❌ 组件内自定义 `backdrop-filter`
- ❌ 组件内自定义 `radial-gradient`（光晕）
- ❌ 组件内直接写 `rgba(...)` 玻璃背景

---

## 4. 图标规范

### 4.1 用 ReinIcon

```vue
<ReinIcon name="heart" :size="22" :stroke-width="2" />
```

### 4.2 新增图标

在 [src/components/ui/ReinIcon.vue](file:///c:/Users/Administrator/Documents/Code/Rein/src/components/ui/ReinIcon.vue) 的 `ICON_PATHS` 注册表追加：

```typescript
const ICON_PATHS: Record<IconName, string> = {
  // ...existing
  "new-icon": "M12 2L2 22h20L12 2z",
};
```

然后将 `IconName` 联合类型追加 `"new-icon"`。

### 4.3 规则

- viewBox 固定 `0 0 24 24`
- stroke-based，`stroke-linecap="round"` `stroke-linejoin="round"`
- 默认 `stroke-width=2`，可按场景调至 2.4（强调）或 1.8（次级）
- 继承 `currentColor`
- 实心图标（play/pause/stop/drag）用 `fill="currentColor" stroke="none"`

---

## 5. 按钮规范

### 5.1 变体选择

| 场景 | 变体 | 示例 |
|------|------|------|
| 主操作（每屏 1 个） | `filled` | 开始运动、保存 |
| 次操作 | `tinted` | 取消、查看详情 |
| 浮动操作 | `glass` + tier | FAB、悬浮工具栏 |
| 文本操作 | `plain` | 跳过、了解更多 |

### 5.2 尺寸

| 尺寸 | 高度 | 内边距 | 字号 | 用途 |
|------|------|--------|------|------|
| `sm` | 32px | 12px | 13px | 卡片内、密集列表 |
| `md` | 40px | 20px | 15px | 默认 |
| `lg` | 48px | 24px | 16px | 全宽 CTA、引导页 |

### 5.3 用法

```vue
<ReinButton variant="filled" size="md" @click="save">保存</ReinButton>

<ReinButton variant="glass" tier="thick" glow="primary" block>
  <template #icon-left><ReinIcon name="play" :size="16" /></template>
  开始
</ReinButton>

<ReinButton variant="filled" :loading="saving" :disabled="!valid">
  提交
</ReinButton>
```

---

## 6. 卡片规范

### 6.1 结构

卡片 = `<GlassCard>` 包裹 + 内部布局组件。内部组件**不应**再带玻璃背景。

```vue
<!-- RunningCard.vue 内部 -->
<template>
  <div class="running-card">
    <div class="card-header">
      <span class="card-label">跑步</span>
      <ReinIcon name="run" :size="16" />
    </div>
    <div class="card-stats">...</div>
    <div class="card-footer">...</div>
  </div>
</template>
```

### 6.2 glow 语义映射

卡片应在 `CardConfig.glow` 声明其语义光晕：

| 卡片类型 | glow | 理由 |
|---------|------|------|
| 跑步 | `primary` | 主运动 |
| 骑行 | `accent` | 强调 |
| 瑜伽 | `warning` | 柔和提醒 |
| 力量 | `danger` | 高强度 |
| 步数 / 课程 | `success` | 完成 |
| 心率 | `danger` | 健康警示 |
| 睡眠 | `accent` | 放松 |
| 水分 | `primary` | 基础需求 |

### 6.3 内部排版

- 主数值：`--text-2xl` (24px) + `--fw-bold` (700)
- 标签：`--text-sm` (13px) + `--fw-medium` (500) + `--color-text-secondary`
- 单位：`--text-xs` (12px) + `--color-text-tertiary`
- 分割线：`1px solid var(--color-divider)`

---

## 7. 布局规范

### 7.1 三档断点

| 模式 | 宽度 | 布局 | Tab 栏 |
|------|------|------|--------|
| `phone` | < 768px | 单列 | 底部 |
| `pad` | 768–1200px | 双列 | 底部 |
| `desktop` | ≥ 1200px | 多列 + 侧栏 | 侧栏 |

通过 `useBreakpoint()` 获取，`App.vue` 据此切换 `Layout`。

### 7.2 安全区域

所有贴边元素必须加 `safe-area-*`：

```vue
<header class="safe-area-top">
<nav class="safe-area-bottom">
```

### 7.3 滚动容器

主滚动区加 `scrollbar-hide`（移动端隐藏滚动条）：

```vue
<main class="app-main scrollbar-hide">
```

---

## 8. 无障碍规范

| 项 | 规则 |
|----|------|
| 焦点环 | 全局 `:focus-visible` 已设 2px 品牌色 outline，组件勿覆盖 |
| aria-label | 所有图标按钮必须 `aria-label` |
| role | 自定义控件（tab、dialog）必须设 `role` + `aria-*` |
| 颜色对比 | 文本对 `--color-bg` 对比度 ≥ 4.5:1（正文）/ 3:1（大字） |
| 触控目标 | 最小 44×44px（iOS）/ 48×48dp（Android） |
| 动效尊重 | 后续接入 `prefers-reduced-motion` 时统一关闭非必要动画 |

---

## 9. 动效规范

### 9.1 通用

```css
transition:
  transform var(--dur-fast) var(--ease-immersive),
  opacity var(--dur-fast) var(--ease-immersive),
  background-color var(--dur-fast) var(--ease-immersive);
```

### 9.2 按压

```css
:active:not(:disabled) {
  transform: scale(0.97);
}
```

### 9.3 玻璃悬浮

```css
.interactive:hover {
  border-color: transparent;  /* 边框淡出 */
}
/* halo 由 .halo-hover::after 提供 */
```

### 9.4 禁止

- ❌ `transition: all`（性能差，应明确属性）
- ❌ 裸写 `0.2s ease` / `0.3s`
- ❌ `transform` 动画不带 `will-change` 时超过 3 个并发

---

## 10. 文件组织规范

```
src/components/
├── ui/                    # 通用 UI 原子（GlassCard、ReinButton、ReinIcon）
│   └── index.ts           # 命名导出
├── shell/                 # 应用框架（AppShell、AppTopBar、AppTabBar）
├── cards/                 # 卡片系统
│   ├── CardGrid.vue
│   ├── CardRegistry.ts
│   ├── StaticCard.vue
│   ├── EditableCard.vue
│   ├── health/            # 健康卡片
│   └── sports/            # 运动卡片
└── [feature]/             # 功能组件（chat、map 等）
```

### 10.1 规则

- 通用 UI 原子放 `ui/`，通过 `index.ts` 命名导出
- 业务卡片放 `cards/{domain}/`
- 页面级组件不放 `components/`，放 `pages/`
- 一个组件一个文件，文件名 = 组件名

---

## 11. 测试要点

| 组件类型 | 测试要点 |
|---------|---------|
| GlassCard | 5 档 tier class 正确应用；glow class 组合；halo-hover 类存在；interactive 时 active scale |
| ReinButton | 4 变体 class；3 尺寸；disabled/loading 阻止 click；block 全宽 |
| ReinIcon | 路径注册表完整；未知 name fallback；size/strokeWidth 透传 |
| 卡片 | CardConfig.glow 透传到 GlassCard；edit 模式 overlay 显示 |

---

## 12. 迁移清单

将旧组件迁移到沉浸光感系统的检查项：

- [ ] 所有 hex 颜色替换为 `var(--color-*)`
- [ ] 所有裸 px 间距替换为 `var(--space-*)`
- [ ] 所有裸 px 圆角替换为 `var(--radius-*)`
- [ ] 所有裸 px 字号替换为 `var(--text-*)`
- [ ] 所有 `0.2s ease` 替换为 `var(--dur-fast) var(--ease-immersive)`
- [ ] 所有 `glass-card` / `glass-surface` 评估是否升级为具体档位（`.glass-{tier}`）
- [ ] 所有内联 SVG 评估是否替换为 `<ReinIcon>`
- [ ] 所有图标按钮加 `aria-label`
- [ ] 卡片在 `CardConfig` 声明 `glow`
