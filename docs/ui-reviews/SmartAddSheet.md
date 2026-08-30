# 组件审查：SmartAddSheet.vue

> `src/components/common/SmartAddSheet.vue` · 597 行 · 待办/饮食通用智能添加抽屉：草稿区 → AI 后台解析 → 分区出卡确认

**评级：B**

## 总评

交互设计本身很成熟：图片先进可移除的草稿芯片、「生成」期间文案管理感知性能、结果先出卡再勾选确认、写入后转灰降透明度——确认流完整。动效层面有一个明确的 checklist 违规（`transition: all`）、四处绕开令牌的颜色/圆角，以及一个真实的忙碌态竞态（生成中点「清空」后结果仍会回填）。作为 AI 揭晓时刻的载体，识别结果的进场完全静态，也辜负了这个高光瞬间。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L525 `transition: all var(--dur-fast) var(--ease-standard)` | `transition: background-color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard)` | Emil checklist 第一条：`all` 让未来新增的任何属性变化都被意外动画化；只声明需要的属性 | P1 |
| 2 | L72-101 `runGenerate` 进行中 L230「清空」仍可点，完成后 L89-90 回填 | `busy` 时禁用清空（或 clearAll 内 `if (busy.value) return`；更优：AbortController 取消生成） | 生成中清空界面 → 结果返回又凭空出现，用户心智模型被打破；「清空」语义被违背 | P1 |
| 3 | L402/L523/L566 `color: #fff`（accent 底上白字 ×3 处） | tokens 新增 `--on-accent: #ffffff` 并引用 | 同一语义在三处重复硬编码；规范颜色零魔法值，且未来 accent 若换浅色需要一处处找 | P1 |
| 4 | L441 `border-radius: 14px` | `border-radius: var(--radius-m)` | 数值恰好等于令牌却没引用——正是令牌体系要消灭的「巧合魔法值」 | P1 |
| 5 | L271-320 识别结果卡与待办草稿列表一次性瞬现 | 列表项 stagger 入场：`opacity 0 + translateY(8px)` 起，每项延迟 40ms，250ms ease-out | AI 解析完的揭晓时刻是全流程情绪最高点；逐项浮出既表达「多条结果」也放大成就感（stagger 30-80ms，不阻塞交互） | P2 |
| 6 | L264-268 busy/error/空三态文字瞬切 | `.state span` 加 150ms opacity 过渡（Vue `<Transition mode="out-in">`） | 错误提示硬蹦出来缺乏铺垫，读起来像闪屏；轻淡入即可衔接 | P2 |
| 7 | L304-307 勾选时 Check 图标 v-if 瞬现 | 包 `<Transition>`：`scale(0.5)+opacity 0` → 1，120ms ease-out | checkbox 打勾的弹入是 iOS 经典微交互，反馈感远强于直接出现；120ms 不拖累连点 | P2 |
| 8 | L277-289 写入成功后按钮区瞬变为 done 文案 | 切换包 `<Transition mode="out-in">` 或给 done 一个 blur(2px)→0 的 160ms 浮现 | 任务完成的收尾时刻同样值得 100-200ms 的仪式感；blur 技巧让两状态融合而非重叠 | P2 |
| 9 | L330 `<div class="pad" />` 无对应样式 | 删除 | scoped 样式中不存在 `.pad`，是无高度的残留节点 | P2 |

## 做得好的

- L257/L284/L317：spinner 用 `vt-spin 0.9s linear infinite`（L412-420）——持续运动选 linear 正确；快转速 spinner 也符合「感知性能」原则。
- L244/L302：图标按钮均带 `aria-label`（移除图片、勾选/取消勾选），符合项目 §4 规范。
- L145/L171：`d.added = true` 逐条落库并即时置灰（L510-512 opacity 0.55 有全局过渡），已添加项保持可见而非消失——空间一致性。
- L45/L93-95/L190-198：无模型、空结果、部分跳过等边界都有具体可操作的文案。

## 修复建议排序

- **P0**：无。
- **P1**：① `transition: all`（#1）；② 忙碌态清空竞态（#2）；③④ 魔法色/圆角令牌化（#3/#4）。
- **P2**：结果揭晓 stagger（#5）、状态文案过渡（#6）、打勾弹入（#7）、done 收尾过渡（#8）、死节点清理（#9）。
