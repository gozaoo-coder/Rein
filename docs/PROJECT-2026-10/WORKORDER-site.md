# 工作单 · 官网（S-B）

你是 **S-B 官网工程师**。只允许写 `site/**`（`site/public/` 已备好素材），
不许动 `src/`、`src-tauri/`、`docs/`、`promo/`、`README.md` 以及任何根级配置文件。

先读（唯一真源）：
- `docs/PROJECT-2026-10/PROJECT-PLAN.md`
- `docs/PROJECT-2026-10/DESIGN-BRIEF.md`
- `src/styles/tokens.css`（**设计令牌真源，直接引用，不要抄近似值**）

## 交付物

`site/` 是一个**独立的 Vite 静态站点**，产物 `site/dist/` 可直接挂到 GitHub Pages。

```
site/
├─ package.json        # name: rein-site, private, type: module
├─ vite.config.ts      # base: './'  ← Pages 子路径必须相对
├─ tsconfig.json
├─ index.html          # 语义化单页，无前端路由
├─ public/
│  ├─ .nojekyll        # 已存在，别删
│  └─ shots/           # 已备好的真实截图，不要重绘 UI
├─ src/
│  ├─ main.ts          # 交互：滚动显形、玻璃导航、数字滚动
│  └─ styles/site.css  # @import 真源令牌 + 站点样式
└─ README.md           # 怎么开发 / 怎么构建 / 怎么发 Pages
```

## 硬性技术约束

1. **base 必须是 `'./'`**（相对资产路径），因为要挂在 `https://<user>.github.io/<repo>/` 子路径。
   站点是**单页、无 history 路由**，不许引入 vue-router 之类。
2. **令牌来自真源**：`site/src/styles/site.css` 第一行
   `@import '../../../src/styles/tokens.css';`
   并在 `vite.config.ts` 里设 `server.fs.allow: ['..']`。颜色/圆角/阴影/字号/时长**一律 var(--*)**，
   出现魔法色值直接算不合格。
3. **液体玻璃要复现真配方**，不能只写 `backdrop-filter: blur()`。正确配方（四层）：
   ```css
   .glass {
     border: 1px solid transparent;
     background:
       linear-gradient(var(--glass-fill), var(--glass-fill)) padding-box,
       linear-gradient(to bottom, var(--glass-rim-hi), var(--glass-rim-lo) 70%) border-box;
     backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
     box-shadow: var(--glass-shadow), inset 0 1px 0 var(--glass-sheen),
                 inset 0 10px 18px -12px var(--glass-sheen);
   }
   ```
4. 依赖：`vite` / `typescript` 之外只加 `motion`（motion.dev，用于滚动显形与微交互）。
   加完依赖记得能 `npm install && npm run build` 跑通。
5. `npm run build` 必须成功，且产物**零 404**：所有引用走相对路径或 `public/` 下的资源。
6. 响应式：≥1100px 桌面三窗格观感、≤480px 手机单列，中间不断裂。
7. 支持浅色与深色（令牌自带 `prefers-color-scheme` 两档，别写死亮色）。

## 页面结构（按此顺序）

1. **顶栏**（玻璃）：logo「Rein」+ 分区锚点 + 「下载」主按钮。滚动时玻璃受光边出现。
2. **首屏**：`全能生活助理` 大标题 + 一句话定位 + 两枚 CTA（下载 / 看功能）+ 设备陈列
   （桌面窗口用 `shots/desktop-home.png`，手机用 `shots/mobile-home.png`，套 `.win` / `.phone` 外壳）。
3. **它不是什么，它是什么**：三柱 —— **它读得到 / 它能动手 / 它会沉淀**（用 DESIGN-BRIEF §1 的口径）。
4. **AI 系统**：6 张能力卡（自带模型 / 对话即操作 / 卡片式产物 / 知识库向量检索 / 长期记忆 / 语音对话）。
5. **功能地图**：按 AI / 记录 / 身体 / 时间 / 钱 / 系统 六组，每组若干条目（图标 + 名称 + 一句能做什么）。
   色相只用在图标上（STANDARDS §4 色彩配额）。
6. **多平台**：桌面三窗格 vs 手机单列并排对照（用真实截图）。
7. **画质与动效**：四档（流畅 / 高画质 / 超高 / 极致）与动效三档（关 / 默认 / 丰富），做成简洁对照。
8. **本地优先**：单机 SQLite、多设备端到端加密同步、更新双验签 —— 三条信任声明。
9. **下载 / 发布**：版本号取 `package.json` 的 `version`（构建时注入或写死当前值均可）+ 平台入口。
10. **页脚**：文档索引、GitHub、许可证说明（注明食物营养值为演示参考值）。

## 文案口径

- 与 `README.md` / `RELEASE_NOTES.md` 用词一致（练够分 / 一日脊柱 / 画质档位 / 卡片产物）。
- 只讲用户看得见的能力，不写文件名、函数名、e2e、typecheck 这类工程词。
- 反例（看到就打回）：紫色渐变 SaaS 风、emoji 当图标、三列通用卡片堆砌、居中大标题 + 三行小灰字。

## 完成判据

- `cd site && npm install && npm run build` 成功，`site/dist/index.html` 存在。
- 用 `node` 起一个静态服务器打开 `site/dist`，目视：无 404、布局成立、玻璃有受光边。
- 汇报：文件清单 + 构建输出大小 + 你怎么自测的。
