<script setup lang="ts">
import { computed, ref } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import { MUSCLE_DESCS, MUSCLE_LABELS, isMuscleKey } from '@/config/muscles'
import type { ActivationMap, MuscleKey } from '@/config/muscles'

import frontSvg from '@/assets/muscles/rein/front.svg?raw'
import backSvg from '@/assets/muscles/rein/back.svg?raw'
import sideSvg from '@/assets/muscles/rein/side.svg?raw'

/**
 * 全身肌群激活图：正面 / 背面 / 侧面三视图。
 *
 * 素材来自 BodyParts3D 的真实人体解剖网格（scripts/build-anatomy.mjs 生成）：
 * 正交投影 → 栅格化 → 等值线追踪，三个视图共用同一套解剖比例，因此等大对齐。
 * 每个分区是一个 <g data-m="肌群键">，按观察深度用画家算法层叠 —— 远的下、
 * 近的上，深层肌群同样被画出来，只是被浅层盖住。
 *
 * 分区属性：
 *   data-m      肌群键（与 src/config/muscles.ts 的 MUSCLE_KEYS 一一对应，含 13 个深层键）
 *   data-layer  1 = 浅层肌、2 = 深层肌（「深层」开关控制是否显示）
 *   data-kind   构建脚本写出的 class（"m"/"a"）；**高亮与否只看键**，
 *               键在 MUSCLE_KEYS 内就是肌群，不在就只是解剖底衬
 *
 * 深层键在文档顺序里画在浅层之下，激活后会再叠画一层（.overlay），
 * 否则会出现「标了大圆肌/菱形肌却看不见」。
 *
 * 着色走 CSS 继承：3 主攻 = --c-exercise，2 辅助 = --heat-mid，
 * 1 稳定 = --c-exercise-soft；未激活走中性赭红，深层解剖走冷灰。
 *
 * 细化到肌束：三角肌前/中/后束、胸大肌上/下束、斜方肌上/中/下束、
 * 股四头分股外侧/股直/股内侧、小腿分腓肠肌/比目鱼肌等，均可单独高亮。
 *
 * 交互（interactive）：点击图任意位置弹抽屉，列出本动作全部参与肌群
 * 并按激活档位排序（主攻 → 辅助 → 稳定，同档保持规则顺序）。
 */
const props = defineProps<{ activation: ActivationMap; interactive?: boolean }>()

interface Region {
  kind: 'm' | 'a'
  key: string
  layer: number
  depth: number
  markup: string
}

interface View {
  viewBox: string
  base: string
  regions: Region[]
}

/** 从生成的 SVG 里拆出底图与各分区（文档顺序即层叠顺序） */
function parseView(raw: string): View {
  const viewBox = raw.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 660 1500'
  const base = raw.match(/<g id="base">([\s\S]*?)<\/g>/)?.[1] ?? ''
  const regions: Region[] = []
  const re = /<g class="(m|a)" data-m="([^"]+)" data-layer="(\d)" data-depth="([^"]+)">([\s\S]*?)<\/g>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    regions.push({
      kind: m[1] as 'm' | 'a',
      key: m[2],
      layer: Number(m[3]),
      depth: Number(m[4]),
      markup: m[5],
    })
  }
  return { viewBox, base, regions }
}

const FRONT = parseView(frontSvg)
const BACK = parseView(backSvg)
const SIDE = parseView(sideSvg)

const VIEWS: { label: string; view: View }[] = [
  { label: '正面', view: FRONT },
  { label: '背面', view: BACK },
  { label: '侧面', view: SIDE },
]

/** 深层开关：关掉只留浅层肌（被激活的深层肌仍会显示，否则点了没反应） */
const showDeep = ref(false)

/** 可高亮分区：键在 MUSCLE_KEYS 内即算肌群（不依赖 SVG 里的 class） */
function isMuscle(r: Region): boolean {
  return isMuscleKey(r.key)
}

function isActive(r: Region): boolean {
  return isMuscle(r) && props.activation[r.key as MuscleKey] !== undefined
}

function isVisible(r: Region): boolean {
  if (r.layer <= 1) return true
  if (showDeep.value) return true
  return isActive(r)
}

/**
 * 深层分区在文档顺序里画在浅层之下，会被浅层盖住而「标了看不见」。
 * 已激活的深层分区在全部浅层之后再叠画一遍（半透明），保证可见。
 */
function overlayRegions(view: View): Region[] {
  return view.regions.filter((r) => r.layer > 1 && isActive(r))
}

function lv(key: MuscleKey): string {
  const v = props.activation[key]
  return v === 3 ? 'l3' : v === 2 ? 'l2' : v === 1 ? 'l1' : ''
}

/** 分区着色只看档位：未激活走中性色，激活按档位 */
function cls(key: MuscleKey): string {
  return props.activation[key] ? lv(key) : 'idle'
}

function title(key: MuscleKey): string {
  const v = props.activation[key]
  if (!v) return MUSCLE_LABELS[key]
  return `${MUSCLE_LABELS[key]} · ${v === 3 ? '主攻' : v === 2 ? '辅助' : '稳定'}`
}

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
  for (const key of Object.keys(props.activation)) {
    if (!isMuscleKey(key)) continue
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

function toggleDeep(): void {
  showDeep.value = !showDeep.value
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
      <figure v-for="item in VIEWS" :key="item.label">
        <div class="figwrap">
          <svg :viewBox="item.view.viewBox" role="img" :aria-label="`肌群激活 · ${item.label}视图`">
            <g class="layer base" aria-hidden="true" v-html="item.view.base" />
            <template v-for="r in item.view.regions" :key="`${item.label}-${r.key}`">
              <g
                v-show="isVisible(r)"
                class="layer"
                :class="isMuscle(r) ? ['muscle', cls(r.key as MuscleKey)] : 'anat'"
                :data-m="r.key"
                :data-layer="r.layer"
              >
                <title v-if="isMuscle(r)">{{ title(r.key as MuscleKey) }}</title>
                <g v-html="r.markup" />
              </g>
            </template>
            <!-- 深层已激活分区：叠画在浅层之上，否则被盖住看不见 -->
            <g
              v-for="r in overlayRegions(item.view)"
              :key="`${item.label}-overlay-${r.key}`"
              class="layer muscle overlay"
              :class="cls(r.key as MuscleKey)"
              aria-hidden="true"
              v-html="r.markup"
            />
          </svg>
        </div>
        <figcaption>{{ item.label }}</figcaption>
      </figure>
    </div>

    <!-- 图例 -->
    <div class="legend row">
      <span><i class="d3" />主攻</span>
      <span><i class="d2" />辅助</span>
      <span><i class="d1" />稳定</span>
      <button
        class="depthbtn"
        type="button"
        :aria-pressed="showDeep"
        @click.stop="toggleDeep"
      >
        {{ showDeep ? '含深层' : '仅浅层' }}
      </button>
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
  gap: 22px;
}

figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

/* 三视图共用同一 viewBox（0 0 660 1500），按宽度等比缩放即得等大人体 */
.figwrap {
  width: 84px;
}

.figwrap svg {
  width: 100%;
  height: auto;
  display: block;
}

/* 命中只发生在「画了的肌群 path」上（空白处穿透到下层/卡片） */
.layer {
  pointer-events: none;
}

.layer.muscle :deep(path) {
  pointer-events: visiblePainted;
}

.interactive {
  cursor: pointer;
}

.interactive .layer.muscle :deep(path) {
  cursor: pointer;
}

/* 底图=素描灰轮廓；未激活肌群=赭红肌肉罩（教科书红调）；
   每块带细描边，分区缝隙+描边清晰可读。激活仍按运动绿色档位打标 */
.layer.base {
  fill: rgba(120, 110, 95, 0.34);
}

.layer.base :deep(path) {
  stroke: rgba(90, 70, 55, 0.55);
  stroke-width: 1.2;
  stroke-linejoin: round;
}

.layer.idle {
  fill: rgba(183, 92, 74, 0.3);
}

/* 深层解剖：冷灰、无描边重音，隐去浅层后读作「更里面一层」 */
.layer.anat {
  fill: rgba(112, 106, 128, 0.26);
}

.layer.muscle :deep(path) {
  stroke: rgba(90, 45, 30, 0.4);
  stroke-width: 1;
  stroke-linejoin: round;
}

@media (prefers-color-scheme: dark) {
  .layer.base {
    fill: rgba(150, 142, 130, 0.36);
  }

  .layer.base :deep(path) {
    stroke: rgba(230, 220, 205, 0.4);
  }

  .layer.idle {
    fill: rgba(214, 108, 86, 0.32);
  }

  .layer.anat {
    fill: rgba(150, 144, 170, 0.22);
  }

  .layer.muscle :deep(path) {
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

/* 深层已激活分区：在浅层之上半透明重描一遍，保证「标了就看得见」 */
.layer.overlay {
  opacity: 0.72;
}

figcaption {
  font-size: var(--fs-micro);
  letter-spacing: 2px;
  color: var(--text-3);
}

.legend {
  gap: 16px;
  align-items: center;
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

.depthbtn {
  font-size: var(--fs-micro);
  color: var(--text-2);
  padding: 2px 9px;
  border: 0.5px solid var(--line-strong);
  border-radius: 999px;
  background: transparent;
}

.depthbtn[aria-pressed='true'] {
  color: var(--text-1);
  background: var(--surface-2);
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
