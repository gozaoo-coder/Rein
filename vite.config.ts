import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
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
    // Windows 下 src-tauri 的构建产物会被进程锁定，watcher 报 EBUSY（target 与 android 工程都一样）
    watch: { ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
