# Rein 设计系统 — 沉浸光感 (Immersive Light)

> 基于 HarmonyOS 沉浸光感视觉风格。毛玻璃表面 + 径向彩色光晕，沿 Z 轴建立层次，让内容沉浸、交互可读、信息可感知。

---

## 1. 设计理念

| 维度 | 原则 |
|------|------|
| **光感** | 彩色径向光晕锚定在卡片角落（83% 104%，右下），20% alpha，模拟环境光沿边缘流淌 |
| **材质** | 5 档玻璃高度系统（Ultra_Thin → Ultra_Thick），每档 = 模糊半径 + 背景透明度 + 阴影 |
| **光晕环** | 交互态悬浮发光环（halo），0.5s 缓动显隐，10% alpha 品牌色 |
| **节奏** | 0.3s 状态变化 / 0.5s 氛围过渡 / 1s 消散，ease-in-out |
| **克制** | 中文字体回退系统字（PingFang SC / Microsoft YaHei），仅 Latin 字形走 HarmonyOS Sans |

---

## 2. 色彩体系

### 2.1 品牌色（HarmonyOS Blue）

| Token | Hex | 用途 |
|-------|-----|------|
| `--brand-500` | `#0A59F7` | 主色，CTA、激活态 |
| `--brand-50` | `#E8F1FE` | 浅底、tinted 按钮 |
| `--brand-900` | `#021532` | 深底、暗色品牌文字 |

### 2.2 光晕色板（径向渐变停靠点，20% alpha）

| Token | rgba | 语义 |
|-------|------|------|
| `--glow-primary` | `rgba(10,89,247,0.2)` | 主操作、跑步 |
| `--glow-success` | `rgba(100,187,92,0.2)` | 完成、步数、课程 |
| `--glow-warning` | `rgba(247,133,10,0.2)` | 提醒、瑜伽 |
| `--glow-danger` | `rgba(232,64,38,0.2)` | 警示、力量训练 |
| `--glow-accent` | `rgba(172,73,245,0.2)` | 强调、骑行 |

> **规则**：每张卡片最多一个 glow 色，对应其语义。光晕锚点固定 `97.75% 83.15% at 83% 104%`（右下角），不可自定义位置。

### 2.3 状态色

| 语义 | Token | Hex |
|------|-------|-----|
| 成功 | `--color-success` | `#64BB5C` |
| 警告 | `--color-warning` | `#F7850A` |
| 危险 | `--color-danger` | `#E84026` |
| 强调 | `--color-accent` | `#AC49F5` |

### 2.4 背景与文字（各 10 档）

```
--bg-50  → --bg-900   (white → #1c1c1e)
--text-50 → --text-900 (white → #1c1c1e)
```

**语义别名**（组件只消费这些）：

- `--color-bg` / `--color-bg-secondary` / `--color-bg-elevated`
- `--color-text` / `--color-text-secondary` / `--color-text-tertiary`
- `--color-divider` / `--color-surface`

---

## 3. 字体系统

### 3.1 字体栈

```css
--font-sans:
  "HarmonyOS Sans", "HarmonyOSHans-Regular",
  "PingFang SC", "Microsoft YaHei",
  -apple-system, BlinkMacSystemFont, "Segoe UI",
  "Helvetica Neue", Arial, sans-serif;
```

- **Latin**：HarmonyOS Sans（项目内嵌 334KB TTF，仅 Latin 子集）
- **中文**：系统回退（PingFang SC on macOS/iOS，Microsoft YaHei on Windows，HarmonyOS Sans SC on HarmonyOS 设备）
- **等宽**：JetBrains Mono / Consolas / ui-monospace

### 3.2 字号阶梯

| Token | Size | 用途 |
|-------|------|------|
| `--text-xs` | 12px | 标签、辅助说明 |
| `--text-sm` | 13px | 卡片次级标签 |
| `--text-base` | 14px | 正文（默认） |
| `--text-md` | 15px | 列表项 |
| `--text-lg` | 16px | 顶栏标题 |
| `--text-xl` | 20px | 弹窗副标题 |
| `--text-2xl` | 24px | 卡片主数值 |
| `--text-3xl` | 40px | 页面大标题 |

### 3.3 字重 / 行高

- 字重：`--fw-regular` (400) / `--fw-medium` (500) / `--fw-semibold` (600) / `--fw-bold` (700)
- 行高：`--lh-tight` (1.2) / `--lh-snug` (1.4) / `--lh-base` (1.5) / `--lh-relaxed` (1.75)

---

## 4. 玻璃材质 5 档系统

核心。每档对应 HarmonyOS 枚举 `Ultra_Thin → Ultra_Thick`。

| 档位 | 模糊半径 | 背景透明度 | 阴影 | 场景 |
|------|----------|-----------|------|------|
| `ultra-thin` | 20px | 55% | shadow-sm | 顶栏、顶部浮层 |
| `thin` | 40px | 70% | shadow-md | 底部 Tab、底部弹层 |
| `medium` | 80px | 80% | shadow-md | 内容卡片、FAB |
| `thick` | 120px | 90% | shadow-lg | 弹窗、下拉、Toast |
| `ultra-thick` | 200px | 96% | shadow-xl | 半模态、大对话框 |

### 4.1 使用方式

**CSS 工具类**（直接 class）：

```html
<div class="glass-ultra-thin">顶部浮层</div>
<div class="glass-medium glow-primary">主操作卡片</div>
<div class="glass-thick halo-hover">可悬浮弹窗</div>
```

**Vue 组件**（推荐，类型安全）：

```vue
<GlassCard tier="medium" glow="primary" :hover-halo="true" :interactive="true">
  ...
</GlassCard>
```

### 4.2 场景规则（来自 HarmonyOS 设计规范）

| 组件 | 档位 | 备注 |
|------|------|------|
| 顶部固定栏（AppTopBar） | `ultra-thin` | 顶部空间渐变模糊延伸 |
| 底部固定栏（AppTabBar） | `thin` | 底部色彩遮罩延伸 |
| 普通内容卡片 | `medium` | 默认 |
| 悬浮按钮（FAB） | `medium` | + `saturate(180%)` |
| 非永久弹窗（任意位置） | `thick` | + halo-hover |
| 半模态 / 大对话框 | `ultra-thick` | 模糊 200px |

---

## 5. 径向光晕

将彩色环境光叠加到玻璃表面。

```css
.glow-primary {
  background-image: radial-gradient(
    97.75% 83.15% at 83% 104%,
    var(--glow-primary) 0%,
    var(--glow-transparent) 100%
  );
}
```

- 锚点：右下角（83% 横向，104% 纵向）
- 起始 alpha：20%
- 与 `glass-*` 档位组合使用（glass 设 `background-color`，glow 设 `background-image`，天然叠加）

---

## 6. 悬浮光晕环

签名交互效果。玻璃表面悬浮时，外围 3px 环形发光。

```css
.halo-hover::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: var(--radius-popover-halo); /* 26px */
  background-color: var(--halo-transparent);
  transition: background-color var(--dur-halo) var(--ease-immersive); /* 0.5s */
}
.halo-hover:hover::after {
  background-color: var(--halo-color); /* rgba(10,89,247,0.1) */
}
```

- 边框同步淡出：`border-color: transparent`（HarmonyOS 弹窗签名）
- 仅用于可交互玻璃表面（卡片、弹窗、FAB）

---

## 7. 圆角系统

| Token | 值 | 用途 |
|-------|-----|------|
| `--radius-sm` | 8px | 小元素、tag |
| `--radius-md` | 12px | 中等元素 |
| `--radius-lg` | 19.2px | 默认卡片 |
| `--radius-xl` | 24px | 弹窗外层 |
| `--radius-2xl` | 32px | 大容器 |
| `--radius-popover` | 24px | 弹窗专用 |
| `--radius-popover-inner` | 23px | 弹窗内层 |
| `--radius-popover-halo` | 26px | 光晕环 |
| `--radius-pill` | 50px | 胶囊按钮、FAB |
| `--radius-full` | 9999px | 圆形 |

---

## 8. 间距系统

4px 基准：`--space-1` (4px) → `--space-20` (80px)。

常用：
- `--space-2` (8px) 紧凑间距
- `--space-4` (16px) 卡片内边距（默认）
- `--space-5` (20px) 顶栏内边距
- `--space-6` (24px) 页面边距

---

## 9. 动效节奏

| Token | 时长 | 用途 |
|-------|------|------|
| `--dur-fast` | 0.3s | 状态变化（hover、focus、active、press） |
| `--dur-halo` | 0.5s | 氛围过渡（光晕环、玻璃边框淡出） |
| `--dur-dismiss` | 1s | 消散、淡出 |
| `--ease-immersive` | ease-in-out | 默认缓动 |

**规则**：
- 所有 `transition` 必须引用 token，禁止裸写 `0.2s ease`
- 按压反馈用 `transform: scale(0.97)` + `--dur-fast`
- 玻璃悬浮用 `border-color` + `--dur-halo`

---

## 10. 暗色模式

通过 `.dark` class 切换。所有语义 token 自动重映射。

- 品牌色反转：`--brand-500` → `#3486F5`（暗底下提亮）
- 光晕 alpha：20% → 22%（暗底下补偿）
- 玻璃背景：白色 → `rgba(44,44,46,*)` 或 `rgba(28,28,30,*)`
- 阴影：透明度提升至 0.3–0.7

**启用方式**：在 `<html>` 上加 `class="dark"`，或通过 `useDevice` composable 自动跟随系统。

---

## 11. 组件消费规则

### 11.1 禁止

- ❌ 组件内硬编码 hex 颜色
- ❌ 组件内硬编码 px 间距 / 圆角 / 时长
- ❌ 组件内自定义 `backdrop-filter`
- ❌ 直接使用 `--brand-*` / `--bg-*` / `--text-*` 原始阶梯（应用语义别名）

### 11.2 必须

- ✅ 颜色用 `var(--color-*)` 语义别名
- ✅ 玻璃表面用 `.glass-{tier}` 工具类或 `<GlassCard>` 组件
- ✅ 光晕用 `.glow-{semantic}` 工具类或 `<GlassCard glow="...">`
- ✅ 间距用 `var(--space-*)`
- ✅ 时长用 `var(--dur-*)` + `var(--ease-immersive)`
- ✅ 字体用 `var(--font-sans)` / `var(--font-mono)`，字号用 `var(--text-*)`

---

## 12. 文件清单

| 文件 | 职责 |
|------|------|
| [src/styles/tokens.css](file:///c:/Users/Administrator/Documents/Code/Rein/src/styles/tokens.css) | 设计令牌（原始阶梯 + 语义别名 + 暗色） |
| [src/styles/global.css](file:///c:/Users/Administrator/Documents/Code/Rein/src/styles/global.css) | 全局重置 + HarmonyOS Sans + glass/glow/halo 工具类 |
| [src/components/ui/GlassCard.vue](file:///c:/Users/Administrator/Documents/Code/Rein/src/components/ui/GlassCard.vue) | 玻璃卡片组件（tier + glow + halo） |
| [src/components/ui/ReinButton.vue](file:///c:/Users/Administrator/Documents/Code/Rein/src/components/ui/ReinButton.vue) | 按钮组件（filled/tinted/glass/plain） |
| [src/components/ui/ReinIcon.vue](file:///c:/Users/Administrator/Documents/Code/Rein/src/components/ui/ReinIcon.vue) | SVG 图标组件（内置路径注册表） |
| [src/assets/fonts/HarmonyOS_Sans.ttf](file:///c:/Users/Administrator/Documents/Code/Rein/src/assets/fonts/HarmonyOS_Sans.ttf) | HarmonyOS Sans Latin 子集 |
