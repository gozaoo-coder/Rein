# 工作单 · 宣传片场景（S-C）

你是 **S-C 动效工程师**。只允许写 `promo/src/scenes/` 下的新文件，不许改
`promo/src/main.js`、`promo/src/brand.css`、`promo/src/lib/`、`promo/render/`、`promo/STORYBOARD.md`。

先读（唯一真源，按顺序）：
1. `promo/STORYBOARD.md` —— **这是分镜脚本，你照着它写**
2. `docs/PROJECT-2026-10/DESIGN-BRIEF.md`
3. `promo/src/scenes/00-brand.js`、`01-pillars.js`、`09-nutrition.js` —— **已完成的范例，照这个模式写**
4. `promo/src/lib/anim.js` —— 可用的确定性工具
5. `promo/src/brand.css` —— 可用的类（.glass/.card/.chip/.bar/.phone/.win/.sheet/.beat-cap/字号类…）

## 你的任务

补齐分镜表里 **02–08 与 10–29 共 26 个爆点**（00 / 01 / 09 已完成，**不要动**）。

每个爆点一个文件 `NN-slug.js` + 同名 `NN-slug.css`（由 JS `import`）：
`at = NN × 2` 秒，`dur = 2`。

## 铁律

1. **确定性**：全局已关掉 CSS transition/animation。所有动效在 `seek(t)` 里写内联样式，
   或用 `createTimeline({ autoplay: false })` + `tl.seek(t * 1000)`。
2. **文字/数字内容用 `lib/anim.js` 自己算**（`seg` / `counter` / `pathD`），
   **不要**指望 anime 把 seek 出来的值写回 `textContent` —— 这是本片最容易翻车的一条。
3. **元素引用用 `el.querySelector(...)`**，绝不用全局选择器（30 个场景同时在 DOM 里）。
4. **视频尺度**：内容区宽 1280–1600px，正文 24–30px，场景标题 56–72px，主数值用 `--fs-display-*`。
   参考：现在 00/01/09 的元素偏小，你新写的要更大、更有分量。
5. **始终有动**：停留段也要有可见的动（呼吸 / 微移 / 光晕 / 数值微动）。
   任何 ≥0.6s 完全静止的段落会被审核打回。
6. **色彩配额**：色相只出现在图标 / 色点 / 进度条与图表 / 类型字章；数值与正文用中性色。
7. **只用令牌**：颜色/圆角/阴影/字号/时长一律 `var(--*)`。
8. 每个场景包含 `<div class="stage-bg">`（暗场场景用 `stage-bg dark`）、可选 `grid-bg`、
   `vignette`、`content`，以及左下角 `<div class="beat-cap"><b>NN</b><span>标签</span></div>`。
9. 进出场必须有：进入 ~0.5s、停留 ~1.0s、退出 ~0.5s（`at` 起算）。
   退场不要和相邻爆点的进入撞成硬切。
10. 素材用 `/shots/*.png`（不要带下划线前缀，已重命名）。

## 自测（必须做，做不到就别提交）

```bash
cd promo
node render/shots.mjs          # 抽 30 张静帧 + 拼贴
```
然后用 `read_file` **逐张看自己负责的静帧**，确认每张都成立（有焦点、有层次、不空不挤），
再修。看不顺眼就改到顺眼为止 —— 你自己就是第一道审核。

最后汇报：写了哪些文件、抽帧看到的整体印象、有哪几个爆点你自己不满意及原因。
