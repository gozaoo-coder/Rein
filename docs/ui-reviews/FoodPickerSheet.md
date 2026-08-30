# 组件审查：FoodPickerSheet.vue

> `src/components/diet/FoodPickerSheet.vue` · 344 行 · 食物库选择器：搜索 → 克重/份量 → 餐次 → 写入

**评级：B**

## 总评

选择流程的骨架成熟：220ms 防抖搜索、`initialFood` 直进记录面板的复用设计、44×44 步进按钮达标触控、实时大卡预览。值得表扬的是搜索结果列表**没有**加任何动画——结果随输入每 220ms 整体替换，动效只会碍事，这是「高频更新不做动画」的正确判断。缺口集中在 accent 白字魔法色（本组件内就有两处半）和确认写入无忙碌态防连点。

## 问题清单

| # | Before | After | Why | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | L315/L336 `color: #fff` + L319 `rgba(255,255,255,0.75)` | 引用新增令牌 `--on-accent`（次级文字可用 `color-mix(in srgb, var(--on-accent) 75%, transparent)`） | accent 底白字已是全项目第 6+ 处硬编码；选中态 chip 的 75% 透明白又是一份独立魔法值 | P1 |
| 2 | L83-100 `confirmAdd` await IPC 期间无 busy 态，可连点 | 加 `adding` ref：点击即置位禁用按钮 + 可选 spinner，finally 复位 | 双击 = 双条记录；同构问题在 FoodParseSheet 已被登记，此处是第二个写入入口 | P1 |
| 3 | L117-131 搜索列表 ↔ 数量配置两个视图 v-if/v-else 硬切 | 切换包一层 `<Transition mode="out-in">`：旧视图 opacity→0 + translateX(-12px)，新视图从 +12px 进，200ms ease-out | 选食物是「向前推进」的空间隐喻，瞬切让两层内容失去层级关系；抽屉高度会随之变化，过渡能掩盖高度跳变 | P2 |
| 4 | L277-285 stepper 按钮手写阴影与 SegmentedControl thumb 同款复制 | tokens 新增 `--shadow-thumb` 统一引用 | 同一视觉材质已出现三处（thumb / stepper / FoodDetailDrawer CTA），改一处漏两处 | P2 |
| 5 | L102-105 bump 固定步长 ±50g，长按无连发 | pointerdown 长按 500ms 后 ~120ms 连发；或步长随当前值放大（>500g 时 ±100） | 从 50g 加到 500g 要点九下；份数模式 ±0.5 份同理 | P2 |
| 6 | L113 搜索框仅 placeholder | input 加 `aria-label="搜索食物"` | 与 DesktopInspector 同款缺口：聚焦后 placeholder 消失信息即消失 | P2 |

## 做得好的

- L51-55：clearTimeout + 220ms 防抖，搜索节奏标准。
- L117-127：搜索结果零动画——高频替换列表不加转场是正确的克制。
- L276-280：步进按钮 44×44 圆形，触控达标。
- L72-81：effGrams/kcalPreview 实时联动，按克/按份双模式统一换算到克。
- L26/L111：external 模式隐藏搜索与返回，同一组件服务两个入口而不分裂。

## 修复建议排序

- **P0**：无。
- **P1**：① accent 白字令牌化（#1）；② confirmAdd 忙碌态（#2）。
- **P2**：两级视图转场（#3）、阴影令牌（#4）、长按连发（#5）、搜索框 aria-label（#6）。
