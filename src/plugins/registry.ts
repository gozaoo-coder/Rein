import type { PluginSpec } from './types'

/**
 * 插件注册表：内置插件在 `src/plugins/builtin/` 里声明，导入即注册（见 `plugins/index.ts`）。
 * 注册表本身是**纯数据**——启用/关闭状态在 `stores/features.ts`，这里不认识 Pinia。
 */
const registry: PluginSpec[] = []

/** 路由名 → 拥有它的插件索引。注册期间会被置空，下一个查询时按当前登记重建 */
let routeIndex: Map<string, PluginSpec> | null = null

/** 路由名 → 拥有它的插件（返回 null = 无主路由，随时可导航） */
export function routeOwner(routeName: string): PluginSpec | null {
  routeIndex ??= new Map(
    registry.flatMap((p) => (p.routes ?? []).map((r) => [r, p] as const)),
  )
  return routeIndex.get(routeName) ?? null
}

/** 声明一个功能插件。id 与路由名重复都视为编码错误，直接抛出（早失败 > 静默覆盖）。 */
export function definePlugin(spec: PluginSpec): PluginSpec {
  if (registry.some((p) => p.id === spec.id)) throw new Error(`插件 id 重复：${spec.id}`)
  for (const route of spec.routes ?? []) {
    const owner = routeOwner(route)
    if (owner) throw new Error(`路由 ${route} 已被插件 ${owner.id} 认领，${spec.id} 不能重复声明`)
  }
  registry.push(spec)
  routeIndex = null // 索引失效：自己新认领的路由也要能被查到
  return spec
}

/** 全部插件（注册顺序） */
export const plugins: readonly PluginSpec[] = registry

/** 可开关的插件：设置页「打开或关闭功能」的列表来源 */
export function toggleablePlugins(): PluginSpec[] {
  return registry.filter((p) => p.toggleable)
}

export function pluginById(id: string): PluginSpec | undefined {
  return registry.find((p) => p.id === id)
}
