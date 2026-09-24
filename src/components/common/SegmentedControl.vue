<script setup lang="ts">
import { computed, ref } from 'vue'

import GlassThumb from '@/components/common/GlassThumb.vue'
import { usePressGlow } from '@/composables/usePressGlow'
import { motionRich } from '@/system/motion'

/** iOS 分段控件：滑块随选中项平移。 */
const props = defineProps<{
  options: { value: string; label: string }[]
  modelValue: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const index = computed(() => Math.max(0, props.options.findIndex((o) => o.value === props.modelValue)))

/**
 * 丰富档：滑块的位移与按压交给 GlassThumb（液态融合 + 形变），原来那块纯色滑块让位。
 * 分段控件滑块是这里最常被按到的东西 —— 苹果说的「基础交互控件在交互时会活起来」，
 * 落点就在它身上。
 */
const goo = computed(() => motionRich.value)

/** 按压定向光晕（丰富档）：一份监听挂在整个控件上，按 selector 就近点亮被按的那一段 */
const segEl = ref<HTMLElement | null>(null)
usePressGlow(segEl, '.seg-item')

/**
 * 键盘：单选组的常规操作 —— 左右方向键换选项，跳过的项不落焦点（roving tabindex）。
 * 这些按钮表达的是「选一个」，不是「切一个页签」，所以用 radio 而不是 tab
 * （tab 会给读屏一个错误的心智模型：它以为下面会有一块跟着换的内容）。
 */
function pick(v: string): void {
  emit('update:modelValue', v)
}

function onKey(e: KeyboardEvent, i: number): void {
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!d) return
  e.preventDefault()
  const next = props.options[(i + d + props.options.length) % props.options.length]
  if (next) pick(next.value)
}
</script>

<template>
  <!-- 段数多时缩字号：每一段的宽度是总宽除以段数，5 段 × 4 个汉字在 320px 上会溢出。
       缩字号只作用于分段控件本身，完整标签在调用处的清单里给足（PERF_MODES 的 short） -->
  <div
    ref="segEl"
    class="seg"
    :class="{ goo }"
    role="radiogroup"
    :style="{ '--n': options.length, '--seg-fs': options.length > 4 ? '12px' : 'var(--fs-subhead)' }"
  >
    <GlassThumb v-if="goo" :index="index" :count="options.length" />
    <div v-else class="thumb" :style="{ transform: `translateX(${index * 100}%)` }" />
    <button
      v-for="(o, i) in options"
      :key="o.value"
      type="button"
      role="radio"
      class="seg-item glow-layer"
      :class="{ on: o.value === modelValue }"
      :aria-checked="o.value === modelValue"
      :tabindex="o.value === modelValue ? 0 : -1"
      @click="pick(o.value)"
      @keydown="onKey($event, i)"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.seg {
  position: relative;
  display: flex;
  background: var(--surface-2);
  border-radius: var(--radius-s);
  padding: 2px;
  /* 裁掉 goo 的模糊外溢：融合滤镜的模糊半径是"容器高度的 14%"，外溢会有几个像素，
     不裁的话丰富档下滑块边上会多一圈淡淡的光晕（像画糊了）。 */
  overflow: hidden;
}

/* 丰富档：两处令牌把滑块换成"表面"语义 —— 分段控件坐在**不透明**的轨道上
   （--surface-2），滑块就该是一块实色底，与压在玻璃上那层半透明 blob 不是一回事：
   亮色白、暗色深灰，浓度 1。颜色照旧走令牌，超高的底变薄时它不受影响。 */
.seg.goo {
  --glass-blob: var(--surface);
  --glass-blob-a: 1;
  /* 32px 上的滑块内缩只要 2px（底栏药丸是 4/5px） */
  --thumb-inset-y: 2px;
  --thumb-inset-x: 2px;
}

.thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc((100% - 4px) / var(--n));
  height: calc(100% - 4px);
  background: var(--surface);
  border-radius: 8px;
  box-shadow: var(--shadow-thumb);
  transition: transform var(--dur-base) var(--ease-standard);
}

.seg-item {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  font-size: var(--seg-fs, var(--fs-subhead));
  font-weight: 600;
  white-space: nowrap;
  color: var(--text-2);
  transition: color var(--dur-fast) var(--ease-standard);
}

.seg-item.on {
  color: var(--text-1);
}
</style>
