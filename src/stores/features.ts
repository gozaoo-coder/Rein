import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import {
  pluginById,
  plugins,
  type NavContribution,
  type NavSurface,
  type PluginSpec,
  type ToolContribution,
} from '@/plugins'

/**
 * 功能插件开关：整个应用「哪些功能开着」的唯一事实来源。
 *
 * 消费方（导航栏、主页工具格、路由守卫）一律问这里，不各自判断：
 * - `tools` / `nav(surface)`：已开插件的扩展点贡献，按 order 排好
 * - `isEnabled(id)`：路由守卫与条件渲染共用
 *
 * 持久化在 localStorage（`rein.features.v1`）——它与番茄钟设置同属「界面级偏好」，
 * 不是业务数据，因此不进 SQLite、不进知识库索引。
 */
const STORE_KEY = 'rein.features.v1'

type EnabledMap = Record<string, boolean>

/** 读本地开关；损坏/不可用一律回落默认值（开关丢了不能拖垮启动） */
function load(): EnabledMap {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as EnabledMap
    }
  } catch {
    /* 忽略损坏的本地开关 */
  }
  return {}
}

export const useFeaturesStore = defineStore('features', () => {
  /** 只存用户改过的项：解析时与 defaults() 合并，新增插件不必迁移旧数据 */
  const overrides = ref<EnabledMap>(load())

  watch(
    overrides,
    (m) => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(m))
      } catch {
        /* 本地存储不可用时退化为内存态 */
      }
    },
    { deep: true },
  )

  /** 插件是否启用：内核插件（不可开关）恒开 */
  function isEnabled(id: string): boolean {
    const p = pluginById(id)
    if (!p || !p.toggleable) return true
    return overrides.value[id] ?? p.defaultEnabled !== false
  }

  function setEnabled(id: string, on: boolean): void {
    const p = pluginById(id)
    if (!p?.toggleable) return
    overrides.value = { ...overrides.value, [id]: on }
  }

  const activePlugins = computed<PluginSpec[]>(() => plugins.filter((p) => isEnabled(p.id)))

  /** 主页工具格：已开插件的工具卡，按 order 升序 */
  const tools = computed<ToolContribution[]>(() =>
    activePlugins.value
      .flatMap((p) => p.tools ?? [])
      .sort((a, b) => a.order - b.order),
  )

  /** 某个导航容器里的条目：已开插件贡献的，按 order 升序 */
  function nav(surface: NavSurface): NavContribution[] {
    return activePlugins.value
      .flatMap((p) => (p.nav ?? []).filter((n) => n.surfaces.includes(surface)))
      .sort((a, b) => a.order - b.order)
  }

  return { isEnabled, setEnabled, activePlugins, tools, nav }
})
