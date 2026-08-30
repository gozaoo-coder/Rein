# 组件审查：TodoEditorSheet.vue

> `src/components/todo/TodoEditorSheet.vue` · 275 行 · 待办编辑抽屉：标题/日期/时间段/时长/分类/重要程度/备注完整表单

**评级：B**

## 总评

字段密度高但秩序井然的表单抽屉：chips 单选、时长快捷档、危险操作隔离在左下角，aria-label 覆盖了全部图标按钮与原生日期/时间输入，令牌使用干净。扣分点集中在 `.chip` 的 `transition: all`——它同时覆盖了 base.css 为 button 准备的精确过渡声明，且违背「指定具体属性」的明确规则；其余为若干打磨项。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L231 `.chip { transition: all var(--dur-fast) var(--ease-standard); }` | `transition: background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard);`（chip 只变背景与文字色） | 方法论审查清单第一条：禁止 `transition: all`，必须指定具体属性；all 会把未来任何新增属性变化都卷进动画，也是性能与可预测性隐患 | P1 |
| 2 | L103 `<input v-model="form.title" class="title" type="text" placeholder="要做什么？" maxlength="80">` 仅占位符充当标签 | 加 `aria-label="待办标题"`（或视觉隐藏的 `<label>`） | 占位符不是标签：输入后即消失，读屏与回看场景下字段失名；同文件其他输入都有 aria-label（L108/L115），唯独主输入没有，一致性也破 | P2 |
| 3 | L127-129 自定义时长的 chip（非预设档位）条件插入，出现为瞬时 DOM | 插入元素配进场：`@starting-style { opacity: 0; transform: scale(0.95); }` + 现有 transition | 「现实里没有东西凭空出现」；150ms 以内的 scale(0.95)+opacity 淡入即可，避免突兀弹入 | P2 |
| 4 | L251-254 `.danger { width: 38px; height: 38px; ... }` | 热区扩到 ≥44px（视觉圆形可维持 38px，用 padding 或透明外圈扩大命中区） | 触控目标低于 HIG 44pt 下限；删除是破坏性操作，误触代价最高，热区反而应最大 | P2 |
| 5 | L178 `<button class="save" :disabled="!canSave" @click="save">保存</button>` 无表单包裹，键盘 Enter 不触发保存 | 外层包 `<form @submit.prevent="save">`，save 改 `type="submit"` | 移动端 IME 的「前往/Go」键与桌面 Enter 都依赖 form 语义；纯 click 绑定让键盘流断在最后一公里 | P2 |

## 做得好的

- L121：时长 chips 用 `.chip num`，数字等宽不抖。
- L108 / L115 / L174：日期、时间、删除图标按钮均有 aria-label。
- L123：点击已选中的时长 chip 可取消选择（置 null），给了无感的撤销路径。
- L234-237：选中态走 `--accent-soft` + `--accent` 令牌，与全应用选中语言一致。
- L269 + L272-274：保存按钮禁用态有 opacity 过渡（0.4），禁用→可用是平滑变化而非瞬跳。
- L39-52：每次打开 watch 重填表单，无脏状态残留。

## 修复建议排序

- **P0**：无。
- **P1**：`.chip` 的 `transition: all` 收敛为具体属性（#1）。
- **P2**：标题输入补 aria-label（#2）、自定义时长 chip 进场（#3）、删除按钮热区（#4）、Enter 提交（#5）。
