# 肌群图素材来源

## 当前使用（BodyParts3D 真实解剖网格投影，src/assets/muscles/rein/）

三视图（front / back / side）不再是手绘控制点，而是**由真实人体解剖数据投影生成**：

- **数据来源**：**BodyParts3D 4.0**（IS-A 树，多边形削减率 99%）
  - 下载：<https://dbarchive.biosciencedbc.jp/jp/bodyparts3d/download.html>
  - 归档 `isa_BP3D_4.0_obj_99.zip`（136 MB / 2234 个 OBJ）
  - 建模对象：**成年男性**全身三维模型；每块肌肉是一个独立网格，命名取自 FMA
- **许可**：**CC BY 4.0**（2025/02/27 由 CC BY-SA 2.1 JP 升版）
  - 署名要求：`BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International`
  - 无传染性条款，可随本项目分发衍生 SVG
- **生成流程**：
  1. `node scripts/fetch-anatomy.mjs`
     只取本项目用到的 ~150 个网格。归档支持 Range 请求，脚本先读 ZIP 中央目录拿到
     各条目偏移，再按需取「本地头 + 压缩数据」局部解压，实际流量约 15 MB 而非 136 MB。
     产物落在 `resources/anatomy/meshes/`（已 gitignore）。
  2. `node scripts/build-anatomy.mjs`
     正交投影 → 栅格化 → 等值线追踪（marching squares）→ Douglas–Peucker 简化；
     三个视图共用同一套解剖比例，因此等大对齐；分区以 `<g data-m="肌群键">` 表达。
- **坐标与投影**：X = 左(+)/右(−)，Y = 前(−)/后(+)，Z = 上(+)；身高约 1719 mm。
  正面视线 +Y、背面 −Y、侧面 −X（从受试者左侧看，面朝左），三视图均为等大正投影。
- **层叠**：画家算法 —— 每个分区按观察深度排序，远的下、近的上。
  深层肌群同样被画出来，只是被浅层盖住，因此「隐去浅层」即可看到真实深层结构。
- **分区粒度**：26 个肌束级分区，与 `src/config/muscles.ts` 的 `MuscleKey` 一一对应。
  其中三角肌前/中/后束直接对应 FMA 的 **clavicular / acromial / spinal part of deltoid**，
  胸大肌上/下束对应 **clavicular part / sternocostal + abdominal part of pectoralis major**，
  斜方肌上/中/下束对应 **descending / transverse / ascending part of trapezius** ——
  细分来自解剖本体而非人为切分。
- **额外**：另绘制 15 组真实深层结构（肩袖、臀小肌、髂腰肌、股中间肌等），
  以 `class="a"` 标记，只作解剖填充、不参与高亮，隐去浅层后可见。
- **校验**：`node scripts/e2e-muscle-map.mjs`（无头浏览器，断言三视图分区齐备、
  分区路径无内联 fill、浅层/深层标注与开关、单束高亮不影响相邻束）。

### 两个数据缺口：背阔肌与腹直肌

BodyParts3D 在 IS-A 与 PART-OF 两棵树上**都没有** `latissimus dorsi` 与
`rectus abdominis`（已对 4.0 全量清单逐条核对），而这两块在健身场景里很关键。
`scripts/build-anatomy.mjs` 因此按**相邻真实结构的边界**推导它们：

- **腹直肌**：体表轮廓 ∧ 腹斜肌所跨层面 ∧ |X| ≤ 腹斜肌内缘，再减去腹斜肌与胸大肌。
- **背阔肌**：体表轮廓 ∧ 腰背层面（大圆肌上界 → 臀大肌下界）∧ |X| ≤ 邻接结构外缘，
  再减去斜方肌、竖脊肌、腹斜肌、臀大肌、大圆肌。

逐行的边界都取自相邻网格的实际像素，因此形状仍跟着真实解剖走；这两块会在
`SOURCE.md` 与本说明里明确标注为「推导」而非直出。

## 备选素材（已评审，未采用）

- **wger 项目**（CC BY-SA 4.0，源自 OpenStax / Tomáš Kebert）：医科解剖教科书风，
  原始下载仍在 `resources/muscles/`。
- **@lucawahlen/human-muscle**（MIT）：插画级男女人体，正/背两视图，20 组整块；
  无侧视图、无深层数据，解剖轮廓为绘制而非投影。
- **melihcolpan/MuscleMap**（MIT）：平滑男模、正/背 12 组；原数据在
  `resources/muscles/male-src/`，构建脚本 `scripts/build-male-muscles.mjs`。
- **react-body-highlighter v2**（MIT）：低多边形男模，约 20 组整块。
- **eslamelfateh/react-native-body-parts-anatomy**（MIT）：317 块细分，
  三角肌仍整块、无侧视图。

## 许可

- `src/assets/muscles/rein/` 衍生自 BodyParts3D，**沿用 CC BY 4.0**，需保留署名：
  `BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International`
- 备选素材各自遵循原项目许可证（wger 衍生素材沿用 **CC BY-SA 4.0**，需保留署名）。
