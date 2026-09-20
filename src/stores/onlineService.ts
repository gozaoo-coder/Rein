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

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    try {
      settings.value = await onlineService.settingsGet()
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
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

  /** 拉模型目录：失败也回结构（catalog.status 区分「密钥错」「服务端没配」「连不上」） */
  async function refresh(): Promise<OnlineCatalog | null> {
    if (!settings.value.baseUrl.trim() && !settings.value.apiKey.trim()) return null
    loading.value = true
    error.value = null
    try {
      await saveSettings({})
      const result = await onlineService.catalog(settings.value.baseUrl, settings.value.apiKey)
      catalog.value = result
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
