<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Scale, TrendingDown, TrendingUp } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import { parseDate, todayStr } from '@/utils/date'
import type { BodyMetric } from '@/types'

/** 体重 · 身高追踪：按天记录、趋势与历史；非空值自动同步进身体资料。 */
const n = useNutritionStore()
const { toast } = useToast()

onMounted(() => {
  void n.loadMetrics()
})

/* ---- 当前状态（从记录回溯取最近的非空值） ---- */
type MetricField = 'weightKg' | 'heightCm'

function lastValue(key: MetricField): number | null {
  for (const m of n.metrics) {
    const v = m[key]
    if (v != null) return v
  }
  return null
}

/** 较上一条同类值的增量（正为升 / 负为降），无可比对象时为 null */
function deltaFrom(index: number, key: MetricField): number | null {
  const cur = n.metrics[index]?.[key]
  if (cur == null) return null
  for (let i = index + 1; i < n.metrics.length; i++) {
    const prev = n.metrics[i]![key]
    if (prev != null) {
      const d = Math.round((cur - prev) * 10) / 10
      return d === 0 ? null : d
    }
  }
  return null
}

const latestWeight = computed(() => lastValue('weightKg'))
const latestHeight = computed(() => lastValue('heightCm'))

const bmi = computed<{ value: number; label: string; cls: string } | null>(() => {
  const w = latestWeight.value
  const hCm = latestHeight.value ?? n.profile?.heightCm
  if (w == null || hCm == null || hCm <= 0) return null
  const v = Math.round((w / (hCm / 100) ** 2) * 10) / 10
  // 中国成人标准（WS/T 428）
  const [label, cls] =
    v < 18.5 ? ['偏瘦', 'warn'] : v < 24 ? ['正常', 'ok'] : v < 28 ? ['超重', 'warn'] : ['肥胖', 'bad']
  return { value: v, label, cls }
})

/* ---- 体重趋势（最近 ≤30 条含体重的记录，时间升序） ---- */
const CHART_W = 320
const CHART_H = 84
const PAD_X = 5
const PAD_Y = 12

const trend = computed(() =>
  [...n.metrics]
    .filter((m): m is BodyMetric & { weightKg: number } => m.weightKg != null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30)
    .map((m) => ({ date: m.date, v: m.weightKg })),
)

const trendGeom = computed(() => {
  const pts = trend.value
  if (pts.length < 2) return null
  const vs = pts.map((p) => p.v)
  const min = Math.min(...vs)
  const max = Math.max(...vs)
  const span = Math.max(max - min, 0.8)
  const lo = min - span * 0.12
  const hi = max + span * 0.12
  const x = (i: number) => PAD_X + (i * (CHART_W - PAD_X * 2)) / (pts.length - 1)
  const y = (v: number) => PAD_Y + ((hi - v) / (hi - lo)) * (CHART_H - PAD_Y * 2)
  return {
    points: pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '),
    area: `M${x(0).toFixed(1)},${y(vs[0]!).toFixed(1)} ${pts
      .map((p, i) => `L${x(i).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(' ')} L${x(pts.length - 1).toFixed(1)},${CHART_H} L${x(0).toFixed(1)},${CHART_H} Z`,
    last: { x: x(pts.length - 1), y: y(vs[vs.length - 1]!) },
    min,
    max,
    from: pts[0]!.date,
    to: pts[pts.length - 1]!.date,
  }
})

function fmtShort(s: string): string {
  const d = parseDate(s)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/* ---- 记录弹层 ---- */
const r1 = (v: number) => Math.round(v * 10) / 10

const sheetOpen = ref(false)
const saving = ref(false)
const formDate = ref(todayStr())
const formWeight = ref(70)
const formHeight = ref(175)

function openSheet(): void {
  formDate.value = todayStr()
  formWeight.value = r1(lastValue('weightKg') ?? n.profile?.weightKg ?? 70)
  formHeight.value = r1(lastValue('heightCm') ?? n.profile?.heightCm ?? 175)
  sheetOpen.value = true
}

async function submit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    await n.recordMetric({
      date: formDate.value,
      weightKg: r1(formWeight.value),
      heightCm: r1(formHeight.value),
    })
    toast('已记录 · 身体资料已同步')
    sheetOpen.value = false
  } finally {
    saving.value = false
  }
}

/* ---- 单条记录操作 ---- */
const entryOpen = ref(false)
const entry = ref<BodyMetric | null>(null)

function tapEntry(m: BodyMetric): void {
  entry.value = m
  entryOpen.value = true
}

async function onEntrySelect(value: string): Promise<void> {
  if (value === 'delete' && entry.value) {
    await n.deleteMetric(entry.value.id)
    toast('已删除该条记录')
  }
}
</script>

<template>
  <section class="card">
    <header class="row between">
      <div>
        <h2>体重 · 身高追踪</h2>
        <p class="t-3">按天记录变化 · 自动同步身体资料</p>
      </div>
      <button class="rec row center" @click="openSheet">记录</button>
    </header>

    <!-- 空态 -->
    <EmptyState
      v-if="!n.metrics.length"
      :icon="Scale"
      title="还没有记录"
      hint="点右上角「记录」，开始追踪体重与身高"
    />

    <template v-else>
      <!-- 当前状态 -->
      <ul class="stats">
        <li>
          <em>最新体重</em>
          <b class="num">{{ latestWeight?.toFixed(1) ?? '--' }}<i>kg</i></b>
          <span
            v-if="deltaFrom(0, 'weightKg') !== null"
            class="delta num"
            :class="(deltaFrom(0, 'weightKg') ?? 0) < 0 ? 'down' : 'up'"
          >
            <TrendingDown v-if="(deltaFrom(0, 'weightKg') ?? 0) < 0" :size="12" />
            <TrendingUp v-else :size="12" />
            {{ Math.abs(deltaFrom(0, 'weightKg')!).toFixed(1) }}
          </span>
        </li>
        <li>
          <em>最新身高</em>
          <b class="num">{{ latestHeight ?? '--' }}<i>cm</i></b>
        </li>
        <li>
          <em>BMI</em>
          <b class="num">{{ bmi ? bmi.value : '--' }}</b>
          <span v-if="bmi" class="bmi-tag" :class="bmi.cls">{{ bmi.label }}</span>
        </li>
      </ul>

      <!-- 体重趋势 -->
      <figure v-if="trendGeom" class="trend">
        <figcaption class="num t-3">
          <span>近 {{ trend.length }} 次体重</span>
          <span>最低 {{ trendGeom.min.toFixed(1) }} · 最高 {{ trendGeom.max.toFixed(1) }} kg</span>
        </figcaption>
        <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="bt-weight-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.22" />
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path :d="trendGeom.area" fill="url(#bt-weight-fill)" />
          <polyline
            :points="trendGeom.points"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <circle :cx="trendGeom.last.x" :cy="trendGeom.last.y" r="3.2" fill="var(--accent)" />
        </svg>
        <span class="axis num t-3"><i>{{ fmtShort(trendGeom.from) }}</i><i>{{ fmtShort(trendGeom.to) }}</i></span>
      </figure>

      <!-- 历史 -->
      <ul class="hist">
        <li
          v-for="(m, i) in n.metrics.slice(0, 5)"
          :key="m.id"
          role="button"
          tabindex="0"
          :aria-label="`编辑 ${fmtShort(m.date)} 的身体记录`"
          @click="tapEntry(m)"
          @keydown.enter.prevent="tapEntry(m)"
          @keydown.space.prevent="tapEntry(m)"
        >
          <span class="date num">
            {{ fmtShort(m.date) }}
            <i v-if="m.date === todayStr()">今天</i>
          </span>
          <span class="val num">{{ m.weightKg != null ? `${m.weightKg.toFixed(1)} kg` : '--' }}</span>
          <span class="val num t-3">{{ m.heightCm != null ? `${m.heightCm} cm` : '--' }}</span>
          <span
            v-if="deltaFrom(i, 'weightKg') !== null"
            class="delta num"
            :class="(deltaFrom(i, 'weightKg') ?? 0) < 0 ? 'down' : 'up'"
          >
            {{ (deltaFrom(i, 'weightKg') ?? 0) > 0 ? '+' : '' }}{{ deltaFrom(i, 'weightKg')!.toFixed(1) }}
          </span>
          <span v-else class="delta none"></span>
        </li>
      </ul>
      <p v-if="n.metrics.length > 5" class="more t-3">共 {{ n.metrics.length }} 条记录</p>
    </template>

    <!-- 记录弹层 -->
    <SheetModal :open="sheetOpen" title="记录体重 · 身高" @close="sheetOpen = false">
      <div class="fsheet">
        <label class="fdate">
          <span>日期</span>
          <input v-model="formDate" type="date" class="num" :max="todayStr()">
        </label>
        <NumberStepper
          :model-value="formWeight"
          label="体重"
          unit="kg"
          :step="0.1"
          :min="30"
          :max="200"
          @update:model-value="formWeight = r1($event)"
        />
        <NumberStepper
          :model-value="formHeight"
          label="身高"
          unit="cm"
          :step="0.5"
          :min="100"
          :max="250"
          @update:model-value="formHeight = r1($event)"
        />
        <button class="save" :disabled="saving" @click="submit">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <p class="fnote t-3">同一天再次记录会覆盖当天数值。</p>
      </div>
    </SheetModal>

    <!-- 单条记录操作 -->
    <ActionSheet
      :open="entryOpen"
      :title="entry ? `${entry.date} 的记录` : undefined"
      :actions="[{ label: '删除这条记录', value: 'delete', danger: true }]"
      @select="onEntrySelect"
      @close="entryOpen = false"
    />
  </section>
</template>

<style scoped>
h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

header > div > p {
  font-size: var(--fs-caption);
  margin-top: 1px;
}

.rec {
  padding: 6px 14px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-subhead);
  font-weight: 600;
  flex: none;
}

/* 当前状态 */
.stats {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.stats li {
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.stats em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.stats b {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-title2);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.stats b i {
  font-style: normal;
  font-weight: 400;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: 2px;
}

.delta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-top: 2px;
  font-size: var(--fs-micro);
  font-weight: 600;
}

.delta.down {
  color: var(--c-protein);
}

.delta.up {
  color: var(--c-carb);
}

.bmi-tag {
  display: inline-block;
  margin-top: 2px;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.bmi-tag.ok {
  background: var(--ok-soft);
  color: var(--c-protein);
}

.bmi-tag.warn {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--c-carb);
}

.bmi-tag.bad {
  background: var(--danger-soft);
  color: var(--danger);
}

/* 趋势图 */
.trend {
  margin: 14px 0 0;
}

.trend figcaption {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-micro);
}

.trend svg {
  display: block;
  width: 100%;
  height: 84px;
  margin-top: 6px;
}

.axis {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-micro);
}

.axis i {
  font-style: normal;
}

/* 历史 */
.hist {
  margin-top: 12px;
}

.hist > * + * {
  border-top: 0.5px solid var(--line);
}

.hist li {
  display: grid;
  grid-template-columns: 1fr auto auto 56px;
  align-items: center;
  gap: 14px;
  padding: 9px 0;
  cursor: pointer;
}

.hist .date {
  font-size: var(--fs-subhead);
  font-weight: 500;
}

.hist .date i {
  font-style: normal;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.hist .val {
  font-size: var(--fs-subhead);
  min-width: 62px;
  text-align: right;
}

.hist li .delta {
  justify-self: end;
  font-size: var(--fs-footnote);
}

.more {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 0.5px solid var(--line);
  text-align: center;
  font-size: var(--fs-footnote);
}

/* 记录弹层表单 */
.fsheet {
  padding-bottom: 6px;
}

.fdate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 0;
}

.fdate span {
  font-size: var(--fs-subhead);
  font-weight: 500;
}

.fdate input {
  padding: 7px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.save {
  width: 100%;
  margin-top: 16px;
  padding: 13px 0;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-headline);
  font-weight: 700;
}

.save:disabled {
  opacity: 0.5;
}

.fnote {
  margin-top: 8px;
  text-align: center;
  font-size: var(--fs-caption);
}
</style>
