<script setup lang="ts">
import { computed, ref } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import { MUSCLE_DESCS, MUSCLE_LABELS } from '@/config/muscles'
import type { ActivationMap, MuscleKey } from '@/config/muscles'

import frontBase from '@/assets/muscles/med/front.svg?raw'
import frontScm from '@/assets/muscles/med/front-scm.svg?raw'
import frontDeltoid from '@/assets/muscles/med/muscle-2.svg?raw'
import frontChest from '@/assets/muscles/med/muscle-4.svg?raw'
import frontBiceps from '@/assets/muscles/med/muscle-1.svg?raw'
import frontForearm from '@/assets/muscles/med/front-forearm.svg?raw'
import frontCoreAbs from '@/assets/muscles/med/muscle-6.svg?raw'
import frontCoreObliques from '@/assets/muscles/med/muscle-14.svg?raw'
import frontQuads from '@/assets/muscles/med/muscle-10.svg?raw'
import backBase from '@/assets/muscles/med/back.svg?raw'
import backDeltoid from '@/assets/muscles/med/back-deltoid.svg?raw'
import backTraps from '@/assets/muscles/med/muscle-9.svg?raw'
import backLats from '@/assets/muscles/med/muscle-12.svg?raw'
import backTriceps from '@/assets/muscles/med/muscle-5.svg?raw'
import backForearm from '@/assets/muscles/med/back-forearm.svg?raw'
import backCore from '@/assets/muscles/med/muscle-16.svg?raw'
import backGlutes from '@/assets/muscles/med/muscle-8.svg?raw'
import backHamstrings from '@/assets/muscles/med/muscle-11.svg?raw'
import backCalves from '@/assets/muscles/med/muscle-7.svg?raw'
import backSoleus from '@/assets/muscles/med/muscle-15.svg?raw'
import sideBase from '@/assets/muscles/med/side-base.svg?raw'
import sideScm from '@/assets/muscles/med/side-scm.svg?raw'
import sideTraps from '@/assets/muscles/med/side-traps.svg?raw'
import sideChest from '@/assets/muscles/med/side-chest.svg?raw'
import sideDeltoid from '@/assets/muscles/med/side-deltoid.svg?raw'
import sideBiceps from '@/assets/muscles/med/side-biceps.svg?raw'
import sideTriceps from '@/assets/muscles/med/side-triceps.svg?raw'
import sideForearm from '@/assets/muscles/med/side-forearm.svg?raw'
import sideLats from '@/assets/muscles/med/side-lats.svg?raw'
import sideCore from '@/assets/muscles/med/side-core.svg?raw'
import sideQuads from '@/assets/muscles/med/side-quads.svg?raw'
import sideHamstrings from '@/assets/muscles/med/side-hamstrings.svg?raw'
import sideGlutes from '@/assets/muscles/med/side-glutes.svg?raw'
import sideCalves from '@/assets/muscles/med/side-calves.svg?raw'

/**
 * 全身肌群激活图：正面 / 背面 / 侧面三视图，肌群按档位填色——
 * 3 主攻 = --c-exercise，2 辅助 = --heat-mid，1 稳定 = --c-exercise-soft。
 *
 * 素材为医科解剖教科书风（wger 项目，源自 OpenStax / Tomáš Kebert，
 * CC BY-SA 4.0，出处见 resources/muscles/SOURCE.md）：中性底图 + 每肌群
 * 一个叠加层同画布堆叠；侧视图与补缺肌群（SCM/前臂/后束）为按医科
 * 风格手绘（scripts/patch-med.mjs）。档位着色走 fill 继承。
 *
 * 交互（interactive）：点击图任意位置弹抽屉，列出本动作全部参与肌群
 * 并按激活档位排序（主攻 → 辅助 → 稳定，同档保持规则顺序）。
 */
const props = defineProps<{ activation: ActivationMap; interactive?: boolean }>()

interface Layer {
  key: MuscleKey
  svg: string
}

/** 顺序即层叠顺序：大面积打底、细小组件靠后（后画在上层，点击优先命中） */
const FRONT_LAYERS: Layer[] = [
  { key: 'quads', svg: frontQuads },
  { key: 'core', svg: frontCoreAbs },
  { key: 'core', svg: frontCoreObliques },
  { key: 'chest', svg: frontChest },
  { key: 'biceps', svg: frontBiceps },
  { key: 'forearm', svg: frontForearm },
  { key: 'deltoid', svg: frontDeltoid },
  { key: 'scm', svg: frontScm },
]

const BACK_LAYERS: Layer[] = [
  { key: 'core', svg: backCore },
  { key: 'lats', svg: backLats },
  { key: 'glutes', svg: backGlutes },
  { key: 'hamstrings', svg: backHamstrings },
  { key: 'calves', svg: backCalves },
  { key: 'calves', svg: backSoleus },
  { key: 'traps', svg: backTraps },
  { key: 'deltoid', svg: backDeltoid },
  { key: 'triceps', svg: backTriceps },
  { key: 'forearm', svg: backForearm },
]

/** 侧面视图（面朝左）：侧向肌群参考，各层与正/背同画布堆叠 */
const SIDE_LAYERS: Layer[] = [
  { key: 'quads', svg: sideQuads },
  { key: 'core', svg: sideCore },
  { key: 'chest', svg: sideChest },
  { key: 'traps', svg: sideTraps },
  { key: 'calves', svg: sideCalves },
  { key: 'biceps', svg: sideBiceps },
  { key: 'forearm', svg: sideForearm },
  { key: 'triceps', svg: sideTriceps },
  { key: 'lats', svg: sideLats },
  { key: 'hamstrings', svg: sideHamstrings },
  { key: 'glutes', svg: sideGlutes },
  { key: 'deltoid', svg: sideDeltoid },
  { key: 'scm', svg: sideScm },
]

function lv(key: MuscleKey): string {
  const v = props.activation[key]
  return v === 3 ? 'l3' : v === 2 ? 'l2' : v === 1 ? 'l1' : ''
}

/** 全部肌群始终渲染：激活按档位着色，未激活走中性浅灰（idle）。
 *  素材自带分区（上/中/下胸、前束等），路径间缝隙在中性与高亮
 *  状态下都保留分块感；<title> 注入供悬停提示。 */
interface Rendered {
  key: MuscleKey
  cls: string
  svg: string
}

function renderLayer(l: Layer): Rendered {
  const v = props.activation[l.key]
  const title = v
    ? `${MUSCLE_LABELS[l.key]} · ${v === 3 ? '主攻' : v === 2 ? '辅助' : '稳定'}`
    : MUSCLE_LABELS[l.key]
  return {
    key: l.key,
    cls: v ? lv(l.key) : 'idle',
    svg: l.svg.replace(/(<svg[^>]*>)/, `$1<title>${title}</title>`),
  }
}

const frontRendered = computed(() => FRONT_LAYERS.map(renderLayer))
const backRendered = computed(() => BACK_LAYERS.map(renderLayer))
const sideRendered = computed(() => SIDE_LAYERS.map(renderLayer))

/* ---------- 交互：点击图 → 全部参与肌群按档位排序 ---------- */

const detailOpen = ref(false)

interface MuscleRow {
  key: MuscleKey
  label: string
  tag: string
  level: number
  desc: string
}

const sortedMuscles = computed<MuscleRow[]>(() => {
  const rows: MuscleRow[] = []
  for (const key of Object.keys(props.activation) as MuscleKey[]) {
    const v = props.activation[key]
    if (!v) continue
    rows.push({
      key,
      label: MUSCLE_LABELS[key],
      tag: v === 3 ? '主攻' : v === 2 ? '辅助' : '稳定',
      level: v,
      desc: MUSCLE_DESCS[key],
    })
  }
  // 按激活档位降序（主攻 → 辅助 → 稳定），同档保持配置顺序（稳定排序）
  rows.sort((a, b) => b.level - a.level)
  return rows
})

const detailTitle = computed(() => `激活肌群 · ${sortedMuscles.value.length} 个`)

function onMapTap(): void {
  if (props.interactive) detailOpen.value = true
}
</script>

<template>
  <div
    class="mmap col"
    :class="{ interactive }"
    :role="interactive ? 'button' : undefined"
    :tabindex="interactive ? 0 : undefined"
    :aria-label="interactive ? '查看全部激活肌群' : '肌群激活图'"
    @click="onMapTap"
    @keydown.enter.prevent="onMapTap"
    @keydown.space.prevent="onMapTap"
  >
    <div class="figs row">
      <!-- 正面 -->
      <figure>
        <div class="figwrap" role="img" aria-label="肌群激活 · 正面视图">
          <i class="layer base" aria-hidden="true" v-html="frontBase" />
          <i v-for="(l, i) in frontRendered" :key="`f${i}`" class="layer" :class="l.cls" v-html="l.svg" />
        </div>
        <figcaption>正面</figcaption>
      </figure>

      <!-- 背面 -->
      <figure>
        <div class="figwrap" role="img" aria-label="肌群激活 · 背面视图">
          <i class="layer base" aria-hidden="true" v-html="backBase" />
          <i v-for="(l, i) in backRendered" :key="`b${i}`" class="layer" :class="l.cls" v-html="l.svg" />
        </div>
        <figcaption>背面</figcaption>
      </figure>

      <!-- 侧面 -->
      <figure>
        <div class="figwrap" role="img" aria-label="肌群激活 · 侧面视图">
          <i class="layer base" aria-hidden="true" v-html="sideBase" />
          <i v-for="(l, i) in sideRendered" :key="`s${i}`" class="layer" :class="l.cls" v-html="l.svg" />
        </div>
        <figcaption>侧面</figcaption>
      </figure>
    </div>

    <!-- 图例 -->
    <div class="legend row">
      <span><i class="d3" />主攻</span>
      <span><i class="d2" />辅助</span>
      <span><i class="d1" />稳定</span>
    </div>
    <p v-if="interactive" class="taphint">点击查看全部激活肌群</p>

    <!-- 激活肌群抽屉：全部参与肌群按档位排序 -->
    <SheetModal :open="detailOpen" :title="detailTitle" @close="detailOpen = false">
      <div v-for="m in sortedMuscles" :key="m.key" class="mrow row">
        <i class="dot" :class="lv(m.key)" />
        <div class="mid flex-1">
          <div class="namerow row">
            <b>{{ m.label }}</b>
            <span class="tag t-3">{{ m.tag }}</span>
          </div>
          <p class="desc">{{ m.desc }}</p>
        </div>
      </div>
    </SheetModal>
  </div>
</template>

<style scoped>
.mmap {
  gap: 10px;
  align-items: center;
  width: 100%;
}

.figs {
  justify-content: center;
  gap: 34px;
}

figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

/* 所有层左上对齐、等宽锚定；同一视图共用同一 viewBox，叠放即人体 */
.figwrap {
  position: relative;
  width: 84px;
}

.layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  display: block;
}

.layer:first-child {
  position: relative;
}

.layer :deep(svg) {
  width: 100%;
  height: auto;
  display: block;
}

/* 命中只发生在「画了的肌群 path」上（空白处穿透到下层/卡片） */
.layer {
  pointer-events: none;
}

.layer :deep(svg path) {
  pointer-events: visiblePainted;
}

.interactive {
  cursor: pointer;
}

.interactive .layer :deep(svg path) {
  cursor: pointer;
}

/* 底图与档位色经 fill 继承进 svg path。
   医科解剖风：底图=素描灰轮廓；未激活肌群=赭红肌肉罩（教科书红调）；
   每块带细描边，分区缝隙+描边清晰可读。激活仍按运动绿色档位打标 */
.layer.base {
  fill: rgba(120, 110, 95, 0.38);
}

.layer.idle {
  fill: rgba(183, 92, 74, 0.3);
}

.layer :deep(svg path) {
  stroke: rgba(90, 45, 30, 0.4);
  stroke-width: 1.2;
  stroke-linejoin: round;
}

@media (prefers-color-scheme: dark) {
  .layer.base {
    fill: rgba(150, 142, 130, 0.4);
  }

  .layer.idle {
    fill: rgba(214, 108, 86, 0.32);
  }

  .layer :deep(svg path) {
    stroke: rgba(255, 214, 200, 0.16);
  }
}

.layer.l1 {
  fill: var(--c-exercise-soft);
}

.layer.l2 {
  fill: var(--heat-mid);
}

.layer.l3 {
  fill: var(--c-exercise);
}

figcaption {
  font-size: var(--fs-micro);
  letter-spacing: 2px;
  color: var(--text-3);
}

.legend {
  gap: 16px;
}

.legend span {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-micro);
  color: var(--text-2);
}

.legend i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 0.5px solid var(--line-strong);
}

.d1 {
  background: var(--c-exercise-soft);
}

.d2 {
  background: var(--heat-mid);
}

.d3 {
  background: var(--c-exercise);
  border-color: transparent;
}

.taphint {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* 激活肌群列表抽屉 */
.mrow {
  gap: 10px;
  padding: 13px 2px;
  border-bottom: 0.5px solid var(--line);
}

.mrow:last-child {
  border-bottom: none;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin-top: 3px;
  flex: none;
}

.dot.l1 {
  background: var(--c-exercise-soft);
}

.dot.l2 {
  background: var(--heat-mid);
}

.dot.l3 {
  background: var(--c-exercise);
}

.namerow {
  gap: 8px;
  align-items: baseline;
}

.namerow b {
  font-size: var(--fs-callout);
  color: var(--text-1);
}

.tag {
  font-size: var(--fs-caption);
}

.desc {
  margin-top: 3px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.6;
}
</style>