<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Dumbbell, Play, Sparkles } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { sessionService } from '@/services/sessionService'
import { useAiStore } from '@/stores/ai'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'
import { openImmersive } from '@/system/sessionImmersive'
import type { ScoreGroupKey } from '@/config/muscles'
import type { GroupScore } from '@/utils/trainingScore'
import {
  buildCatchupPlan,
  catchupPrompt,
  gapOf,
  pickCatchup,
  type CatchupPick,
} from '@/utils/weakMuscles'

/**
 * 弱项加练：把「本周练得不够的肌群」变成一节**能直接开练的临时课程**。
 *
 * 分两层，刻意如此：
 *  1. **本地先排好**（纯函数，见 utils/weakMuscles）—— 打开即见，不依赖模型。
 *     补弱这件事的规则本身是确定的（缺多少组 → 用哪个主攻动作 → 补几组），
 *     让模型从零生成反而会引入不可复核的自由度。
 *  2. **再交给 AI 细化** —— 草稿与弱项数据一起送过去，模型有得改。
 *     模型没配也不影响第一层：按钮退化成「看一眼我该练什么」。
 *
 * 「临时」是真的临时：课程只活在内存里，`session.start()` 直接开练，
 * **不写进课程库** —— 它是「今天补一下」，不是「我的训练计划」。
 */
const props = defineProps<{ open: boolean; weak: GroupScore[] }>()
const emit = defineEmits<{ close: [] }>()

const lib = useExerciseLibStore()
const session = useSessionStore()
const ai = useAiStore()
const toast = useToast()
const router = useRouter()

const picks = ref<CatchupPick[]>([])
const loading = ref(false)
const starting = ref(false)
const conflictOpen = ref(false)

/** 用户练过的动作 id：优先从这些里挑（不用重新学动作，重量也有底） */
async function loadHistoryIds(): Promise<Set<string>> {
  try {
    const refs = await sessionService.strengthExercises()
    return new Set(refs.map((r) => r.exerciseId).filter((x): x is string => !!x))
  } catch {
    return new Set()
  }
}

async function prepare(): Promise<void> {
  loading.value = true
  try {
    await lib.ensureLoaded()
    const history = await loadHistoryIds()
    picks.value = pickCatchup(props.weak, lib.list, history)
  } catch (e) {
    console.warn('[catchup] 组装失败', e)
    picks.value = []
  } finally {
    loading.value = false
  }
}

// 每次打开重算（训练数据可能刚变），而不是 mounted 一次
watch(
  () => props.open,
  (o) => {
    if (o) void prepare()
  },
)

const plan = computed(() => buildCatchupPlan(picks.value))

/**
 * 弱项 + 跳过的，**合成一个列表**。
 *
 * 不是为了绕开什么 bug（两个相邻 v-for 在 Vue 3 里是合法的），
 * 而是两件事确实属于同一个序列：「已经排到动作的」与「动作库缺主攻动作、跳过的」
 * 都是这次判定的一部分。分两组渲染会让「跳过」那几条沉到列表末尾、
 * 读起来像附注；合起来才能按同一规则（缺口降序）排在它们该在的位置。
 */
interface WeakRow {
  group: ScoreGroupKey
  label: string
  gap: number
  /** 已排到的动作名；空 = 动作库缺主攻动作，跳过了 */
  exercises: string
  skipped: boolean
}

const rows = computed<WeakRow[]>(() => {
  const done = picks.value.map((p) => ({
    group: p.group,
    label: p.label,
    gap: p.gap,
    exercises: p.exercises.map((e) => e.name).join(' · '),
    skipped: false,
  }))
  const rest = props.weak
    .filter((w) => !picks.value.some((p) => p.group === w.group))
    .map((w) => ({ group: w.group, label: w.label, gap: gapOf(w), exercises: '', skipped: true }))
  // 缺口降序：最该补的排最前，跳过的也按同一条规则落在它该在的位置
  return [...done, ...rest].sort((a, b) => b.gap - a.gap)
})

const totalSets = computed(() => plan.value.exercises.reduce((n, e) => n + e.sets, 0))

async function startTraining(): Promise<void> {
  if (!plan.value.exercises.length || starting.value) return
  starting.value = true
  try {
    const r = await session.start(plan.value)
    if (r === 'conflict') {
      conflictOpen.value = true
      return
    }
    emit('close')
    openImmersive(null)
  } finally {
    starting.value = false
  }
}

/**
 * 交给 AI：带上弱项与草稿，跳到 AI 页让模型重排一遍。
 *
 * `askFrom` 递过去的那句话在 AI 页是**直接发送**的（与抢课「交给 AI 排查」同一条路径：
 * 那个场景下最缺的就是时间，不该再让人按一次发送）。这里同理 ——
 * 用户点「交给 AI 调整」的意图就是「让它去做」，所以文案也按"已开始生成"写，
 * 不承诺一个不存在的确认步骤。
 */
function handToAi(): void {
  ai.askFrom(catchupPrompt(picks.value, plan.value))
  emit('close')
  void router.push({ name: 'ai' })
  toast.toast('已交给 AI，正在按弱项重排…')
}

function goConflict(): void {
  conflictOpen.value = false
  emit('close')
  if (session.foreignRoute) void router.push(session.foreignRoute)
  else openImmersive(null)
}
</script>

<template>
  <SheetModal :open="open" title="弱项加练" initial-snap="large" @close="emit('close')">
    <p class="lede">
      本周练得不够的肌群，已按缺口排好一节临时课程。它不会存进课程库 —— 开练即用，练完即弃。
    </p>

    <!-- 弱项清单：先说清「缺什么」，再说「练什么」 -->
    <ul class="weaklist">
      <li v-for="r in rows" :key="r.group" class="wrow" :class="{ muted: r.skipped }">
        <span class="wname">{{ r.label }}</span>
        <span class="wgap num">差 {{ r.gap }} 组</span>
        <span v-if="r.skipped" class="wex t-3">动作库没有以它为主攻的动作（只能靠复合动作间接补）</span>
        <span v-else class="wex t-2">{{ r.exercises }}</span>
      </li>
    </ul>

    <!-- 临时课程草稿 -->
    <div class="draft">
      <div class="dhead row between">
        <span class="dt">临时课程草稿</span>
        <span class="ds num">{{ plan.exercises.length }} 个动作 · 共 {{ totalSets }} 组</span>
      </div>
      <ul v-if="plan.exercises.length" class="dlist">
        <li v-for="e in plan.exercises" :key="e.id" class="drow">
          <i class="dic"><Dumbbell :size="14" /></i>
          <span class="dname flex-1">{{ e.name }}</span>
          <span class="dsets num">{{ e.sets }} × {{ e.reps ?? '—' }}</span>
        </li>
      </ul>
      <p v-else class="dhint t-3">
        {{ loading ? '正在挑动作…' : '没有可补的肌群，或动作库里缺少对应的主攻动作。' }}
      </p>
    </div>

    <div class="acts">
      <button
        class="primary row center"
        type="button"
        :disabled="!plan.exercises.length || starting"
        @click="startTraining"
      >
        <Play :size="16" fill="currentColor" />
        {{ starting ? '准备中…' : '开始训练' }}
      </button>
      <button
        class="ghost row center"
        type="button"
        :disabled="!plan.exercises.length"
        @click="handToAi"
      >
        <Sparkles :size="15" />
        交给 AI 调整
      </button>
    </div>
    <p class="hint">
      「交给 AI 调整」会把弱项与上面的草稿一起送进对话，由模型重新排一遍并说明理由 ——
      那句话在 AI 页是直接发出的（与「交给 AI 排查」同一条路径），不需要再点一次发送。
    </p>

    <ActionSheet
      :open="conflictOpen"
      title="已有进行中的训练"
      :actions="[{ label: '前往接续', value: 'go' }]"
      @close="conflictOpen = false"
      @select="goConflict"
    />
  </SheetModal>
</template>

<style scoped>
.lede {
  font-size: var(--fs-footnote);
  line-height: 1.6;
  color: var(--text-2);
}

.weaklist {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
}

.wrow {
  display: grid;
  grid-template-columns: 84px 62px 1fr;
  align-items: baseline;
  gap: 8px;
  padding: 9px 0;
  border-bottom: 0.5px solid var(--line);
}

.wrow.muted .wname,
.wrow.muted .wgap {
  color: var(--text-3);
}

.wname {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.wgap {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--c-balance);
}

.wex {
  font-size: var(--fs-caption);
  line-height: 1.5;
  min-width: 0;
}

.draft {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.dhead {
  margin-bottom: 8px;
}

.dt {
  font-size: var(--fs-footnote);
  font-weight: 700;
}

.ds {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.dlist {
  display: flex;
  flex-direction: column;
}

.drow {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 0;
}

.drow + .drow {
  border-top: 0.5px solid var(--line);
}

.dic {
  width: 24px;
  height: 24px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.dname {
  font-size: var(--fs-footnote);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsets {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
}

.dhint {
  padding: 8px 0;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.acts {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.primary {
  gap: 7px;
  padding: 13px 18px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.ghost {
  gap: 7px;
  padding: 12px 18px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.primary:disabled,
.ghost:disabled {
  opacity: 0.4;
}

.hint {
  margin-top: 10px;
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--text-3);
}
</style>
