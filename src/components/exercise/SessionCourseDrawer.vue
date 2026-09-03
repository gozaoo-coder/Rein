<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Ellipsis, FastForward } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import SessionExerciseSwapSheet from './SessionExerciseSwapSheet.vue'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'
import { exerciseSub } from '@/utils/plan'
import type { PlanExercise, SessionSetSlot } from '@/types'

/**
 * 沉浸模式 · 全课程浏览抽屉（顶部胶囊唤起）。
 * 内容颗粒度到「每一组」：按动作分段，段内先列激活热身组（小重量，不计入组数），
 * 再列正式组，逐组标出状态（已完成 / 已跳过 / 进行中 / 未开始）。
 * 抽屉内可做的两件事：
 *  - 某个待做正式组右侧的 ··· → 跳至该组（只能向前跳，中间的组登记为跳过）；
 *  - 一组都还没做的动作 → 更换动作（只换动作本体，编排沿用本课程）。
 * 打开时内容区自动滚到当前组。
 */
const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ close: [] }>()

const s = useSessionStore()
const { toast } = useToast()

/** 内容滚动容器（SheetModal 暴露），用于打开时定位到当前组 */
const sheetRef = ref<InstanceType<typeof SheetModal> | null>(null)

interface ExGroup {
  exIdx: number
  ex: PlanExercise
  sub: string
  /** 激活热身组（不计入完成组数） */
  warmups: SessionSetSlot[]
  /** 正式组 */
  slots: SessionSetSlot[]
  done: number
  total: number
  canSwap: boolean
}

const groups = computed<ExGroup[]>(() => {
  const out: ExGroup[] = []
  for (const slot of s.courseSlots) {
    let g = out[out.length - 1]
    if (!g || g.exIdx !== slot.exIdx) {
      const ex = s.plan?.exercises[slot.exIdx]
      if (!ex) continue
      g = {
        exIdx: slot.exIdx,
        ex,
        sub: exerciseSub(ex),
        warmups: [],
        slots: [],
        done: 0,
        total: 0,
        canSwap: s.canSwapExercise(slot.exIdx),
      }
      out.push(g)
    }
    if (slot.warmup) {
      g.warmups.push(slot)
      continue
    }
    g.slots.push(slot)
    g.total++
    if (slot.state === 'done') g.done++
  }
  return out
})

const skippedTotal = computed(() => s.setSlots.filter((x) => x.state === 'skipped').length)

/* ---------- 打开即滚到当前组 ---------- */

function scrollToCurrent(): void {
  const body = sheetRef.value?.bodyEl
  if (!body) return
  const el = body.querySelector<HTMLElement>('[data-current="true"]')
  if (!el) return
  const b = body.getBoundingClientRect()
  const e = el.getBoundingClientRect()
  body.scrollTop += e.top - b.top - (b.height - e.height) / 2
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    scrollToCurrent()
    // 抽屉入场是 transform 动画，布局落定后再校准一次
    requestAnimationFrame(scrollToCurrent)
  },
)

/* ---------- 单组 ··· 菜单：跳至该组 ---------- */

const menuOpen = ref(false)
const menuTarget = ref<SessionSetSlot | null>(null)
/** 菜单锚定元素：被点的那个 ··· 按钮 */
const menuAnchor = ref<HTMLElement | null>(null)

const MENU_ACTIONS: MenuItem[] = [{ label: '跳至该组', value: 'jump', icon: FastForward }]

function openMenu(e: MouseEvent, slot: SessionSetSlot): void {
  menuAnchor.value = (e.currentTarget as HTMLElement) ?? null
  menuTarget.value = slot
  menuOpen.value = true
}

function onMenuPick(value: string): void {
  const t = menuTarget.value
  menuTarget.value = null
  if (value !== 'jump' || !t) return
  const before = skippedTotal.value
  if (s.skipToSet(t.exIdx, t.setNo)) {
    const skipped = skippedTotal.value - before
    toast(
      skipped > 0
        ? `已跳至 ${t.exName} 第 ${t.setNo} 组 · 跳过 ${skipped} 组`
        : `已跳至 ${t.exName} 第 ${t.setNo} 组`,
    )
    emit('close')
  } else {
    toast('只能跳到还没做的组')
  }
}

/* ---------- 更换动作 ---------- */

const swapIdx = ref<number | null>(null)

function onSwapPick(src: PlanExercise): void {
  const i = swapIdx.value
  swapIdx.value = null
  if (i == null) return
  if (s.swapExercise(i, src)) toast(`已更换为「${src.name}」`)
  else toast('该动作已经做过，不能更换')
}

/* ---------- 展示 ---------- */

function fmtKg(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 每组的右侧状态文本：完成态展示真实登记值，其余展示状态词；热身组加前缀 */
function setMeta(slot: SessionSetSlot): string {
  if (slot.state === 'skipped') return slot.warmup ? '热身已跳过' : '已跳过'
  if (slot.state === 'current') return '进行中'
  if (slot.state === 'pending') return '未开始'
  const prefix = slot.warmup ? '热身 ' : ''
  if (slot.done?.sec != null) return `${slot.done.sec} 秒`
  if (slot.done?.weight != null) {
    return `${prefix}${fmtKg(slot.done.weight)}kg${slot.done.reps != null ? ` × ${slot.done.reps}` : ''}`
  }
  return '已完成'
}

const STATE_CLASS: Record<SessionSetSlot['state'], string> = {
  done: 'is-done',
  skipped: 'is-skipped',
  current: 'is-current',
  pending: 'is-pending',
}
</script>

<template>
  <SheetModal ref="sheetRef" :open="open" title="全课程进度" initial-snap="large" @close="emit('close')">
    <p class="pname">{{ s.plan?.name ?? '训练课' }}</p>
    <p class="pmeta num">
      已完成 {{ s.doneCount }}/{{ s.totalCount }} 组<template v-if="skippedTotal > 0">
        · 跳过 {{ skippedTotal }} 组</template>
    </p>

    <section v-for="g in groups" :key="g.exIdx" class="exblock">
      <header class="exhead row">
        <span class="ord num">{{ String(g.exIdx + 1).padStart(2, '0') }}</span>
        <div class="flex-1 exid col">
          <span class="exname">{{ g.ex.name }}</span>
          <span class="exsub num t-3">{{ g.sub }}</span>
        </div>
        <span class="excount num t-3">{{ g.done }}/{{ g.total }} 组</span>
        <button
          v-if="g.canSwap"
          type="button"
          class="swapbtn"
          :aria-label="`更换动作 ${g.ex.name}`"
          @click="swapIdx = g.exIdx"
        >
          更换
        </button>
      </header>

      <ul class="sets">
        <!-- 激活热身组：不计入组数，先行展示；未做的热身不提供跳转 -->
        <li
          v-for="w in g.warmups"
          :key="'warm' + w.setNo"
          class="setrow row is-warm"
          :class="STATE_CLASS[w.state]"
          :data-current="w.state === 'current' ? 'true' : undefined"
        >
          <span class="wtag">热身</span>
          <span class="setno num">第 {{ w.setNo }} 组</span>
          <span class="setmeta num">{{ setMeta(w) }}</span>
        </li>
        <li
          v-for="slot in g.slots"
          :key="slot.setNo"
          class="setrow row"
          :class="STATE_CLASS[slot.state]"
          :data-current="slot.state === 'current' ? 'true' : undefined"
        >
          <span class="setno num">第 {{ slot.setNo }} 组</span>
          <span class="setmeta num">{{ setMeta(slot) }}</span>
          <button
            v-if="slot.state === 'pending' || slot.state === 'current'"
            type="button"
            class="morebtn"
            :aria-label="`第 ${slot.setNo} 组的操作`"
            @click="openMenu($event, slot)"
          >
            <Ellipsis :size="18" />
          </button>
        </li>
      </ul>
    </section>

    <p class="foot">跳过的组视为未做，不计入完成组数与总容量统计。</p>

    <!-- 单组操作菜单（只向前跳到未做的组） -->
    <AppMenu
      :open="menuOpen"
      :title="menuTarget ? `${menuTarget.exName} · 第 ${menuTarget.setNo} 组` : ''"
      :actions="MENU_ACTIONS"
      :anchor="menuAnchor"
      @select="onMenuPick"
      @close="menuOpen = false"
    />

    <!-- 换动作：候选来自全部课程出现过的同类动作 -->
    <SessionExerciseSwapSheet
      :open="swapIdx !== null"
      :kind="s.plan?.exercises[swapIdx ?? 0]?.kind ?? 'strength'"
      :current-name="s.plan?.exercises[swapIdx ?? 0]?.name ?? ''"
      @pick="onSwapPick"
      @close="swapIdx = null"
    />
  </SheetModal>
</template>

<style scoped>
.pname {
  font-size: var(--fs-title3);
  font-weight: 700;
}

.pmeta {
  margin-top: 3px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.exblock {
  margin-top: 18px;
}

.exhead {
  gap: 10px;
  padding-bottom: 8px;
}

.ord {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-3);
}

.exid {
  gap: 1px;
}

.exname {
  font-size: var(--fs-callout);
  font-weight: 600;
}

.exsub {
  font-size: var(--fs-caption);
}

.excount {
  font-size: var(--fs-caption);
  flex: none;
}

.swapbtn {
  flex: none;
  padding: 5px 11px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.sets {
  border-radius: var(--radius-m);
  background: var(--surface-2);
  overflow: hidden;
}

.setrow {
  gap: 10px;
  height: 46px;
  padding: 0 12px;
}

.setrow + .setrow {
  border-top: 0.5px solid var(--line);
}

.setno {
  font-size: var(--fs-callout);
  font-weight: 600;
}

/* 热身组行：与正式组区分，轻量展示（不计入完成组数） */
.wtag {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line-strong, var(--line));
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 600;
}

.setrow.is-warm .setno {
  color: var(--text-3);
  font-weight: 500;
}

.setrow.is-warm .setmeta {
  color: var(--text-3);
}

.setmeta {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.morebtn {
  flex: none;
  width: 32px;
  height: 32px;
  margin-right: -4px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.morebtn:active {
  background: var(--line-strong);
}

/* 完成：登记值用运动绿点题；跳过：整行压暗表示不计入统计 */
.setrow.is-done .setmeta {
  color: var(--c-exercise-deep);
  font-weight: 600;
}

.setrow.is-skipped {
  opacity: 0.5;
}

.setrow.is-skipped .setno {
  text-decoration: line-through;
}

.setrow.is-current {
  background: var(--c-exercise-soft);
}

.setrow.is-current .setno {
  font-weight: 700;
}

.setrow.is-current .setmeta {
  color: var(--c-exercise-deep);
  font-weight: 700;
}

.setrow.is-pending .setno {
  color: var(--text-2);
  font-weight: 500;
}

.foot {
  margin-top: 16px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: 1.5;
}
</style>
