# 动作库种子来源与许可

`resources/exercises.json` 是**生成物**，由 `node scripts/gen-exercises.mjs` 写出，输入有两份：

| 输入 | 内容 | 许可 / 说明 |
|---|---|---|
| `scripts/gen-exercises.mjs` 的 SPEC 表（手写） | 60 个内置动作：中文名、别名、分类、器材、**显式肌群激活表**、要点；处方与要点优先取课程种子 `resources/workout_plans.json` 第一次出现的位置 | 本项目原创 |
| `scripts/catalog/dataset.mjs`（生成物）+ `scripts/catalog/dataset-selection.mjs`（手写精选表） | exercises-dataset 的精选子集：中文名、别名、分类、器材、评审过的肌群表、手写要点，以及数据集的中文分步说明（`steps`） | 数据与说明文本 **MIT**（见下） |

## 许可与署名

- **exercises-dataset**（<https://github.com/hasaneyldrm/exercises-dataset>，1,324 个动作 / 10 语言）：
  数据、结构、说明文本为 **MIT**。本项目只导入「精选子集」的中文名（自行撰写）、
  肌群表（自评审）与 `instruction_steps.zh`（**机器翻译**，仅作分步说明素材，随条目人工过审）。
- **媒体一律不导入**：该仓库的 180×180 缩略图与动画 GIF 为 **© Gym visual**，仓库原文要求
  「reuse the media 前自行到 gymvisual.com 取得授权」——授权到手之前不进本仓库、不进安装包。
- 中文名与要点由本项目撰写；肌群档位（主攻/辅助/稳定）是**本项目的评审结论**，
  不采用数据集粗粒度的 `target` / `secondary_muscles`（它没有上/下胸、没有三角肌三束）。

## 转换管线（新增条目怎么做）

```bash
# 1) 取数据集原件（12.9 MB，不入库：.gitignore 已忽略 resources/_dataset/）
curl -L -o resources/_dataset/exercises.json \
  https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/data/exercises.json

# 2) 在 scripts/catalog/dataset-selection.mjs 里加一条（中文名 + 评审过的 muscles + tips）
#    没写 muscles 的条目会先用 scripts/catalog/muscle-terms.mjs 的映射生成草稿并给出警告

# 3) 生成目录与评审草稿
node scripts/import-dataset.mjs --src resources/_dataset/exercises.json

# 4) 人工过审 resources/_review/dataset-review.json（草稿 vs 评审结果、中文分步说明）
#    把结论回填 dataset-selection.mjs，再重跑 2~3

# 5) 合并进种子
node scripts/gen-exercises.mjs
```

硬约束（任一不满足即报错）：中文名必填且唯一、肌群键必须属于 `MUSCLE_KEYS`（39 键）、
档位只能是 1/2/3、id/名不得与手写 SPEC 冲突、`steps` 最多 12 步且单步 ≤200 字。
