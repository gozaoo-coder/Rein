# 组件审查：DesktopInspector.vue

> `src/components/layout/DesktopInspector.vue` · 230 行 · 桌面三窗格壳右侧信息栏：今日小结 + 待办快切 + AI 问句

**评级：B**

## 总评

信息密度控制得当，勾选圈用 inset box-shadow 画环、完成时填充+白勾的方案只动 `background-color/box-shadow`（L167-169 显式列举属性，写法正确）。但有一个实打实的功能缺陷：AI 问句输入后问题文本被丢弃，只完成跳转——用户以为问出去的话石沉大海。另外待办完成态的文字删除线与变色是瞬跳。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L37-43 `sendAsk()` 清空输入 → 跳转 ai 页，`void q` 丢弃问题文本 | 经由 store 或 sessionStorage 把 `q` 带入 ai 页并自动发送/预填输入框 | 用户完整输入一句话点发送，唯一的反馈是「页面换了」——输入被吞是最伤信任的交互缺陷；要么送达要么别叫 send | P1 |
| 2 | L186-189 `.line.done` 变灰 + 删除线瞬跳 | `.line { transition: color var(--dur-base) }` 并以 `text-decoration-color var(--dur-base)` 从 transparent 过渡到 currentColor | 打勾是待办最高频的正反馈时刻；删除线从无到有硬蹦，而 text-decoration-color 动画能让划线像手写划过；勾圈本身已有过渡（L167-170），文字却掉队了 | P1 |
| 3 | L88-90 完成勾的白 Check 图标瞬现 | `<Transition>` 包裹：scale(0.5)→1 + opacity，120ms ease-out | 与 SmartAddSheet 同款微交互缺口；勾的弹入是「完成了」的触觉等价物 | P2 |
| 4 | L54/L56 内联 `style="gap: 12px"` / `style="gap: 7px; min-width: 0"` | 收进 scoped 类 | 组件其余部分全部走类体系，两处内联样式破坏可检索性；且 L76 还有第三处内联 font-size | P2 |
| 5 | L101 仅 placeholder 无 label | input 加 `aria-label="问 AI"` | 读屏聚焦时听不到这个输入框是什么；placeholder 在输入后消失即信息消失 | P2 |

## 做得好的

- L157-176：tick 勾选环的实现漂亮——inset shadow 当圆环描边，选中时填充分类色并令 shadow 消失，两条属性显式声明过渡。
- L173：`:var(--tc, var(--cat-general))` 分类色带缺省兜底。
- L77：`.more` 按钮带 aria-label 与 pressable 类。
- L201-210：ask 输入条毛玻璃与 TabBar 同材质，跨组件质感一致。

## 修复建议排序

- **P0**：无。
- **P1**：① 问句送达链路（#1）；② 完成态文字过渡（#2）。
- **P2**：白勾弹入（#3）、内联样式收编（#4）、input aria-label（#5）。
