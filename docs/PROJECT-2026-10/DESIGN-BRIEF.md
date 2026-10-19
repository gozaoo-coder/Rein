# 设计简报 · Rein 对外表达层

> 官网与视频都要**看起来就是从 App 里长出来的**。做法不是"模仿得像"，而是
> **引用同一份设计令牌**（`src/styles/tokens.css`）与同一套动效曲线。
> 本文件把散在令牌与 STANDARDS 里的约束收成一份可执行的清单。

## 1. 产品一句话

**Rein · 全能生活助理** —— 一个以 AI 为中枢的个人生活助理：饮食、营养、运动、待办、
专注、记账、课表、知识库，长在同一条时间线上，**都能被 AI 读懂、也能被 AI 操作**。
Tauri 2 + Vue 3 + Rust（SQLite），**单机优先、数据留在本地**，Windows 与 Android 同一份代码。

## 2. 品牌与气质

- 气质关键词：**克制、通透、有秩序**。不是"炫技"，是"安静地把事办明白"。
- 观感对齐 Apple **Liquid Glass**：四层玻璃（半透明底 + 受光边 + 内顶高光 + 光学层），
  四档画质（流畅 / 高画质 / 超高 / 极致），动效可关 / 默认 / 丰富。
- **色彩配额（硬约束）**：数值与正文用中性色；色相只允许出现在
  「图标 / 色点 / 进度条与图表 / 类型字章」上。一屏几个彩色数字会互相抢注意力。

## 3. 设计令牌（引用真源，不要抄近似值）

官网通过 `@import` 直接引用 `src/styles/tokens.css`；视频工程把同名变量镜像到 `:root`。
**关键值**（亮色档）：

| 组 | 令牌 | 值 |
| --- | --- | --- |
| 画布 | `--bg` | `#f5f5f7` |
| 表面 | `--surface` / `--surface-2` / `--surface-3` | `#ffffff` / `#f2f2f4` / `#ebebed` |
| 文字 | `--text-1` / `--text-2` / `--text-3` | `#1d1d1f` / `#6e6e73` / `#86868b` |
| 主色 | `--accent` / `--accent-strong` / `--on-accent` | `#0062d6` / `#0a5ec2` / `#ffffff` |
| 语义 | `--ok` / `--warn` / `--danger` | `#34c759` / `#ff9500` / `#ff3b30` |
| 三环 | `--c-intake` / `--c-exercise` / `--c-balance` | `#fa114f` / `#92e82a` / `#1eeaef` |
| 宏量 | `--c-protein` / `--c-carb` / `--c-fat` | `#34c759` / `#ff9f0a` / `#ffcc00` |
| 玻璃 | `--glass-fill` / `--glass-blur` / `--glass-sat` | `rgba(255,255,255,.52)` / `28px` / `180%` |
| 圆角 | `--radius-s/m/l/xl/full` | `10 / 14 / 22 / 28 / 999` px |
| 阴影 | `--shadow-card` / `--shadow-float` | 见 tokens.css |
| 字体 | `--font` | `-apple-system, 'SF Pro Display', 'Segoe UI', system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif` |
| 字号 | `--fs-display-xl…--fs-micro` | 84 / 56 / 44 / 40 / 34 / 32 / 26 / 21 / 19 / 17 / 15 / 14 / 13 / 12 / 11 |
| 缓动 | `--ease-out` / `--ease-standard` / `--ease-spring` / `--ease-sheet` / `--ease-liquid` | 见 tokens.css |
| 时长 | `--dur-fast` / `--dur-base` / `--dur-sheet` / `--dur-slow` | 150 / 250 / 420 / 480 ms |

暗色档：`--bg #000`、`--surface #1c1c1e`、`--text-1 #f5f5f7`、`--accent #0a84ff`。
官网与视频**默认亮色**，可用深色分区做节奏（暗场用 `--hero-*` 那组轨迹剧场值：
`--hero-bg #0b0b0e`）。

## 4. 动效规则

- 默认标准曲线；**进出同路径**（从哪进就从哪出）；按压反馈落在 `:active`。
- 缓动一律取令牌；不得自造贝塞尔。
- 视频里的"爆点"节奏：**每 2s 一个信息单元** = 进入（≈0.5s）→ 停留（≈1.0s）→ 退出（≈0.5s）。
  爆点之间共享同一条缓动族，转场不许出现硬切（除非是刻意的场景切换，用 `--dur-sheet`）。
- 可动的东西：位移、缩放、透明度、模糊、颜色、数字滚动、进度环填充、条形增长。
- 不许动的东西：字号突变、布局属性（宽高/边距）逐帧改（会重排、会掉帧）。

## 5. 文案口径

- 中文为主，与 `RELEASE_NOTES.md` / README 的用词一致（如「练够分」「一日脊柱」「画质档位」）。
- 只讲**用户看得见的能力**，不写文件名 / 函数名 / e2e 这类工程词。
- 结构偏爱：先给**事实/结论**，再给入口。句式短，动词开头。
- 英文点缀可用（Rein / AI），不整句英文。

## 6. 视觉资产

- 桌面：`docs/screens/desktop-home.png`、`desktop-nutrition.png`、`desktop-ledger.png`。
- 手机：`docs/screens/mobile-home.png`、`mobile-ledger.png`（430×932 出厂尺寸）。
- 桌面工作台高清：`docs/design/desktop-2026-10/_workbench-*.png`。
- 用法：官网直接把截图放进设备框（圆角 + 玻璃高光 + 落影），不重绘 UI；
  视频可把截图作为"屏内内容"，外面套与 App 同一套玻璃壳。

## 7. 反例（看到就打回）

- 紫色渐变 SaaS 落地页、emoji 当图标、居中大标题 + 三列通用卡片堆砌。
- 视频里出现与 App 无关的素材、无品牌的模板转场、超过 2s 不动的画面。
- 用了 `#007aff`/自定义蓝而不是 `--accent`；用了非令牌圆角（如 `12px` 圆角配手机卡）。
- 玻璃只有 blur 没有受光边（那不是 Rein 的液体玻璃，是一层糊）。
