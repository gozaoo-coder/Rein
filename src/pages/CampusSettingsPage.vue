<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, CalendarClock, ChevronRight, CircleCheck, CircleAlert, FileDown, LogOut, RefreshCw, School, Sparkles, Trash2 } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { campusService } from '@/services/campusService'
import { isSessionLostMessage, useCampusStore } from '@/stores/campus'
import { useFeaturesStore } from '@/stores/features'
import type { AiAction, HolidayConfigView, SchoolSystemInfo } from '@/types'

const store = useCampusStore()
const router = useRouter()
const toast = useToast()
// 选课/抢课是课表的子模块（默认关闭）：入口显隐问功能开关
const features = useFeaturesStore()

/* ---------------- 学校系统选择器 ---------------- */

const picked = ref<SchoolSystemInfo | null>(null)
const baseUrl = ref('')

const activeSystem = computed(
  () => picked.value ?? store.systems.find((s) => s.kind === store.account?.systemKind) ?? store.systems[0] ?? null,
)

function pickSystem(s: SchoolSystemInfo): void {
  picked.value = s
  baseUrl.value = s.defaultBaseUrl
  captchaSrc.value = ''
  needCaptcha.value = false
}

/* ---------------- 登录表单 ---------------- */

const loginName = ref('')
const password = ref('')
const captcha = ref('')
const savePassword = ref(true)
const needCaptcha = ref(false)
const captchaSrc = ref('')
/**
 * 表单里的错误。登录是一步错就彻底卡住的操作，**不能只靠 toast** ——
 * 它两秒就没了，用户回头想看清楚失败原因时已经找不到，只能反复试。
 */
const loginError = ref('')
/** 必须去网页端处理的（首次登录改密 / 口令过弱），单独透出给一句带链接的引导 */
const loginAction = ref<string | null>(null)
/**
 * 会话过期。此时 `account.loggedIn` 可能仍为 true（Cookie 还在，只是教务不认了），
 * 光看它会连登录表单都显示不出来，所以用这个标志把表单请回来。
 */
const sessionLost = ref(false)

/** 会话过期且存过密码：密码可以留空 —— 后端会用存下的那份重登（见 Rust `relogin`） */
const canUseSavedPassword = computed(() => sessionLost.value && !!store.account?.hasPassword)

/**
 * 当前选的是正方（ZFSoft）那一套吗。
 *
 * 两家的验证码时机不同，UI 要跟着变：树维**随时可能要**（登录响应里直接说 needCaptcha），
 * 正方是**错够几次才要**，而且失败页里看不出这个要求 —— 所以正方要多一个人工入口。
 */
const isZfsoft = computed(() => activeSystem.value?.loginStrategy === 'zfsoft-login-rsa')

const canLogin = computed(
  () =>
    !!activeSystem.value &&
    loginName.value.trim() !== '' &&
    (password.value !== '' || canUseSavedPassword.value) &&
    !store.loggingIn,
)

// 用户一动手改输入，就把上一次的失败提示收起来（否则他会以为改完还是这个错）。
// 刻意不盯验证码框：登录失败后 `refreshCaptcha()` 会清空它，那是程序自己动的，
// 跟着清会把「验证码不正确」这句话一闪就抹掉。
watch([loginName, password], () => {
  loginError.value = ''
  loginAction.value = null
})

function refreshCaptcha(): void {
  const sys = activeSystem.value
  if (!sys) return
  void (async () => {
    try {
      const b64 = await campusService.captcha(sys.kind, baseUrl.value.trim(), loginName.value.trim())
      captchaSrc.value = `data:image/jpeg;base64,${b64}`
      needCaptcha.value = true
      captcha.value = ''
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : '获取验证码失败')
    }
  })()
}

async function onLogin(): Promise<void> {
  const sys = activeSystem.value
  if (!sys) return
  loginError.value = ''
  loginAction.value = null
  try {
    const outcome = await store.login({
      systemKind: sys.kind,
      baseUrl: baseUrl.value.trim(),
      loginName: loginName.value.trim(),
      // 密码不做任何 trim：桂电的密码末尾的点是密码的一部分，去掉就登不上
      password: password.value,
      captcha: captcha.value,
      savePassword: savePassword.value,
    })

    if (outcome.ok) {
      sessionLost.value = false
      toast.toast(`已登录${outcome.account?.studentName ? ` · ${outcome.account.studentName}` : ''}`)
      password.value = ''
      captcha.value = ''
      needCaptcha.value = false
      captchaSrc.value = ''
      // 登录完顺手把课表拉下来 —— 用户登进来就是为了看课表
      await onSync()
      return
    }

    // 失败：把原因**留在表单里**。后端保证这里一定有话可说（见 `guet::login_failure`）
    loginError.value = outcome.message ?? '登录失败，请重试'
    loginAction.value = outcome.actionRequired
    if (outcome.needCaptcha) refreshCaptcha()
  } catch (e) {
    loginError.value = e instanceof Error ? e.message : '登录失败'
  }
}

/* ---------------- 同步 ---------------- */

const syncHint = computed(() => {
  const a = store.account
  if (!a?.lastSyncAt) return '还没有同步过'
  const r = store.lastSync
  const tail = r ? ` · ${r.courses} 门课 / ${r.sessions} 个时段` : ''
  return `上次同步：${new Date(a.lastSyncAt).toLocaleString('zh-CN')}${tail}`
})

async function onSync(): Promise<void> {
  try {
    const r = await store.sync()
    sessionLost.value = false
    toast.toast(`${r.semesterName}：写入 ${r.todosWritten} 条时间线日程`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '同步失败'
    // 会话过期：把登录表单请出来。存了密码的账号后端已经自动重登过一轮了，
    // 走到这里说明那一轮也没成（多半是没存密码），只能用户亲手上。判据优先看错误码
    if (isSessionLostMessage(e)) sessionLost.value = true
    toast.toast(msg)
  }
}

async function onSemesterChange(id: number): Promise<void> {
  try {
    await store.setCurrentSemester(id)
    toast.toast('已切换学期，时间线已重建')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '切换学期失败')
  }
}

/* ---------------- 账号管理 ---------------- */

const confirmOpen = ref(false)
// 取消由 ActionSheet 自己那颗「取消」承担，清单里不再重复一条
const dangerActions = [{ label: '删除账号并清除课表日程', value: 'delete', danger: true }]

async function onDanger(value: string): Promise<void> {
  confirmOpen.value = false
  if (value !== 'delete') return
  try {
    await store.removeAccount()
    toast.toast('账号与课表日程已清除')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '删除失败')
  }
}

async function onLogout(): Promise<void> {
  try {
    await store.logout()
    toast.toast('已退出登录，课表保留为只读快照')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '退出失败')
  }
}

/* ---------------- AI 操作记录 ---------------- */

const audit = ref<AiAction[]>([])
const auditBusy = ref(false)
const exportBusy = ref(false)
/** 记录里的时刻：只给到分钟 —— 一口气看二十条时，秒没有意义 */
function shortAt(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadAudit(): Promise<void> {
  auditBusy.value = true
  try {
    // probe=false：这里只看落库的现场，不该因为打开设置页就打一次教务
    const st = await campusService.rescueState(false)
    audit.value = st.recentActions
  } catch {
    /* 读不到就不显示：它只是记录，不该在设置页弹错误 */
  } finally {
    auditBusy.value = false
  }
}

async function onExportScript(): Promise<void> {
  exportBusy.value = true
  try {
    const out = await campusService.curlExport({ hours: 24 })
    toast.toast(`已导出 ${out.count} 条请求 → ${out.path}`)
    await loadAudit()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '导出失败')
  } finally {
    exportBusy.value = false
  }
}

/* ---------------- 官方调休映射 ---------------- */

/**
 * 开关 + 按日期的手动覆盖。这里**不做前端推断** —— 后端才是映射的唯一真源
 * （课表页与首页时间线都要生效），前端只负责把用户的纠正回写。
 */
const holidayView = ref<HolidayConfigView | null>(null)
const holidayEnabled = ref(true)
const holidayBusy = ref(false)
/** 新增覆盖用的草稿：日期 + 补星期几 */
const holidayDraftDate = ref('')
const holidayDraftWeekday = ref(3)

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 当前生效的补班映射，按日期升序（含被覆盖为「不补课」的行） */
const holidayRows = computed(() =>
  Object.entries(holidayView.value?.makeups ?? {})
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, weekday]) => ({ date, weekday })),
)

async function loadHoliday(): Promise<void> {
  try {
    const v = await campusService.holidayConfigGet()
    holidayView.value = v
    holidayEnabled.value = v.enabled
  } catch {
    // 数据源不可达不该打断设置页：保留上一次的值，用户仍可改开关
  }
}

async function persistHoliday(patch: { enabled?: boolean; overrides?: Record<string, number> }): Promise<void> {
  if (holidayBusy.value) return
  holidayBusy.value = true
  try {
    await campusService.holidayConfigSet({
      enabled: patch.enabled ?? holidayEnabled.value,
      overrides: patch.overrides ?? holidayView.value?.overrides ?? {},
    })
    await loadHoliday()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '保存调休映射失败')
  } finally {
    holidayBusy.value = false
  }
}

function onHolidayToggle(v: boolean): void {
  holidayEnabled.value = v
  void persistHoliday({ enabled: v })
}

/** 改某一天补星期几；`0` = 该日不补课 */
function onHolidayWeekday(date: string, weekday: number): void {
  void persistHoliday({ overrides: { ...(holidayView.value?.overrides ?? {}), [date]: weekday } })
}

function onHolidayAdd(): void {
  const date = holidayDraftDate.value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    toast.toast('请先选择日期')
    return
  }
  void persistHoliday({ overrides: { ...(holidayView.value?.overrides ?? {}), [date]: holidayDraftWeekday.value } })
  holidayDraftDate.value = ''
}

onMounted(async () => {
  await store.init()
  void loadAudit()
  void loadHoliday()
  const a = store.account
  if (a) {
    loginName.value = a.loginName
    baseUrl.value = a.baseUrl
  } else if (activeSystem.value) {
    baseUrl.value = activeSystem.value.defaultBaseUrl
  }
})
</script>

<template>
  <div class="page">
    <PageHeader title="课表配置与设置" subtitle="绑定学校教务系统后自动同步课表" back />

    <!-- 桌面栅格：壳层只把 .page 的**直接子项**摊成两栏，而这一页里有两张卡
         需要通栏（见 .desk-main 那段注释），所以自带一层 .d-grid 承接。
         手机端它只是个普通 div，块流与卡片间距都不变 -->
    <div class="d-grid set-grid">
    <!-- ① 学校系统选择器（抽象层的 UI 出口） -->
    <section class="card">
      <div class="sec-head">
        <School :size="17" />
        <h2>学校系统</h2>
      </div>
      <ul class="sys-list">
        <li v-for="s in store.systems" :key="s.kind">
          <button class="sys" :class="{ on: activeSystem?.kind === s.kind }" @click="pickSystem(s)">
            <div class="sys-main">
              <span class="sys-name">{{ s.name }}</span>
              <span class="sys-vendor">{{ s.vendor }}</span>
            </div>
            <CircleCheck v-if="activeSystem?.kind === s.kind" :size="18" class="tick" />
          </button>
        </li>
      </ul>

      <label class="flabel">服务地址</label>
      <input v-model="baseUrl" type="url" class="mono" autocomplete="off" spellcheck="false" />
      <p class="tip">
        {{ activeSystem?.baseUrlHint }}
        <template v-if="activeSystem?.bizTypeId">业务类型：本科生（{{ activeSystem.bizTypeId }}）。</template>
      </p>
    </section>

    <!-- ② 登录 / 账号状态 -->
    <section class="card">
      <div class="sec-head">
        <CircleCheck v-if="store.account?.loggedIn" :size="17" class="ok" />
        <CircleAlert v-else :size="17" class="warn" />
        <h2>{{ store.account?.loggedIn ? '已登录' : '登录教务系统' }}</h2>
      </div>

      <div v-if="store.account" class="who">
        <p class="who-name">
          {{ store.account.studentName ?? store.account.loginName }}
          <span class="who-code">{{ store.account.studentCode ?? store.account.loginName }}</span>
        </p>
        <p v-if="store.account.department" class="who-line">
          {{ store.account.department }}<template v-if="store.account.major"> · {{ store.account.major }}</template>
        </p>
        <p v-if="store.account.adminclass" class="who-line">
          行政班 {{ store.account.adminclass }}
          <template v-if="store.account.grade"> · {{ store.account.grade }} 级</template>
          <template v-if="store.account.totalCredits"> · {{ store.account.totalCredits }} 学分</template>
        </p>
        <p class="who-line dim">
          <template v-if="sessionLost">会话已过期，需要重新登录</template>
          <template v-else-if="store.account.sessionAt">
            会话确认于 {{ new Date(store.account.sessionAt).toLocaleString('zh-CN') }}
          </template>
          <template v-else>会话未确认</template>
          <template v-if="!store.account.hasPassword"> · 未保存密码，过期后需重新登录</template>
        </p>
      </div>

      <template v-if="!store.account?.loggedIn || sessionLost">
        <!-- 会话过期时的引导：存了密码就别让人再输一遍 -->
        <p v-if="sessionLost" class="banner">
          <CircleAlert :size="14" />
          <span>
            教务会话已过期。
            <template v-if="store.account?.hasPassword">密码已保存，直接点「重新登录」就行，不用重新输入。</template>
            <template v-else>请重新输入密码登录一次。</template>
          </span>
        </p>

        <label class="flabel">学号</label>
        <input v-model="loginName" type="text" inputmode="numeric" autocomplete="username" placeholder="学号" />

        <label class="flabel">密码</label>
        <input v-model="password" type="password" autocomplete="current-password" placeholder="教务系统密码" />
        <p class="tip">密码区分大小写，<b>结尾的符号也要原样输入</b>（不会被自动去除）。</p>

        <!-- 正方的验证码是「错够几次才要」，而登录失败页里**看不到**这个要求
             （没有验证码输入框的痕迹，只有一句提示文字）。所以给一个人工出口：
             教务一旦要求验证码，用户在这里就能把输入框请出来，而不是卡死。 -->
        <button v-if="isZfsoft && !needCaptcha" class="cap-link" @click="refreshCaptcha">
          教务提示需要验证码？点这里获取
        </button>

        <template v-if="needCaptcha">
          <label class="flabel">验证码</label>
          <div class="cap-row">
            <input v-model="captcha" type="text" class="cap-input" autocomplete="off" placeholder="图中字符" />
            <button class="cap-img" aria-label="刷新验证码" @click="refreshCaptcha">
              <img v-if="captchaSrc" :src="captchaSrc" alt="验证码" />
              <RefreshCw v-else :size="16" />
            </button>
          </div>
        </template>

        <label class="check">
          <input v-model="savePassword" type="checkbox" />
          <span>保存密码（会话过期后可自动重登）</span>
        </label>

        <button class="primary" :disabled="!canLogin" @click="onLogin">
          {{ store.loggingIn ? '登录中…' : canUseSavedPassword && password === '' ? '重新登录' : '登录' }}
        </button>

        <!-- 失败原因留在表单里：toast 会消失，而它要提醒你去解决的问题不会 -->
        <p v-if="loginError" class="form-err">
          <CircleAlert :size="14" />
          <span>{{ loginError }}</span>
        </p>
        <p v-if="loginAction" class="form-hint">
          这一条只能在教务网页端处理：<a :href="baseUrl" target="_blank" rel="noreferrer">{{ baseUrl }}</a>，
          处理完回来再登录。
        </p>
      </template>

      <div v-else class="acts">
        <button class="ghost" :disabled="store.syncing" @click="onSync">
          {{ store.syncing ? '同步中…' : '重新同步' }}
        </button>
        <button class="ghost" @click="onLogout">
          <LogOut :size="15" /> 退出登录
        </button>
      </div>
    </section>

    <!-- ③ 课表同步 -->
    <section v-if="store.account" class="card">
      <div class="sec-head">
        <RefreshCw :size="17" />
        <h2>课表同步</h2>
      </div>

      <label class="flabel">当前学期</label>
      <select
        class="sel"
        :value="store.semester?.id ?? ''"
        :disabled="store.syncing"
        @change="onSemesterChange(Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="s in store.semesters" :key="s.id" :value="s.id">
          {{ s.name }}（{{ s.startDate }} ~ {{ s.endDate }}，{{ s.totalWeeks }} 周）
        </option>
      </select>

      <p class="tip">{{ syncHint }}</p>

      <button class="primary" :disabled="store.syncing" @click="onSync">
        {{ store.syncing ? '同步中…' : '立即同步' }}
      </button>
      <p class="tip">
        同步会把课表写进时间线（过去一周 + 未来五周）。已打勾的历史日程不会被覆盖。
      </p>
    </section>

    <!-- ④ 培养方案与选课 -->
    <section v-if="store.account" class="card">
      <div class="sec-head">
        <BookOpen :size="17" />
        <h2>培养方案与选课</h2>
      </div>
      <button class="link-row" @click="router.push({ name: 'campus-program' })">
        <span>
          查看培养方案与学分完成度
          <em v-if="store.account.totalCredits">已修 {{ store.account.totalCredits }} 学分</em>
        </span>
        <ChevronRight :size="18" />
      </button>
      <!-- 选课/抢课是课表的子模块（默认关闭）：入口跟着开关走，不再只是一个「开着的页面」 -->
      <button
        v-if="features.isEnabled('campus-grab')"
        class="link-row"
        @click="router.push({ name: 'campus-course-select' })"
      >
        <span>
          选课（直连教务）
          <em>选课窗口开放后可在这里一键选课</em>
        </span>
        <ChevronRight :size="18" />
      </button>
      <p v-else class="tip">
        「选课 · 抢课」是课表的子模块，默认关闭。需要时到「设置 › 打开或关闭功能」里打开。
      </p>
    </section>

    <!-- ⑤ 官方调休映射：默认开。关掉即不显示「假 / 调」标记，也不做任何映射 -->
    <section v-if="store.account" class="card">
      <div class="sec-head">
        <CalendarClock :size="17" />
        <h2>官方调休映射</h2>
        <div class="head-switch">
          <ToggleSwitch
            :model-value="holidayEnabled"
            label="根据官方调休数据进行映射"
            :disabled="holidayBusy"
            @update:model-value="onHolidayToggle"
          />
        </div>
      </div>
      <p class="tip">
        开启后，法定放假日会在课表与时间线上标「假」，补班日会把被补那天的课一并显示并标「调」。
        数据来自公开的 holiday-cn 校历库；补哪一天由规律推断，下面可以逐日纠正。
      </p>

      <template v-if="holidayEnabled">
        <ul v-if="holidayRows.length" class="holiday-list">
          <li v-for="row in holidayRows" :key="row.date">
            <span class="h-date num">{{ row.date }}</span>
            <select
              class="h-sel"
              :value="row.weekday"
              :disabled="holidayBusy"
              @change="onHolidayWeekday(row.date, Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="(label, i) in WEEKDAY_LABELS" :key="label" :value="i + 1">{{ label }}</option>
              <option :value="0">不补课</option>
            </select>
          </li>
        </ul>
        <p v-else class="tip">当前学期内还没有可映射的调休日（数据可能还没取到）。</p>

        <div class="holiday-add">
          <input v-model="holidayDraftDate" class="h-date-input" type="date" />
          <select v-model.number="holidayDraftWeekday" class="h-sel">
            <option v-for="(label, i) in WEEKDAY_LABELS" :key="label" :value="i + 1">{{ label }}</option>
          </select>
          <button class="mini" :disabled="holidayBusy" @click="onHolidayAdd">添加</button>
        </div>
      </template>
    </section>

    <!-- ⑥ AI 排障：操作记录 + 救援脚本。写操作不弹确认（抢课窗口里确认就是拖延），
         那份信任必须由「事后能一条条查、且每条都能重放」来兜底。 -->
    <section v-if="store.account" class="card audit-card d-full">
      <div class="sec-head">
        <Sparkles :size="17" />
        <h2>AI 操作记录</h2>
        <button class="mini" :disabled="auditBusy" @click="loadAudit">
          {{ auditBusy ? '读取中…' : '刷新' }}
        </button>
      </div>
      <p class="tip">
        让 AI 排查抢课问题时（抢课页的「交给 AI 排查」），它对教务与抢课引擎做过的每一步都会记在这里。
        导出的脚本把这一路的请求原样搬下来，**脱离 App 也能重放**。
      </p>
      <button class="mini wide" :disabled="exportBusy" @click="onExportScript">
        <FileDown :size="14" />
        {{ exportBusy ? '导出中…' : '导出救援脚本' }}
      </button>
      <ul v-if="audit.length" class="audit">
        <li v-for="a in audit.slice(0, 20)" :key="a.id">
          <span class="at num">{{ shortAt(a.at) }}</span>
          <span class="kind">{{ a.kind }}</span>
          <span class="what" :class="{ bad: a.status === 'error' }">{{ a.summary }}</span>
        </li>
      </ul>
      <p v-else class="tip">
        还没有记录 —— AI 一旦对教务动手（探请求、重排任务、重登、导出脚本），这里会一条条出现。
      </p>
    </section>

    <!-- ⑦ 账号管理 -->
    <section v-if="store.account" class="card danger-card d-full">
      <div class="sec-head">
        <Trash2 :size="17" />
        <h2>账号管理</h2>
      </div>
      <p class="tip">
        退出登录只清除会话，课表与已生成的时间线会保留为只读快照；删除账号则会连同课表与派生日程一起清除。
      </p>
      <button class="danger" @click="confirmOpen = true">删除账号</button>
    </section>
    </div>

    <ActionSheet
      :open="confirmOpen"
      title="确认删除该账号？"
      :actions="dangerActions"
      @close="confirmOpen = false"
      @select="onDanger"
    />
  </div>
</template>

<style scoped>
.page {
  padding: 0 var(--page-pad-x) var(--page-pad-bottom);
}

.sec-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  color: var(--text-2);
}

.sec-head h2 {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

/* 记录区的「刷新」「导出脚本」：次级按钮，不跟页面的主操作抢注意力 */
.mini {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 12px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
}

.mini:disabled {
  opacity: 0.55;
}

.mini.wide {
  width: 100%;
  margin-left: 0;
  margin-bottom: 10px;
}

.audit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.audit li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.audit .at {
  flex: none;
  color: var(--text-3);
}

.audit .kind {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  font-weight: 700;
  color: var(--text-2);
  background: var(--surface-2);
}

.audit .what {
  color: var(--text-2);
  word-break: break-all;
}

.audit .what.bad {
  color: var(--warn);
}

.ok {
  color: var(--ok);
}

.warn {
  color: var(--warn);
}

/* ---------- 学校系统 ---------- */
.sys-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 4px;
}

.sys {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: left;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.sys:active {
  transform: scale(0.985);
}

.sys.on {
  background: var(--accent-soft);
}

.sys-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 学校名带「（正式）」这类长后缀，窄卡里折行：balance 掉「式）」这类孤字尾行 */
.sys-name {
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
  text-wrap: balance;
}

.sys-vendor {
  font-size: var(--fs-micro);
  color: var(--text-3);
  text-wrap: balance;
}

.tick {
  flex: none;
  color: var(--accent);
}

/* ---------- 表单 ---------- */
.flabel {
  display: block;
  margin: 12px 0 5px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

input[type='text'],
input[type='password'],
input[type='url'],
.sel {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  border: 0.5px solid transparent;
  transition: border-color var(--dur-fast) var(--ease-standard);
}

input:focus,
.sel:focus {
  border-color: var(--accent);
  outline: none;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-caption);
}

.sel {
  appearance: none;
}

.tip {
  margin-top: 6px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.45;
}

/* ---------- 官方调休映射 ---------- */
.head-switch {
  margin-left: auto;
  display: flex;
}

.holiday-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.holiday-list li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.h-date {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.h-sel {
  margin-left: auto;
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
}

.holiday-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.h-date-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
}

.holiday-add .h-sel {
  margin-left: 0;
}

.holiday-add .mini {
  margin-left: 0;
  flex: none;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.cap-row {
  display: flex;
  gap: 8px;
}

/* 正方的「人工取验证码」入口：做得像一个可点的提示，而不是主操作按钮 */
.cap-link {
  margin-top: 8px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-micro);
  font-weight: 600;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.cap-link:active {
  transform: scale(0.985);
}

.cap-input {
  flex: 1;
  min-width: 0;
}

.cap-img {
  flex: none;
  width: 96px;
  height: 42px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--text-3);
}

.cap-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* ---------- 按钮 ---------- */
.primary {
  width: 100%;
  margin-top: 14px;
  padding: 12px;
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

.primary:disabled {
  opacity: 0.45;
}

/* ---------- 失败反馈 ---------- */
.banner {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 10px;
  padding: 9px 11px;
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
  font-size: var(--fs-caption);
  line-height: 1.4;
}

.form-err {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 10px;
  color: var(--danger);
  font-size: var(--fs-caption);
  line-height: 1.4;
}

.form-hint {
  margin-top: 6px;
  color: var(--text-3);
  font-size: var(--fs-micro);
  line-height: 1.45;
}

.form-hint a {
  color: var(--accent);
  word-break: break-all;
}

.banner svg,
.form-err svg {
  flex: none;
  margin-top: 1px;
}

.acts {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.ghost {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 11px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: 600;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.ghost:active {
  transform: scale(0.985);
}

.ghost:disabled {
  opacity: 0.45;
}

.danger {
  width: 100%;
  margin-top: 12px;
  padding: 11px;
  border-radius: var(--radius-m);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-caption);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.danger:active {
  transform: scale(0.985);
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   前四张是两两成对的短卡（学校系统 | 登录、课表同步 | 培养方案），壳层那套
   半栏栅格正合适；两张不成对的要单独说：
   ============================================================ */

/* AI 操作记录：它是一份会随记录条数长高的日志，行内是「时刻 / 种类 / 摘要」三列 ——
   半栏里每行的摘要都要折行，通栏才读成一张表。导出键也跟着从满宽收回自适应宽 */
.desk-main .audit-card .mini.wide {
  width: auto;
  margin-bottom: 0;
}

/* 账号管理：跟着通栏，横排成「说明在左、危险动作在右」——
   它若留在半栏，行尾会空出半个屏幕，而它本来只有一句话加一个按钮 */
.desk-main .danger-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 var(--desk-gap);
  align-items: center;
}

.desk-main .danger-card > .sec-head {
  grid-column: 1 / -1;
}

/* 通栏之后满宽的红色按钮会顶成一条 1000px 的长条：只留它自己那份宽度 */
.desk-main .danger-card > .danger {
  width: auto;
  margin-top: 0;
  padding: 11px 22px;
}

/* ---------- 账号信息 ---------- */
.who {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  margin-bottom: 4px;
}

.who-name {
  font-size: var(--fs-callout);
  font-weight: 700;
  color: var(--text-1);
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.who-code {
  font-size: var(--fs-caption);
  font-weight: 500;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.who-line {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.4;
}

.who-line.dim {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ---------- 链接行 ---------- */
.link-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  text-align: left;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.link-row:active {
  transform: scale(0.985);
}

.link-row em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}
</style>
