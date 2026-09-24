import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { campusService } from '@/services/campusService'
import { useTodoStore } from '@/stores/todo'
import type {
  CampusAccount,
  CampusLoginInput,
  CampusSemester,
  LoginOutcome,
  ScheduleEntry,
  ScheduleView,
  SchoolSystemInfo,
  SyncOutcome,
} from '@/types'
import { todayStr, addDays } from '@/utils/date'

/**
 * 校园教务域 store。
 *
 * 只做三件事：持有课表视图、驱动同步、在同步后让时间线重新加载
 * （课表会写 `todos` 的派生行，不刷新的话首页时间线要等下次进页面才更新）。
 */
export const useCampusStore = defineStore('campus', () => {
  const systems = ref<SchoolSystemInfo[]>([])
  const account = ref<CampusAccount | null>(null)
  const semesters = ref<CampusSemester[]>([])
  const view = ref<ScheduleView | null>(null)

  const loading = ref(false)
  const syncing = ref(false)
  const loggingIn = ref(false)
  /** 最近一次同步的结果，配置页用来展示「18 门课 / 42 个时段」这类回执 */
  const lastSync = ref<SyncOutcome | null>(null)

  const hasAccount = computed(() => account.value !== null)
  const semester = computed(() => view.value?.semester ?? null)
  const courses = computed(() => view.value?.courses ?? [])
  const timeSlots = computed(() => view.value?.timeSlots ?? [])
  const entries = computed(() => view.value?.entries ?? [])

  /** 日期 → 当天所有课（已按开始时间升序，后端保证） */
  const byDate = computed(() => {
    const map = new Map<string, ScheduleEntry[]>()
    for (const e of entries.value) {
      const list = map.get(e.date)
      if (list) list.push(e)
      else map.set(e.date, [e])
    }
    return map
  })

  const currentSemesterId = computed(() => semester.value?.id ?? null)

  function entriesOn(date: string): ScheduleEntry[] {
    return byDate.value.get(date) ?? []
  }

  /** 当前学期名 + 第几周，给页头副标题用 */
  const headerSubtitle = computed(() => {
    const s = semester.value
    if (!s) return ''
    return s.currentWeek ? `${s.name} · 第${s.currentWeek}周` : s.name
  })

  async function init(): Promise<void> {
    if (systems.value.length === 0) {
      systems.value = await campusService.systems()
    }
    account.value = await campusService.accountGet()
    if (account.value) {
      semesters.value = await campusService.semesters()
    }
  }

  /** 读一段日期区间的课表。区间由调用方按当前视图算好。 */
  async function loadRange(from: string, to: string, semesterId?: number | null): Promise<void> {
    loading.value = true
    try {
      view.value = await campusService.schedule({ from, to, semesterId: semesterId ?? null })
      account.value = view.value.account
      if (view.value.semester) {
        semesters.value = await campusService.semesters()
      }
    } finally {
      loading.value = false
    }
  }

  async function login(input: CampusLoginInput): Promise<LoginOutcome> {
    loggingIn.value = true
    try {
      const outcome = await campusService.login(input)
      if (outcome.ok) {
        account.value = outcome.account
        semesters.value = await campusService.semesters()
      }
      return outcome
    } finally {
      loggingIn.value = false
    }
  }

  /** 同步课表。成功后刷新时间线 —— 派生日程是写进 todos 的。 */
  async function sync(semesterId?: number | null): Promise<SyncOutcome> {
    syncing.value = true
    try {
      const outcome = await campusService.sync(semesterId ?? currentSemesterId.value)
      lastSync.value = outcome
      account.value = await campusService.accountGet()
      semesters.value = await campusService.semesters()
      await useTodoStore().loadAll()
      return outcome
    } finally {
      syncing.value = false
    }
  }

  /**
   * 会话过期后的静默重登：密码留空，后端会回落到账号里存的那份。
   *
   * 后端自己也会在联网命令里做这件事（见 Rust `commands::recover_session`），
   * 所以这里失败基本只剩两种情况：**没存密码**，或者存的那份也登不上了 ——
   * 两种都必须把用户请到表单里，而不是丢一句「请重新登录」让他自己找。
   */
  async function relogin(): Promise<LoginOutcome> {
    const a = account.value
    if (!a) {
      return {
        ok: false,
        message: '还没有绑定教务系统账号，请先登录一次',
        needCaptcha: false,
        actionRequired: null,
        account: null,
      }
    }
    return login({
      systemKind: a.systemKind,
      baseUrl: a.baseUrl,
      loginName: a.loginName,
      password: '',
      savePassword: a.savePassword,
    })
  }

  async function setCurrentSemester(semesterId: number): Promise<void> {
    await campusService.setCurrentSemester(semesterId)
    await sync(semesterId)
  }

  /** 只清会话；课表快照与已生成的时间线保留为只读快照 */
  async function logout(): Promise<void> {
    await campusService.logout()
    account.value = await campusService.accountGet()
  }

  /** 删账号：课表与派生日程一起清掉 */
  async function removeAccount(): Promise<void> {
    await campusService.accountDelete()
    account.value = null
    semesters.value = []
    view.value = null
    lastSync.value = null
    await useTodoStore().loadAll()
  }

  /** 会话是否还有效；供配置页显示「已过期」状态、同步前预检 */
  async function probeSession(): Promise<boolean> {
    try {
      return await campusService.sessionProbe()
    } catch {
      return false
    }
  }

  return {
    systems,
    account,
    semesters,
    view,
    loading,
    syncing,
    loggingIn,
    lastSync,
    hasAccount,
    semester,
    courses,
    timeSlots,
    entries,
    byDate,
    currentSemesterId,
    headerSubtitle,
    entriesOn,
    init,
    loadRange,
    login,
    relogin,
    sync,
    setCurrentSemester,
    logout,
    removeAccount,
    probeSession,
  }
})

/** 课表页默认的时间窗口，与 Rust 侧物化窗口一致（过去一周 + 未来五周） */
export function defaultRange(today = todayStr()): { from: string; to: string } {
  return { from: addDays(today, -7), to: addDays(today, 35) }
}

/**
 * 这条错误是不是「教务会话过期」。
 *
 * 判据以 IPC 错误码为准（Rust `ReinError::code = "session_lost"`，后端所有
 * 「需要重新登录」的出口都带着它）；关键词只作兜底 —— 错误被二次包装后码会丢，
 * mock/浏览器模式下的普通 Error 也没有码。前端认它只为一件事：
 * 把「去重新登录」这个动作直接递给用户，而不是让他自己去配置页里找。
 */
export function isSessionLostMessage(err: unknown): boolean {
  const obj = typeof err === 'object' && err !== null ? (err as { code?: unknown; message?: unknown }) : null
  if (obj?.code === 'session_lost') return true
  const msg = obj ? String(obj.message ?? '') : String(err ?? '')
  return (
    msg.includes('会话已过期') ||
    msg.includes('重新登录') ||
    msg.includes('登录已过期')
  )
}
