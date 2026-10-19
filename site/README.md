# Rein 官网

Rein 的对外单页站点：Vite + TypeScript，纯静态产物，可直接挂到 GitHub Pages 的子路径。

## 它和 App 共用一份设计语言

页面**不复制颜色值**，而是直接引用设计令牌真源：

- `src/styles/site.css` 第一行 `@import '../../../src/styles/tokens.css';`
- 颜色、圆角、阴影、字号、时长、缓动一律写成 `var(--*)`，与 App 是同一套值。
- 因此 `vite.config.ts` 里设了 `server.fs.allow: ['..']`，开发服务器要能读到 `site/` 之外的这一个文件。
- 液体玻璃复现的是四层配方（半透明底 + 受光边 + 内顶高光 + 光学内层），不是单写一条 `backdrop-filter`。

页面支持浅色与深色，跟随系统 `prefers-color-scheme`，无需额外开关。

## 开发

```bash
cd site
npm install
npm run dev        # http://localhost:5173
```

## 构建

```bash
npm run build      # tsc --noEmit && vite build
npm run preview    # 本地预览 site/dist
```

产物在 `site/dist/`。版本号从仓库根的 `package.json` 的 `version` 在构建时注入，页面上所有
`[data-version]` 会自动填成 `v<version>`。

## 发布到 GitHub Pages

因为站点要落在 `https://<user>.github.io/<repo>/` 这种**子路径**下，`vite.config.ts` 里：

- `base: './'` —— 所有资产走相对路径；
- 站点是**单页、无 history 路由**，不引入 vue-router 之类。

任意静态托管都直接吃 `site/dist/`：

```bash
# 本地起一个静态服务器看一眼
node -e "const h=require('http'),f=require('fs'),p=require('path');h.createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);if(u.endsWith('/'))u+='index.html';const t=p.join('dist',u);f.readFile(t,(e,d)=>{if(e){s.writeHead(404);s.end('404');return}s.end(d)})}).listen(4173)"
```

GitHub Pages：把 `site/dist/` 的内容推到 `gh-pages` 分支（或作为 Pages 的发布目录）即可；
`public/.nojekyll` 会一起进产物，避免下划线开头的资源被 Jekyll 忽略。

## 结构

```
site/
├─ index.html            # 语义化单页（无前端路由）
├─ vite.config.ts        # base: './'，注入版本号，允许读上层令牌
├─ tsconfig.json
├─ public/
│  ├─ .nojekyll
│  └─ shots/             # 真实截图（设备框内直接放，不重绘 UI）
└─ src/
   ├─ main.ts            # 滚动显形 / 玻璃导航受光边 / 数字滚动 / 分区高亮
   └─ styles/site.css    # @import 真源令牌 + 站点样式
```

## 素材

`public/shots/` 里的截图取自 App 的真实界面（桌面工作台、手机端、记账、营养等）。
替换时保持文件同名即可，页面用相对路径 `/shots/<name>.png` 引用。
