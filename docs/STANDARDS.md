# Rein 编码规范

> 原则：可预测 > 简洁。任何让后来者「猜」的写法都是违规。

## 1. 语言与静态检查

- **TypeScript**：`strict` 全开（含 `noUnusedLocals/noUnusedParameters/verbatimModuleSyntax`）。类型错误一律修代码，禁止 `any` / `@ts-ignore` 兜底；确有需要用 `unknown` + 收窄并注释原因。
- **Vue**：`<script setup lang="ts">`；props/emits 必须类型化（`defineProps<{...}>`）；组件内样式一律 `scoped`。
- **Rust**：以 `cargo clippy -- -D warnings` 为门槛；`unwrap()` 仅允许用于 `Mutex::lock` 与测试代码。

## 2. 命名

| 对象 | 规则 | 示例 |
| --- | --- | --- |
| TS 变量/函数 | 小驼峰，动词开头 | `loadSummary`、`calcGrams` |
| TS 类型/接口 | 大驼峰，不加 `I` 前缀 | `DailySummary` |
| Pinia store id | 与文件名一致的小驼峰 | `defineStore('nutrition')` |
| Vue 组件文件 | 大驼峰多词名，按域放目录 | `FoodPickerSheet.vue` |
| CSS 类 | 组件内 kebab-case，不追求全局复用 | `.pitem`、`.grabber` |
| 设计令牌 | `--c-领域` / `--语义` / `--fs-` / `--radius-` / `--dur-` | `--c-protein`、`--ease-sheet` |
| Rust 命令 | snake_case 动词开头 | `list_foods`、`log_meal` |
| Rust 结构体字段 | snake_case + `#[serde(rename_all = "camelCase")]` | `sodium_mg → sodiumMg` |
| IPC 参数例外 | 运动类型用 `workoutType` | 见 ARCHITECTURE §3 |

## 3. 分层纪律

- 页面（pages）只做：装配组件、onMounted 数据加载、弹层开关。业务规则下沉到 store。
- 组件允许直接读 store；**跨域联动必须走 store action**（如记饮食后刷新营养总览在 `dietStore.add` 内完成），不允许页面手动编排两个 store 的刷新顺序。
- 组件 ↔ 后端：只能经 `services/*Service.ts`。新增命令时三处同步（见 ARCHITECTURE §3），漏一处 = 不可合并。
- 类型只从 `@/types` barrel 导入：`import type { Food } from '@/types'`。

## 4. 样式规范

- 颜色、圆角、阴影、字号、时长、缓动**只引用 tokens.css 令牌**；review 时看到魔法值直接打回。
- 数字展示加 `.num`（tabular-nums）；正文层级用 `--text-2/--text-3`，不用透明度手调。
- 动效遵守 ARCHITECTURE §5：默认标准曲线；进出同路径；按压反馈在 `:active`。
- 每个可交互元素必须有可见的按压/悬停态与 aria-label（图标按钮必填）。

## 5. 数据契约

- 前后端字段命名以 `src/types/*.ts` 为准；改字段 = 同步改 Rust models + mock + 所有 service，并在 PR 描述里标注 breaking。
- 日期 `YYYY-MM-DD`、时间戳 ISO-8601、时刻为分钟数——不得引入第二种表示。
- 新增营养素字段需同时覆盖：foods 表迁移、Food/NutrientIntake 两结构体、types/diet.ts、MICROS 配置、mock 种子。

## 6. Git 与提交

- 分支：`main` 保持可构建；功能开发用 `feat/<域名>-<摘要>` 短分支。
- 提交信息：`type(scope): 中文摘要`，type ∈ feat/fix/refactor/docs/chore/style/test。
  - 例：`feat(diet): 食物库份量选择器`；`fix(ai): 数量词回看窗口越界`
- 一个提交做一件事；架构性变更（目录调整、令牌改名）单独提交并同步文档。

## 7. 质量门槛（合并前全部通过）

```bash
npm run typecheck        # TS
npm run build            # 前端构建
cd src-tauri && cargo clippy -- -D warnings && cargo check
```

UI 改动需附截图（浅色 + 暗色各一张）；数据流改动需在 mock 与 tauri 两种模式下各验证一遍。

## 8. 文档同步义务

- 改分层/契约/目录结构 → 更新 `ARCHITECTURE.md`
- 改命名/流程/门槛 → 更新本文档
- 文档与代码冲突时，先改文档再改代码（或同 PR 完成）。
