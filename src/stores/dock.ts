import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

/**
 * 底部 Dock 左键（独立圆钮）的自定义落点。
 *
 * Dock 改成「左圆钮 + 中药丸 + 右圆钮」后，内核三格（主页 / 运动 / 我）与 AI 各有归属，
 * 课表这类模块主页面退到左钮上继续一键可达 —— 默认就是它。
 *
 * 只存**路由名**，不存 label / icon：候选清单每次从插件层现取（见 TabBar 的 candidates），
 * 关掉某个模块后该候选自然消失，这里不必跟着迁移数据；存量落点失效时 Dock 会回落到
 * 候选里的第一项。与功能开关同属界面级偏好，走 localStorage，不进 SQLite。
 */
const STORE_KEY = 'rein.dock.v1'

/** 默认落点：课表 */
export const DOCK_LEFT_DEFAULT = 'campus-schedule'

function load(): string {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const left = (JSON.parse(raw) as { left?: unknown } | null)?.left
      if (typeof left === 'string' && left) return left
    }
  } catch {
    /* 本地存储不可用 → 默认落点 */
  }
  return DOCK_LEFT_DEFAULT
}

export const useDockStore = defineStore('dock', () => {
  const leftRoute = ref(load())

  watch(leftRoute, (route) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ left: route }))
    } catch {
      /* 存不下就只留内存态 */
    }
  })

  function setLeftRoute(route: string): void {
    leftRoute.value = route
  }

  return { leftRoute, setLeftRoute }
})
