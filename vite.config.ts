import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * 是不是 Tauri 在驱动这次构建 / dev。
 *
 * `tauri build` 会在跑 beforeBuildCommand（= npm run build）前注入 TAURI_ENV_* 一组
 * 环境变量，`npm run dev` 单独跑（纯浏览器）时没有。用「谁在驱动」而不是 NODE_ENV
 * 判据：两者都是 production 构建，区别只在**产物交给谁**。
 */
const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM)

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // 桌面端不带内存 mock 后端（约 1 MB：6800 行实现 + foods.json 全量）。
      // 它只在浏览器直连时可达（transport.isTauri 为假），替身见 src/mock/disabled.ts。
      // 必须排在 '@' 前面：alias 是首个命中即生效。
      ...(isTauriBuild
        ? { '@/mock/server': fileURLToPath(new URL('./src/mock/disabled.ts', import.meta.url)) }
        : {}),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@resources': fileURLToPath(new URL('./resources', import.meta.url)),
    },
  },
  // Tauri 约定：固定端口、不清屏，便于 CLI 读取 devUrl
  clearScreen: false,
  server: {
    host: true,
    port: 1420,
    strictPort: true,
    // Windows 下两类路径会让 watcher 撞 EBUSY 而**整进程退出**（不是降级，是 dev server 死掉）：
    //   1. src-tauri 的构建产物会被编译进程锁住（target 与 android 工程都一样）；
    //   2. 原子写：编辑器 / 工具先写 `.xxx.tmpdir/xxx.tmp` 再 rename，chokidar 抢在 rename
    //      之前去 watch 那个临时路径就 EBUSY。文件本身是合法的保存动作，不该带走 dev server，
    //      所以按形态忽略掉（2026-09-30：一次审查里因此死了两次，每次都让在跑的 e2e 全红）。
    watch: {
      ignored: [
        '**/src-tauri/target/**',
        '**/src-tauri/gen/**',
        '**/*.tmpdir/**',
        '**/.*.tmp',
        '**/*~',
      ],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
