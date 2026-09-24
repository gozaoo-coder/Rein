<script setup lang="ts">
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { LayoutGrid, Sparkles } from 'lucide-vue-next'

import GlassSurface from '@/components/common/GlassSurface.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import {
  GLASS_PARAM_SPECS,
  glassParams,
  glassTuned,
  resetGlassParams,
  setGlassParam,
  type GlassParamKey,
  type GlassParamSpec,
} from '@/system/glassParams'
import { glassPipeline, liquidGlass, setPerfMode } from '@/system/perf'

/**
 * 液态玻璃参数调节面板（画质预览页的入口拉开）。
 *
 * 面板自带一块**暗场预览**：折射采样的是背后的东西，台子上有细格与光晕才看得出
 * 位移与色散；三块玻璃按真实 Dock 的装配摆（圆 + 药丸 + 圆）。台内换的是与标本台
 * 同一套暗场玻璃上下文（--hero-* 那组），所以这里看到的材质就是 Dock 上的材质。
 *
 * 每一行 = 英文键名（与 GlassSurface 的 prop 同名）+ 中文名 + 当前值 + 滑杆：
 * 值点一下就地输入（吸附到步长、夹回区间），滑杆给的是宽区间 —— 这一页是给
 * 「调到合适为止」用的，不是日常微调。改动即时写进 system/glassParams 并存本地，
 * 定稿后把那组数写回 GLASS_DEFAULTS 即可。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

/** 小数位从步长推出来（0.02 → 2 位、1 → 0 位）：读数、输入框、吸附共用一套 */
function decimals(step: number): number {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

function fmt(spec: GlassParamSpec): string {
  return glassParams.value[spec.key].toFixed(decimals(spec.step))
}

/* ---------- 点一下就地输入（与数字步进器同一套手感） ---------- */
const editing = ref<GlassParamKey | null>(null)
const draft = ref('')
let inputEl: HTMLInputElement | null = null

function setInputRef(el: Element | ComponentPublicInstance | null): void {
  inputEl = (el as HTMLInputElement | null) ?? null
}

function beginEdit(spec: GlassParamSpec): void {
  draft.value = fmt(spec)
  editing.value = spec.key
  void nextTick(() => {
    inputEl?.focus()
    inputEl?.select()
  })
}

function cancelEdit(): void {
  editing.value = null
}

/** 提交：解析 → 吸附到步长 → 夹回区间（越界与垃圾输入都拖不坏玻璃） */
function commit(spec: GlassParamSpec): void {
  if (editing.value !== spec.key) return
  editing.value = null
  const n = Number(draft.value.replace(/[，,\s]/g, ''))
  if (!Number.isFinite(n)) return
  const snapped = spec.min + Math.round((n - spec.min) / spec.step) * spec.step
  setGlassParam(spec.key, Number(snapped.toFixed(decimals(spec.step))))
}

function onSlide(spec: GlassParamSpec, e: Event): void {
  setGlassParam(spec.key, Number((e.target as HTMLInputElement).value))
}

const stateText = computed(() =>
  liquidGlass.value
    ? `折射已开启（${glassPipeline.value === 'collapsed' ? '塌缩管线' : '完整管线'}），下面的拖动即时生效`
    : '当前档位没有折射，参数只在「超高」两档生效',
)
</script>

<template>
  <SheetModal :open="props.open" title="液态玻璃参数" initial-snap="large" @close="emit('close')">
    <template #action>
      <button type="button" class="reset" :disabled="!glassTuned" @click="resetGlassParams">恢复默认</button>
    </template>

    <!-- 暗场预览：细格给位移当量尺，光晕给边缘当色散源（纯装饰，读屏不必知道） -->
    <div class="stage stage-dark" aria-hidden="true">
      <span class="glow" />
      <span class="grid" />
      <div class="stage-row">
        <GlassSurface :width="54" :height="54" border-radius="50%" tint="dark">
          <span class="glyph"><LayoutGrid :size="20" /></span>
        </GlassSurface>
        <GlassSurface class="stage-pill" :height="54" border-radius="27" tint="dark">
          <span class="stage-tabs">
            <span class="stage-tab on">主页</span>
            <span class="stage-tab">运动</span>
            <span class="stage-tab">AI</span>
          </span>
        </GlassSurface>
        <GlassSurface :width="54" :height="54" border-radius="50%" tint="dark">
          <span class="glyph"><Sparkles :size="20" /></span>
        </GlassSurface>
      </div>
    </div>

    <!-- 参数只作用于折射分支：没开折射时先说清楚，并给一键切档 -->
    <p class="state" :class="liquidGlass ? 'on' : 'warn'">
      <span class="sdot" />
      <span class="stxt">{{ stateText }}</span>
      <button v-if="!liquidGlass" type="button" class="jump" @click="setPerfMode('ultra-opt')">切到超高（优化）</button>
    </p>

    <div class="params">
      <div v-for="s in GLASS_PARAM_SPECS" :key="s.key" class="prow">
        <div class="ptop">
          <code class="pkey">{{ s.key }}</code>
          <span class="pcn">{{ s.cn }}</span>
          <button
            v-if="editing !== s.key"
            type="button"
            class="pval num"
            :aria-label="`修改 ${s.cn}`"
            @click="beginEdit(s)"
          >
            {{ fmt(s) }}
          </button>
          <input
            v-else
            :ref="setInputRef"
            v-model="draft"
            class="pval num edit"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :aria-label="`输入 ${s.cn}`"
            @blur="commit(s)"
            @keydown.enter="commit(s)"
            @keydown.esc="cancelEdit"
          />
        </div>
        <input
          class="prange"
          type="range"
          :min="s.min"
          :max="s.max"
          :step="s.step"
          :value="glassParams[s.key]"
          :aria-label="`${s.cn} ${s.key}`"
          @input="onSlide(s, $event)"
        />
      </div>
    </div>

    <p class="pnote t-3">
      按管线顺序排：位移贴图（边缘厚度 / 中心亮度 / 贴图模糊）→ 三通道位移（位移强度 + 通道偏移，
      偏移拉开就是边缘的彩色色散）→ 收尾柔化 → 表面（背景饱和度 / 底色浓度）。
      数值点一下可直接输入；改动即时生效并存在本机。
    </p>
  </SheetModal>
</template>

<style scoped>
.reset {
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.reset:disabled {
  opacity: 0.4;
}

/* ---------- 暗场预览 ---------- */
/* 台内换一套玻璃材质：class 上的 .stage-dark（base.css）—— 暗底上的玻璃按应用在
   暗场的做法压暗（HUD 芯片材质），受光边换中性白，前景因此永远是浅色。
   与画质预览页的标本台**共用那一份**（两处原本各抄了一遍，正是"两份定义必然漂"
   那类事故的温床）；弱档的实底退化也在那份里。 */
.stage {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 4px 0 12px;
  padding: 22px 12px;
  border-radius: var(--radius-l);
  background: var(--hero-bg);
}

/* 「减弱透明度」：折射与白雾底都是内联样式，媒体查询在组件里够不着，靠调用处压住 */
@media (prefers-reduced-transparency: reduce) {
  .stage {
    --surface: var(--hero-bg);
    --line-strong: var(--hero-chip-line);
  }

  .stage :deep(.glass) {
    background: var(--hero-bg) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}

.glow,
.grid {
  position: absolute;
  pointer-events: none;
}

.glow {
  top: -60%;
  left: -10%;
  width: 90%;
  height: 200%;
  border-radius: 50%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--c-exercise) 42%, transparent), transparent);
}

.grid {
  inset: 0;
  background-image:
    linear-gradient(var(--hero-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--hero-grid) 1px, transparent 1px);
  background-size: 12px 12px;
}

.stage-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 300px;
}

.stage-pill {
  flex: 1;
  min-width: 0;
}

.glyph {
  display: flex;
  color: var(--hero-text);
}

.stage-tabs {
  display: flex;
  width: 100%;
  height: 100%;
}

.stage-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--hero-text-dim);
  font-size: var(--fs-micro);
  font-weight: 600;
}

.stage-tab.on {
  color: var(--hero-text);
}

/* ---------- 状态 ---------- */
.state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.sdot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}

.state.on .sdot {
  background: var(--c-exercise);
}

.state.warn .sdot {
  background: var(--warn);
}

.jump {
  flex: none;
  margin-left: auto;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: 700;
}

/* ---------- 参数行 ---------- */
.ptop {
  display: flex;
  align-items: center;
  gap: 7px;
}

.pkey {
  flex: none;
  padding: 1px 5px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  color: var(--text-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--fs-micro);
}

.pcn {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

/* 当前值：点一下就地输入（数字等宽，避免拖动滑杆时抖动） */
.pval {
  flex: none;
  margin-left: auto;
  min-width: 64px;
  padding: 3px 6px;
  border-radius: var(--radius-s);
  color: var(--accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.pval:active {
  background: var(--surface-2);
}

.pval.edit {
  border-bottom: 1px solid var(--accent);
  background: none;
  color: var(--text-1);
}

.prange {
  width: 100%;
  height: 28px;
  margin-top: 1px;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
}

.prange::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.prange::-webkit-slider-thumb {
  width: 20px;
  height: 20px;
  margin-top: -8px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
  appearance: none;
  -webkit-appearance: none;
}

.prange::-moz-range-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.prange::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
}

.pnote {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.6;
}
</style>
