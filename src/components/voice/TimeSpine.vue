<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, MessageCircle, ListTodo, Play } from 'lucide-vue-next'

/**
 * 时间脊 —— 语音记录的唯一时间原语。
 *
 * 核心主张：**会话不是列表，是一段可以摸到的时间**。
 * 一段话在脊上的宽度 = 它真实说出来的时长，块之间的空隙 = 静默。
 * 于是「哪里密、哪里冷场、谁在长篇大论」不用读文字就能看出来。
 *
 * 三种形态同一份数据，缩放即切换，不是三个页面：
 *  - `structure`：整场压进一屏，只看结构（块的宽度与位置）
 *  - `read`：文字展开，顶部保留一条按真实比例的「你在这里」细带
 *  - `mini`：一行缩略脊，给列表 / 浮条 / 选择器用
 *
 * 数据口径：ASR 只给每句的起始时间，没有句末时间，所以**块宽是估计的**
 * （按字数估朗读时长，且不超过到下一句的间隔，剩余部分即静默）。
 */

export interface SpineSeg {
  /** 句首时间（毫秒） */
  t: number
  /** 句末时间；有就用它算块宽，没有才按字数估 */
  durMs?: number
  /** 说话人。ASR 不做说话人分离，真实数据通常只有一位 */
  who: string
  text: string
  /** 未定稿（还在转写中的那句） */
  partial?: boolean
}

export interface SpinePin {
  /** 挂在第几句上（纪要条目本来就有 refs，直接复用） */
  idx: number
  kind: 'answer' | 'todo'
  text: string
}

const props = withDefaults(
  defineProps<{
    segments: SpineSeg[]
    /** 总时长；缺省取最后一句 + 一句的估时 */
    totalMs?: number
    pins?: SpinePin[]
    /** full 整脊 / mini 一行缩略 */
    size?: 'full' | 'mini'
    mode?: 'structure' | 'read'
    /** 播放/录制游标（毫秒） */
    headMs?: number
    /** 当前高亮句下标 */
    activeIdx?: number
    /** 静默超过这个秒数就折叠，0 = 不折 */
    foldSilenceOver?: number
  }>(),
  { size: 'full', mode: 'structure', foldSilenceOver: 8 },
)

const emit = defineEmits<{
  seek: [ms: number]
  pick: [idx: number]
  unfold: [i: number]
}>()

/** 块宽：优先用 ASR 给的真实句末时间；只有它缺失时才按字数估朗读时长。
 *  估的时候不超过到下一句的间隔 —— 剩下的部分就是静默。 */
function estimateDur(i: number): number {
  const s = props.segments[i]!
  if (s.durMs != null && s.durMs > 0) return s.durMs
  const next = props.segments[i + 1]
  const byText = Math.max(900, Math.min(14_000, (s.text.length / 5.2) * 1000))
  if (!next) return byText
  return Math.min(byText, Math.max(400, next.t - s.t))
}

const total = computed(() => props.totalMs ?? (props.segments.at(-1)?.t ?? 0) + estimateDur(props.segments.length - 1))

const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / Math.max(1, total.value)) * 100))}%`

interface Block {
  idx: number
  who: string
  t: number
  dur: number
  text: string
  partial: boolean
  /** 本句之前是否有被折叠的静默 */
  foldBefore: number
}

const blocks = computed<Block[]>(() =>
  props.segments.map((s, i) => {
    const prev = props.segments[i - 1]
    const gap = prev ? s.t - (prev.t + estimateDur(i - 1)) : 0
    return {
      idx: i,
      who: s.who,
      t: s.t,
      dur: estimateDur(i),
      text: s.text,
      partial: !!s.partial,
      foldBefore: props.foldSilenceOver > 0 && gap > props.foldSilenceOver * 1000 ? gap : 0,
    }
  }),
)

/** 说话人 → 泳道（最多两条；超过两条的会话按前两位分流） */
const lanes = computed(() => {
  const seen: string[] = []
  for (const s of props.segments) if (!seen.includes(s.who)) seen.push(s.who)
  return seen.slice(0, 2)
})
const laneOf = (who: string) => Math.max(0, lanes.value.indexOf(who))

const rulerTicks = computed(() => {
  const stepChoices = [30_000, 60_000, 300_000, 600_000, 900_000]
  const step = stepChoices.find((s) => total.value / s <= 8) ?? 900_000
  const out: { ms: number; label: string }[] = []
  for (let ms = 0; ms <= total.value; ms += step) out.push({ ms, label: fmt(ms) })
  return out
})

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 把注记挂到对应句子的时间点上；同句多条合并成一个锚点 */
const pinsOnAxis = computed(() => {
  const byIdx = new Map<number, SpinePin[]>()
  for (const p of props.pins ?? []) {
    const list = byIdx.get(p.idx) ?? []
    list.push(p)
    byIdx.set(p.idx, list)
  }
  return [...byIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, items]) => ({
      idx,
      items,
      t: props.segments[idx]?.t ?? 0,
      hasTodo: items.some((x) => x.kind === 'todo'),
    }))
})

const hasTodoPins = computed(() => (props.pins ?? []).some((p) => p.kind === 'todo'))
const headPct = computed(() => (props.headMs == null ? null : pct(props.headMs)))

function onAxisClick(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  emit('seek', Math.round(ratio * total.value))
}
</script>

<template>
  <!-- ============ 缩略脊：列表 / 浮条 / 选择器用 ============ -->
  <div v-if="size === 'mini'" class="mini" :aria-label="`会话缩略 ${fmt(total)}`">
    <span
      v-for="b in blocks"
      :key="b.idx"
      class="mblk"
      :class="[`lane-${laneOf(b.who)}`, { partial: b.partial }]"
      :style="{ left: pct(b.t), width: pct(b.dur) }"
    />
    <span v-if="headPct" class="mhead" :style="{ left: headPct }" />
  </div>

  <!-- ============ 结构脊：整场压进一屏 ============ -->
  <div v-else-if="mode === 'structure'" class="spine">
    <div class="lanes">
      <div v-for="(w, li) in lanes" :key="w" class="lane-row">
        <span v-if="lanes.length > 1" class="lane-name">{{ w }}</span>
        <div class="lane-track" @click="onAxisClick">
          <button
            v-for="b in blocks.filter((x) => laneOf(x.who) === li)"
            :key="b.idx"
            class="blk"
            :class="{ on: b.idx === activeIdx, partial: b.partial }"
            :style="{ left: pct(b.t), width: pct(b.dur) }"
            :title="b.text"
            @click.stop="emit('pick', b.idx)"
          >
            <span class="btext">{{ b.text }}</span>
          </button>
        </div>
      </div>

      <!-- 静默折叠：一条细缝 -->
      <div v-if="blocks.some((x) => x.foldBefore)" class="folds">
        <span v-if="lanes.length > 1" class="lane-name" />
        <div class="fold-track" @click="onAxisClick">
          <button
            v-for="b in blocks.filter((x) => x.foldBefore)"
            :key="`f-${b.idx}`"
            class="fold"
            :style="{ left: pct(b.t - b.foldBefore), width: pct(b.foldBefore) }"
            :aria-label="`静默 ${Math.round(b.foldBefore / 1000)} 秒`"
            @click.stop="emit('unfold', b.idx)"
          >
            <i /><i /><i />
          </button>
        </div>
      </div>

      <!-- 坐标轴 + 纪要锚点 -->
      <div class="axis">
        <span v-if="lanes.length > 1" class="lane-name" />
        <div class="axis-track" @click="onAxisClick">
          <span v-for="tick in rulerTicks" :key="tick.ms" class="tick" :style="{ left: pct(tick.ms) }">
            <i /><em class="num">{{ tick.label }}</em>
          </span>
          <button
            v-for="p in pinsOnAxis"
            :key="`p-${p.idx}`"
            class="pin"
            :class="{ todo: p.hasTodo }"
            :style="{ left: pct(p.t) }"
            :aria-label="`第 ${p.idx + 1} 句处的纪要`"
            @click.stop="emit('pick', p.idx)"
          />
          <span v-if="headPct" class="head" :style="{ left: headPct }" />
        </div>
      </div>
    </div>

    <p class="legend">
      <span><i class="sw lane-0" />{{ lanes[0] ?? '—' }}</span>
      <span v-if="lanes[1]"><i class="sw lane-1" />{{ lanes[1] }}</span>
      <span v-if="hasTodoPins"><i class="sw pin-sw" />待办</span>
      <span class="dim">块宽 = 说话时长 · 点块跳转</span>
    </p>
  </div>

  <!-- ============ 精读：文字展开，时间仍在 ============ -->
  <div v-else class="reading">
    <div class="strip" @click="onAxisClick">
      <span
        v-for="b in blocks"
        :key="b.idx"
        class="sblk"
        :class="[`lane-${laneOf(b.who)}`, { on: b.idx === activeIdx }]"
        :style="{ left: pct(b.t), width: pct(b.dur) }"
      />
      <span v-if="headPct" class="mhead" :style="{ left: headPct }" />
    </div>

    <ol class="lines">
      <template v-for="b in blocks" :key="b.idx">
        <li v-if="b.foldBefore" class="silence">
          <span class="stime num">{{ fmt(b.t - b.foldBefore) }}</span>
          <span class="slabel">静默 {{ Math.round(b.foldBefore / 1000) }} 秒</span>
        </li>
        <li
          class="tl"
          :class="{ on: b.idx === activeIdx, partial: b.partial }"
          @click="emit('pick', b.idx)"
        >
          <time class="num">{{ fmt(b.t) }}</time>
          <span class="who">{{ b.who }}</span>
          <p>
            {{ b.text }}<span v-if="b.partial" class="caret" />
            <button
              v-for="p in pinsOnAxis.find((x) => x.idx === b.idx)?.items ?? []"
              :key="p.text"
              class="ipin"
              :class="{ todo: p.kind === 'todo' }"
              :title="p.text"
            >
              <component :is="p.kind === 'todo' ? ListTodo : MessageCircle" :size="10" />
            </button>
          </p>
          <button class="jump" :aria-label="`从 ${fmt(b.t)} 播放`" @click.stop="emit('seek', b.t)">
            <Play :size="11" />
          </button>
        </li>
      </template>
    </ol>

    <p v-if="pinsOnAxis.length" class="pinbar">
      <ChevronRight :size="12" />
      本场有 {{ pinsOnAxis.length }} 处纪要锚点，点句尾的角标可对照
    </p>
  </div>
</template>

<style scoped>
/* ===== 缩略脊 ===== */
.mini {
  position: relative;
  width: 100%;
  height: 18px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.mblk {
  position: absolute;
  top: 4px;
  height: 10px;
  min-width: 2px;
  border-radius: 3px;
}

.mblk.partial {
  opacity: 0.55;
}

.mhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: var(--text-1);
}

/* 两说话人：域色 + 中性，避免再引入第三第四种颜色 */
.lane-0 {
  background: var(--led-shopping);
}

.lane-1 {
  background: color-mix(in srgb, var(--led-shopping) 42%, var(--surface-2));
}

/* ===== 结构脊 ===== */
.spine {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lanes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lane-row,
.folds,
.axis {
  display: flex;
  align-items: center;
  gap: 10px;
}

.lane-name {
  flex: none;
  width: 34px;
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lane-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 34px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  cursor: crosshair;
}

.blk {
  position: absolute;
  top: 4px;
  bottom: 4px;
  min-width: 3px;
  padding: 0 7px;
  border-radius: 7px;
  overflow: hidden;
  text-align: left;
  color: var(--on-accent);
}

.blk.on {
  outline: 2px solid var(--text-1);
  outline-offset: 1px;
}

.blk.partial {
  opacity: 0.6;
}

.btext {
  display: block;
  font-size: var(--fs-micro);
  line-height: 26px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fold-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 16px;
  cursor: pointer;
}

.fold {
  position: absolute;
  top: 6px;
  height: 4px;
  min-width: 8px;
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  gap: 2px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-3) 22%, transparent);
}

.fold i {
  width: 1px;
  height: 4px;
  background: var(--surface);
}

.axis-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 26px;
  border-top: 1px solid var(--line-strong);
  cursor: crosshair;
}

.tick {
  position: absolute;
  top: 0;
}

.tick i {
  display: block;
  width: 1px;
  height: 5px;
  background: var(--line-strong);
}

.tick em {
  position: absolute;
  top: 6px;
  transform: translateX(-50%);
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.pin {
  position: absolute;
  top: -5px;
  width: 9px;
  height: 9px;
  transform: translateX(-50%) rotate(45deg);
  border-radius: 2px;
  background: var(--led-shopping);
}

.pin.todo {
  background: var(--cat-work);
}

.head {
  position: absolute;
  top: -6px;
  bottom: 0;
  width: 1.5px;
  background: var(--text-1);
}

.legend {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-left: 44px;
  font-size: var(--fs-micro);
  color: var(--text-2);
}

.legend span {
  display: flex;
  align-items: center;
  gap: 5px;
}

.legend .dim {
  margin-left: auto;
  color: var(--text-3);
}

.sw {
  width: 9px;
  height: 9px;
  border-radius: 3px;
}

.sw.pin-sw {
  border-radius: 2px;
  transform: rotate(45deg);
  background: var(--cat-work);
}

/* ===== 精读 ===== */
.reading {
  display: flex;
  flex-direction: column;
}

.strip {
  position: relative;
  height: 16px;
  margin-bottom: 6px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
  cursor: crosshair;
}

.sblk {
  position: absolute;
  top: 3px;
  height: 10px;
  min-width: 2px;
  border-radius: 3px;
}

.sblk.on {
  height: 14px;
  top: 1px;
}

.lines {
  display: flex;
  flex-direction: column;
}

.tl {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 10px 6px;
  margin: 0 -6px;
  border-bottom: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
}

.tl:last-child {
  border-bottom: none;
}

.tl.on {
  background: color-mix(in srgb, var(--led-shopping) 9%, transparent);
}

.tl.partial p {
  color: var(--text-2);
}

.tl time {
  flex: none;
  width: 38px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.tl .who {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
  color: var(--led-shopping);
}

.tl p {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-callout);
  line-height: 1.6;
  color: var(--text-1);
}

.tl .jump {
  flex: none;
  align-self: center;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  opacity: 0;
}

.tl:hover .jump,
.tl.on .jump {
  opacity: 1;
}

.ipin {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  margin-left: 5px;
  vertical-align: -2px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--led-shopping) 16%, transparent);
  color: var(--led-shopping);
}

.ipin.todo {
  background: color-mix(in srgb, var(--cat-work) 18%, transparent);
  color: var(--cat-work);
}

.silence {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 6px 5px 0;
}

.stime {
  flex: none;
  width: 38px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  opacity: 0.6;
}

.slabel {
  font-size: var(--fs-micro);
  color: var(--text-3);
  padding: 2px 9px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-3) 12%, transparent);
}

.pinbar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.caret {
  display: inline-block;
  width: 2px;
  height: 13px;
  margin-left: 3px;
  vertical-align: -2px;
  background: var(--led-shopping);
  animation: caret 1s steps(2) infinite;
}

@keyframes caret {
  50% {
    opacity: 0;
  }
}
</style>
