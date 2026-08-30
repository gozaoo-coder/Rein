# 组件审查：ExerciseDetailDrawer.vue

> `src/components/exercise/ExerciseDetailDrawer.vue` · 163 行 · 动作详情抽屉：动作名 + 肌群激活图 + 训练参数格 + 动作要点

**评级：B**

## 总评

纯展示型抽屉，自身零动画（进出交给 SheetModal），信息层级（小节标题 → 内容）与空状态处理（未识别肌群不展示猜测，L58）都符合「不做虚构」的项目原则。参数值统一 `.num`。问题全部是令牌卫生：badge 的青色系整组手写且暗色分支与 tokens 的暗色值漂移，参数格圆角写死了 `--radius-m` 的数值。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L94-95 `background: rgba(30, 234, 239, 0.14); color: #00858a;` + L98-102 暗色覆盖 `color: #1eeaef;` | 引用均衡色令牌派生：`background: color-mix(in srgb, var(--c-balance) 14%, transparent); color: var(--c-balance);` 并删除暗色媒体查询块 | 手写青色系实为 `--c-balance`（亮 #1eeaef / 暗 #40e8ec）的私有变体；暗色分支又写回亮色值 #1eeaef，绕开了 tokens 暗色提亮策略，主题调整时必然脱管 | P1 |
| 2 | L141 `.cell { … border-radius: 14px; }` | `border-radius: var(--radius-m);` | 14px 与 `--radius-m` 精确相等却写死，全局调圆角阶梯时此处不动 | P1 |
| 3 | L93 `border-radius: 8px;` | 收进圆角阶梯（最近为 `--radius-s:10px`）或新增 micro 徽标半径令牌 | 8px 是阶梯外无主值 | P2 |
| 4 | L146 `.cell .v { font-size: 22px; }` | `font-size: var(--fs-title2);`（21px） | 字号应走 iOS HIG 阶梯；22px 悬在 title2(21) 与 title1(26) 之间 | P2 |

## 做得好的

- L52-58 肌群数据缺失时给出明确空态文案且不猜测（「暂无…的肌群数据」），符合项目诚实原则。
- L62-65 参数格数值统一 `.num`；L21-40 stats 按 strength/timed/cardio 三类组织，缺数据显式渲染「—」而非隐藏。
- 全部颜色/圆角（除上列）/字号引用令牌；无任何自有动画，避免在抽屉内叠加第二层运动。
- L161 `white-space: pre-line` 让要点文案保留换行结构，长文本可读性好。

## 修复建议排序

- **P0**（明显手感缺陷或违反方法论核心）：无。
- **P1**（应修）：① badge 青色系改引用 `--c-balance` 派生并删除暗色硬编码块（L94-102）；② 参数格圆角换 `--radius-m`（L141）。
- **P2**（打磨项）：③ badge 8px 圆角收进阶梯（L93）；④ 数值字号对齐 `--fs-title2`（L146）。
