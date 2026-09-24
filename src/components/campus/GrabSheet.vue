<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AlertTriangle, Info, Zap } from 'lucide-vue-next'

import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { idOf, teacherText, useCourseSelectStore } from '@/stores/courseSelect'
import type { CourseSelectLesson, GrabTask } from '@/types'

/**
 * 抢课设置抽屉：把「怎么抢」讲清楚，然后交给引擎。
 *
 * 为什么值得一个抽屉而不是直接一个按钮：
 * 1. **上课小组（`scheduleGroupAssoc`）决定你在和谁竞争**。一门课有 3 个组时，
 *    第 2 组满了而第 1 组还有位置 —— 不选组就等于把选择权交给教务的默认值，
 *    而抢课最怕的恰恰是「抢错了组」。
 * 2. **意愿值（`virtualCost`）填错会让提交直接被拒**。启用了虚拟钱包的轮次里它是硬门槛，
 *    普通轮次又必须留 0，这个区别不写在界面上没人猜得到。
 * 3. 模式（占位优先 / 直接提交）是策略选择，用户该知道自己在选什么。
 * 4. **志愿组**决定这门课是在跟别的课抢一个名额，还是自己独立排一队 ——
 *    见「志愿组」那一节的说明。
 */
const props = defineProps<{
  open: boolean
  lesson: CourseSelectLesson | null
  /** 当前批次是否允许进入；不允许时只展示不提交 */
  allowEnter: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  close: []
  /** 加入抢课任务单（交给引擎，关掉页面也会继续） */
  grab: [
    payload: {
      mode: 'predicate' | 'direct'
      virtualCost: number
      scheduleGroupId: unknown
      groupKey: string | null
      groupName: string | null
      priority: number
    },
  ]
  /** 立刻试一次（一次性提交 + 轮询） */
  apply: [payload: { virtualCost: number; scheduleGroupId: unknown }]
}>()

const store = useCourseSelectStore()

const mode = ref<'predicate' | 'direct'>('predicate')
const virtualCost = ref(0)
/** 'default' = 不指定，让教务用它自己的默认组 */
const groupChoice = ref('default')

/* ---------------- 志愿组 ----------------
 * 同组 = 互斥备选（时间冲突 / 一轮只能选一门）：只会中一个，中选后同组其余自动取消。
 * 最典型的用法是**同一门课的多个教学班**：第 1 志愿满了就去抢第 2 志愿的班。
 */
const squadMode = ref(false)
/** 'new' = 新建一组；否则是已有组的 key */
const squadPick = ref('new')
const squadPriority = ref(1)
/** 新建组的 key。一次打开抽屉只生成一个 —— 否则每次重算都会变成新组 */
const newSquadKey = ref('')

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  )
}

/** 任务单里已有的志愿组（结束/取消的不算），供「加入某一组」用 */
const squads = computed(() => {
  const byKey = new Map<string, { key: string; name: string; members: GrabTask[] }>()
  for (const t of store.grabTasks) {
    const k = t.groupKey?.trim()
    if (!k || t.status === 'cancelled') continue
    const g = byKey.get(k) ?? { key: k, name: t.groupName?.trim() || '志愿组', members: [] }
    g.members.push(t)
    byKey.set(k, g)
  }
  for (const g of byKey.values()) g.members.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  return [...byKey.values()]
})

const pickedSquad = computed(() => squads.value.find((g) => g.key === squadPick.value) ?? null)

/** 下一志愿序号：接着已有成员往后排，省得用户自己数 */
function nextPriority(): number {
  const g = pickedSquad.value
  if (!g?.members.length) return 1
  return Math.max(...g.members.map((m) => m.priority ?? 0)) + 1
}

function toSquad(next: boolean): void {
  squadMode.value = next
  if (!next) return
  // 有现成的组就默认并进去（「再抢这个班的备选」是最常见的第二次操作）
  if (squads.value.length) squadPick.value = squads.value[0]!.key
  else squadPick.value = 'new'
  squadPriority.value = nextPriority()
}

/** 被谁压着 —— 直接说出「等第几志愿」，比自己再推一遍组内次序有用 */
function holderLabel(m: GrabTask): string {
  const holder = pickedSquad.value?.members.find((x) => x.id === m.heldBy)
  return holder ? `（等第 ${holder.priority ?? '?'} 志愿）` : '（待命）'
}

watch(
  () => [props.open, props.lesson?.id] as const,
  ([open]) => {
    if (!open) return
    // 每次打开回到保守默认：占位优先（抢位次）、意愿值 0（普通轮次的要求）
    mode.value = 'predicate'
    virtualCost.value = 0
    // 只有一个组时直接选中它 —— 只有一个选择还让人点一下是浪费
    groupChoice.value = groups.value.length === 1 ? idOf(groups.value[0]?.id) : 'default'
    squadMode.value = false
    squadPick.value = 'new'
    squadPriority.value = 1
    newSquadKey.value = uuid()
  },
)

const name = computed(
  () => props.lesson?.course?.nameZh || props.lesson?.course?.nameEn || '（教务未给课程名）',
)
const groups = computed(() => props.lesson?.scheduleGroups ?? [])
const picked = computed(() => props.lesson?.selectedLesson != null)

/** 已满：有上限且已选人数达到上限。抢已满的课是常态（等别人退），不是错误。 */
const full = computed(() => {
  const l = props.lesson
  if (!l || l.limitCount == null || l.stdCount == null) return false
  return l.stdCount >= l.limitCount
})

/** 选中的组对象（'default' 时为 null，表示不给教务发这个字段） */
const groupId = computed(() => {
  if (groupChoice.value === 'default') return null
  const g = groups.value.find((x) => idOf(x.id) === groupChoice.value)
  return g ? g.id : null
})

/** 志愿组：交给引擎的三个值。独立任务时 key 为 null、序为 0 */
const squadKey = computed(() => {
  if (!squadMode.value) return null
  return squadPick.value === 'new' ? newSquadKey.value : squadPick.value
})
/** 新建组的组名就用这门课的名字 —— 组是备选，名字取自第一个进去的人最直观 */
const squadName = computed(() => {
  if (!squadMode.value) return null
  return squadPick.value === 'new' ? name.value : (pickedSquad.value?.name ?? name.value)
})
</script>

<template>
  <SheetModal
    :open="open && !!lesson"
    :title="name"
    initial-snap="large"
    @close="emit('close')"
  >
    <p class="meta">
      <span v-if="lesson?.course?.code" class="num">{{ lesson.course.code }}</span>
      <span v-if="lesson?.course?.credits != null">{{ lesson.course.credits }} 学分</span>
      <span v-if="teacherText(lesson!)">{{ teacherText(lesson!) }}</span>
      <span v-if="lesson?.stdCount != null" class="num">
        已选 {{ lesson.stdCount }}<template v-if="lesson.limitCount != null"> / {{ lesson.limitCount }}</template>
      </span>
    </p>

    <p v-if="picked" class="banner ok">这门课已经在你名下了</p>
    <p v-else-if="full" class="banner warn">
      <AlertTriangle :size="14" />
      当前已满。自动抢课会一直守着 —— 有人退课的空档就是机会。
    </p>

    <!-- 抢课方式 -->
    <section class="block">
      <h3>抢课方式</h3>
      <SegmentedControl
        v-model="mode"
        :options="[
          { value: 'predicate', label: '占位优先' },
          { value: 'direct', label: '直接提交' },
        ]"
      />
      <p class="hint">
        <Info :size="13" />
        <template v-if="mode === 'predicate'">
          开窗瞬间先占住队列位次（不花意愿值），受理后再正式确认。抢的是位次，
          所以这是默认选择。
        </template>
        <template v-else>
          跳过占位，直接发正式选课请求。少一次往返，但开窗那一刻更容易被排在后面。
        </template>
      </p>
    </section>

    <!-- 上课小组。用 button + role=radio 而不是 label + 装饰点：
         后者键盘完全够不着（没有 input 也没有 tabindex），而这是一列真正的单选。
         教务没给小组时**整段不出现** —— 一个「没有可选项」的选择器，
         配上三行解释自己是空的，对用户来说只是噪声 -->
    <section v-if="groups.length" class="block">
      <h3>上课小组</h3>
      <div class="opts" role="radiogroup" aria-label="上课小组">
        <button
          type="button"
          role="radio"
          :aria-checked="groupChoice === 'default'"
          class="opt row"
          :class="{ on: groupChoice === 'default' }"
          @click="groupChoice = 'default'"
        >
          <span class="dot" />
          <span class="col flex-1">
            <b>不指定</b>
            <em>由教务按默认组分配</em>
          </span>
        </button>
        <button
          v-for="g in groups"
          :key="idOf(g.id)"
          type="button"
          role="radio"
          :aria-checked="groupChoice === idOf(g.id)"
          class="opt row"
          :class="{ on: groupChoice === idOf(g.id) }"
          @click="groupChoice = idOf(g.id)"
        >
          <span class="dot" />
          <span class="col flex-1">
            <b>第 {{ g.no ?? '?' }} 组{{ g.default ? '（默认）' : '' }}</b>
            <em v-if="g.limitCount != null" class="num">容量 {{ g.limitCount }}</em>
          </span>
        </button>
      </div>
    </section>

    <!-- 意愿值 -->
    <section class="block">
      <h3>意愿值</h3>
      <NumberStepper v-model="virtualCost" :min="0" :max="999" :step="5" label="投入意愿值" />
      <p class="hint">
        <Info :size="13" />
        只有启用了「虚拟学分/意愿值」的轮次才需要填；普通轮次留 0 即可。
        占位阶段它会自动按 0 发送。
      </p>
    </section>

    <!-- 志愿组 -->
    <section class="block">
      <h3>志愿组</h3>
      <SegmentedControl
        :model-value="squadMode ? 'squad' : 'solo'"
        :options="[
          { value: 'solo', label: '独立抢' },
          { value: 'squad', label: '志愿组' },
        ]"
        @update:model-value="toSquad($event === 'squad')"
      />

      <template v-if="squadMode">
        <div class="opts" role="radiogroup" aria-label="志愿组">
          <button
            v-for="g in squads"
            :key="g.key"
            type="button"
            role="radio"
            :aria-checked="squadPick === g.key"
            class="opt row"
            :class="{ on: squadPick === g.key }"
            @click="squadPick = g.key; squadPriority = nextPriority()"
          >
            <span class="dot" />
            <span class="col flex-1">
              <b>{{ g.name }}</b>
              <em>
                已有 {{ g.members.length }} 个志愿：
                {{ g.members.map((m) => `第${m.priority ?? '?'}志愿 ${m.courseName ?? '（未命名）'}`).join(' · ') }}
              </em>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="squadPick === 'new'"
            class="opt row"
            :class="{ on: squadPick === 'new' }"
            @click="squadPick = 'new'; squadPriority = 1"
          >
            <span class="dot" />
            <span class="col flex-1">
              <b>新建一组</b>
              <em>把「同一门课的多个教学班」或「时间冲突的几门课」放一起</em>
            </span>
          </button>
        </div>

        <NumberStepper v-model="squadPriority" :min="1" :max="20" :step="1" label="第几志愿" />

        <!-- 把组内次序摆出来给人看：这才是「会不会白等」的答案 -->
        <ul v-if="pickedSquad" class="queue">
          <li v-for="m in pickedSquad.members" :key="m.id">
            <span class="tag-mini">第 {{ m.priority ?? '?' }}</span>
            {{ m.courseName ?? m.lessonName ?? '（未命名）' }}
            <em v-if="m.heldBy">{{ holderLabel(m) }}</em>
          </li>
        </ul>

        <p class="hint">
          <Info :size="13" />
          <span>
            同组课程是<b>互斥备选</b>：只会中一个，任一中选后同组其余自动取消 ——
            所以不会出现「同时抢到两门时间冲突的课」。
            同一门课的多个教学班填同一组、按 1/2/3 排序就是最典型的用法。
          </span>
        </p>
      </template>
      <p v-else class="hint">
        <Info :size="13" />
        这门课自己排一队，和别人互不影响。想让它和别的课「只能中一个」时，改选「志愿组」。
      </p>
    </section>

    <template #footer>
      <div class="acts">
        <button
          class="primary"
          :disabled="busy || !allowEnter || picked"
          @click="emit('grab', { mode, virtualCost, scheduleGroupId: groupId, groupKey: squadKey, groupName: squadName, priority: squadMode ? squadPriority : 0 })"
        >
          <Zap :size="16" />
          加入抢课
        </button>
        <p class="hint center">
          <Info :size="13" />
          <span>
            「加入抢课」由后台引擎持续重试，<b>关掉这个页面也会继续</b>。
          </span>
        </p>
        <!-- 「只试一次」不再和「加入抢课」并排：两颗平级的按钮、差别只写在 11px 提示里，
             在时间压力下就是陷阱 —— 现在它是一个明细级的次要动作，标签也自己说明后果 -->
        <button
          class="once"
          :disabled="busy || !allowEnter || picked"
          @click="emit('apply', { virtualCost, scheduleGroupId: groupId })"
        >
          只试一次，不加入任务单
        </button>
      </div>
    </template>
  </SheetModal>
</template>

<style scoped>
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-bottom: 10px;
}

.num {
  font-variant-numeric: tabular-nums;
}

.banner {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-caption);
  padding: 9px 12px;
  border-radius: var(--radius-m);
  margin-bottom: 12px;
  line-height: 1.45;
}

.banner.warn {
  color: var(--warn-strong);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.banner.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.block {
  margin-bottom: 16px;
}

.block h3 {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 7px;
}

/* 这些说明是「占位优先 / 直接提交」「意愿值填多少」「同组互斥」唯一的解释 ——
   写在界面上却读不出来，等于没写。11px 的 --text-3 在亮色下只有约 2.5:1 */
.hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.5;
  margin-top: 6px;
}

.hint.center {
  justify-content: center;
  text-align: center;
}

.hint svg {
  flex: none;
  margin-top: 2px;
}

.opt {
  width: 100%;
  text-align: left;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  margin-bottom: 6px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-standard);
}

.opt.on {
  background: var(--accent-soft);
}

.opt b {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.opt em {
  font-size: var(--fs-micro);
  font-style: normal;
  margin-top: 1px;
  /* 选项的说明（容量多少 / 已有几个志愿 / 这个组是干什么的）——
     它们是决定选哪个的依据，不是脚注 */
  color: var(--text-2);
}

.dot {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  position: relative;
}

.opt.on .dot {
  border-color: var(--accent);
}

.opt.on .dot::after {
  content: '';
  position: absolute;
  inset: 3.5px;
  border-radius: 50%;
  background: var(--accent);
}

.acts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 组内次序：一眼看出「谁在等谁」 */
.queue {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.queue li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.queue em {
  font-style: normal;
}

.tag-mini {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 13px;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.985);
}

.ghost {
  padding: 11px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: 600;
}

/* 明细级的次要动作：看起来就不像「主按钮」，不会被当成第二个「加入抢课」 */
.once {
  align-self: center;
  min-height: 44px;
  padding: 0 12px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}

.once:disabled,
.primary:disabled,
.ghost:disabled {
  opacity: 0.4;
}
</style>
