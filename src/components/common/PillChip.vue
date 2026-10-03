<script setup lang="ts">
/**
 * 胶囊 chip：主页与画布上「一条短语（+ 可选前导点 / 尾部注）」的统一实现。
 *
 * **为什么要有它**：同一个主页上原本并存四套同类实现 —— 文字链（7×13px / 13px 字）、
 * 待办 chip（7×12px / 12px）、餐次 chip（5×10px / 11px）、详情胶囊（5×10px / 12px）。
 * 单看每一颗都不难看，排在一屏里就散：同一种视觉语法有四种尺寸。
 * 收成「两档尺寸 + 三档语气」，规格只有一份，以后改一处就是全站。
 *
 * 尺寸（差的是「一行放得下几颗」，不是随手 1px）：
 *   `md` 常规 12px 字 / 6×12 内边距；`sm` 密集 11px 字，用于一行的元数据摘要。
 * 语气（只决定正文色与强调，不改变形状）：
 *   `label` 中性内容（待办标题，最深一档）、`muted` 中性控件（导航、摘要）、
 *   `action` 去处（强调色 + 更重字重，按下去交给全局 `button:active`）。
 *
 * `as` 决定渲染成什么：**要点的传 `button`，纯展示的传 `span`**。
 * 主页那条「摄入总览」本身就是一整枚 `button`，里面凡是 chip 都必须是 `span`
 * （button 不能嵌 button），所以元素类型不能写死。
 */
withDefaults(
  defineProps<{
    /** 渲染元素：可点的用 `button`（自带按压反馈），纯展示用 `span` */
    as?: 'button' | 'span'
    /** 语气：中性内容 / 中性控件 / 去处 */
    tone?: 'label' | 'muted' | 'action'
    /** 尺寸：常规 / 密集 */
    size?: 'md' | 'sm'
  }>(),
  { as: 'span', tone: 'muted', size: 'md' },
)
</script>

<template>
  <component :is="as" class="chip" :class="[tone, size]">
    <slot />
  </component>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-weight: 600;
  white-space: nowrap;
}

.md {
  padding: 6px 12px;
  font-size: var(--fs-caption);
}

.sm {
  padding: 5px 10px;
  font-size: var(--fs-micro);
}

.label {
  color: var(--text-1);
}

.muted {
  color: var(--text-2);
}

.action {
  color: var(--accent-strong);
  font-weight: 700;
}

/* 前导圆点：四颗 chip 此前各写一份 7px，这里收一份。
   `:slotted` 是必须的 —— 点由使用方塞进插槽，属于父组件的作用域。 */
.chip :slotted(.dot) {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
}

/* 尾部注（时长 / 计数）：比正文浅一档。`label` 下才看得出层次，
   `muted` 下与正文同为 --text-2，是刻意的「不加戏」。 */
.chip :slotted(.trail) {
  font-style: normal;
  font-weight: 500;
  color: var(--text-2);
}
</style>
