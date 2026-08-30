# Rein · 健康生活运动管理

Tauri 2 + Vue 3 + Rust（SQLite）桌面应用，苹果风格。记录饮食、追踪能量与营养、管理待办与专注、联动运动消耗。

## 快速开始

```bash
npm install          # 前端依赖
npm run app:dev      # 桌面端开发（自动起 vite + rust，窗口 430×932）
npm run app:build    # 打包 NSIS 安装包
```

纯浏览器 UI 开发（无后端，走内存 mock 与演示数据）：

```bash
npm run dev          # http://localhost:1420
```

其他常用命令：`npm run typecheck`（类型检查）、`npm run build`（类型检查 + 前端构建）、`npm run icon`（重新生成应用图标）。

## 功能地图

| 功能 | 前端入口 | 后端模块 |
| --- | --- | --- |
| 记饮食（拍照 AI / 文字 AI / 食物库） | 主页快捷键、AI 页对话 | `modules/ai` + `modules/diet` |
| 食物库（每 100g 营养 + 份量克重） | 记饮食 → 从食物库选择 | `modules/diet` |
| 饮食全览（建议打卡 + 宏量 + 钠 + 微微量元素） | 主页底部卡片 | `modules/nutrition` + `config/dri.ts` |
| 能量与营养（目标 / 摄入 / 运动大卡 + 三大宏量进度） | 主页首卡 | `modules/nutrition` |
| 待办 + 日时间线 / 周视图 / 月视图 | 主页待办卡、「我」页完成度 | `modules/todo` |
| 番茄钟（可关联待办，会话存档） | 主页番茄钟卡、「我」页设置 | `modules/pomodoro` |
| 运动（MET 估算消耗，计入能量平衡） | 运动页 | `modules/exercise` |
| 训练课（模板计划 → 做组/组间休息/计时动作 → 汇总保存；运动详情分析） | 运动页「今日训练」 | 纯前端状态机 `stores/session.ts`，保存写入 `modules/exercise` |
| 健康方案（程序计算三档基线 → 日程级展开 → AI 复盘调参） | 「我 › 个人约束 › 健康方案」 | 持久化 `modules/program`；计算在前端 `utils/programEngine.ts`（食谱模板由 `scripts/gen-recipes.mjs` 生成） |
| 食谱库 + AI 定制菜单（模板浏览 / 喜欢不喜欢 / 按目标生成一日菜单） | 主页「食谱库」链接 | 偏好存 `recipe_prefs`；AI 在前端 `ai/recipeGen.ts`（模型出结构、食物库实算营养） |

## 目录结构

```
├─ docs/                    # 架构与规范文档（先读这两个再动手）
├─ resources/foods.json     # 食物库种子（前端 mock 与 Rust 共用）
├─ resources/workout_plans.json     # 内置课程种子（含器械 meta）
├─ resources/recipe_templates.json  # 食谱模板库（scripts/gen-recipes.mjs 从 foods.json 实算生成）
├─ scripts/                 # 工具脚本（图标生成、食谱模板生成等）
├─ src/                     # Vue 前端
│  ├─ components/{common,layout,diet,nutrition,todo,pomodoro,exercise}
│  ├─ pages/                # 四个一级页面（主页/运动/AI/我）
│  ├─ stores/               # Pinia 状态（按领域一店）
│  ├─ services/             # IPC 封装（唯一出口 transport.ts）
│  ├─ types/                # 领域类型（前后端契约镜像）
│  ├─ config/               # 展示元数据 / DRI 参考
│  ├─ utils/  composables/
│  └─ styles/               # 设计令牌 tokens.css + base.css
└─ src-tauri/               # Rust 后端
   └─ src/modules/          # 按领域分模块：diet/nutrition/todo/exercise/pomodoro/ai/seed
```

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 分层、数据流、IPC 契约、数据库 schema、扩展指南
- [docs/STANDARDS.md](docs/STANDARDS.md) — 命名、代码风格、提交规范、质量门槛

## 说明

- `resources/foods.json` 营养值为近似参考值（框架演示用），替换权威数据源时保持字段结构即可。
- 拍照/文字解析当前为本地关键词实现；接入 LLM/视觉模型时只改 `src-tauri/src/modules/ai`，契约不变。
