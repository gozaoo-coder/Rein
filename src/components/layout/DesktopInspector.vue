<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowRight,
  BookOpen,
  Check,
  Cloud,
  Download,
  Dumbbell,
  Folder,
  GraduationCap,
  History,
  ListChecks,
  Settings2,
  SlidersHorizontal,
} from 'lucide-vue-next'

import ActivityRings from '@/components/common/ActivityRings.vue'
import { CATEGORY_META } from '@/config/domain'
import { categoryOf, fmtCents } from '@/config/ledger'
import { useExerciseStore } from '@/stores/exercise'
import { useFeaturesStore } from '@/stores/features'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { todayStr } from '@/utils/date'

/**
 * 桌面三窗格壳 · 右侧信息栏。
 *
 * **它随页面变**：一整块「今日」在所有页面常驻，在设置页里就是三条与当下无关的
 * 数字，占着 298px 却什么也不回答。所以这里按**路由分组**（GROUP_OF）换内容 ——
 * 运动页给训练摘要、AI 页给工具入口、记账页给本月收支……
 * 这一层是「当前这块地在讲什么」的旁注，不是第二套导航。
 *
 * 三条纪律：
 *   ① 数据**按需加载**（load(group)）：常驻面板最容易变成「不管在哪个页面都拉全量」
 *      的成本黑洞，所以只加载当前分组真正要显示的那几份；
 *   ② 不静态 import 重模块（AI 栈、campus 服务）—— 信息栏在每个桌面页面都在，
 *      它 import 什么就等于把什么钉进主包；
 *   ③ 分组里没有数据的部分**整块不出现**，不留一个只有标题的空卡。
 */
type AsideGroup = 'today' | 'sports' | 'ai' | 'nutrition' | 'ledger' | 'campus' | 'account'

/** 路由 → 信息栏分组。缺省 today（今天/待办/专注/录音/方案这一族）。 */
const GROUP_OF: Record<string, AsideGroup> = {
  sports: 'sports',
  'sports-plans': 'sports',
  'sports-plan-detail': 'sports',
  'sports-plan-edit': 'sports',
  'sports-exercises': 'sports',
  'sports-records': 'sports',
  'session-run': 'sports',
  ai: 'ai',
  'ai-models': 'ai',
  'ai-knowledge': 'ai',
  'ai-files': 'ai',
  'ai-knowledge-files': 'ai',
  'ai-files-usage': 'ai',
  'ai-files-usage-large': 'ai',
  nutrition: 'nutrition',
  'nutrition-adjust': 'nutrition',
  'nutrition-foods': 'nutrition',
  'nutrition-recipes': 'nutrition',
  ledger: 'ledger',
  'campus-schedule': 'campus',
  'campus-settings': 'campus',
  'campus-program': 'campus',
  'campus-course-select': 'campus',
  'campus-grab-tasks': 'campus',
  me: 'account',
  settings: 'account',
  'settings-features': 'account',
  'settings-sync': 'account',
  'settings-update': 'account',
  'settings-perf': 'account',
}

/** 提问占位文案随分组走：占位符是这块地方唯一能教用户「可以问什么」的位置 */
const ASK_HINT: Record<AsideGroup, string> = {
  today: '今天的蛋白质够吗？',
  sports: '这周练得够吗？',
  ai: '帮我记一笔午饭',
  nutrition: '今天还能吃点什么？',
  ledger: '本月餐饮花了多少？',
  campus: '明天几点有课？',
  account: '怎么开启多设备同步？',
}

/** AI 页的常用问句：把「能问什么」摊开，比一个空输入框有用 */
const AI_QUICK = ['分析今日饮食', '这周运动量怎么样', '帮我把明天安排满', '总结这个月的开销']

const today = todayStr()
const route = useRoute()
const router = useRouter()

const group = computed<AsideGroup>(() => GROUP_OF[String(route.name ?? '')] ?? 'today')

const exercise = useExerciseStore()
const nutrition = useNutritionStore()
const pomo = usePomodoroStore()
const todo = useTodoStore()
const ledger = useLedgerStore()
const features = useFeaturesStore()

/** 今日待办：只在「今天向」与运动页出现 —— 在记账页里它只是噪声 */
const showTodos = computed(() => group.value === 'today' || group.value === 'sports')

/** 按需加载（见文件头纪律①）。同一个分组内切换路由不会重复拉取。 */
let loaded: AsideGroup | null = null
function load(g: AsideGroup): void {
  if (loaded === g) return
  loaded = g
  if (g === 'today') {
    void nutrition.loadSummary(today)
    void pomo.loadToday()
    void todo.loadDay(today)
    void ledger.loadMonth()
    if (features.isEnabled('program')) void loadProgramAside()
  } else if (g === 'sports') {
    void exercise.loadWeek(today)
    void todo.loadDay(today)
  } else if (g === 'nutrition') {
    void nutrition.loadSummary(today)
  } else if (g === 'ledger') {
    void ledger.loadMonth()
  } else if (g === 'account') {
    void nutrition.loadSummary(today)
    void pomo.loadToday()
    if (features.isEnabled('program')) void loadProgramAside()
  }
  /* ai / campus 不需要数据：它们给的是入口 */
}

/* ---- 方案信息栏卡：右栏是桌面端的常驻入口（动态 import，见文件头纪律②） ---- */

interface ProgramAside {
  id: number
  heading: string
  today: string
  due: boolean
}

const programAside = ref<ProgramAside | null>(null)

async function loadProgramAside(): Promise<void> {
  try {
    const [{ useProgramStore }, { parseBlob }, { programStatus, courseOnDate, reviewDue }] =
      await Promise.all([
        import('@/stores/program'),
        import('@/utils/programEngine'),
        import('@/utils/programCycle'),
      ])
    const store = useProgramStore()
    if (!store.loaded) await store.load()
    const rec = store.active
    if (!rec) {
      programAside.value = null
      return
    }
    const blob = parseBlob(rec)
    const st = programStatus(rec, blob)
    if (!st) {
      programAside.value = null
      return
    }
    const course = st.ended || st.upcoming ? null : courseOnDate(blob, today)
    programAside.value = {
      id: rec.id,
      heading: `第 ${st.week} 周 / ${st.weeks}`,
      today: st.ended ? '本期已结束' : st.upcoming ? `${st.startDate.slice(5)} 开跑` : course ? `今天 ${course.courseName}` : '今天休息',
      due: reviewDue(rec, blob),
    }
  } catch {
    programAside.value = null /* 方案数据损坏只让这一卡消失，不拖累信息栏 */
  }
}

onMounted(() => load(group.value))
watch(group, (g) => load(g))

const todayExpenseCents = computed(() =>
  ledger.entries.filter((e) => e.date === today && e.kind === 'expense').reduce((s, e) => s + e.amountCents, 0),
)

/** 本月最近三笔（按日期、再按 id 倒序 —— 同一天的顺序就是录入顺序） */
const recentEntries = computed(() =>
  [...ledger.entries].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 3),
)

function entryColor(key: string): string {
  return categoryOf(key)?.colorVar ?? 'var(--text-3)'
}

/** 宏量条的安全填充比例：读数是「限制项」时（钠、糖）超了就该满格报警，不溢出 */
function barPct(current: number, target: number): number {
  if (!target) return 0
  return Math.max(0, Math.min(1, current / target))
}

/** 读数取整：宏量原值是浮点（67.43900000000001），直接印出来是一串噪声 */
function g0(n: number): number {
  return Math.round(n)
}

function hhmm(startMin: number): string {
  return `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`
}

const ask = ref('')

/**
 * 提问：问题随路由带到 AI 页预填（AIPage 的 route.query.ask watcher 接住）。
 * 导航失败时把话还回输入框 —— 用户的输入不该石沉大海（这是这一格从前的 P1 缺陷）。
 */
async function sendAsk(): Promise<void> {
  const q = ask.value.trim()
  if (!q) return
  ask.value = ''
  try {
    await router.push({ name: 'ai', query: { ask: q } })
  } catch {
    ask.value = q
  }
}

function askQuick(q: string): void {
  ask.value = q
  void sendAsk()
}
</script>

<template>
  <aside class="inspector">
    <!-- ============ 今天向：三环 + 摄入 / 专注 / 支出 ============ -->
    <section v-if="group === 'today' || group === 'account'" class="card">
      <header class="c-head">
        <h2>今日</h2>
        <RouterLink v-if="group === 'account'" class="c-more" :to="{ name: 'home' }">总览<ArrowRight :size="13" /></RouterLink>
      </header>
      <div class="row" style="gap: 12px">
        <ActivityRings :rings="nutrition.rings" :size="group === 'today' ? 86 : 72" />
        <div class="col flex-1" style="gap: 7px; min-width: 0">
          <div class="stat">
            <b class="num">{{ nutrition.kcalIntake }}</b>
            <span class="cap">摄入 kcal</span>
          </div>
          <div class="stat">
            <b class="num">{{ pomo.todayFocusMin }}</b>
            <span class="cap">专注 分</span>
          </div>
          <div v-if="group === 'today'" class="stat">
            <b class="num">¥{{ fmtCents(todayExpenseCents) }}</b>
            <span class="cap">今日支出</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ 健康方案：执行期的常驻状态（今天练什么 / 该复盘了） ============ -->
    <section v-if="programAside && (group === 'today' || group === 'account')" class="card">
      <header class="c-head">
        <h2>健康方案</h2>
        <RouterLink class="c-more" :to="{ name: 'program' }">方案<ArrowRight :size="13" /></RouterLink>
      </header>
      <p class="p-head num">{{ programAside.heading }}</p>
      <p class="p-today">{{ programAside.today }}</p>
      <button
        v-if="programAside.due"
        class="due pressable"
        @click="router.push({ name: 'program', query: { review: '1' } })"
      >
        本周复盘可做
      </button>
    </section>

    <!-- ============ 运动：本周负荷 + 最近记录 + 直达 ============ -->
    <template v-if="group === 'sports'">
      <section class="card">
        <header class="c-head">
          <h2>本周运动</h2>
          <RouterLink class="c-more" :to="{ name: 'sports-records' }">记录<ArrowRight :size="13" /></RouterLink>
        </header>
        <div class="figures">
          <div class="fig">
            <b class="num">{{ exercise.weekMinutes }}</b>
            <span class="cap">分钟</span>
          </div>
          <div class="fig">
            <b class="num">{{ exercise.weekKcal }}</b>
            <span class="cap">大卡</span>
          </div>
          <div class="fig">
            <b class="num">{{ exercise.weekWorkouts.length }}</b>
            <span class="cap">次</span>
          </div>
        </div>
      </section>

      <section v-if="exercise.recent.length" class="card">
        <header class="c-head"><h2>最近运动</h2></header>
        <ul class="mini">
          <li v-for="w in exercise.recent.slice(0, 3)" :key="w.id" class="mini-row">
            <Dumbbell :size="14" class="mini-ic" />
            <span class="mini-name">{{ w.name }}</span>
            <span class="num mini-meta">{{ w.durationMin }}′</span>
          </li>
        </ul>
      </section>

      <nav class="quick" aria-label="运动快捷入口">
        <button class="qbtn pressable" @click="router.push({ name: 'sports-plans' })">
          <ListChecks :size="16" /><span>全部课程</span>
        </button>
        <button class="qbtn pressable" @click="router.push({ name: 'sports-exercises' })">
          <Dumbbell :size="16" /><span>动作库</span>
        </button>
        <button class="qbtn pressable" @click="router.push({ name: 'sports-records' })">
          <History :size="16" /><span>运动记录</span>
        </button>
      </nav>
    </template>

    <!-- ============ AI：工具入口 + 常用问句 ============ -->
    <template v-if="group === 'ai'">
      <section class="card">
        <header class="c-head"><h2>AI 工具</h2></header>
        <ul class="nav">
          <li>
            <button class="nav-row pressable" @click="router.push({ name: 'ai-models' })">
              <Settings2 :size="16" class="nav-ic" />
              <span class="col nav-txt"><b>管理模型</b><em>服务 · 密钥 · 语音</em></span>
              <ArrowRight :size="14" class="nav-go" />
            </button>
          </li>
          <li>
            <button class="nav-row pressable" @click="router.push({ name: 'ai-knowledge' })">
              <BookOpen :size="16" class="nav-ic" />
              <span class="col nav-txt"><b>知识库</b><em>长期记住你的偏好</em></span>
              <ArrowRight :size="14" class="nav-go" />
            </button>
          </li>
          <li>
            <button class="nav-row pressable" @click="router.push({ name: 'ai-files' })">
              <Folder :size="16" class="nav-ic" />
              <span class="col nav-txt"><b>文件</b><em>给 AI 的附件与产物</em></span>
              <ArrowRight :size="14" class="nav-go" />
            </button>
          </li>
        </ul>
      </section>

      <section class="card">
        <header class="c-head"><h2>试试问</h2></header>
        <div class="chips">
          <button v-for="q in AI_QUICK" :key="q" class="chip-q pressable" @click="askQuick(q)">{{ q }}</button>
        </div>
      </section>
    </template>

    <!-- ============ 营养：能量 + 宏量进度 ============ -->
    <section v-if="group === 'nutrition'" class="card">
      <header class="c-head">
        <h2>今日营养</h2>
        <RouterLink class="c-more" :to="{ name: 'nutrition' }">全览<ArrowRight :size="13" /></RouterLink>
      </header>
      <div class="row" style="gap: 12px">
        <ActivityRings :rings="nutrition.rings" :size="76" />
        <div class="col flex-1" style="gap: 7px; min-width: 0">
          <div class="stat">
            <b class="num">{{ nutrition.kcalIntake }}</b>
            <span class="cap">/ {{ nutrition.kcalTarget }} kcal</span>
          </div>
          <div class="stat">
            <b class="num">{{ nutrition.kcalRemaining }}</b>
            <span class="cap">剩余 kcal</span>
          </div>
        </div>
      </div>
      <ul class="bars">
        <li v-for="m in nutrition.macros.slice(0, 3)" :key="m.key" class="bar-row">
          <span class="bar-label">{{ m.label }}</span>
          <!-- 填充走 scaleX 而不是 width：width 每帧都要重排（本项目的既有反模式），
               scaleX 只走合成；这里虽是静态读数，也不给后面留一个坏例子 -->
          <span class="bar-track">
            <i class="bar-fill" :style="{ transform: `scaleX(${barPct(m.current, m.target)})`, background: `var(${m.colorVar})` }" />
          </span>
          <span class="num bar-val">{{ g0(m.current) }}/{{ g0(m.target) }}</span>
        </li>
      </ul>
    </section>

    <!-- ============ 记账：本月收支 + 最近三笔 ============ -->
    <template v-if="group === 'ledger'">
      <section class="card">
        <header class="c-head">
          <h2>本月收支</h2>
          <RouterLink class="c-more" :to="{ name: 'ledger' }">记账<ArrowRight :size="13" /></RouterLink>
        </header>
        <div class="figures">
          <div class="fig">
            <b class="num danger">¥{{ fmtCents(ledger.monthExpenseCents) }}</b>
            <span class="cap">支出</span>
          </div>
          <div class="fig">
            <b class="num ok">¥{{ fmtCents(ledger.monthIncomeCents) }}</b>
            <span class="cap">收入</span>
          </div>
        </div>
      </section>

      <section v-if="recentEntries.length" class="card">
        <header class="c-head"><h2>最近三笔</h2></header>
        <ul class="mini">
          <li v-for="e in recentEntries" :key="e.id" class="mini-row">
            <i class="dot" :style="{ background: entryColor(e.category) }" />
            <span class="mini-name">{{ e.note || categoryOf(e.category)?.label || '一笔记录' }}</span>
            <span class="num mini-meta" :class="e.kind === 'expense' ? 'danger' : 'ok'">
              {{ e.kind === 'expense' ? '−' : '+' }}{{ fmtCents(e.amountCents) }}
            </span>
          </li>
        </ul>
      </section>
    </template>

    <!-- ============ 课表：模块入口（关掉就不出现） ============ -->
    <section v-if="group === 'campus' && features.isEnabled('campus')" class="card">
      <header class="c-head"><h2>课表</h2></header>
      <ul class="nav">
        <li>
          <button class="nav-row pressable" @click="router.push({ name: 'campus-schedule' })">
            <GraduationCap :size="16" class="nav-ic" />
            <span class="col nav-txt"><b>我的课表</b><em>本周课程与时间</em></span>
            <ArrowRight :size="14" class="nav-go" />
          </button>
        </li>
        <li>
          <button class="nav-row pressable" @click="router.push({ name: 'campus-program' })">
            <BookOpen :size="16" class="nav-ic" />
            <span class="col nav-txt"><b>培养方案</b><em>学分完成度</em></span>
            <ArrowRight :size="14" class="nav-go" />
          </button>
        </li>
        <li>
          <button class="nav-row pressable" @click="router.push({ name: 'campus-settings' })">
            <Settings2 :size="16" class="nav-ic" />
            <span class="col nav-txt"><b>课表配置</b><em>教务地址与学期</em></span>
            <ArrowRight :size="14" class="nav-go" />
          </button>
        </li>
      </ul>
    </section>

    <!-- ============ 设置：分区直达 ============ -->
    <section v-if="group === 'account'" class="card">
      <header class="c-head"><h2>设置</h2></header>
      <ul class="nav">
        <li>
          <button class="nav-row pressable" @click="router.push({ name: 'settings-features' })">
            <SlidersHorizontal :size="16" class="nav-ic" />
            <span class="col nav-txt"><b>打开或关闭功能</b><em>运动 · 课表 · 健康方案</em></span>
            <ArrowRight :size="14" class="nav-go" />
          </button>
        </li>
        <li>
          <button class="nav-row pressable" @click="router.push({ name: 'settings-sync' })">
            <Cloud :size="16" class="nav-ic" />
            <span class="col nav-txt"><b>多设备同步</b><em>同一网段直连</em></span>
            <ArrowRight :size="14" class="nav-go" />
          </button>
        </li>
        <li>
          <button class="nav-row pressable" @click="router.push({ name: 'settings-update' })">
            <Download :size="16" class="nav-ic" />
            <span class="col nav-txt"><b>软件更新</b><em>版本与更新通道</em></span>
            <ArrowRight :size="14" class="nav-go" />
          </button>
        </li>
      </ul>
    </section>

    <!-- ============ 今日待办：点勾即完成 ============ -->
    <section v-if="showTodos" class="card">
      <header class="c-head">
        <h2>今日待办</h2>
        <RouterLink class="c-more" :to="{ name: 'todos' }">全部<ArrowRight :size="13" /></RouterLink>
      </header>
      <ul v-if="todo.dayTodos.length" class="mini">
        <li v-for="t in todo.dayTodos.slice(0, 4)" :key="t.id">
          <button
            class="mini-row pressable todo"
            :style="{ '--tc': 'var(' + CATEGORY_META[t.category].colorVar + ')' }"
            @click="void todo.toggle(t)"
          >
            <i class="tick" :class="{ on: t.status === 'done' }">
              <Transition name="ckin">
                <Check v-if="t.status === 'done'" :size="13" :stroke-width="3" />
              </Transition>
            </i>
            <span class="mini-name line" :class="{ done: t.status === 'done' }">{{ t.title }}</span>
            <span v-if="t.startMin != null" class="num mini-meta">{{ hhmm(t.startMin) }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="empty">今天还没有待办</p>
    </section>

    <!-- ============ AI 提问：常驻（占位文案随分组变） ============ -->
    <form class="ask row glass-surface" @submit.prevent="sendAsk">
      <input v-model="ask" :placeholder="ASK_HINT[group]" aria-label="向 AI 提问" />
      <button class="send" aria-label="发送" type="submit">
        <ArrowRight :size="17" :stroke-width="2.4" />
      </button>
    </form>
  </aside>
</template>

<style scoped>
/* 信息栏本体刻意**不是** .glass-surface：它是一整条可滚动的大面板，而 .glass-surface
   带 backdrop-filter —— 带 backdrop-filter 的元素会成为后代的 backdrop root，里面
   那个 .ask 的模糊就会退化成「只采到信息栏自己的内容」，而不是页面。所以这里保留
   原来那份更薄的 24% 表面（它本来就是"内容面板"而不是悬浮玻璃层），
   **玻璃交给 .ask**（控制层，与 Dock / 悬浮条同一套材质与档位升级）。 */
.inspector {
  width: var(--inspector-w);
  flex: none;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 24px 20px 120px 0;
  background: color-mix(in srgb, var(--surface) 24%, transparent);
  border-left: 0.5px solid var(--line);
}

/* 间距统一由 flex gap 给：.card + .card 那条 14px 会与它叠成 28px，
   于是「分组块」之间的呼吸比模块内部还大，整栏读起来是散的 */
.inspector .card + .card {
  margin-top: 0;
}

/* ---------- 组内标题 ---------- */
.c-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.c-head h2 {
  font-size: var(--fs-headline);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.c-more {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent-strong);
  text-decoration: none;
}

/* ---------- 数字行（标签在左、值在右） ---------- */
.stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.stat b {
  font-size: var(--fs-headline);
  font-weight: 700;
  letter-spacing: -0.3px;
  font-variant-numeric: tabular-nums;
}

.cap {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}

/* 方案卡：一行周期 + 一行今天，复盘到期时多一条行动条 */
.p-head {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.p-today {
  margin-top: 3px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.due {
  width: 100%;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-s);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 700;
  text-align: center;
}

/* ---------- 大数字三联（运动 / 收支） ---------- */
.figures {
  display: flex;
  gap: 6px;
}

.fig {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.fig b {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.4px;
  font-variant-numeric: tabular-nums;
}

.danger {
  color: var(--danger-strong);
}

.ok {
  color: var(--ok-strong);
}

/* ---------- 紧凑列表（记录 / 最近三笔 / 待办） ---------- */
.mini {
  display: flex;
  flex-direction: column;
  margin-top: 2px;
}

.mini-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 0;
  text-align: left;
  min-width: 0;
}

.mini-row + .mini-row {
  border-top: 0.5px solid var(--line);
}

.todo + .todo {
  border-top: 0.5px solid var(--line);
}

.mini-ic {
  flex: none;
  color: var(--text-3);
}

.dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
}

.mini-name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mini-meta {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-3);
}

/* ---------- 入口行（AI 工具 / 课表 / 设置） ---------- */
.nav {
  display: flex;
  flex-direction: column;
}

.nav-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 0;
  text-align: left;
  min-width: 0;
}

.nav li + li .nav-row {
  border-top: 0.5px solid var(--line);
}

.nav-ic {
  flex: none;
  color: var(--text-2);
}

.nav-txt {
  flex: 1;
  min-width: 0;
  gap: 1px;
}

.nav-txt b {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.nav-txt em {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-go {
  flex: none;
  color: var(--text-3);
}

/* ---------- 快捷入口按钮（运动页） ---------- */
.quick {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

.qbtn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 11px 4px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-2);
}

/* ---------- 常用问句 ---------- */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.chip-q {
  padding: 7px 11px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
  text-align: left;
}

/* ---------- 宏量进度 ---------- */
.bars {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 14px;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 9px;
}

.bar-label {
  width: 34px;
  flex: none;
  white-space: nowrap;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.bar-track {
  flex: 1;
  min-width: 0;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--ring-track);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  transform-origin: left center;
}

.bar-val {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
}

/* ---------- 待办勾选 ---------- */
.tick {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 0 0 1.7px var(--line-strong);
  color: transparent;
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    box-shadow var(--dur-fast) var(--ease-standard);
}

.tick.on {
  background: var(--tc, var(--cat-general));
  box-shadow: none;
  color: var(--on-accent);
}

/* 对勾弹入 */
.ckin-enter-active {
  transition:
    transform 120ms var(--ease-standard),
    opacity 120ms var(--ease-standard);
}

.ckin-enter-from {
  transform: scale(0.5);
  opacity: 0;
}

.line {
  text-decoration: line-through;
  text-decoration-color: transparent;
  transition:
    color var(--dur-base) var(--ease-standard),
    text-decoration-color var(--dur-base) var(--ease-standard);
}

.line.done {
  color: var(--text-3);
  text-decoration-color: currentColor;
}

.empty {
  padding: 8px 0 2px;
  font-size: var(--fs-footnote);
  color: var(--text-3);
}

/* ---------- AI 提问条 ---------- */
/* 材质（底 / 受光边 / 高光 / 投影 / 模糊）全在 .glass-surface 里 —— 这里只给排版。
   再写一遍 background 或 backdrop-filter 会与它抢同一条声明，胜负取决于样式表顺序。 */
.ask {
  gap: 10px;
  padding: 11px 11px 11px 16px;
  border-radius: var(--radius-full);
}

.ask input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-footnote);
  font-weight: 500;
}

.send {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
