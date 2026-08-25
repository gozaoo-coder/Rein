# 肌群图素材来源

## 当前使用（医科解剖教科书风，src/assets/muscles/med/）

- **底图与肌群层**：wger 项目（[flutter 仓库](https://github.com/wger-project/flutter) `assets/images/muscles/`），
  原始绘图为 OpenStax / Tomáš Kebert (umimeto.org)，发布于
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Muscles_front_and_back.svg)，**CC BY-SA 4.0**。
  肌群 id 对应：1 肱二头 / 2 三角肌(前) / 3 前锯肌 / 4 胸大肌 / 5 肱三头 / 6 腹直肌 /
  7 腓肠肌 / 8 臀大肌 / 9 斜方肌 / 10 股四头 / 11 腘绳肌 / 12 背阔肌 / 13 肱肌 /
  14 腹斜肌 / 15 比目鱼肌 / 16 竖脊肌。
- **处理管线**：`node scripts/prep-muscles.mjs`（补 viewBox、剥内联 fill/opacity、底图降精度瘦身）
  输出 `src/assets/muscles/med/`；`node scripts/patch-med.mjs` 生成手绘补缺层与侧视图：
  SCM（胸锁乳突肌）、正/背面前臂、背面后束带，以及 side-* 侧视全套（面朝左，与正/背同画布）。
- **原数据**：`front.svg` / `back.svg` / `muscle-*.svg`（原始下载，用于 reprocessing）。

## 备选素材（已评审，未采用）

- **melihcolpan/MuscleMap**（MIT）：平滑男模、正/背 12 组 + 上中下胸/前束细分；
  原数据在 `resources/muscles/male-src/`，构建脚本 `scripts/build-male-muscles.mjs`（可复现）。
- **react-body-highlighter v2**（MIT）：低多边形男模，约 20 组整块。
- **eslamelfateh/react-native-body-parts-anatomy**（MIT）：317 块细分（多片腹斜/前臂等），
  三角肌仍整块，无侧视图。

## 许可

- wger 素材衍生素材沿用 **CC BY-SA 4.0**，需保留本署名。
- 备选素材各自遵循原项目许可证。
