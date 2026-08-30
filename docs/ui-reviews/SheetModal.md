# 组件审查：SheetModal.vue

> `src/components/common/SheetModal.vue` · 433 行 · 全应用底部抽屉基石：毛玻璃遮罩 + 三档定位高度 + 先扩高后滚动手势

**评级：B（接近范本的高分 B）**

## 总评

这是全项目交互密度最高的基础组件，方法论执行度很高：进出同路径走底部、进入 420ms / 退出 280ms 的不对称节奏、`--ease-sheet`（正是 Apple sheet / Ionic 抽屉曲线）、百分比位移隐藏、pointer capture、单指保护、手势决策后把原生滚动还给浏览器保住动量、拖动条还有完整的 slider 键盘可访问性。扣分项集中在三处：松手吸附只看距离不看速度（快速轻拂无法跳档，违背动量判定原则）、`role="dialog"` 却不支持 Escape 关闭、以及多处时长/颜色魔法值绕过了自家令牌体系。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L101-106 `onHandleUp()` 仅 `snapTo(dragHeight)` 按最近距离吸附 | 记录 `touchstart/pointerdown` 时间与末段位移，速度超过阈值（如 0.11 px/ms）时朝拖动方向强制跳一档 | Emil 手势原则「动量式判定」：快速轻拂不该受距离阈值约束，否则轻扫三次才能从 small 到 large，手感迟钝 | P1 |
| 2 | L261-268 `role="dialog"` 无键盘关闭路径 | 组件内 `onMounted` 监听 `keydown Escape → emit('close')`（打开期间） | 桌面工作台模式下 Esc 是弹层的本能出口；dialog 角色也隐含该契约 | P1 |
| 3 | L335 `transition: height 320ms var(--ease-sheet)` | 新增令牌 `--dur-snap: 320ms` 并引用；或统一复用 `--dur-sheet` | 项目规范 §4：时长一律引用令牌；320ms 是游离于令牌体系外的第三个时长（另有 L427 的 280ms） | P1 |
| 4 | L427 `transition: transform 280ms var(--ease-sheet)` | 引用新令牌（同 #3） | 同上；退出时长目前也是魔法值 | P1 |
| 5 | L318 `background: rgba(0, 0, 0, 0.4)` | tokens.css 新增 `--scrim: rgba(0, 0, 0, 0.4)` 并引用 | 遮罩色被每个弹层组件复制的话将无法全局调深浅；规范要求颜色零魔法值 | P1 |
| 6 | L335 `transition: height ...` 高度参与过渡 | 保持现状亦可接受（仅松手瞬间触发）；追求极致可改为 `transform: translateY()` + 固定最大高度裁剪 | 方法论性能规则「只动 transform 和 opacity」；height 每帧触发整面板 relayout。因 `is-dragging` 已关过渡、仅在吸附时播一次，降级为低频问题 | P2 |
| 7 | L84-99 拖到 min/max 档位时 `clampH` 硬截断 | 越界位移乘衰减系数（如 `over * 0.15`）做橡皮筋阻尼 | Emil：「现实中的东西不会突然停止，会先减速」；现在拖到顶像撞上隐形墙 | P2 |
| 8 | L270-287 拖动条热区约 19px 高（padding 9+5 + grabber 5） | 热区增高至 ≥32px（视觉 grabber 不变，扩大 `grabber-zone` 上下 padding） | 触控目标过小，指尖在抽屉顶缘易同时碰到内容区；HIG 最小 44pt，此处至少远离临界 | P2 |
| 9 | L258 `<div class="backdrop">` | 加 `aria-hidden="true"` | 纯装饰遮罩不应进入可访问树 | P2 |
| 10 | 打开时焦点不移入面板、关闭后不归还原触发点 | `watch(open)` 中打开时聚焦 `grabber-zone`，关闭时归还 | 键盘/读屏用户在桌面模式下会被留在原地；配合 #2 一起补齐 | P2 |

## 做得好的

- L423-432：进出场不对称（420ms in / 280ms out）且同路径走底部，完全命中「慢进快出、进出同路径」两条原则。
- L429-431：`transform: translate(-50%, 105%)` 用百分比隐藏，适配任意抽屉高度，不写死像素。
- L189：`e.touches.length !== 1` 单指保护，防止换指导致抽屉跳变。
- L196-208：手势首个 move 即决策归属，「native」分支立即摘掉监听把动量还给合成器——这是很多抽屉库都做错的细节。
- L217-223：注释明确解释了为什么鼠标拖拽不能立即 `setPointerCapture`（会吞掉正文按钮的 click），捕获延迟到手势判定一刻——对边角案例的思考到位。
- L108-114 + L273-284：拖动条实现了完整 `role="slider"` + 方向键调档 + `aria-valuenow`，键盘用户也能调三档高度。
- L338-341：拖拽中 `transition: none` 保证逐帧跟手，松手才恢复过渡吸附。

## 修复建议排序

- **P0**：无。
- **P1**：① 速度解算吸附（#1，对手感影响最直接）；② Escape 关闭（#2）；③④⑤ 魔法值收编进令牌（#3/#4/#5）。
- **P2**：越界阻尼、拖动条热区、焦点管理、backdrop aria-hidden、height 过渡的长期 transform 化。
