# Rein 宣传片工程

用**无头浏览器逐帧渲染**出来的宣传片：1920×1080、**60fps**、60s、**每 2s 一个爆点**（30 个），
带一条**卡点配乐 + 音效**。
动效来自 **anime.js v4** 与 **motion.dev**；设计令牌直接 `@import` App 的
`src/styles/tokens.css`，所以这条片子与产品共用同一份颜色 / 圆角 / 阴影 / 缓动。

## 目录

```
promo/
├─ index.html            # 舞台（1920×1080）
├─ STORYBOARD.md         # 分镜脚本：30 个爆点逐个的意图与关键动效
├─ src/
│  ├─ main.js            # 主时钟：window.__promo = { duration, seek(t), beats, ready }
│  ├─ brand.css          # 令牌桥 + 舞台基座 + **编辑版式头带 + 版心栅格**
│  ├─ lib/anim.js        # 确定性动效基元（seg / counter / pathD / enter …）
│  └─ scenes/            # NN-slug.js + NN-slug.css，一个文件一个爆点
├─ render/
│  ├─ browser.mjs        # 找 chromium / Edge / Chrome，起上下文
│  ├─ serve.mjs          # 把 dist/ 挂在临时端口
│  ├─ music.mjs          # 卡点配乐：纯 Node 确定性合成 → wav + mid
│  ├─ record.mjs         # 逐帧 seek + 截图 + ffmpeg 编码（混音）
│  ├─ shots.mjs          # 抽每个爆点的静帧 + 拼贴 + 审核 manifest
│  └─ review.mjs         # 多代理审核闭环（spawn cmdc --yolo）
├─ review/reviewers.json # 审核员花名册（12 个维度 × 3 名复评）
└─ out/                  # 产物：rein-promo.mp4 / .wav / .mid / beats/ / contact-sheet.jpg
```

## 为什么是「逐帧」而不是「录屏」

页面暴露 `window.__promo.seek(t)`，录制时按 `t = i / fps` 逐帧 seek 再截图。
于是**同一时刻永远得到同一画面** —— 与机器性能、掉帧、后台负载全都无关。
代价是不能用 CSS transition/animation（`brand.css` 全局关掉了），
所有动效必须能由时间函数算出来；文字与数字内容因此用 `lib/anim.js` 自己算。

## 命令

```bash
npm install

npm run dev          # 浏览器预览（加 ?play 让它自己跑一遍）
npm run shots        # 抽 30 张静帧 + 拼贴 + review-manifest.json
npm run music        # 配乐 → out/rein-promo.wav + out/rein-promo.mid
npm run video        # 出片（60fps，自动先渲配乐） → out/rein-promo.mp4
npm run video:fast   # 30fps 快出（调版式时用）
npm run video:silent # 静音出片（不带配乐）
npm run review       # 数十名审核员出裁决 → review/round-N/summary.md

node render/record.mjs --fps=60 --scale=1                # 参数见 record.mjs 头部
node render/record.mjs --from=6 --to=12 --keep-frames    # 只渲一段、保留帧
node render/review.mjs --dry-run --limit=3               # 先看审核排班
```

> 逐帧渲染是**与帧率无关**的：同一份代码在 30fps 与 60fps 下画的是同一条时间曲线，
> 60fps 只是把同一段运动采样得更密（1800 → 3600 帧）。所以「提升细腻度」= 把采样率提上去
> ＋ 让离散状态切换（换行、切档）也走插值，而不是硬切。

## 依赖

- **anime.js v4**：单条时间线的编排（`createTimeline({ autoplay:false })` + `seek`）。
- **motion.dev**：给单个元素一条可独立 seek 的播放（`animate(...).pause()`，seek 写 `.time`）。
- **playwright-core**：驱动本机已有的 Chromium / Edge / Chrome（不下载浏览器）。
- **ffmpeg**：帧序列 → H.264 mp4（`-crf 16 -preset slow -pix_fmt yuv420p +faststart`）。

## 加一个爆点

1. 在 `src/scenes/` 加 `NN-slug.js`（`at = NN × 2`）与 `NN-slug.css`；
2. 导出 `createScene()`，返回 `{ id, label, at, dur, el, seek(t) }`；
3. `main.js` 用 `import.meta.glob` 自动收编，不用改注册表；
4. 在 `STORYBOARD.md` 的表里补一行（那是脚本，也是审核的依据）。
