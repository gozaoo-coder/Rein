# 肌群图素材来源

## 当前使用（自绘三视图，src/assets/muscles/rein/）

三视图（front / back / side）为**自行描线的原创资产**，不再使用第三方解剖素材：

- **描线来源**：无限画布（`ghcr.io/basketikun/infinite-canvas`，本地 `http://localhost:8091/canvas`）
  中的男性肌肉体型三视图参考图（正面 / 侧面 / 背面）。
- **生成方式**：`node scripts/build-anatomy.mjs`
  - 控制点按参考图像素坐标逐个测出（逐行扫描剪影 + 局部放大读肌缝）；
  - 只写左半身、右半身镜像，保证左右绝对对称；
  - 相邻分区共享同一组边界点（自同一条边链切片），**不重叠、不留缝**；
  - 输出统一 `viewBox 0 0 660 1500`，三视图等大对齐；分区以 `<g data-m="肌群键">` 表达。
- **体格设定**：成年男性肌肉体型；髋部以衣物分区覆盖，不暴露生殖器官。
- **分区粒度**：26 个肌束级分区（三角肌前/中/后束、胸大肌上/下束、斜方肌上/中/下束、
  股四头分股外侧/股直/股内侧、小腿分腓肠肌/比目鱼肌/胫骨前肌等），可单独高亮。
- **校验**：`node scripts/e2e-muscle-map.mjs`（无头浏览器，断言三视图分区齐备、
  分区路径无内联 fill、单束高亮不影响相邻束、底图含衣物分区）。

## 备选素材（已评审，未采用）

- **wger 项目**（CC BY-SA 4.0，源自 OpenStax / Tomáš Kebert）：医科解剖教科书风，
  原始下载仍在 `resources/muscles/`，处理脚本见 git 历史（`prep-muscles.mjs` / `patch-med.mjs`）。
- **melihcolpan/MuscleMap**（MIT）：平滑男模、正/背 12 组 + 上中下胸/前束细分；
  原数据在 `resources/muscles/male-src/`，构建脚本 `scripts/build-male-muscles.mjs`（可复现）。
- **react-body-highlighter v2**（MIT）：低多边形男模，约 20 组整块。
- **eslamelfateh/react-native-body-parts-anatomy**（MIT）：317 块细分（多片腹斜/前臂等），
  三角肌仍整块，无侧视图。

## 许可

- `src/assets/muscles/rein/` 为自行绘制，随本项目授权。
- 备选素材各自遵循原项目许可证（wger 衍生素材沿用 **CC BY-SA 4.0**，需保留署名）。
