<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Info, RotateCcw } from 'lucide-vue-next'

import GrabTimeline from '@/components/campus/GrabTimeline.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import { useCourseSelectStore } from '@/stores/courseSelect'
import type { GrabSettings } from '@/types'

/**
 * 抢课节奏设置。
 *
 * 只暴露**真正需要动的旋钮**，其余（退避上限、轮询上限）留给默认值 ——
 * 一个抢课页面不该有一屏工程参数，调错了还会让人以为程序坏了。
 *
 * 每个数字旁边都写清「调大/调小会怎样」，因为这些值的取舍是**概率**而不是对错：
 * 快一点更容易被风控，慢一点更容易被别人抢走。用户该知道自己在换什么。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const store = useCourseSelectStore()
const toast = useToast()

const draft = ref<GrabSettings | null>(null)
const saving = ref(false)

const DEFAULTS: GrabSettings = {
  minIntervalMs: 700,
  pollIntervalMs: 2000,
  fullRetryMs: 5000,
  backoffMs: 1500,
  maxBackoffMs: 30000,
  leadMs: 800,
  maxAttempts: 0,
  maxPolls: 15,
  cedeAfterMs: 0,
  watchWindow: true,
}

const s = computed(() => draft.value ?? store.grabSettings ?? DEFAULTS)

watch(
  () => props.open,
  (open) => {
    if (open) draft.value = { ...(store.grabSettings ?? DEFAULTS) }
  },
)

onMounted(() => {
  if (!store.grabSettings) void store.loadGrabSettings()
})

function set<K extends keyof GrabSettings>(key: K, value: GrabSettings[K]): void {
  draft.value = { ...s.value, [key]: value }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await store.saveGrabSettings(s.value)
    toast.toast('已生效')
    emit('close')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

function reset(): void {
  draft.value = { ...DEFAULTS }
}

/**
 * 让贤期限对用户按**秒**显示（毫秒没人愿意读），存库仍是毫秒。
 * 0 是有意义的取值（= 死守），所以下限就是 0，不做「至少几分钟」的兜底。
 */
const cedeSec = computed({
  get: () => Math.round(s.value.cedeAfterMs / 1000),
  set: (v: number) => set('cedeAfterMs', Math.max(0, Math.round(v)) * 1000),
})

/**
 * 正在调哪个参数 —— 时间轴上对应的那一段会被点亮，其余淡下去。
 *
 * 靠 `focusin` / `pointerdown` 冒泡到这一层来判定，而不是给每个控件加事件：
 * 这样以后再加参数，只要把它放进同一块 `<section data-key="…">` 里就自动接上。
 */
const active = ref<keyof GrabSettings | null>(null)

function markActive(e: Event): void {
  const sec = (e.target as HTMLElement | null)?.closest?.('[data-key]')
  const key = sec?.getAttribute('data-key')
  if (key) active.value = key as keyof GrabSettings
}

/**
 * 节奏档位：把「要调成多快」这件事做成一次点击，而不是让人点几十下加号。
 *
 * 每一档都写明它的**代价**，因为这几个数字不是对错问题 —— 是拿封禁风险换命中率。
 * 「压测档」标了 12ms（≈80 次/秒），那是拿真账号对教务压出来的数，不是猜的。
 */
const PRESETS: { name: string; hint: string; patch: Partial<GrabSettings> }[] = [
  { name: '保守', hint: '默认节奏，最不容易被风控盯上', patch: { minIntervalMs: 700, pollIntervalMs: 2000, fullRetryMs: 5000 } },
  { name: '偏快', hint: '窗口很短、课又热门时用', patch: { minIntervalMs: 200, pollIntervalMs: 800, fullRetryMs: 1500 } },
  { name: '压测档', hint: '≈80 次/秒，实测无异常但风险自负', patch: { minIntervalMs: 12, pollIntervalMs: 300, fullRetryMs: 600 } },
]

function applyPreset(p: (typeof PRESETS)[number]): void {
  draft.value = { ...s.value, ...p.patch }
  active.value = 'minIntervalMs'
}
</script>

<template>
  <SheetModal :open="open" title="抢课节奏" initial-snap="medium" @close="emit('close')">
    <p class="lead t-2">
      这些数字是<b>概率上的取舍</b>：快一点更容易被教务风控拦下，慢一点更容易被别人抢走。
      默认值按「抢 1–4 门课」标定，不确定就别改。
    </p>

    <!-- 时间轴放在最前面：先看懂循环长什么样，再谈调哪个数字 -->
    <GrabTimeline :settings="s" :active="active" />

    <div class="presets">
      <button
        v-for="p in PRESETS"
        :key="p.name"
        class="preset"
        :title="p.hint"
        @click="applyPreset(p)"
      >
        <b>{{ p.name }}</b>
        <em>{{ p.hint }}</em>
      </button>
    </div>

    <div class="rows" @focusin="markActive" @pointerdown="markActive">
      <section class="block" data-key="minIntervalMs" @pointerenter="active = 'minIntervalMs'">
        <NumberStepper
          :model-value="s.minIntervalMs"
          :min="10"
          :max="5000"
          :step="50"
          unit="ms"
          label="两次提交的最小间隔"
          @update:model-value="set('minIntervalMs', $event)"
        />
        <p class="hint">
          <Info :size="13" />
          <span>
            所有任务共用一个闸门 —— 排 5 门课不会变成 5 倍请求量。
            <b>它才是「多久打一次教务」的总开关</b>，其余几个等待都得排在它后面。
          </span>
        </p>
      </section>

      <section class="block" data-key="leadMs" @pointerenter="active = 'leadMs'">
        <NumberStepper
          :model-value="s.leadMs"
          :min="0"
          :max="3000"
          :step="50"
          unit="ms"
          label="开窗前提前出手"
          @update:model-value="set('leadMs', $event)"
        />
        <p class="hint">
          <Info :size="13" />
          <span>
            请求在路上要走一会。提前这一点出手，才能让<b>请求本身</b>落在开窗那一瞬间，
            而不是排在开窗之后。网络越慢越该调大。
          </span>
        </p>
      </section>

      <section class="block" data-key="pollIntervalMs" @pointerenter="active = 'pollIntervalMs'">
        <NumberStepper
          :model-value="s.pollIntervalMs"
          :min="50"
          :max="10000"
          :step="100"
          unit="ms"
          label="查结果间隔"
          @update:model-value="set('pollIntervalMs', $event)"
        />
        <p class="hint">
          <Info :size="13" /> 提交之后隔多久问一次「选上了吗」。教务自己也是 2 秒一次。
        </p>
      </section>

      <section class="block" data-key="fullRetryMs" @pointerenter="active = 'fullRetryMs'">
        <NumberStepper
          :model-value="s.fullRetryMs"
          :min="100"
          :max="60000"
          :step="100"
          unit="ms"
          label="满员后重试间隔"
          @update:model-value="set('fullRetryMs', $event)"
        />
        <p class="hint">
          <Info :size="13" />
          「已满」会一直守着，但节奏放慢 —— 名额释放是稀疏事件，打快了只是白费力气。
        </p>
      </section>

      <section class="block" data-key="maxAttempts" @pointerenter="active = 'maxAttempts'">
        <NumberStepper
          :model-value="s.maxAttempts"
          :min="0"
          :max="500"
          :step="5"
          unit="次"
          label="最多提交次数"
          @update:model-value="set('maxAttempts', $event)"
        />
        <p class="hint">
          <Info :size="13" /> 0 = 不限，一直抢到窗口关闭。抢课通常都设 0；
          只在你想限制「试几次不行就算了」时才填。
        </p>
      </section>

      <!-- 志愿组：这条是「互斥备选」的耐心旋钮 -->
      <section class="block" data-key="cedeAfterMs" @pointerenter="active = 'cedeAfterMs'">
        <NumberStepper
          v-model="cedeSec"
          :min="0"
          :max="3600"
          :step="30"
          unit="秒"
          label="让贤期限"
        />
        <p class="hint">
          <Info :size="13" />
          <span>
            只在<b>志愿组</b>里有意义。当前志愿一直满员超过这么久，就把出手机会让给下一志愿。
            <b>0 = 死守</b>：只有它彻底没戏（时间冲突 / 连败 / 窗口关闭）才轮到下一个 ——
            满员是等得到名额的，所以默认死守。
          </span>
        </p>
      </section>

      <section class="block toggle-row" data-key="watchWindow" @pointerenter="active = 'watchWindow'">
        <div class="col">
          <b>窗口监听</b>
          <em class="t-3">App 开着就每分钟问一次「窗口公布了没有」，即使还没排任何课</em>
        </div>
        <ToggleSwitch
          :model-value="s.watchWindow"
          label="窗口监听"
          @update:model-value="set('watchWindow', $event)"
        />
        <p class="hint">
          <Info :size="13" />
          关掉它，你就只能在手动刷新页面时才发现窗口开了。开着才可能「窗口一开就收到提示」。
        </p>
      </section>
    </div>

    <div class="acts">
      <button class="primary" :disabled="saving" @click="save">保存</button>
      <button class="ghost" @click="reset">
        <RotateCcw :size="14" /> 恢复默认
      </button>
    </div>
  </SheetModal>
</template>

<style scoped>
.lead {
  font-size: var(--fs-caption);
  line-height: 1.55;
  margin-bottom: 14px;
}

.block {
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  margin-bottom: 10px;
}

/* 节奏档位：一次点击把三个数字一起调好，省得点几十下加号 */
.presets {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}

.preset {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 6px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.preset:active {
  transform: scale(0.97);
}

.preset b {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-1);
}

.preset em {
  font-size: var(--fs-micro);
  font-style: normal;
  color: var(--text-3);
  line-height: 1.3;
}

.toggle-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 10px;
}

.toggle-row .col {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.toggle-row b {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
}

.toggle-row em {
  font-size: var(--fs-micro);
  font-style: normal;
  line-height: 1.45;
}

.toggle-row .hint {
  grid-column: 1 / -1;
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.5;
  margin-top: 4px;
}

.hint svg {
  flex: none;
  margin-top: 2px;
}

.acts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.primary {
  padding: 13px;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
}

.ghost {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 11px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.primary:disabled {
  opacity: 0.45;
}
</style>
