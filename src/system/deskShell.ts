import { ref, watch } from 'vue'

/**
 * 桌面壳层里**跨组件共享的两个开关**（导航轨、信息栏、命令面板都要读写）。
 *
 * 为什么不放在 App.vue 里用 props 传：这三个组件是兄弟关系，而"信息栏开不开"
 * 又是**用户偏好**（要落 localStorage、下次启动照旧）。放一份响应式模块进来，
 * 读的人直接 import，不必让 App 当二传手 —— 壳层里只有这一处状态是真的全局的。
 */

/**
 * 修饰键的**显示写法**：macOS 写 ⌘，其余平台写 Ctrl+。
 *
 * 监听端两种都收（metaKey || ctrlKey），这里只管「印出来是哪一个」——
 * 这个应用同时发 Windows 与 Android 包，在 Windows 上教用户按 ⌘K 是在教一个
 * 键盘上不存在的键。平台在会话内不会变，所以算一次就够。
 */
export const MOD =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl+'

const KEY_INSPECTOR = 'rein.inspector.v1'

function readInspector(): boolean {
  try {
    // 缺省开：信息栏是这个工作台的第三格，默认关掉等于把一半能力藏起来
    return localStorage.getItem(KEY_INSPECTOR) !== '0'
  } catch {
    return true
  }
}

/** 右侧信息栏是否展开（⌘I 或导航轨底部的开关切换） */
export const inspectorOpen = ref(readInspector())

watch(inspectorOpen, (v) => {
  try {
    localStorage.setItem(KEY_INSPECTOR, v ? '1' : '0')
  } catch {
    /* 本地存储不可用时不记偏好，不影响本次会话 */
  }
})

export function toggleInspector(): void {
  inspectorOpen.value = !inspectorOpen.value
}

/* ---------- 最近访问（命令面板的「最近」组） ---------- */

const KEY_RECENT = 'rein.recentRoutes.v1'
const RECENT_MAX = 6

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY_RECENT)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const recentRoutes = ref<string[]>(readRecent())

/** 记一次访问：按路由名去重、最新的排最前、只留 6 条 */
export function rememberRoute(name: string): void {
  if (!name) return
  const next = [name, ...recentRoutes.value.filter((n) => n !== name)].slice(0, RECENT_MAX)
  recentRoutes.value = next
  try {
    localStorage.setItem(KEY_RECENT, JSON.stringify(next))
  } catch {
    /* 同上 */
  }
}
