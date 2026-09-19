import type { Component } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

/** 导航容器：移动端底部页签 / 桌面导航轨 */
export type NavSurface = 'tabbar' | 'rail'

/**
 * 工具卡的就地动作名。插件声明「做什么」，由承载工具格的页面实现「怎么做」——
 * 这样插件保持纯声明（不持有组件状态、不 import router），页面保留自己的弹层与路由。
 * 新增动作 = 这里加一个字面量 + 承载页面在 ACTIONS 里实现。
 */
export type ToolAction = 'smart-add' | 'add-workout' | 'voice-session'

/** 导航贡献：一个条目可同时出现在两种容器里（surfaces 决定落点） */
export interface NavContribution {
  /** 目标路由名。关闭插件后该路由被守卫拦回主页 */
  route: string
  label: string
  icon: Component
  surfaces: NavSurface[]
  /** 同容器内升序排列；内核条目占用 0~99，插件用 100 起步留出插入空间 */
  order: number
}

/** 主页「常用工具」格里的动作卡 */
export interface ToolContribution {
  /** 全局唯一 id（跨插件不重复，渲染 key 与开关埋点共用） */
  id: string
  title: string
  /** 副标题；函数形式可读实时数据（如记账本月支出） */
  sub: string | (() => string)
  icon: Component
  /** 图标章配色：底色为同色相 12~14% 淡彩，前景为同色相深档（与全局约定一致） */
  ic: { background: string; color: string }
  order: number
  /** 跳转目标（与 action 二选一） */
  to?: RouteLocationRaw
  /** 就地动作（开抽屉 / 唤起运行时），优先于 to */
  action?: ToolAction
}

/**
 * 功能插件：一个功能模块的完整声明 = 元数据（设置页开关行）+ 扩展点贡献 + 路由所有权。
 * 关闭开关的效果：工具卡与导航条目消失、路由被守卫拦回主页、数据原样保留。
 */
export interface PluginSpec {
  id: string
  name: string
  /** 设置页开关行里的一行说明 */
  desc: string
  icon: Component
  /** 主题色令牌名（如 --c-exercise），开关行图标章从这里取色 */
  accent: string
  /** 是否允许用户开关；false（默认）= 内核功能，恒开且不进设置页 */
  toggleable?: boolean
  /** 首次运行的默认开关状态（仅 toggleable 有意义，默认开） */
  defaultEnabled?: boolean
  /** 该插件拥有的路由名：关闭后这些路由被守卫拦回主页 */
  routes?: string[]
  tools?: ToolContribution[]
  nav?: NavContribution[]
}
