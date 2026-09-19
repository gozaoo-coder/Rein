<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Info, RotateCcw } from 'lucide-vue-next'

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
</script>

<template>
  <SheetModal :open="open" title="抢课节奏" initial-snap="medium" @close="emit('close')">
    <p class="lead t-2">
      这些数字是<b>概率上的取舍</b>：快一点更容易被教务风控拦下，慢一点更容易被别人抢走。
      默认值按「抢 1–4 门课」标定，不确定就别改。
    </p>

    <section class="block">
      <NumberStepper
        :model-value="s.minIntervalMs"
        :min="300"
        :max="5000"
        :step="100"
        unit="ms"
        label="两次提交的最小间隔"
        @update:model-value="set('minIntervalMs', $event)"
      />
      <p class="hint">
        <Info :size="13" />
        所有任务共用一个闸门 —— 排 5 门课不会变成 5 倍请求量。调小等于赌教务的风控阈值，
        被拦下时会直接失败，反而更慢。
      </p>
    </section>

    <section class="block">
      <NumberStepper
        :model-value="s.leadMs"
        :min="0"
        :max="3000"
        :step="100"
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

    <section class="block">
      <NumberStepper
        :model-value="s.pollIntervalMs"
        :min="500"
        :max="10000"
        :step="500"
        unit="ms"
        label="查结果间隔"
        @update:model-value="set('pollIntervalMs', $event)"
      />
      <p class="hint">
        <Info :size="13" /> 提交之后隔多久问一次「选上了吗」。教务自己也是 2 秒一次。
      </p>
    </section>

    <section class="block">
      <NumberStepper
        :model-value="s.fullRetryMs"
        :min="1000"
        :max="60000"
        :step="1000"
        unit="ms"
        label="满员后重试间隔"
        @update:model-value="set('fullRetryMs', $event)"
      />
      <p class="hint">
        <Info :size="13" />
        「已满」会一直守着，但节奏放慢 —— 名额释放是稀疏事件，打快了只是白费力气。
      </p>
    </section>

    <section class="block">
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
    <section class="block">
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

    <section class="block toggle-row">
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
