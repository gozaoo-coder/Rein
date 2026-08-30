# 组件审查：CountdownOverlay.vue

> `src/components/common/CountdownOverlay.vue` · 129 行 · 训练开始全屏倒数：3·2·1→GO! 或闪现组次标签

**评级：B**

## 总评

「稀有时刻可以加愉悦感」的正确示范：过冲式 pop（scale 0.4→1.18→1）配超细字重的大号数字，GO! 切换为品牌红并带光晕，仪式感到位；`:key` 重挂载让每个数字都重放动画是个干净的手法。问题在一处竞态缺陷（GO! 的 800ms 延迟 emit 没有清理路径）和一个魔法派生色。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L53/L59 `setTimeout(() => emit('done'), 800/1200)` 未保存句柄 | 存入 `let doneTimer` 并在 `stopTimer()` 与 `watch(show)` 关闭分支中 `clearTimeout` | 用户在 GO! 展示期间退出沉浸页后，迟到的 `done` 会在错误时机触发计时启动等下游动作；interval 清了 timeout 没清，清理不对称 | P1 |
| 2 | L98 `text-shadow: 0 0 40px rgba(250, 17, 79, 0.35)` | tokens 新增 `--intake-glow: rgba(250, 17, 79, 0.35)` 并引用 | 这是 `--c-intake` 的手工透明副本，改品牌红时此处必漏；规范要求颜色零魔法值 | P2 |
| 3 | L45-55 `setInterval` 计数递减 | 以 `Date.now()` 起点推算剩余秒数，interval 仅做刷新 | WebView 切后台时定时器被节流，纯计数倒计时会被拉长数倍；运动场景切查看消息很常见 | P2 |
| 4 | L69 覆盖层无语义 | 容器加 `role="timer"` 或文本包 `aria-live="assertive"` | 读屏用户听不到 3·2·1·GO，而它恰恰是「该开始用力了」的关键信号 | P2 |

## 做得好的

- L71-72：`:key="text"` 触发重挂载重放动画，比手动 restart class 的 hack 可靠。
- L107-119：pop 起点 scale(0.4)+opacity 0 而非 scale(0)——即使是大字号戏剧性入场也保留了「从有到有」的自然感；55% 处 1.18 过冲给倒数必要的能量感，符合「稀有场景可加 delight」的频率决策框架。
- L84：`color-mix` 让遮罩继承 `--bg`，亮暗主题自动跟随。
- L121-128：overlay 进出场纯 opacity 渐变，250ms 标准节奏。

## 修复建议排序

- **P0**：无。
- **P1**：① done 延迟回调的清理（#1，真实竞态）。
- **P2**：glow 色令牌化（#2）、倒计时抗节流（#3）、读屏语义（#4）。
