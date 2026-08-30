# 组件审查：SegmentedControl.vue

> `src/components/common/SegmentedControl.vue` · 66 行 · iOS 分段控件，白色滑块随选中项平移

**评级：B**

## 总评

实现思路正确：滑块是独立 thumb 层用 `translateX(index * 100%)` 平移，只动 transform、GPU 友好，宽度用 CSS 变量按选项数自适应等分，文字颜色单独走 `--dur-fast` 过渡——层次分明。主要缺口在读屏语义（一组普通按钮，无任何选中态表达）和 thumb 阴影魔法值。另外对每天切换多次的控件，250ms 的滑块过渡略偏慢。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L16-27 容器与按钮无 ARIA 结构 | `.seg` 加 `role="tablist"`、`.seg-item` 加 `role="tab" :aria-selected="o.value===modelValue"`（或 radiogroup/radio 方案） | 读屏用户听到的是 N 个同名按钮，感知不到当前选中哪段——分段控件的核心信息就是选中态 | P1 |
| 2 | L48 `box-shadow: 0 1px 4px rgba(0,0,0,0.12), 0 0 0 0.5px var(--line)` | tokens 新增 `--shadow-thumb` 并引用 | 规范：阴影一律引用令牌；暗色模式下 0.12 黑阴影几乎不可见，thumb 与底色仅靠 surface 色差区分，令牌化后可随主题调整 | P2 |
| 3 | L49 `transition: transform var(--dur-base)`（250ms） | 收紧到 `180ms var(--ease-standard)` 或换 `cubic-bezier(0.23, 1, 0.32, 1)` | 分段控件属「一天几十次」的控件，Emil 决策框架要求此类高频操作动效大幅缩短；滑块要脆不要绵 | P2 |
| 4 | L52-56 `.seg-item` 高度约 33px（padding 6px + 行高） | padding 增至 `9px 0`（高约 39-40px）或外层定 min-height | 触控目标偏小；iOS 原生分段控件高 32pt 但配合整条热区，Web 里建议向 44pt 靠拢 | P2 |

## 做得好的

- L17：thumb 平移用 `translateX(index * 100%)`，百分比相对自身宽度，选项数变化时自动适配，零 JS 测量。
- L40-50：滑块独立层 + 只动 transform，连续快速点击时过渡可打断、不跳变。
- L60：文字颜色单独 `--dur-fast` 过渡，比滑块先到位，层次感正确。
- L16/L44-45：`--n` 变量驱动等分宽度，纯 CSS 解耦了选项数量。

## 修复建议排序

- **P0**：无。
- **P1**：① tablist/tab 语义（#1）。
- **P2**：阴影令牌（#2）、时长收紧（#3）、触控高度（#4）。
