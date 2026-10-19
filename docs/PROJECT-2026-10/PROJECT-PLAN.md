# 项目计划 · 对外表达三件事（README / 官网 / 宣传视频）

> 交付对象：Rein 0.5.20 的对外表达层。三条工作流并行，共享同一份设计语言。
> 本文件是**运转规则**（谁做什么、边界在哪、什么算完成）；视觉与文案口径见
> [DESIGN-BRIEF.md](./DESIGN-BRIEF.md)。两份都要先读完再动手。

## 1. 目标与交付物

| # | 交付物 | 落点 | 完成判据 |
| - | --- | --- | --- |
| A | README 优化 | `README.md` | 首屏 3 秒讲清「这是什么/给谁/凭什么」；信息层级重排；所有相对链接可达；与官网口径一致 |
| B | 官网 | `site/`，产物 `site/dist/` | 与 App 同一套设计令牌；`npm run build` 通过；`dist/index.html` 可直接静态托管（GitHub Pages 子路径可用） |
| C | 宣传视频 | `promo/`，成片 `promo/out/rein-promo.mp4` | 1920×1080、50–120s、每 2s 一个爆点、动效来自 motion.dev + anime.js v4；无头浏览器逐帧渲染 |

## 2. 组织与角色

- **PM / 架构（主代理）**：定规格、切边界、集成、跑闸门、下裁决、打包审批件。
- **实现流（`cmdc -p … --yolo` 子代理，并行）**：
  - `S-A README 作者` — 只写 `README.md`。
  - `S-B 官网工程师` — 只写 `site/**`，可读 `src/styles/`、`docs/screens/`、`docs/design/`。
  - `S-C 动效工程师` — 只写 `promo/**`，可读 `src/styles/tokens.css`。
- **审核流（`cmdc -p … --yolo` 子代理群，数十名）**：按镜头 / 视效 / 一致性维度独立出裁决，
  只读产物、写 `promo/review/**` 与 `site/review/**` 的报告，不改产品代码。

## 3. 工作流

```
P0 规格        PM 写 PROJECT-PLAN + DESIGN-BRIEF                    ← 唯一真源
P1 并行实现    S-A / S-B / S-C 三条流互不写同一文件
P2 集成        PM 装依赖、构建官网、渲染视频、修集成问题
P3 审核闭环    数十名审核子代理 → 裁决 JSON → 汇总
                 └─ 有 REJECT → 回到对应实现流修复 → 重渲染 → 复审（≤3 轮）
P4 验收打包    PM 跑全量闸门 → 审批包（dist + mp4 + 审核报告）
```

## 4. 文件边界（并发安全）

并行流**禁止**写别人的路径。跨流只读。

| 流 | 可写 | 只读 |
| - | --- | --- |
| S-A | `README.md` | 其余全部 |
| S-B | `site/**` | `src/styles/tokens.css`、`docs/screens/**`、`docs/design/**`、`index.html` |
| S-C | `promo/**` | `src/styles/tokens.css`、`docs/screens/**` |
| 审核 | `promo/review/**`、`site/review/**` | 产物与规格 |

**不得触碰现有仓库工作区未提交的改动**（`src/`、`src-tauri/`、`docs/*.md` 的在改文件）。

## 5. 质量闸门（P4 必须全绿）

```bash
npm run typecheck   # 根工程 TS（site/ 与 promo/ 有各自 tsconfig，不进根闸门）
npm run lint        # 只扫 src/
npm run build       # 根工程前端构建（回归，确保没被牵连）
npm run contract    # IPC 契约三方一致（回归）
cd site  && npm run build          # 官网构建
cd promo && npm run build:video    # 视频渲染（node render/record.mjs）
```

官网另需人工/自动核验：`site/dist/index.html` 用 `file://` 或静态服务器打开无 404、
资源全部内联或同目录、无外链硬编码绝对路径（Pages 子路径兼容）。

## 6. 审核闭环规则（数十名代理）

- 审核员按**维度 × 独立复评**铺开（同一维度至少 3 名互不通气，避免单点口味）。
- 每名审核员必须返回**严格 JSON**：
  ```json
  { "reviewer": "…", "lens": "…", "beat": "…", "verdict": "pass|reject",
    "score": 0-10, "issues": [{ "severity": "blocker|major|minor", "what": "…", "fix": "…" }] }
  ```
- 汇总规则：**任一名审出 blocker = 该镜头/区块被驳回**；≥1/3 打 reject = 复审。
- 驳回项必须有明确的 `what`（现象）与 `fix`（改法），否则视为无效裁决、不入账。
- 复审只重审被驳回的镜头与受影响的相邻镜头（转场是共享的），不全量重跑。

## 7. 风险与止损

| 风险 | 止损 |
| --- | --- |
| 并行子代理改同一文件 | §4 边界表；PM 集成时 `git status` 核对 |
| 视频动效不可确定性 seek（录出来对不上） | 所有动画由**单一 master timeline**驱动，页面暴露 `window.__promo.seek(t)`；DOM 状态只由它决定 |
| 逐帧渲染磁盘爆掉 | 帧写临时目录、编码后立即清理；30fps |
| 官网在 Pages 子路径 404 | Vite `base: './'`（相对资产），单页无 history 路由 |
| 审核代理成本失控 | 审核并发限流；复审只针对驳回项；轮次上限 3 |
