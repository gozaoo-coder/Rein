/**
 * 构建期替身：**只**在 Tauri 构建里替换 `@/mock/server`（见 vite.config.ts 的 alias）。
 *
 * 为什么要有这个文件：`src/mock/server.ts` 是浏览器开发/预览用的内存后端，
 * 它连同 `resources/foods.json`（896 KB 源文件）一起被 Rollup 打成约 1 MB 的懒加载
 * chunk —— 桌面端（Tauri）里 `transport.isTauri` 恒为真，那条分支永远走不到，
 * 于是这 1 MB 白进安装包、白占 WebView 的磁盘与解析预算。
 *
 * 替身必须与真实现**同名导出**（transport.ts / campusService.ts / voiceService.ts
 * 三处动态 import）：接口对不上就是运行时炸，而不是编译期炸，所以这里的形状要跟着改。
 *
 * 命中这里 = 「桌面端走到了本不该走的分支」，一律抛错，别静默降级成假数据。
 */

/** 与 `src/mock/server.ts::mockInvoke` 同签名 */
export async function mockInvoke<T>(cmd: string, _args?: Record<string, unknown>): Promise<T> {
  throw new Error(`内存 mock 后端未打进桌面端构建（命令 ${cmd}）—— 这条分支只在浏览器直连时可达`)
}

/** 与 `src/mock/server.ts::mockCampus` 同形状（抢课事件挂钩） */
export const mockCampus: { onGrab: ((state: unknown) => void) | null } = { onGrab: null }

/** 与 `src/mock/server.ts::mockVoice` 同形状（ASR 事件挂钩） */
export const mockVoice: { onAsr: ((e: unknown) => void) | null } = { onAsr: null }
