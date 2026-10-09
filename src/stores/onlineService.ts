/**
 * Rein 在线服务：用服务密钥换模型目录 → 按服务端清单落库 → 与服务端对账成本。
 *
 * 这里是「服务端说了算」的落点：模型清单、单价、流量价全部来自 `/v1/models` 的
 * `rein` 扩展字段，本地不猜、也不让用户手填模型 ID。密钥存在本机（app_meta），
 * 从界面上只会以 `rein_sk_…abcd` 的形式回显。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { onlineService } from '@/services/onlineService'
import type { OnlineCatalog, OnlineServiceSettings, OnlineUsage } from '@/types'

export const useOnlineServiceStore = defineStore('online-service', () => {
  const settings = ref<OnlineServiceSettings>({ baseUrl: '', apiKey: '', savedAt: null })
  const catalog = ref<OnlineCatalog | null>(null)
  const usage = ref<OnlineUsage | null>(null)
  const loading = ref(false)
  const syncing = ref(false)
  const error = ref<string | null>(null)
  /** 目录里被勾选的模型 id（导入用） */
  const picked = ref<string[]>([])
  const loaded = ref(false)
  /** 本会话是否已经静默核对过一次（load 里用，避免每次进页面都打服务端） */
  let autoChecked = false

  const hasKey = computed(() => settings.value.apiKey.trim().length > 0)
  const models = computed(() => catalog.value?.models ?? [])
  const ready = computed(() => catalog.value?.ok === true)
  const configured = computed(() => ready.value && models.value.length > 0)

  /** 状态说人话：界面直接贴这一句 */
  const statusText = computed(() => {
    if (!hasKey.value) return '未配置服务密钥'
    if (!catalog.value) return '待连接'
    switch (catalog.value.status) {
      case 'ready':
        return models.value.length > 0 ? `已连接 · ${models.value.length} 个模型可用` : '已连接 · 服务端还没有可用模型'
      case 'unauthorized':
        return '密钥无效'
      case 'forbidden':
        return '密钥权限不足'
      case 'not_configured':
        return '服务端还未配置模型'
      case 'unreachable':
        return '无法连接服务'
      default:
        return '连接异常'
    }
  })

  /** 这个密钥的「调用条件」：服务端报的原文优先（余额不足/已限流…），
   *  没报就按状态码与白名单说人话 —— 这一句是用户判断「还能不能用」的依据。 */
  const accountText = computed(() => {
    const c = catalog.value
    if (!hasKey.value) return '未配置服务密钥：填 rein_sk_… 之后才能取到可用模型'
    if (!c) return '还没连接：点「获取模型列表」看这个密钥能用什么'
    if (c.clientNote) return c.clientNote
    if (c.clientStatus) return `账号状态：${c.clientStatus}`
    switch (c.status) {
      case 'ready':
        return c.clientModels.length > 0
          ? `本账号限用 ${c.clientModels.length} 个模型（其余模型不在白名单里）`
          : '本账号无限制：服务端下发的模型都可用'
      case 'unauthorized':
        return '密钥无效或已被撤销，需要服务端重新签发'
      case 'forbidden':
        return '这个密钥没有可用模型（白名单为空）'
      case 'not_configured':
        return '服务端暂无可用模型（后台还没配 provider）'
      case 'unreachable':
        return '服务异常或网络不通：地址是否写错、服务是否在跑'
      default:
        return '连接异常：看下方错误原文'
    }
  })

  /**
   * 读设置 + 上次成功的目录快照。
   *
   * 快照是「每次打开都显示待连接」那个异常的解法：密钥存在本机，凭什么冷启动
   * 就装作没连上？先渲染上次的状态，再由后台静默核对一次（见下面的 autoChecked）。
   */
  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    try {
      const [s, cached] = await Promise.all([
        onlineService.settingsGet(),
        // 快照读失败只是没有「上次」，不影响任何功能
        onlineService.cachedCatalog().catch(() => null),
      ])
      settings.value = s
      if (cached && !catalog.value) catalog.value = cached
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    // 有密钥就后台核对一次（每会话一次，不跟着每次进页面打服务端）：
    // 白名单变了、模型撤了，这一页会自己更正
    if (hasKey.value && !autoChecked) {
      autoChecked = true
      void refresh(false)
    }
  }

  /** 保存地址与密钥（密钥为空也算保存：用于清空配置） */
  async function saveSettings(patch: Partial<OnlineServiceSettings>): Promise<void> {
    const next = { ...settings.value, ...patch }
    settings.value = await onlineService.settingsSave(next)
  }

  /** 断开：清掉本机保存的密钥与目录（本机账本与服务端的账都不动） */
  async function disconnect(): Promise<void> {
    await saveSettings({ apiKey: '' })
    catalog.value = null
    usage.value = null
    picked.value = []
    error.value = null
  }

  /**
   * 拉模型目录：失败也回结构（catalog.status 区分「密钥错」「服务端没配」「连不上」）。
   *
   * `silent = true`（后台核对）时，**失败不覆盖**上一次成功的目录：启动瞬间的
   * 网络抖动不该把「已连接」翻成「无法连接」再闪回来。错误照记（打开抽屉就能看到
   * 原文与重试），用户主动点「获取模型列表」才是权威结果，一律写入。
   */
  async function refresh(silent = false): Promise<OnlineCatalog | null> {
    if (!settings.value.baseUrl.trim() && !settings.value.apiKey.trim()) return null
    loading.value = true
    error.value = null
    try {
      await saveSettings({})
      const result = await onlineService.catalog(settings.value.baseUrl, settings.value.apiKey)
      if (result.ok || !silent || !catalog.value) catalog.value = result
      if (!result.ok) error.value = result.error
      // 首次拉到目录时默认全选，用户少点一次
      if (result.ok && picked.value.length === 0) picked.value = result.models.map((m) => m.id)
      return result
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      loading.value = false
    }
  }

  function toggle(id: string): void {
    picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
  }

  function pickAll(all = true): void {
    picked.value = all ? models.value.map((m) => m.id) : []
  }

  /** 落库：服务端清单之外的同源模型会被清掉（手动添加的模型不受影响） */
  async function sync(ids?: string[]): Promise<{ added: number; updated: number; removed: number } | null> {
    const modelIds = ids ?? picked.value
    syncing.value = true
    error.value = null
    try {
      const result = await onlineService.sync(settings.value.baseUrl, settings.value.apiKey, modelIds)
      return result
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      syncing.value = false
    }
  }

  /** 服务端账本（权威口径），用于跟本机账本对账 */
  async function refreshUsage(days = 30): Promise<void> {
    if (!hasKey.value) {
      usage.value = null
      return
    }
    try {
      usage.value = await onlineService.usage(settings.value.baseUrl, settings.value.apiKey, days)
    } catch (e) {
      usage.value = null
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    settings,
    catalog,
    usage,
    loading,
    syncing,
    error,
    picked,
    hasKey,
    models,
    ready,
    configured,
    statusText,
    accountText,
    load,
    saveSettings,
    disconnect,
    refresh,
    toggle,
    pickAll,
    sync,
    refreshUsage,
  }
})
