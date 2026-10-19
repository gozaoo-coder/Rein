# 交付说明 · 对外表达三件事（待审批）

> 审批件：**官网构建产物** + **宣传片成片** + **README**。三件都做完并各自过了闸门；
> 审核闭环跑了一轮完整（驳回 → 重改 → 复审），过程与原始裁决全部留档。

## 1. 交付清单

| # | 交付物 | 落点 | 状态 |
| - | --- | --- | --- |
| A | README 优化 | `README.md` | ✅ 已完成 |
| B | 官网 | 源码 `site/`；**产物 `site/dist/`**；审批包 `dist-release/rein-site-0.5.20.zip`（4.8 MB） | ✅ 可挂 Pages |
| C | 宣传片 | 源码 `promo/`；**成片 `promo/out/rein-promo.mp4`**（60.0s / 1920×1080 / 30fps / H.264 / 9.2 MB） | ✅ 已成片 |

支撑材料：计划与工作流 `docs/PROJECT-2026-10/PROJECT-PLAN.md`、设计简报 `DESIGN-BRIEF.md`、
分镜脚本 `promo/STORYBOARD.md`、审核报告 `promo/review/round-1/summary.md`。

## 2. 三件事分别做了什么

### A. README
按「3 秒讲清是什么、30 秒看懂凭什么」重排：加了信息徽章、把功能地图按
**AI / 记录 / 身体 / 时间 / 钱 / 系统** 六组重分、新增文档索引与「官网与宣传片」入口。
顺手修掉两处**与代码不符**的旧表述：桌面断点 1100px → **900px**（真源 `src/config/domain.ts`
的 `DESKTOP_MIN = 900`）、三窗格 → 「导航轨 + 主人区，更宽时展开信息栏」。

### B. 官网（`site/`）
- **与 App 同一套设计语言**：`site/src/styles/site.css` 第一行直接
  `@import '../../../src/styles/tokens.css'` —— 不是抄近似值，是引用真源；页面里所有颜色/圆角/
  阴影/字号/缓动都是 `var(--*)`。
- **液体玻璃按真配方**（半透明底 + 受光边 + 内顶高光 + 光学内层），不是单写一条 `backdrop-filter`。
- 十个区块：玻璃顶栏 / 首屏（设备陈列）/ 它是什么 / AI 系统 / 功能地图 / 多平台 /
  画质与动效 / 本地优先 / 下载 / 页脚；支持浅色与深色。
- **GitHub Pages 就绪**：`base: './'`（相对资产）、单页无 history 路由、`public/.nojekyll`
  （避免 Jekyll 吃掉 `_` 开头资源）。
- 构建：`cd site && npm install && npm run build`（= `tsc --noEmit && vite build`）→
  `index.html 37.3 kB / CSS 21.4 kB / JS 66.0 kB`。
- **实测零 404、零 console 报错**（无头浏览器跑了一遍，证据 `promo/out/site/console.json`）。
- 附一个**手动触发**的部署工作流 `.github/workflows/pages.yml`（`workflow_dispatch`，
  不会在 push 时自己跑）—— 你在仓库设置里把 Pages 的 Source 选成 GitHub Actions，
  点一次 Run workflow 即可；想自己推 `gh-pages` 也行，产物就是 `site/dist/`。

### C. 宣传片（`promo/`）
- **规格**：1920×1080 · 30fps · **60.0s** · **30 个爆点，每 2.0s 一个**（规格要求 50–120s、2s 爆点）。
- **动效框架**：**anime.js v4**（`createTimeline({autoplay:false})` + `seek`）承担单条时间线的编排；
  **motion.dev**（`animate(...).pause()` + 写 `.time`）承担元素级独立弹簧。两者各有用例，
  范例见 `scene/00-brand.js`（anime）与 `01-pillars.js`（motion）。
- **无头浏览器渲染**：页面暴露 `window.__promo.seek(t)`，录制器按 `t = i/fps` **逐帧 seek + 截图**，
  再交给 ffmpeg 编码。这样成片**与机器性能无关** —— 掉帧、卡顿不可能发生。
  代价是全局关掉了 CSS transition/animation，所有动效必须能由时间函数算出来。
- **与 App 同一套令牌**：`brand.css` 直接 `@import` 真源 `tokens.css`。

## 3. 审核闭环（数十名代理）

### 设计与执行
- 花名册 `promo/review/reviewers.json`：**12 个维度 × 3 名独立复评 = 36 名审核员**
  （视觉层级 / 对比度 / 品牌一致性 / 动效节奏 / 构图留白 / 配色纪律 / 字体排印 /
  信息密度 / 叙事结构 / 转场连续性 / 产品还原度 / 细节做工）。
- 每名审核员是一次独立的 `cmdc --yolo` 无头运行：只给它一个维度、一张总览拼贴与分配到的
  爆点静帧，**只看产物**出裁决；同一维度的 3 名复评互不通气，且合起来覆盖全部 30 个爆点。
- 裁决写成结构化 JSON（`verdicts[].{beat,verdict,score,issues[].{severity,what,fix}}`），
  落地在 `promo/review/round-N/raw/`；汇总规则：**任一 blocker = 该镜头驳回**，
  或 ≥1/3 打回也驳回。汇总脚本 `promo/render/review.mjs`，报告 `review/round-N/summary.md`。

### 第 1 轮结果（13/36 名完成裁决 —— 见下方「缺口」）
- 覆盖 30 个爆点、**130 条镜头裁决**；**驳回 14 个爆点**、其中 **4 条 blocker**。
- 裁决质量是**可执行**的，不是"感觉不行"：例如
  - `22-update` blocker：「印章从 1.5 倍缩下来，右缘顶出卡片边界约 65px，
    卡外浮着半透明矩形 + 三角箭头」；
  - `15-score` blocker：「86% 与『优秀』用了绿色文字 —— 违反色彩配额」；
  - `09-nutrition` blocker：「09 顶部整片空白，没有眉标与主标题，02–08 的标题带在这里断掉」；
  - 系统性：「居中大标题 + 三列等高白卡」在 10-recipes / 16-plan / 01-pillars 三处被点名，
    正是设计简报 §7 的反例。
- 原始裁决（含像素坐标与改法）全部留在 `promo/review/round-1/raw/*.json`。

### 已按裁决重改（本轮实际改掉的）
| 爆点 | 裁决 | 改了什么 |
| --- | --- | --- |
| 09-nutrition | blocker | 补上眉标 + 场景标题；右侧面板从 3 行补到 6 行；入画节奏从 1.05s 收到 0.5s（**抽帧抽到的数值与环上数值自相矛盾**，根因就是入画慢）；三环放大到 400px |
| 15-score | blocker | 「优秀」由 `--c-exercise-deep` 改为 `--text-2`（数值与正文一律中性色）；补场景标题 |
| 22-update | 2 blockers | 印章过冲 1.5 → **1.12**（半宽 × 0.12 < 卡片 48px 内边距，元素不再越界）；补场景标题 |
| 19 / 21 / 26 | 系统性 | 补上与 02–08 同基准的场景标题带（21 是暗场，标题走 `--hero-text`） |

重改后重抽 30 张静帧：`promo/out/contact-sheet.jpg`。

### 第 2 轮（复审）
只重审**被驳回并已重改**的 6 个爆点、每人只看 3 张图（请求体小一个数量级）——
这一轮 **29/36 名**产出了裁决，成功率从 36% 提到 81%，反过来印证了第 1 轮的失败确实是**请求太重**。

结论：**6 个都仍未通过，但均分普遍上升**（22-update 5.8→7.4、09 5.6→7.0、15 5.5→6.7），
且新打回的意见质量更高、更具体 —— 从「观感」推进到了**产品口径**：

- `09-nutrition`：写完「运动加回 +412」，同一屏又写「剩余 1053」= 2000−947，
  把刚写的 +412 整个丢了；且词序应为产品的「运动加回」而不是「运动加成 / 回加」；
  图例不该带数字（产品注释写明同一个量报两遍会被误读成另一件事）。
- `15-score`：「优秀」这个档名**在产品里根本不存在**（`config/muscles.ts` 六段档名里
  75–89 是「足够」）；「三大肌群覆盖 86%」也是虚构口径（产品按 10 组肌群评估）。
- `19-ledger`：5,000 − 3,224 = 1,776，画面写 1,750（差 26 元）；且产品把预算画成
  **线性进度条**、环留给「分类占比」，本镜把两者的形态对调了。
- `22-update`：卡上的 App 图标是自造的「浅蓝底箭头」，与片头片尾的「蓝底白 R」是两个 Rein 标记。
- 系统性：`09/15/19` 的标题里全角逗号后面都留下一个 **26px 空洞**（逐列投影量出来的）。

### 第二次重改（已做）
| 爆点 | 改了什么 |
| --- | --- |
| 09-nutrition | 按产品算法重算：上限 = 2000 + 412 = **2412**、剩余可吃 = **1465**；词序改「运动加回」；图例去掉数字；外环按真实比例 39% 画；主读数恢复「947 / 2412 大卡」一行；顺带修掉一个**我自己引入的 bug**（选择器没命中，`<circle>` 默认黑填充把三环糊成一个黑圆盘 —— 现已把 `fill="none"` 写成属性，不再依赖选择器） |
| 15-score | 档名「优秀」→ 产品的「**足够**」；注脚改成产品口径「本周 5 次训练 · 10 组肌群中 3 组不足」 |
| 19-ledger | 「剩余 1,750」→「可用结余 **1,776**」，账先配平 |
| 22-update | 图标换成片头片尾那一枚「蓝底白 R」；去掉 `ed25519 / 仓库公钥` 这类工程词；印章落位去掉缩放过冲（两张章是 flex 等宽并列，任何 >1 的缩放都会让它们在缝上叠起来） |
| 全片 | `.k-title` 加 `text-spacing-trim: trim-both`，治中文标点挤压（不认这条的内核当未知属性忽略，纯增益） |

重改后已重新出片：`promo/out/rein-promo.mp4`（60.0s / 1920×1080 / 30fps / 9.2 MB）。

## 4. 缺口与如实说明（重要）

1. **审核员完成率**：第 1 轮 36 名里只有 **13 名**产出了裁决，第 2 轮 **29 名**。
   失败原文是 `Error: Unable to connect to the API`，留在 `promo/review/round-N/raw/*.log`。
   排查过程：先用 `cmdc -p "PING_OK"` 证明网关本身可达（单次小请求成功），再逐级降载 ——
   并发 8 → 4 → 3 → **1**、把审核用图从 1080p 降到 720p、把审核员要读的文件从 3 份减到 2 份、
   让每人只看 3 张图。**串行也一样失败，请求轻下来才成功** —— 说明瓶颈是
   「重型多模态无头运行」这种请求形态本身被限流，不是并发数、也不是本机性能。
   第 2 轮 81% 的成功率是这条判断的直接证据。
2. **第 2 轮 6 个爆点仍未通过**：已按意见改了一轮（见上表），但没有再跑第 3 轮复审 ——
   每轮要几小时，我把剩余改法与证据都留档了，是否继续由你定。
   建议的下一步优先级：`21-sync`（右侧设备是空壳骨架、三条链路与标签对不上）、
   `26-workbench`（一屏四个焦点 + 浮卡与截图内容重复）、`19-ledger`（三列等宽卡是设计简报点名的反例）。
3. **第 1 轮其它驳回项尚未重改**：04 / 05 / 10 / 11 / 13 / 16 / 18 / 23 / 25 的 major 项，
   改法逐条写在 `round-1/summary.md` 里。优先建议 `11-todo` 与 `23-apis`（"有线框没内容"最伤观感）。
4. **成片无声**：本轮没有配乐与音效（没有可用音源，也不该凭空生成）。
   成片是纯画面轨，加音乐只需在 `render/record.mjs` 的 ffmpeg 那一步补一个 `-i 音乐 -shortest`。
5. **01-pillars 尺度偏小**：第 1 轮就被判「元素尺度不是视频尺度、三卡等权无主次」，
   我保留了原样（它是最早写的范例），改法已写在报告里。

## 5. 闸门

| 闸门 | 结果 |
| --- | --- |
| `npm run typecheck`（根工程 TS） | ✅ 通过 |
| `npm run contract`（IPC 契约三方一致） | ✅ Rust 286 / services 286 / mock 286 |
| `npm run lint` | ✅ 0 error（10 warning，均在 `src/mock/server.ts`，属仓库既有 WIP，非本次改动） |
| `cd site && npm run build` | ✅ 通过 |
| `cd promo && npm run build` / `npm run shots` / `npm run video` | ✅ 通过 |
| 官网零 404 / 零 console 报错 | ✅ 实测 |

本次改动**没有触碰** `src/`、`src-tauri/` 与其它在改的文档；新增的都是独立目录
（`site/`、`promo/`、`docs/PROJECT-2026-10/`）与两个文件（`README.md`、`.github/workflows/pages.yml`）。

## 6. 审批后怎么发

```bash
# 官网 → GitHub Pages
cd site && npm install && npm run build      # 产物 site/dist
# 二选一：
#   a) 仓库设置把 Pages Source 设为 GitHub Actions，然后手动跑 .github/workflows/pages.yml
#   b) 把 site/dist 的内容推到 gh-pages 分支

# 宣传片
cd promo && npm install && npm run video      # → promo/out/rein-promo.mp4
```
