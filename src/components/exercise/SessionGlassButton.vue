<script setup lang="ts">
import GlassSurface from '@/components/common/GlassSurface.vue'

/**
 * 运动沉浸页的控制层玻璃块 —— 把 GlassSurface 收成一个「带按钮的玻璃胶囊/圆钮」。
 *
 * 为什么要有这一层：沉浸页的控制层（顶栏两枚胶囊 + 组数状态、底簇的组格轨 /
 * 图标钮 / 次按钮）全是同一件事 —— **一块玻璃 + 里面一颗按钮**。逐个写
 * `<GlassSurface :width :height :border-radius fill>` 会把同一组几何抄十几遍，
 * 而「两份定义必然漂」是这个仓已经付过代价的教训（Dock 与标本台曾经各写一套）。
 *
 * 三条必须守住的规矩（都是 GlassSurface / 折射管线的硬约束，不是风格问题）：
 *   1. **按钮在玻璃里面，玻璃不在按钮里面**。GlassSurface 的根就是材质本体；
 *      把它放进一颗会 transform 的按钮里，缩放会连带背景根一起变，折射整段失效。
 *      所以这里永远是 GlassSurface → slot(button)，按压反馈加在 slot 里的按钮上。
 *   2. **不进 .glass-surface**：那一份是「模糊 + 令牌」的毛玻璃，与这里的折射分支
 *      重复且会在超高档下错过整份光学令牌（rim-2 / caustic / halo）。
 *   3. **glow-layer 挂在玻璃根上**：::after 的包含块要落在这块玻璃自己的盒子上
 *      （base.css 的 .glow-layer 已自带 position: relative），触点坐标也因此按
 *      玻璃盒算 —— 挂在里层按钮上的话，光晕会画到玻璃外面去。
 */
withDefaults(
  defineProps<{
    /** 宽度：'auto' 表示跟着内容走（文字胶囊），数字 / 长度字符串则固定 */
    w?: string | number
    h?: string | number
    /** 圆角：胶囊给 var(--radius-full)，正圆给 '50%' */
    radius?: string | number
    /** 折射分支的底：与其余玻璃同色才不会让真图对比度掉一档 */
    fill?: string
  }>(),
  {
    w: 'auto',
    h: 'var(--imm-btn-h)',
    radius: 'var(--radius-full)',
    fill: 'var(--glass-fill)',
  },
)
</script>

<template>
  <GlassSurface class="sgbtn glow-layer" :width="w" :height="h" :border-radius="radius" :fill="fill">
    <slot />
  </GlassSurface>
</template>

<style scoped>
/* 行内的玻璃块一律不参与伸缩：宽度由调用方的胶囊/圆钮自己定，
   主行动（实底胶囊）才是那根伸缩的弹簧。 */
.sgbtn {
  flex: none;
}
</style>
