import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { onUpdateProgress, updateService } from '@/services/updateService'
import type {
  DownloadState,
  InstallResult,
  OnlineServiceStatus,
  UpdateCheck,
  UpdateSettings,
  UpdateSettingsPatch,
  UpdateSnapshot,
} from '@/types'

/**
 * 在线更新：唯一事实来源是 Rust 侧的 `UpdateHub` + `app_meta`，这里只做镜像与编排。
 *
 * 两个刻意的取舍：
 * 1. **进度监听挂在 store 上而不是页面里**：下载要在切页/收起页面后继续可见，
 *    页面卸载时退订会让进度条「一离开就瞎」。store 是应用级单例，正好当这个宿主。
 * 2. **状态以后端为准**：任何操作后都拿后端返回的快照覆盖本地，不在前端推算进度 ——
 *    前端推算出来的进度一旦与后端不一致，用户看到的百分比就会开始漂。
 */
export const useUpdateStore = defineStore('update', () => {
  const snapshot = ref<UpdateSnapshot | null>(null)
  const loading = ref(false)
  const checking = ref(false)
  const installing = ref(false)
  const error = ref<string | null>(null)
  const online = ref<OnlineServiceStatus | null>(null)
  const onlineLoading = ref(false)

  let progressBound = false
  /** 下载中兜底轮询：事件在 WebView 被挂起/页面刚挂载时会丢，轮询保证进度一定在走 */
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const settings = computed<UpdateSettings | null>(() => snapshot.value?.settings ?? null)
  const check = computed<UpdateCheck | null>(() => snapshot.value?.check ?? null)
  /** 下载进度（与下面的 startDownload 动作区分开，别同名） */
  const downloadState = computed<DownloadState | null>(() => snapshot.value?.download ?? null)
  const currentVersion = computed(() => snapshot.value?.currentVersion ?? '')
  const phase = computed(() => downloadState.value?.phase ?? 'idle')
  const readyToInstall = computed(() => snapshot.value?.readyToInstall ?? false)
  /** 正在下载/校验/安装：这期间不允许重复触发 */
  const busy = computed(() =>
    (['preparing', 'downloading', 'verifying', 'installing'] as const).includes(
      phase.value as 'preparing' | 'downloading' | 'verifying' | 'installing',
    ),
  )
  /** 有可用更新，且用户没有跳过这个版本 */
  const hasUpdate = computed(() => Boolean(check.value?.available) && !check.value?.ignored)

  function mergeProgress(state: DownloadState): void {
    if (!snapshot.value) return
    snapshot.value = {
      ...snapshot.value,
      download: state,
      readyToInstall: state.verified,
    }
  }

  /** 首次使用即订阅进度事件；常驻不退订（见 store 头注释）。 */
  function ensureProgressBinding(): void {
    if (progressBound) return
    progressBound = true
    onUpdateProgress(mergeProgress)
  }

  /** 下载期间开一个低频轮询；完成后自动停。 */
  function ensurePolling(): void {
    if (pollTimer) return
    pollTimer = setInterval(async () => {
      if (!busy.value) {
        stopPolling()
        return
      }
      try {
        mergeProgress(await updateService.progress())
      } catch {
        /* 轮询失败不打断：事件通道仍是主路径 */
      }
    }, 700)
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function captureError(e: unknown, fallback: string): void {
    error.value = e instanceof Error ? e.message : String(e ?? fallback)
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      ensureProgressBinding()
      snapshot.value = await updateService.status()
      // 事件在订阅前可能已经发生过，拉一次兜底
      if (busy.value) {
        mergeProgress(await updateService.progress())
        ensurePolling()
      }
    } catch (e) {
      captureError(e, '读取更新状态失败')
    } finally {
      loading.value = false
    }
  }

  /** 检查更新。force = 用户手动点的（忽略总开关与间隔）。 */
  async function checkNow(force = true): Promise<UpdateCheck | null> {
    checking.value = true
    error.value = null
    try {
      const result = await updateService.check(force)
      // 后端把候选与检查结果都存了，这里直接刷新整份快照
      snapshot.value = await updateService.status()
      return result
    } catch (e) {
      captureError(e, '检查更新失败')
      return null
    } finally {
      checking.value = false
    }
  }

  /**
   * 启动时的静默检查：只在「开关打开 + 距上次检查超过间隔」时跑。
   * 返回值 = 是否有新版本（调用方决定要不要提示）。
   */
  async function autoCheckIfDue(): Promise<boolean> {
    const s = snapshot.value?.settings
    if (!s?.enabled || !s.autoCheck) return false
    const last = s.lastCheckAt ? Date.parse(s.lastCheckAt) : 0
    const due = Date.now() - last > Math.max(1, s.checkIntervalHours) * 3600_000
    if (!due) return hasUpdate.value
    await checkNow(false)
    return hasUpdate.value
  }

  async function save(patch: UpdateSettingsPatch): Promise<boolean> {
    try {
      snapshot.value = await updateService.saveSettings(patch)
      return true
    } catch (e) {
      captureError(e, '保存设置失败')
      return false
    }
  }

  async function startDownload(): Promise<boolean> {
    error.value = null
    try {
      const state = await updateService.download()
      mergeProgress(state)
      ensurePolling()
      return true
    } catch (e) {
      captureError(e, '开始下载失败')
      return false
    }
  }

  async function cancel(): Promise<void> {
    try {
      await updateService.cancel()
      stopPolling()
      mergeProgress(await updateService.progress())
    } catch (e) {
      captureError(e, '取消失败')
    }
  }

  async function discard(): Promise<void> {
    try {
      await updateService.discard()
      snapshot.value = await updateService.status()
    } catch (e) {
      captureError(e, '丢弃安装包失败')
    }
  }

  async function install(): Promise<InstallResult | null> {
    installing.value = true
    error.value = null
    try {
      const result = await updateService.install()
      stopPolling()
      snapshot.value = await updateService.status()
      return result
    } catch (e) {
      captureError(e, '安装失败')
      return null
    } finally {
      installing.value = false
    }
  }

  async function pruneCache(): Promise<number> {
    try {
      return await updateService.pruneCache()
    } catch (e) {
      captureError(e, '清理缓存失败')
      return 0
    }
  }

  /** 探测 Rein 在线服务（模型网关预留接口）。 */
  async function probeOnline(baseUrl?: string): Promise<OnlineServiceStatus | null> {
    onlineLoading.value = true
    try {
      online.value = await updateService.onlineServiceStatus(baseUrl)
      return online.value
    } catch (e) {
      captureError(e, '在线服务探测失败')
      return null
    } finally {
      onlineLoading.value = false
    }
  }

  return {
    snapshot,
    loading,
    checking,
    installing,
    error,
    online,
    onlineLoading,
    settings,
    check,
    downloadState,
    currentVersion,
    phase,
    busy,
    readyToInstall,
    hasUpdate,
    load,
    checkNow,
    autoCheckIfDue,
    save,
    startDownload,
    cancel,
    discard,
    install,
    pruneCache,
    probeOnline,
  }
})
