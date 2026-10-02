<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

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
 * 每块肌肉是一个 <g data-m="肌群键">，按观察深度用画家算法层叠 —— 远的下、
 * 近的上，深层肌群同样被画出来，只是被浅层盖住。
 *
 * 分区属性：
 *   data-m      肌群键（与 src/config/muscles.ts 的 MUSCLE_KEYS 一一对应，含 13 个深层键）
 *   data-layer  1 = 浅层肌、2 = 深层肌（「深层」开关控制是否显示）
 *   data-depth  观察深度（0 = 离观察者最远，9 = 最近）；文档顺序即按它升序排好
 *   data-kind   构建脚本写出的 class（"m"/"a"）；**高亮与否只看键**，
 *               键在 MUSCLE_KEYS 内就是肌群，不在就只是解剖底衬
 *
 * ---------- 深度分层（2026-09-26）----------
 * 加这一层是因为「三档颜色」本身说不清**是哪一块肌肉**：正面视图里背阔肌被胸大肌、
 * 腹直肌压住，二者又都是同一种绿，一眼看去只能读出"这里有块肌肉被激活了"，
 * 读不出是哪块。于是按 data-depth 把每块分进三个层，并按「越靠观察者越实」给透明度：
 *
 *   外层（depth ≥ 6.0）alpha 1.00  |  中层（3.2 ~ 6.0）alpha 0.78  |  后层（< 3.2）alpha 0.56
 *
 * 三个层**各自**乘以激活档位的颜色，所以「外层稳定」也依然比「后层主攻」实 —— 读的人
 * 先看到的是"远近"这一维，再看颜色读出强度。阈值不是随手取的：0~9 这个深度标尺上，
 * 3.2 / 6.0 恰好把正视图切成「后背那一片（斜方下 / 菱形 / 背阔 / 竖脊 / 臀 / 腘绳）」
 * 与「前面那一片（胸上下 / 腹直 / 腹斜 / 股四头）」，背视图同样切得干净 —— 而背面视图
 * 的层序是**反的**（可见的背肌在外层），这正对：判据是"离观察者多近"，不是"在人体的哪一面"。
 *
 * 极**致**档另给被表层覆盖的肌肉加景深模糊（中层 1px、后层 2px）：透明度之外再加一条
 * 「被盖住的本来就不在焦平面上」的线索。单位是**CSS 像素**，而 SVG 里的模糊按用户坐标算
 * （台架实测：viewBox 660 渲染到 84px 宽时 blur(16px) 只铺开约 10 个屏幕像素），
 * 所以这里由 JS 量出「1 CSS 像素 = 多少用户单位」写成 --mmap-u，CSS 再乘上去 ——
 * 换个尺寸渲染时模糊量不会跟着缩放失真。
 *
 * 三个层是**按 band 分组的 <g>**，不是给每块单独加样式：分组之后模糊一次只跑 3 遍
 * （而不是每块肌肉一遍），而且因为生成的 SVG 本来就是按 depth 升序写的文档顺序，
 * 分组不会改变任何一块的层叠次序（同组内保持原顺序，组间按 band 顺序）。
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

/* ---------- 深度分层：把每块肌肉按 data-depth 分进 外层 / 中层 / 后层 ---------- */

/** 分层阈值（深度标尺 0~9，数值的来源与解剖依据见文件头）。改了要同步 e2e 的断言 */
const BAND_MID_FROM = 3.2
const BAND_NEAR_FROM = 6.0

/** 0 = 后层（离观察者最远）、1 = 中层、2 = 外层；索引即绘制顺序，也是 CSS 类名后缀 */
function bandOf(depth: number): 0 | 1 | 2 {
  if (depth >= BAND_NEAR_FROM) return 2
  return depth >= BAND_MID_FROM ? 1 : 0
}

interface Band {
  band: 0 | 1 | 2
  regions: Region[]
}

/**
 * 把一个视图的分区按 band 分组。生成脚本写出的文档顺序本来就是按 data-depth 升序，
 * 所以「按 band 归组」不会改变任何一块的层叠次序 —— 组内保持原顺序、组间按 band 升序，
 * 连起来与原来的文档顺序等价。这也是能把模糊挂在组上的前提。
 */
function bandsOf(regions: Region[]): Band[] {
  const out: Band[] = []
  for (const r of regions) {
    const band = bandOf(r.depth)
    const last = out[out.length - 1]
    if (last && last.band === band) last.regions.push(r)
    else out.push({ band, regions: [r] })
  }
  return out
}

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
 * 叠画那一遍同样按 band 分组 —— 否则它又会变回「每块肌肉一遍滤镜」。
 */
function overlayBands(view: View): Band[] {
  return bandsOf(view.regions.filter((r) => r.layer > 1 && isActive(r)))
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

/* ---------- 景深模糊的换算：1 CSS 像素 = 多少 SVG 用户单位 ---------- */

/**
 * SVG 里的 CSS `filter: blur(Npx)` 按**用户坐标**算，不是屏幕像素 —— 台架实测：
 * viewBox 660 渲染到 84px 宽（缩放 0.127）时，blur(16px) 在屏幕上只铺开约 10 个像素，
 * 而不是 16 个。所以「1px 模糊」不能直接写 blur(1px)（那样只有 0.13 个屏幕像素，
 * 等于没加），得先量出缩放比再换算。
 *
 * 量出来的是**用户单位/CSS 像素**（= viewBox 宽 / 实测渲染宽，getBoundingClientRect
 * 报的就是 CSS 像素），写进 --mmap-u，CSS 再乘上想要的像素数。
 * 刻意**不**除 devicePixelRatio：景深是**视觉**线索，「1px」该指同一个观感量级，
 * 除以 dpr 会让手机（dpr 2.75~3）上的模糊缩到 1/3、等于关掉。所以这里的 px 是
 * CSS 像素，三端观感一致。量在**根元素**上，三个视图共用一份 —— 它们本来就等大。
 * 尺寸变了要重量（.figwrap 的宽度是响应式的）。
 */
const root = ref<HTMLElement | null>(null)
let scaleObserver: ResizeObserver | null = null

function syncUnit(): void {
  const host = root.value
  const svg = host?.querySelector<SVGSVGElement>('.figwrap svg')
  if (!host || !svg) return
  const viewBoxWidth = svg.viewBox.baseVal.width || 660
  const rendered = svg.getBoundingClientRect().width
  if (rendered <= 0) return
  host.style.setProperty('--mmap-u', String(viewBoxWidth / rendered))
}

onMounted(() => {
  syncUnit()
  scaleObserver = new ResizeObserver(() => syncUnit())
  if (root.value) scaleObserver.observe(root.value)
})

onUnmounted(() => {
  scaleObserver?.disconnect()
})
</script>

<template>
  <div
    ref="root"
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
            <!-- 按深度分层：三个 band 各是一个组，越靠观察者的越实（后层最淡）。
                 分组同时是模糊的单位 —— 极致档每个组只跑一遍滤镜，不是每块肌肉一遍 -->
            <g
              v-for="b in bandsOf(item.view.regions)"
              :key="`${item.label}-band-${b.band}`"
              class="band"
              :class="`band-${b.band}`"
            >
              <template v-for="r in b.regions" :key="`${item.label}-${r.key}`">
                <g
                  v-show="isVisible(r)"
                  class="layer"
                  :class="isMuscle(r) ? ['muscle', cls(r.key as MuscleKey)] : 'anat'"
                  :data-m="r.key"
                  :data-layer="r.layer"
                  :data-depth="r.depth"
                >
                  <title v-if="isMuscle(r)">{{ title(r.key as MuscleKey) }}</title>
                  <g v-html="r.markup" />
                </g>
              </template>
            </g>
            <!-- 深层已激活分区：叠画在浅层之上，否则被盖住看不见（同样按 band 分组） -->
            <g
              v-for="b in overlayBands(item.view)"
              :key="`${item.label}-ov-band-${b.band}`"
              class="band"
              :class="`band-${b.band}`"
            >
              <g
                v-for="r in b.regions"
                :key="`${item.label}-overlay-${r.key}`"
                class="layer muscle overlay"
                :class="cls(r.key as MuscleKey)"
                aria-hidden="true"
                v-html="r.markup"
              />
            </g>
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
    <!-- 深度图例：不加这一行的话，"同一个绿色是胸还是背"只能靠猜 —— 分层的全部意义
         就是让人一眼分清，那它自己得先说得清 -->
    <p class="layernote t-3">越靠观察者越实：外层 &gt; 中层 &gt; 后层（正面视图里的背阔肌属后层）</p>
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

/* ---------- 深度分层：越靠观察者越实 ----------
   三个 band 的透明度**各自**叠在激活档位的颜色上（fill 在 .layer.l1/2/3 上，与这里正交）：
   于是「外层稳定」也比「后层主攻」实 —— 先读出远近，再读颜色读强度。
   数值刻意拉开到一眼能分（1 / 0.78 / 0.56）：差 0.05 那种量级在读图时是读不出来的，
   而这套分层的唯一目的就是"一眼分清是哪一块"。 */
.band {
  opacity: var(--band-alpha, 1);
}

.band-0 {
  --band-alpha: 0.56;
}

.band-1 {
  --band-alpha: 0.78;
}

.band-2 {
  --band-alpha: 1;
}

/* 极致档：被表层覆盖的肌肉再加一条景深线索（中层 1px、后层 2px 模糊）。
   单位换算见脚本里的 --mmap-u —— SVG 内的模糊按用户坐标算，直接写 1px 等于没加。
   var() 的兜底值是 dpr=1 时量出来的那份，只用于 JS 量到之前的首帧。
   只在极致档给：这是"更贵但更像真玻璃"的那一档该付的钱，其余档靠透明度梯度就够了。 */
html[data-perf='extreme'] .band-1 {
  filter: blur(calc(1 * var(--mmap-u, 7.86) * 1px));
}

html[data-perf='extreme'] .band-0 {
  filter: blur(calc(2 * var(--mmap-u, 7.86) * 1px));
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

/* 深层已激活分区：在浅层之上半透明重描一遍，保证「标了就看得见」。
   它自己也落在某个 band 组里，所以这个 0.72 会与组的透明度**相乘**（后层叠画 = 0.40）——
   这是有意的：把它抬到浅层之上是为了"看得见"，而它仍然该读作"在后头"。
   两者要的是一件事的两面：可见 ≠ 与表层同样靠前。 */
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

.layernote {
  margin-top: -4px;
  font-size: var(--fs-micro);
  text-align: center;
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
